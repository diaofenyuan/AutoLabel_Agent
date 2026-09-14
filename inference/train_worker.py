"""由 Java 调度的软件内模型训练进程；单任务执行，不承担任务队列。

与推理 worker 同族：stdin/stdout 行级 JSON、ready 握手、父进程句柄监测、关闭时只退出自身。
差异在于训练没有固定总超时，Java 侧用心跳与停滞判定管理长任务，因此这里不能复用 LocalInference。

协议：
  命令 probe / train / cancel / shutdown，stdin 由主线程持续读取，保证取消可即时送达。
  train 立即回执并在线程中执行，进度以 event 行持续输出，结束时输出终止事件后退出进程。
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import queue
import sys
import threading
import time

# 训练进程同样不自动下载权重：基础权重必须是已登记且哈希一致的本地文件。
os.environ["YOLO_AUTOINSTALL"] = "false"
os.environ.setdefault("YOLO_VERBOSE", "false")

PROTOCOL_VERSION = 1
# AMP 自检会联网下载权重；本地已有该文件时才允许这次自检，否则跳过并如实上报。
AMP_PROBE_ASSET = "yolo26n.pt"
# 从零开始训练时按任务类型选择 ultralytics 自带的模型结构（不涉及任何下载）。
ARCHITECTURES = {
    "detect": "yolo11.yaml",
    "segment": "yolo11-seg.yaml",
    "pose": "yolo11-pose.yaml",
    "obb": "yolo11-obb.yaml",
    "classify": "yolo11-cls.yaml",
}
# 关闭数据增强等同于关掉全部训练期增强项（ultralytics 的 augment 参数是推理期 TTA，不是训练增强）。
NO_AUGMENTATION = {
    "mosaic": 0.0, "mixup": 0.0, "cutmix": 0.0, "copy_paste": 0.0, "erasing": 0.0,
    "hsv_h": 0.0, "hsv_s": 0.0, "hsv_v": 0.0, "degrees": 0.0, "translate": 0.0,
    "scale": 0.0, "shear": 0.0, "perspective": 0.0, "flipud": 0.0, "fliplr": 0.0,
}
METRIC_KEYS = {
    "metrics/precision(B)": "precision", "metrics/recall(B)": "recall",
    "metrics/mAP50(B)": "mAP50", "metrics/mAP50-95(B)": "mAP50_95",
    "metrics/accuracy_top1": "top1", "metrics/accuracy_top5": "top5",
}
LOSS_KEYS = {"train/box_loss": "boxLoss", "train/cls_loss": "clsLoss", "train/dfl_loss": "dflLoss", "train/loss": "loss"}


class TrainingError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# 协议通道固定为真实 stdout：训练期间会把第三方输出重定向到 stderr，协议行不能被改写。
protocol = sys.stdout


def emit(value: dict) -> None:
    protocol.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    protocol.flush()


def numeric(value):
    """只接受有限数值：NaN/Inf 会毒化指标并与 JSON 协议冲突。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def digest(path: str, limit: int | None = None) -> str | None:
    try:
        hasher = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(block)
                if limit is not None and handle.tell() > limit:
                    break
        return hasher.hexdigest()
    except OSError:
        return None


def watch_parent() -> None:
    raw = os.environ.get("AUTOLABEL_PARENT_PID")
    if raw is None or os.name != "nt":
        return
    if not raw.isdecimal() or int(raw) <= 0 or int(raw) == os.getpid():
        raise RuntimeError("invalid parent process")
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    parent = kernel.OpenProcess(0x00100000, False, int(raw))
    if not parent:
        raise RuntimeError("parent process unavailable")

    def wait():
        # 与推理进程一致：Java 强退时不依赖 stdin EOF，靠父进程句柄结束自身。
        status = kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
        kernel.CloseHandle(parent)
        os._exit(0 if status == 0 else 1)

    threading.Thread(target=wait, daemon=True, name="parent-lifetime").start()


class TrainingWorker:
    """训练执行器：环境探测与单任务训练。"""

    def __init__(self, preload_failure: Exception | None = None) -> None:
        self._gate = threading.Lock()
        self._cancel = threading.Event()
        self._job: str | None = None
        self._cancelled = False
        self._stop_requested = False
        self._last_epoch = 0
        self._preload_failure = preload_failure

    # ===== 环境探测 =====

    def probe(self) -> dict:
        if self._preload_failure is not None:
            return {"available": False, "code": "training_environment_missing",
                    "message": "当前 Python 缺少可用的 Ultralytics 或 PyTorch，无法训练"}
        try:
            with contextlib.redirect_stdout(sys.stderr):
                import torch
                import ultralytics
                import numpy
                import cv2
            from ultralytics.cfg import DEFAULT_CFG_DICT

            cuda = torch.cuda.is_available()
            devices = [{"id": "cpu", "name": "CPU"}]
            if cuda:
                for index in range(torch.cuda.device_count()):
                    name = torch.cuda.get_device_name(index)
                    entry = {"id": str(index), "name": name}
                    try:
                        # 显存用于启动前回退判定；读不到时不猜测，占位为 None。
                        free, _total = torch.cuda.mem_get_info(index)
                        entry["freeMemoryMb"] = int(free // (1024 * 1024))
                    except Exception:
                        entry["freeMemoryMb"] = None
                    devices.append(entry)
            return {"available": True, "pythonVersion": sys.version.split()[0],
                    "ultralyticsVersion": ultralytics.__version__, "torchVersion": torch.__version__,
                    "numpyVersion": numpy.__version__, "opencvVersion": cv2.__version__,
                    "cudaAvailable": cuda, "devices": devices,
                    "capabilities": {"valPeriod": "val_period" in DEFAULT_CFG_DICT,
                                     "ampProbeCached": self._amp_probe_cached()}}
        except ImportError:
            return {"available": False, "code": "training_environment_missing",
                    "message": "当前 Python 缺少可用的 Ultralytics 或 PyTorch，无法训练"}

    # ===== 训练 =====

    def train(self, payload: dict) -> dict:
        """校验并占用本进程的训练槽；真正的执行由主线程内联调用 run()。"""
        job_id = payload.get("jobId")
        if not isinstance(job_id, str) or not job_id or len(job_id) > 160:
            raise TrainingError("parameter_invalid", "训练任务标识无效")
        task = payload.get("taskType")
        if task not in ARCHITECTURES:
            raise TrainingError("training_task_unsupported", "不支持该训练任务类型：" + str(task))
        if not isinstance(payload.get("dataPath"), str) or not payload["dataPath"]:
            raise TrainingError("parameter_invalid", "缺少训练数据集配置路径")
        if not isinstance(payload.get("outputDir"), str) or not payload["outputDir"]:
            raise TrainingError("parameter_invalid", "缺少训练产物目录")
        with self._gate:
            if self._job is not None:
                raise TrainingError("training_busy", "该训练进程已在执行任务，请等待其结束")
            self._cancel = threading.Event()
            self._cancelled = False
            self._job = job_id
        return {"started": True, "jobId": job_id}

    def cancel(self) -> dict:
        with self._gate:
            job = self._job
            if job is None:
                return {"cancelling": False, "jobId": None}
            # 优雅取消：当前 epoch 结束后保存 last.pt 再退出，不丢已产出的轮次。
            self._cancel.set()
            return {"cancelling": True, "jobId": job}

    def run(self, payload: dict) -> None:
        """在主线程内联执行训练：torch 等依赖只在主线程导入，避免后台线程导入挂起。"""
        job_id = payload["jobId"]
        started = time.monotonic()
        try:
            self._event(job_id, "preparing", started, message="正在准备训练环境与数据集")
            from ultralytics import YOLO
            self._prepare_amp()

            data_path = payload["dataPath"]
            if not os.path.isfile(data_path):
                raise TrainingError("training_dataset_missing", "训练数据集配置不存在，请重新创建快照")
            output = payload["outputDir"]
            os.makedirs(output, exist_ok=True)

            task = payload["taskType"]
            weights = payload.get("baseModelPath")
            if weights:
                if not os.path.isfile(weights):
                    raise TrainingError("training_base_model_missing", "基础权重文件不存在，请重新登记或授权")
                expected = payload.get("baseModelHash")
                if isinstance(expected, str) and expected and digest(weights) != expected:
                    raise TrainingError("training_base_model_changed", "基础权重与登记哈希不一致，训练未开始")
                model = YOLO(weights)
                observed = str(getattr(model, "task", "") or "")
                # 任务类型不符必须显式拒绝：按检测数据训分割只会得到不可用的权重。
                if observed and observed != task:
                    raise TrainingError("training_task_mismatch", "基础权重任务类型与数据集不一致：" + observed)
            else:
                model = YOLO(ARCHITECTURES[task])

            arguments = self._arguments(payload, data_path, output)
            callbacks = {
                "on_train_start": lambda trainer: self._started(job_id, started, trainer, payload),
                "on_fit_epoch_end": lambda trainer: self._epoch(job_id, started, trainer),
            }
            for name, callback in callbacks.items():
                model.add_callback(name, callback)
            self._event(job_id, "running", started, message="训练已开始", epochs=arguments["epochs"])
            # 训练期第三方输出统一并入 stderr，由 Java 侧截断后写成 train.log；stdout 保持纯协议。
            with contextlib.redirect_stdout(sys.stderr):
                model.train(**arguments)
            trainer = getattr(model, "trainer", None)
            planned = int(getattr(trainer, "epochs", arguments["epochs"]) or arguments["epochs"])
            if self._cancelled and self._last_epoch < planned:
                self._finish(job_id, "cancelled", started, trainer, message="已按请求在该轮结束后停止，已产出的权重与逐轮指标保留")
            elif self._cancelled:
                # 取消请求到达时最后一个轮次已经开始：如实报告完成，不把跑完的结果标成取消。
                self._finish(job_id, "finished", started, trainer, message="训练已完成全部轮次；取消请求到达时最后一轮已经开始，结果按完成处理")
            else:
                self._finish(job_id, "finished", started, trainer, message="训练完成")
        except TrainingError as failure:
            self._finish(job_id, "failed", started, None, code=failure.code, message=str(failure))
        except ImportError:
            self._finish(job_id, "failed", started, None, code="training_environment_missing", message="缺少可选的训练依赖，请在设置中检查 Python 环境")
        except Exception as failure:
            memory = "out of memory" in str(failure).lower()
            self._finish(job_id, "failed", started, None,
                         code="device_memory_insufficient" if memory else "training_failed",
                         message="显存不足，请降低批次或改用 CPU" if memory
                         else "训练进程执行失败，请核对数据集与环境后重试")

    def _arguments(self, payload: dict, data_path: str, output: str) -> dict:
        from ultralytics.cfg import DEFAULT_CFG_DICT

        device = payload.get("device", "cpu")
        batch = payload.get("batch")
        arguments = {
            "data": data_path, "epochs": int(payload["epochs"]), "imgsz": int(payload["imgsz"]),
            "batch": -1 if batch == "auto" else int(batch),
            "device": int(device) if str(device).isdigit() else str(device),
            "lr0": float(payload["learningRate"]), "optimizer": payload.get("optimizer", "auto"),
            "momentum": float(payload.get("momentum", 0.937)), "weight_decay": float(payload.get("weightDecay", 0.0005)),
            "warmup_epochs": float(payload.get("warmupEpochs", 3)), "patience": int(payload.get("patience", 100)),
            "workers": int(payload.get("workers", 8)), "seed": int(payload.get("seed", 0)),
            "cos_lr": bool(payload.get("cosLr", False)), "close_mosaic": int(payload.get("closeMosaic", 10)),
            "project": output, "name": "run", "exist_ok": True, "verbose": False, "plots": True,
            # 续训一期按「从 last.pt 出发的新任务」实现，不使用 ultralytics 的 resume 原地续训。
            "resume": False,
        }
        if payload.get("augment") is False:
            arguments.update(NO_AUGMENTATION)
        period = int(payload.get("valPeriod", 1))
        if period > 1 and "val_period" in DEFAULT_CFG_DICT:
            arguments["val_period"] = period
        return arguments

    # ===== 事件 =====

    def _started(self, job_id: str, started: float, trainer, payload: dict) -> None:
        actual = str(getattr(trainer, "device", "") or "")
        self._event(job_id, "running", started, epochs=int(getattr(trainer, "epochs", payload["epochs"])),
                    device=actual, message="训练已在 " + (actual or "未知设备") + " 上开始")

    def _epoch(self, job_id: str, started: float, trainer) -> None:
        epoch, epochs = int(trainer.epoch) + 1, int(trainer.epochs)
        # ultralytics 在训练结束后还会带同一轮次再触发一次回调（收尾验证），重复与越界轮次不重复上报。
        if epoch > epochs or epoch <= self._last_epoch:
            self._request_stop(trainer)
            return
        self._last_epoch = epoch
        self._event(job_id, "epoch", started, epoch=epoch, epochs=epochs,
                    metrics=self._metrics(trainer), message="第 " + str(epoch) + " 轮完成")
        self._request_stop(trainer)

    def _request_stop(self, trainer) -> None:
        """在轮次边界请求停止：保留该轮指标与 last.pt，不虚报完成。"""
        if not self._cancel.is_set():
            return
        self._cancelled = True
        # ultralytics 8.4 的训练循环读 trainer.stop；stop_training 是旧字段，两者都设置以兼容不同版本。
        trainer.stop = True
        trainer.stop_training = True

    def _metrics(self, trainer) -> dict:
        metrics = {}
        for key, name in METRIC_KEYS.items():
            value = numeric((getattr(trainer, "metrics", None) or {}).get(key))
            if value is not None:
                metrics[name] = value
        try:
            items = trainer.label_loss_items(trainer.tloss, prefix="train") if getattr(trainer, "tloss", None) is not None else {}
        except Exception:
            items = {}
        for key, name in LOSS_KEYS.items():
            value = numeric(items.get(key))
            if value is not None:
                metrics[name] = value
        return metrics

    def _event(self, job_id: str, stage: str, started: float, **fields) -> None:
        payload = {"type": "event", "jobId": job_id, "stage": stage,
                   "elapsedMs": int((time.monotonic() - started) * 1000)}
        payload.update({key: value for key, value in fields.items() if value is not None})
        emit(payload)

    def _finish(self, job_id: str, stage: str, started: float, trainer, **fields) -> None:
        payload = {"type": "event", "jobId": job_id, "stage": stage,
                   "elapsedMs": int((time.monotonic() - started) * 1000)}
        payload.update({key: value for key, value in fields.items() if value is not None})
        directory = str(getattr(trainer, "save_dir", "") or "")
        if directory:
            payload["result"] = {"directory": directory, "artifacts": self._artifacts(directory),
                                 "epochs": int(getattr(trainer, "epochs", 0)),
                                 "completedEpochs": self._last_epoch,
                                 "bestFitness": numeric(getattr(trainer, "best_fitness", None))}
        payload["cancelled"] = self._cancelled
        emit(payload)
        # 训练结束即退出：Java 以终止事件为准，进程退出本身不代表失败。
        sys.stdout.flush()
        os._exit(0)

    def _artifacts(self, directory: str) -> list:
        candidates = [("best", os.path.join(directory, "weights", "best.pt")),
                      ("last", os.path.join(directory, "weights", "last.pt")),
                      ("results", os.path.join(directory, "results.csv")),
                      ("args", os.path.join(directory, "args.yaml"))]
        artifacts = []
        for kind, path in candidates:
            if not os.path.isfile(path):
                continue
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            artifacts.append({"kind": kind, "path": path, "size": size, "hash": digest(path)})
        return artifacts

    # ===== 离线与依赖保护 =====

    def _amp_probe_cached(self) -> bool:
        try:
            from ultralytics.utils import SETTINGS
            directory = SETTINGS.get("weights_dir")
            return bool(directory) and os.path.isfile(os.path.join(str(directory), AMP_PROBE_ASSET))
        except Exception:
            return False

    def _prepare_amp(self) -> None:
        """本地没有 AMP 自检权重时跳过该自检，避免训练启动时联网下载权重。"""
        if self._amp_probe_cached():
            return
        import ultralytics.utils.checks as checks

        def skipped(_model):
            print("AMP: 本地缺少 " + AMP_PROBE_ASSET + "，已跳过自检以避免自动下载权重。", file=sys.stderr)
            return True

        checks.check_amp = skipped


def preload() -> Exception | None:
    """
    在启动控制线程之前导入训练依赖。

    Windows 上只要存在一个阻塞在 stdin 读取上的线程，后续导入 torch/ultralytics 就会挂起，
    因此依赖必须在控制线程启动之前完成导入；这里只报告失败，具体的可操作提示由 probe/train 给出。
    """
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy  # noqa: F401
            import cv2  # noqa: F401
            import torch  # noqa: F401
            import ultralytics  # noqa: F401
            from ultralytics import YOLO  # noqa: F401
        return None
    except Exception as failure:  # 缺依赖不算崩溃：核心标注功能不依赖本模块
        return failure


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    watch_parent()
    worker = TrainingWorker(preload())
    queued: queue.Queue = queue.Queue()
    emit({"type": "ready", "protocolVersion": PROTOCOL_VERSION})

    def control() -> None:
        # 独立控制线程持续读取 stdin，取消与停止请求无需等待训练轮次结束。
        # 这里只做标志位与回执，不导入任何训练依赖：Windows 上在主线程阻塞读 stdin 时导入 torch 会挂起。
        while True:
            line = sys.stdin.readline()
            if not line:
                queued.put(None)
                return
            request_id = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("id"), str) or len(request["id"]) > 160:
                    raise TrainingError("request_invalid", "请求标识无效")
                request_id = request["id"]
                command = request.get("command")
                if command == "cancel":
                    emit({"type": "response", "id": request_id, "ok": True, "data": worker.cancel()})
                elif command == "shutdown":
                    emit({"type": "response", "id": request_id, "ok": True, "data": {"stopped": True}})
                    sys.stdout.flush()
                    os._exit(0)
                else:
                    queued.put(request)
            except TrainingError as error:
                emit({"type": "response", "id": request_id, "ok": False, "error": {"code": error.code, "message": str(error)}})
            except Exception:
                emit({"type": "response", "id": request_id, "ok": False,
                      "error": {"code": "request_invalid", "message": "训练请求格式无效"}})

    threading.Thread(target=control, daemon=True, name="training-control").start()
    while True:
        request = queued.get()
        if request is None:
            break
        request_id = request["id"]
        try:
            payload = request.get("payload", {})
            if not isinstance(payload, dict):
                raise TrainingError("parameter_invalid", "参数必须为对象")
            command = request.get("command")
            if command == "probe":
                data = worker.probe()
                emit({"type": "response", "id": request_id, "ok": True, "data": data})
            elif command == "train":
                data = worker.train(payload)
                # 先回执再训练：训练没有固定总超时，进度由事件持续上报，取消由控制线程即时送达。
                emit({"type": "response", "id": request_id, "ok": True, "data": data})
                worker.run(payload)
                return
            else:
                raise TrainingError("training_command_unimplemented", "当前版本尚未实现该训练命令：" + str(command))
        except TrainingError as error:
            emit({"type": "response", "id": request_id, "ok": False, "error": {"code": error.code, "message": str(error)}})
        except ImportError:
            emit({"type": "response", "id": request_id, "ok": False,
                  "error": {"code": "training_environment_missing", "message": "缺少可选训练依赖，请在设置中检查 Python 环境"}})
        except Exception as error:
            # 与推理一致：库异常可能携带本机路径，只暴露稳定分类。
            memory_error = "out of memory" in str(error).lower()
            emit({"type": "response", "id": request_id, "ok": False, "error": {
                "code": "device_memory_insufficient" if memory_error else "training_failed",
                "message": "显存不足，请降低批次或改用 CPU" if memory_error else "训练进程执行失败，请核对数据集与环境"}})


if __name__ == "__main__":
    main()
