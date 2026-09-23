"""由 Java 调度的可选 YOLO 进程；每进程串行推理，不承担任务队列。"""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
from fractions import Fraction
from numbers import Real
import os
from pathlib import Path
import sys
import time
import uuid
from types import SimpleNamespace

os.environ["YOLO_AUTOINSTALL"] = "false"
os.environ.setdefault("YOLO_VERBOSE", "false")
PROTOCOL_VERSION = 1
TASKS = {"detect", "obb", "segment", "pose", "classify"}
TRACKING_ADAPTER_VERSION = "indexed-bytetrack-detect-v1"
TRACKING_CONFIG = {"tracker_type": "bytetrack", "track_high_thresh": 0.25, "track_low_thresh": 0.1,
                   "new_track_thresh": 0.25, "track_buffer": 30, "match_thresh": 0.8, "fuse_score": True}
TRACKING_DIAGNOSTICS = {"centerSpeedDiagonalsPerSecond": 2.0, "areaRatio": 4.0,
                        "overlapIoU": 0.5, "maxOverlapPairChecks": 20000, "maxOverlapExamplesPerFrame": 20}


class InferenceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    sys.stdout.flush()


def number(value, label: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise InferenceError("parameter_invalid", f"{label}应在 {low}～{high} 范围内")
    return value


def local_file(value, suffixes: set[str]) -> Path:
    if not isinstance(value, str) or not value or len(value) > 32767:
        raise InferenceError("file_invalid", "请选择有效的本地文件")
    path = Path(value)
    if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in suffixes:
        raise InferenceError("file_invalid", "所选文件不存在或格式不支持")
    return path.resolve()


def aligned_rows(*rows) -> None:
    # zip 默认截断到最短数组；模型结构损坏时必须整条失败，不能悄悄漏掉目标。
    if len({len(row) for row in rows}) > 1:
        raise InferenceError("result_invalid", "模型返回的几何、类别或置信度数量不一致")


# ---------------------------------------------------------------------------
# 开放词汇（YOLO-World）：类别名由本次请求给出，文本向量按「缓存 → 内置词表 → CLIP」三级解析。
# 任何一级都不会联网：本地没有编码器时直接报 vocabulary_encoder_missing，由界面提示一次性下载。
# ---------------------------------------------------------------------------
VOCABULARY_CACHE_ENV = "AUTOLABEL_VOCAB_CACHE"
TEXT_ENCODER_ENV = "AUTOLABEL_TEXT_ENCODER"
CLIP_ENCODER_FILE = "ViT-B-32.pt"
VOCABULARY_MAX_CLASSES = 200
VOCABULARY_MAX_NAME = 100
BUILTIN_VOCABULARY_DIR = Path(__file__).resolve().parent / "vocab"


def load_alias_table() -> dict:
    """中文别名 → 英文规范名。这张表不依赖 CLIP，可以在构建机上随时重新生成（build_vocab.py --aliases-only）。

    有它，「车辆 → car」这类名字在 npz 还没重建、本机也没有编码器时照样能用；
    没有它，用户只能看到「下载编码器」这一条并不正确的出路。
    """
    try:
        payload = json.loads((BUILTIN_VOCABULARY_DIR / "aliases.json").read_text(encoding="utf-8"))
    except Exception:
        return {}
    aliases = payload.get("aliases")
    return {str(name): str(target) for name, target in aliases.items()} if isinstance(aliases, dict) else {}


ALIAS_TABLE = load_alias_table()


def environment_directory(name: str) -> Path | None:
    """引擎下发的目录；未配置或不是绝对路径时按未配置处理，不猜位置。"""
    value = os.environ.get(name, "")
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else None


def text_classes(value) -> list[str]:
    """校验并归一化文本类别：1～200 条，去重，单条不超过 100 字符。"""
    if not isinstance(value, list) or not value or len(value) > VOCABULARY_MAX_CLASSES:
        raise InferenceError("vocabulary_invalid", f"文本类别必须是 1～{VOCABULARY_MAX_CLASSES} 条的数组")
    names, seen = [], set()
    for item in value:
        if not isinstance(item, str):
            raise InferenceError("vocabulary_invalid", "文本类别只能是字符串")
        name = item.strip()
        if not name or len(name) > VOCABULARY_MAX_NAME:
            raise InferenceError("vocabulary_invalid", f"类别名不能为空且不超过 {VOCABULARY_MAX_NAME} 个字符")
        if name not in seen:
            seen.add(name)
            names.append(name)
    if not names:
        raise InferenceError("vocabulary_invalid", "文本类别去重后为空")
    return names


def vocabulary_key(names: list[str]) -> str:
    """词表标识：同一份类别名（含顺序）永远得到同一个键，缓存才有意义。"""
    payload = json.dumps(names, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_vocabulary(path: Path) -> tuple[list[str], object] | None:
    """读一份词表缓存；内容损坏、结构不符一律按未命中处理，不让缓存问题变成推理失败。"""
    import numpy
    try:
        with numpy.load(path, allow_pickle=False) as data:
            names = [str(item) for item in data["names"].tolist()]
            embeddings = numpy.asarray(data["embeddings"], dtype="float32")
    except Exception:
        return None
    if not names or embeddings.ndim != 3 or embeddings.shape[1] != len(names) or embeddings.shape[0] != 1:
        return None
    return names, embeddings


def builtin_vocabulary(names: list[str]):
    """内置词表：构建期用同一套 CLIP 编码好的规范名向量，命中即零下载、零编码。

    中文别名先映射到英文规范名再取向量。CLIP 的文本编码器只认英文，直接编码中文
    会得到没有意义的向量（实测「人」一个目标都查不到，「person」能查到 5 个）。
    """
    import numpy
    for path in sorted(BUILTIN_VOCABULARY_DIR.glob("*.npz")):
        try:
            with numpy.load(path, allow_pickle=False) as data:
                table = {str(name): row for name, row in zip(data["names"].tolist(), data["embeddings"])}
                aliases = {str(alias): str(target) for alias, target in zip(data["alias_names"].tolist(), data["alias_targets"].tolist())} \
                    if "alias_names" in data else {}
        except Exception:
            continue
        rows = []
        for name in names:
            row = table.get(name)
            if row is None:
                target = aliases.get(name)
                row = None if target is None else table.get(target)
            if row is None:
                rows = []
                break
            rows.append(row)
        if rows:
            return numpy.stack(rows).reshape(1, len(names), -1).astype("float32")
    return None


def encode_vocabulary(model, names: list[str], encoder_directory: Path | None):
    """用本机 CLIP 编码类别名。显式接管下载目录，只认已经下载好的编码器，绝不联网。"""
    import numpy
    encoder = (encoder_directory or Path()) / CLIP_ENCODER_FILE
    if not encoder.is_file():
        raise InferenceError("vocabulary_encoder_missing",
                             f"类别名不在内置词表里，需要 CLIP 文本编码器；请在模型库中下载「CLIP 文本编码器 ViT-B/32」后重试")
    try:
        import clip
    except ImportError:
        raise InferenceError("vocabulary_encoder_missing", "当前 Python 缺少 CLIP 依赖，请重新执行一键准备本地推理环境") from None
    original = clip.load

    def load_local(name, device="cpu", jit=False, download_root=None):
        # ultralytics 默认会按自己的缓存目录取权重；这里强制指向本机已下载的那一份。
        return original(name, device=device, jit=jit, download_root=str(encoder_directory))

    clip.load = load_local
    try:
        with contextlib.redirect_stdout(sys.stderr):
            model.set_classes(names)
            features = model.model.txt_feats.detach().cpu().numpy()
    except InferenceError:
        raise
    except Exception as error:
        raise InferenceError("vocabulary_encoder_missing", f"文本编码器无法加载：{error}") from None
    finally:
        clip.load = original
    return numpy.ascontiguousarray(features, dtype="float32")


def apply_vocabulary(model, names: list[str], embeddings) -> None:
    """把已解析好的文本向量写回模型，等价于 set_classes 但不再碰 CLIP。"""
    import numpy
    import torch
    with contextlib.redirect_stdout(sys.stderr):
        world = model.model
        device = next(world.model.parameters()).device
        world.txt_feats = torch.from_numpy(numpy.ascontiguousarray(embeddings, dtype="float32")).to(device)
        world.model[-1].nc = len(names)
        # 外层 YOLOWorld.names 是只读属性（转发到内层），只写内层 WorldModel 的类别表。
        world.names = {index: name for index, name in enumerate(names)}


def save_vocabulary(directory: Path, key: str, names: list[str], embeddings) -> None:
    import numpy
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{key}.npz"
    temporary = path.with_suffix(".part")
    # 传文件对象而不是路径：numpy 会给「不以 .npz 结尾的路径」自动补扩展名，临时文件就改名不成功了。
    # 先写临时文件再改名：半份缓存在下次读取时会被判定为未命中，但绝不冒充完整。
    with open(temporary, "wb") as handle:
        numpy.savez_compressed(handle, names=numpy.asarray(names), embeddings=numpy.ascontiguousarray(embeddings, dtype="float32"))
    temporary.replace(path)


def result_number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise InferenceError("result_invalid", f"模型返回了无效的{label}")
    return float(value)


def segment_topology(raw_mask, original_shape) -> dict:
    import cv2
    import numpy as np

    mask = raw_mask.cpu().numpy() if hasattr(raw_mask, "cpu") else np.asarray(raw_mask)
    if mask.ndim != 2 or not all(0 < edge <= 20000 for edge in mask.shape) or mask.size > 40000000:
        raise InferenceError("result_invalid", "分割掩码尺寸无效或超过处理上限")
    if not np.isfinite(mask).all() or not np.isin(mask, [0, 1]).all():
        raise InferenceError("result_invalid", "分割掩码必须是有限的二值结果")
    height, width = original_shape
    if any(isinstance(edge, bool) or not isinstance(edge, Real) or not math.isfinite(edge) or
           edge != int(edge) or not 0 < edge <= 20000 for edge in (height, width)):
        raise InferenceError("result_invalid", "分割基准图尺寸无效")
    mask_height, mask_width = mask.shape
    gain = min(mask_height / height, mask_width / width)
    pad_x, pad_y = (mask_width - width * gain) / 2, (mask_height - height * gain) / 2
    # masks.xy 只取外轮廓并连接多个区域；保留层级，避免孔洞被填满或小区域消失。
    contours, hierarchy = cv2.findContours(np.ascontiguousarray(mask, dtype=np.uint8), cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if len(contours) > 4096 or sum(len(contour) for contour in contours) > 65536:
        raise InferenceError("result_too_complex", "分割轮廓超过保留上限，请降低输入尺寸后重新运行")
    rings, outer_count, hole_count, degenerate, outside = [], 0, 0, False, False
    for index, contour in enumerate(contours):
        parent, depth = int(hierarchy[0][index][3]), 0
        ancestor = parent
        while ancestor >= 0:
            depth += 1
            ancestor = int(hierarchy[0][ancestor][3])
        hole = depth % 2 == 1
        hole_count += int(hole)
        outer_count += int(not hole)
        points = [{"x": (float(x) - pad_x) / gain, "y": (float(y) - pad_y) / gain}
                  for x, y in contour.reshape(-1, 2)]
        degenerate |= len(points) < 3 or cv2.contourArea(contour) <= 0
        outside |= any(not 0 <= point["x"] <= width or not 0 <= point["y"] <= height for point in points)
        rings.append({"ringId": index, "parentRingId": parent if parent >= 0 else None,
                      "depth": depth, "hole": hole, "points": points})
    return {"maskWidth": int(mask_width), "maskHeight": int(mask_height), "coordinateSpace": "baseline_pixels",
            "maskToBaseline": [1 / gain, 0, -pad_x / gain, 0, 1 / gain, -pad_y / gain],
            "rings": rings, "outerCount": outer_count, "holeCount": hole_count,
            "degenerate": bool(degenerate), "outOfBounds": bool(outside),
            "requiresGeometryReview": outer_count != 1 or hole_count > 0 or bool(degenerate) or bool(outside)}


def file_hash(path: Path, expected=None, *, quick=True) -> str:
    """文件指纹。quick=True 走 size+mtime 短路（推理热路径）；载入与授权等显式校验传 quick=False 全量重算。

    改一个字节就会因 mtime 变化被重新全量计算并识破，不会被短路缓存掩盖。
    """
    if expected is not None and (not isinstance(expected, str) or len(expected) != 64 or
                                 any(char not in "0123456789abcdef" for char in expected)):
        raise InferenceError("fingerprint_invalid", "文件指纹格式不正确")
    stat = path.stat()
    key = str(path)
    cached = _HASH_CACHE.get(key)
    if quick and cached is not None and cached[0] == stat.st_size and cached[1] == stat.st_mtime_ns:
        value = cached[2]
    else:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        value = digest.hexdigest()
        _HASH_CACHE[key] = (stat.st_size, stat.st_mtime_ns, value)
    if expected is not None and value != expected:
        raise InferenceError("input_changed", "本次固定的模型或图片内容已变化")
    return value


def tracking_identifier(value, label):
    if not isinstance(value, str) or not value or len(value) > 160:
        raise InferenceError("tracking_input_invalid", f"{label}无效")
    return value


def tracking_fingerprint(value, label):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise InferenceError("fingerprint_invalid", f"{label}应为完整 SHA-256")
    return value


# 指纹短路缓存：key=文件路径，值=(size, mtime_ns, sha256)。只存少量热点文件（模型/当前批次图片）。
_HASH_CACHE: dict[str, tuple[int, int, str]] = {}


def tracking_integer(value):
    # 不接受浮点时间，也不让超长十进制输入触发无界大整数运算。
    if not isinstance(value, str) or not 1 <= len(value) <= 80:
        raise InferenceError("tracking_time_invalid", "时间整数必须使用不超过 80 字符的十进制字符串")
    digits = value[1:] if value.startswith("-") else value
    if not digits or any(c not in "0123456789" for c in digits):
        raise InferenceError("tracking_time_invalid", "时间整数格式无效")
    return int(value)


def tracking_fraction(value):
    if not isinstance(value, dict) or set(value) != {"numerator", "denominator"}:
        raise InferenceError("tracking_time_invalid", "时间基准需要精确分子与分母")
    numerator, denominator = tracking_integer(value["numerator"]), tracking_integer(value["denominator"])
    if numerator <= 0 or denominator <= 0:
        raise InferenceError("tracking_time_invalid", "时间基准的分子和分母必须为正数")
    return Fraction(numerator, denominator)


def tracking_request(payload):
    allowed = {"sequenceId", "sourceVideoId", "sourceVideoHash", "expectedModelHash", "templateHash",
               "classMap", "parameters", "cadence", "frames"}
    if set(payload) - allowed:
        raise InferenceError("parameter_invalid", "跟踪请求包含未支持的参数；跟踪器配置由版本固定")
    for key in ("sequenceId", "sourceVideoId"):
        tracking_identifier(payload.get(key), key)
    for key in ("sourceVideoHash", "expectedModelHash", "templateHash"):
        tracking_fingerprint(payload.get(key), key)
    mapping = payload.get("classMap")
    if not isinstance(mapping, dict) or not mapping:
        raise InferenceError("class_map_required", "请配置模型类别映射")
    if any(not isinstance(key, str) or not key.isascii() or not key.isdecimal() or
           (value is not None and (not isinstance(value, str) or not value or len(value) > 160))
           for key, value in mapping.items()):
        raise InferenceError("class_map_invalid", "类别映射格式不正确")
    parameters = payload.get("parameters", {})
    if not isinstance(parameters, dict) or set(parameters) - {"confidence", "iou", "imageSize", "maxDetections"}:
        raise InferenceError("parameter_invalid", "跟踪推理参数无效")
    parameters = {"confidence": 0.1, "iou": 0.7, "imageSize": 640, "maxDetections": 100, **parameters}
    number(parameters["confidence"], "检测阈值", 0, 1)
    number(parameters["iou"], "重叠阈值", 0, 1)
    for key, low, high in (("imageSize", 32, 4096), ("maxDetections", 1, 100)):
        value = number(parameters[key], key, low, high)
        if value != int(value):
            raise InferenceError("parameter_invalid", "输入尺寸和目标数量必须是整数")
    cadence = tracking_fraction(payload.get("cadence"))
    if cadence > Fraction(1, 5):
        raise InferenceError("tracking_cadence_unsupported", "自动跟踪只支持间隔不超过 1/5 秒的密集帧，请改用关键帧插值")
    frames = payload.get("frames")
    if not isinstance(frames, list) or not 2 <= len(frames) <= 120:
        raise InferenceError("tracking_limit_exceeded", "每次跟踪需要 2～120 帧")
    seen, times, dimensions = set(), [], None
    allowed_frame = {"inputId", "assetId", "sourceVideoId", "imagePath", "expectedInputHash", "width", "height",
                     "pts", "timeBase", "sceneId", "boundaryBefore", "boundaryAfter"}
    for frame in frames:
        if not isinstance(frame, dict) or set(frame) - allowed_frame:
            raise InferenceError("tracking_input_invalid", "视频帧结构无效")
        input_id = tracking_identifier(frame.get("inputId"), "输入标识")
        tracking_identifier(frame.get("assetId"), "素材标识")
        if input_id in seen or frame.get("sourceVideoId") != payload["sourceVideoId"]:
            raise InferenceError("tracking_input_invalid", "输入标识不能重复，且全部帧必须属于同一来源视频")
        seen.add(input_id)
        tracking_fingerprint(frame.get("expectedInputHash"), "基准图指纹")
        shape = tuple(frame.get(key) for key in ("width", "height"))
        if any(isinstance(edge, bool) or not isinstance(edge, int) or not 1 <= edge <= 20000 for edge in shape) or shape[0] * shape[1] > 40000000:
            raise InferenceError("tracking_input_invalid", "视频基准图尺寸无效或超过处理上限")
        if dimensions is not None and dimensions != shape:
            raise InferenceError("tracking_input_invalid", "同一跟踪序列的基准图尺寸必须一致")
        dimensions = shape
        path = local_file(frame.get("imagePath"), {".png"})
        with path.open("rb") as stream:
            header = stream.read(24)
        if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR" or (
            int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")) != shape:
            raise InferenceError("tracking_input_invalid", "跟踪只接受尺寸匹配的已导入 PNG 基准图")
        if frame.get("sceneId") is not None:
            tracking_identifier(frame["sceneId"], "场景标识")
        if frame.get("boundaryBefore") not in (None, "scene", "enter", "unlocatable") or frame.get("boundaryAfter") not in (None, "exit", "unlocatable"):
            raise InferenceError("tracking_input_invalid", "视频边界类型无效")
        stamp = tracking_integer(frame.get("pts")) * tracking_fraction(frame.get("timeBase"))
        if times and stamp - times[-1] != cadence:
            raise InferenceError("tracking_cadence_unsupported", "帧时间必须严格递增且实际间隔一致；不能按帧编号代替 PTS")
        times.append(stamp)
    if times[-1] - times[0] > 10:
        raise InferenceError("tracking_limit_exceeded", "单次跟踪时间跨度不能超过 10 秒")
    return parameters, times


def tracking_backend():
    # 普通 predict 无需 lap；显式探测先于 tracker 导入，库不得自行安装依赖。
    try:
        import lap
        if not callable(getattr(lap, "lapjv", None)):
            raise ImportError("lapjv missing")
    except (ImportError, OSError):
        raise InferenceError("tracking_dependency_missing", "当前 Python 缺少可用的 lap；请在所选推理环境安装 lap 后重试，普通检测仍可使用") from None
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        import cv2
        import ultralytics
        from ultralytics.trackers.byte_tracker import BYTETracker, STrack

    class IndexedDetections:
        def __init__(self, boxes, indices=None):
            self.boxes = boxes
            self.indices = np.arange(len(boxes)) if indices is None else indices

        def __len__(self):
            return len(self.boxes)

        def __getitem__(self, selection):
            return IndexedDetections(self.boxes[selection], self.indices[selection])

        @property
        def xywh(self):
            return self.boxes.xywh

        @property
        def conf(self):
            return self.boxes.conf

        @property
        def cls(self):
            return self.boxes.cls

    class IndexedByteTracker(BYTETracker):
        def init_track(self, detections, img=None):
            if not len(detections):
                return []
            # 8.3 系列在高低分子集内重新编号；原行号贯穿筛选，禁止错配目标。
            indexed = np.column_stack([detections.xywh, detections.indices])
            return [STrack(box, score, category) for box, score, category in zip(indexed, detections.conf, detections.cls)]

    versions = {"python": sys.version.split()[0], "ultralytics": ultralytics.__version__,
                "torch": torch.__version__, "numpy": np.__version__, "opencv": cv2.__version__,
                "lap": getattr(lap, "__version__", None)}
    return lambda: IndexedByteTracker(SimpleNamespace(**TRACKING_CONFIG)), IndexedDetections, versions


def tracking_issue(code, message, severity="warning", **details):
    return {"code": code, "severity": severity, "message": message, **details}


def tracking_box_valid(box, width, height):
    return box["width"] > 0 and box["height"] > 0 and box["x"] >= 0 and box["y"] >= 0 and (
        box["x"] + box["width"] <= width and box["y"] + box["height"] <= height)


def tracking_box_iou(a, b):
    overlap = max(0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])) * max(
        0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    union = a["width"] * a["height"] + b["width"] * b["height"] - overlap
    return overlap / union if union > 0 else 0


def watch_parent() -> None:
    raw = os.environ.get("AUTOLABEL_PARENT_PID")
    if raw is None or os.name != "nt":
        return
    if not raw.isdecimal() or int(raw) <= 0 or int(raw) == os.getpid():
        raise RuntimeError("invalid parent process")
    import ctypes
    from ctypes import wintypes
    import threading

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
        # 使用已打开的父进程句柄，Java 强退时不等待阻塞推理读到 stdin EOF。
        status = kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
        kernel.CloseHandle(parent)
        os._exit(0 if status == 0 else 1)

    threading.Thread(target=wait, daemon=True, name="parent-lifetime").start()


class Worker:
    def __init__(self):
        self.model = None
        self.model_hash = None
        self.model_path = None
        self.task = None
        self.device = "cpu"

    def probe(self) -> dict:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                import torch
                import ultralytics
                import numpy
                import cv2
                try:
                    import onnxruntime
                    onnx_version = onnxruntime.__version__
                except ImportError:
                    onnx_version = None
            cuda = torch.cuda.is_available()
            return {"available": True, "pythonVersion": sys.version.split()[0], "ultralyticsVersion": ultralytics.__version__,
                    "torchVersion": torch.__version__, "onnxruntimeVersion": onnx_version,
                    "numpyVersion": numpy.__version__, "opencvVersion": cv2.__version__, "cudaAvailable": cuda,
                    "devices": [{"id": "cpu", "name": "CPU"}] +
                    [{"id": str(index), "name": torch.cuda.get_device_name(index)} for index in range(torch.cuda.device_count() if cuda else 0)]}
        except ImportError:
            return {"available": False, "code": "inference_environment_missing", "message": "当前 Python 缺少兼容的 Ultralytics 或 PyTorch"}

    def set_vocabulary(self, names: list[str]) -> str:
        """按「内置词表 → 缓存 → CLIP」解析本次类别名的文本向量，并把它写回模型。

        返回来源（builtin / cache / encoded）供调用方与核对流程使用；三级都不会联网。
        中文名一律先按别名表翻成英文规范名再取向量：CLIP 只认英文，直接编码中文会得到没有意义的向量
        （实测「人」一个目标都查不到，「person」能查到 5 个）。
        内置词表最先且不写缓存：命中内置必须稳定回报 builtin，不受历次运行的缓存残留影响；
        缓存只留昂贵的 CLIP 编码结果（cache 来源即「编码器产物」，跨运行可复现）。
        """
        hit = self.resolve_builtin(names)
        if hit is not None:
            apply_vocabulary(self.model, hit[0], hit[1])
            return "builtin"
        cache = environment_directory(VOCABULARY_CACHE_ENV)
        key = vocabulary_key(names)
        if cache is not None:
            cached = read_vocabulary(cache / f"{key}.npz")
            if cached is not None and cached[0] == names:
                apply_vocabulary(self.model, names, cached[1])
                return "cache"
        resolved, source = self.resolve_vocabulary(names)
        apply_vocabulary(self.model, resolved, source[1])
        if cache is not None:
            try:
                save_vocabulary(cache, key, names, source[1])
            except OSError:
                pass  # 缓存写不进去不影响本次推理结果。
        return source[0]

    def resolve_builtin(self, names: list[str]):
        """内置词表（含别名表翻译）命中即返回（应用名, 向量）；没有命中返回 None，交给缓存与编码器。"""
        builtin = builtin_vocabulary(names)
        if builtin is not None:
            return names, builtin
        translated = [ALIAS_TABLE.get(name, name) for name in names]
        if translated != names:
            builtin = builtin_vocabulary(translated)
            if builtin is not None:
                return translated, builtin
        return None

    def resolve_vocabulary(self, names: list[str]):
        """先查内置词表，再按别名表翻成英文查一次；仍未命中就只剩 CLIP。

        「含中文且别名表也翻不出来」的名字必须明确拒绝：以前这里会静默编码，返回近乎空的框，
        用户只会以为「模型看不见」。
        """
        builtin = builtin_vocabulary(names)
        if builtin is not None:
            return names, ("builtin", builtin)
        translated = [ALIAS_TABLE.get(name, name) for name in names]
        if translated != names:
            builtin = builtin_vocabulary(translated)
            if builtin is not None:
                return translated, ("builtin", builtin)
        chinese = [name for name in translated if any("\u4e00" <= char <= "\u9fff" for char in name)]
        if chinese:
            raise InferenceError(
                "vocabulary_term_needs_english",
                "这些类别名不在内置词表里，而 CLIP 只认英文：" + "、".join(chinese[:10])
                + "。请填英文名（例如「手办」→ figurine、「公仔」→ plush toy、「消防车」→ fire truck），"
                + "或换成内置词表里已有的名字；下载文本编码器也不会让中文名生效。")
        return translated, ("encoded", encode_vocabulary(self.model, translated, environment_directory(TEXT_ENCODER_ENV)))

    def load(self, payload: dict) -> dict:
        # 加载失败后不沿用上一模型，防止下一条请求误用旧任务或旧权重。
        self.model, self.model_hash, self.model_path, self.task, self.open_vocabulary = None, None, None, None, False
        path = local_file(payload.get("modelPath"), {".pt", ".onnx"})
        model_hash = file_hash(path, payload.get("expectedModelHash"), quick=False)
        task = payload.get("taskType")
        if task not in TASKS:
            raise InferenceError("task_invalid", "请选择支持的标注任务类型")
        device = str(payload.get("device", "cpu"))
        if device != "cpu" and not device.isdecimal():
            raise InferenceError("device_invalid", "设备应为 cpu 或单个 GPU 编号")
        # 开放词汇只对 YOLO-World 这类权重成立：ONNX 导出已把类别写死，非检测任务没有文本类别一说。
        open_vocabulary = payload.get("openVocabulary", False)
        if not isinstance(open_vocabulary, bool):
            raise InferenceError("parameter_invalid", "openVocabulary 必须为布尔值")
        if open_vocabulary and (path.suffix.lower() != ".pt" or task != "detect"):
            raise InferenceError("open_vocabulary_unsupported", "开放词汇只支持检测任务的 .pt 权重")
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            from ultralytics import YOLO, YOLOWorld
            if device != "cpu" and (not torch.cuda.is_available() or int(device) >= torch.cuda.device_count()):
                raise InferenceError("device_unavailable", "所选 GPU 不可用，可切换到 CPU")
            model = YOLOWorld(str(path)) if open_vocabulary else YOLO(str(path), task=task)
        if model.task != task:
            raise InferenceError("model_task_mismatch", "模型实际任务类型与项目不一致")
        with contextlib.redirect_stdout(sys.stderr):
            if path.suffix.lower() == ".onnx":
                # 导出模型的 model.task 只是构造参数；从实际会话核对任务，且加载时固定设备。
                predictor = model._smart_load("predictor")(
                    overrides={**model.overrides, "device": device, "mode": "predict", "save": False, "verbose": False},
                    _callbacks=model.callbacks)
                predictor.setup_model(model=model.model, verbose=False)
                backend = predictor.model
                session = getattr(backend, "session", None)
                metadata = session.get_modelmeta().custom_metadata_map if session is not None else {}
                actual_task = metadata.get("task")
                if actual_task not in TASKS:
                    raise InferenceError("model_task_unverified", "ONNX 模型缺少可核对的任务元数据，请重新导出带任务信息的模型")
                if actual_task != task:
                    raise InferenceError("model_task_mismatch", "模型实际任务类型与项目不一致")
                if device != "cpu" and "CUDAExecutionProvider" not in session.get_providers():
                    raise InferenceError("device_unavailable", "ONNX 后端未提供所选 GPU；请明确选择 CPU 后重新加载")
                model.predictor = predictor
                names = backend.names
            else:
                names = model.names
        file_hash(path, model_hash, quick=False)
        self.model, self.model_hash, self.model_path, self.task, self.device, self.open_vocabulary = model, model_hash, path, task, device, open_vocabulary
        result = {"loaded": True, "taskType": task, "device": device, "modelHash": self.model_hash,
                  "requestedDevice": device, "observedBackend": self.observed_backend(),
                  "classes": [{"id": str(key), "name": value} for key, value in names.items()]}
        if open_vocabulary:
            result["openVocabulary"] = True
        return result

    def observed_backend(self):
        backend = getattr(getattr(self.model, "predictor", None), "model", None)
        if backend is None:
            return None
        session = getattr(backend, "session", None)
        if getattr(backend, "onnx", False) and session is not None:
            return {"kind": "onnxruntime", "device": None, "providers": list(session.get_providers())}
        model = getattr(backend, "model", None)
        if getattr(backend, "pt", False) and model is not None:
            weight = next(model.parameters(), None)
            if weight is not None:
                return {"kind": "pytorch", "device": str(weight.device), "providers": None}
        return None

    def predict(self, payload: dict, request_id: str, *, _capture=None, _model_verified=False) -> dict:
        if self.model is None:
            raise InferenceError("model_required", "请先加载本地模型")
        path = local_file(payload.get("imagePath"), {".png", ".jpg", ".jpeg"})
        input_hash = file_hash(path, payload.get("expectedInputHash"))
        if self.model_path is not None and not _model_verified:
            file_hash(self.model_path, self.model_hash)
        asset_id = payload.get("assetId")
        if not isinstance(asset_id, str) or not asset_id or len(asset_id) > 160:
            raise InferenceError("asset_invalid", "素材标识无效")
        mapping = payload.get("classMap")
        if not isinstance(mapping, dict) or not mapping:
            raise InferenceError("class_map_required", "请配置模型类别到项目类别的映射；忽略类别需明确设为 null")
        if any(not str(key).isdecimal() or (value is not None and (not isinstance(value, str) or not value)) for key, value in mapping.items()):
            raise InferenceError("class_map_invalid", "类别映射格式不正确")
        confidence = number(payload.get("confidence", 0.25), "检测阈值", 0, 1)
        iou = number(payload.get("iou", 0.7), "重叠阈值", 0, 1)
        size = number(payload.get("imageSize", 640), "输入尺寸", 32, 4096)
        max_det = number(payload.get("maxDetections", 300), "最多目标数", 1, 10000)
        if int(size) != size or int(max_det) != max_det:
            raise InferenceError("parameter_invalid", "输入尺寸和最多目标数必须是整数")
        keypoint_names = payload.get("keypointNames", [])
        if self.task == "pose" and (not isinstance(keypoint_names, list) or not keypoint_names or
                                   not all(isinstance(name, str) and name for name in keypoint_names)):
            raise InferenceError("keypoints_required", "关键点任务需要提供项目点名和顺序")
        # 开放词汇：类别名由本次请求给出，模型输出下标即 textClasses 的下标，classMap 语义不变。
        requested = payload.get("textClasses")
        if self.open_vocabulary and requested is None:
            raise InferenceError("vocabulary_required", "开放词汇模型必须在本次请求中给出要识别的类别名")
        if not self.open_vocabulary and requested is not None:
            raise InferenceError("vocabulary_unsupported", "该模型自带固定类别表，不能临时改类别名")
        vocabulary_source = None
        if requested is not None:
            vocabulary_source = self.set_vocabulary(text_classes(requested))
        emit({"type": "event", "id": request_id, "assetId": asset_id, "stage": "local_inference"})
        started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            results = self.model.predict(source=str(path), device=self.device, imgsz=int(size), conf=confidence,
                                         iou=iou, max_det=int(max_det), verbose=False, save=False, stream=False)
        if len(results) != 1:
            raise InferenceError("result_invalid", "单张输入必须返回且仅返回一份推理结果")
        result = results[0]
        try:
            height, width = result.orig_shape
        except (AttributeError, TypeError, ValueError):
            raise InferenceError("result_invalid", "模型实际图片尺寸必须包含高度和宽度") from None
        for edge in (height, width):
            result_number(edge, "实际图片尺寸")
            if edge <= 0 or edge != int(edge):
                raise InferenceError("result_invalid", "模型实际图片尺寸必须为有限正整数")
        file_hash(path, input_hash)
        if self.model_path is not None and not _model_verified:
            file_hash(self.model_path, self.model_hash)
        observed = self.observed_backend()
        if self.device != "cpu" and observed is not None and (
            (observed["kind"] == "pytorch" and not observed["device"].startswith("cuda:")) or
            (observed["kind"] == "onnxruntime" and "CUDAExecutionProvider" not in observed["providers"])
        ):
            raise InferenceError("device_unavailable", "推理后端未使用所选 GPU；请明确选择 CPU 后重新运行")
        elapsed = round((time.perf_counter() - started) * 1000, 2)
        annotations = []
        geometry_issues, geometry_diagnostics, retained_points = [], [], 0
        excluded = 0

        def category(raw_class):
            result_number(raw_class, "类别编号")
            if raw_class < 0 or int(raw_class) != raw_class:
                raise InferenceError("result_invalid", "模型类别编号必须为非负整数")
            source_id = str(int(raw_class))
            if source_id not in mapping:
                raise InferenceError("class_map_incomplete", f"模型返回了尚未映射的类别编号 {source_id}")
            return mapping[source_id]

        def checked_score(score):
            # 显式忽略类别也不能把损坏的原始分数当作正常排除。
            result_number(score, "置信度")
            if not 0 <= score <= 1:
                raise InferenceError("result_invalid", "模型置信度必须在 0～1 范围内")
            return float(score)

        def base(class_id, score):
            return {"id": str(uuid.uuid4()), "classId": class_id, "type": self.task, "confidence": score}

        if self.task == "classify":
            if result.probs is None:
                raise InferenceError("result_invalid", "模型没有返回分类结果")
            score = checked_score(result.probs.top1conf.item())
            class_id = category(result.probs.top1)
            if class_id is None:
                raise InferenceError("classification_excluded", "最高分类结果被排除，不能生成有效分类标签")
            annotations.append(base(class_id, score))
        elif self.task == "obb":
            if result.obb is None:
                raise InferenceError("result_invalid", "模型没有返回旋转框结构")
            corners = result.obb.xyxyxyxy.cpu().tolist()
            classes, scores = result.obb.cls.cpu().tolist(), result.obb.conf.cpu().tolist()
            aligned_rows(corners, classes, scores)
            if len(corners) > max_det:
                raise InferenceError("result_invalid", "模型结果超过已设置的目标数量上限")
            for points, cls, score in zip(corners, classes, scores):
                if len(points) != 4 or any(len(point) != 2 for point in points):
                    raise InferenceError("result_invalid", "旋转框必须返回四个二维角点")
                for point in points:
                    for value in point:
                        result_number(value, "旋转框坐标")
                score = checked_score(score)
                class_id = category(cls)
                if class_id is None:
                    excluded += 1
                    continue
                annotation = base(class_id, score)
                annotation["points"] = [{"x": float(x), "y": float(y)} for x, y in points]
                annotations.append(annotation)
        else:
            if result.boxes is None:
                raise InferenceError("result_invalid", "模型没有返回对象框结构")
            boxes = result.boxes.xyxy.cpu().tolist()
            classes, scores = result.boxes.cls.cpu().tolist(), result.boxes.conf.cpu().tolist()
            aligned_rows(boxes, classes, scores)
            if len(boxes) > max_det:
                raise InferenceError("result_invalid", "模型结果超过已设置的目标数量上限")
            if self.task == "segment" and ((result.masks is None and boxes) or
                                          (result.masks is not None and len(result.masks.xy) != len(boxes))):
                raise InferenceError("result_invalid", "分割轮廓与对象数量不一致")
            if self.task == "segment" and result.masks is not None and (
                    getattr(result.masks, "data", None) is None or len(result.masks.data) != len(boxes)):
                raise InferenceError("result_invalid", "缺少与对象对应的原始分割掩码，不能确认轮廓完整性")
            if self.task == "pose" and ((result.keypoints is None and boxes) or
                                       (result.keypoints is not None and (len(result.keypoints.xy) != len(boxes) or
                                        (result.keypoints.conf is not None and len(result.keypoints.conf) != len(boxes))))):
                raise InferenceError("result_invalid", "关键点与对象数量不一致")
            for index, (box, cls, score) in enumerate(zip(boxes, classes, scores)):
                if len(box) != 4:
                    raise InferenceError("result_invalid", "对象框必须返回四个坐标")
                for value in box:
                    result_number(value, "对象框坐标")
                score = checked_score(score)
                class_id = category(cls)
                if class_id is None:
                    excluded += 1
                    continue
                annotation = base(class_id, score)
                x1, y1, x2, y2 = box
                annotation["bbox"] = {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}
                if self.task == "segment":
                    annotation["points"] = [{"x": float(result_number(x, "轮廓坐标")), "y": float(result_number(y, "轮廓坐标"))}
                                            for x, y in result.masks.xy[index]]
                    topology = segment_topology(result.masks.data[index], result.orig_shape)
                    retained_points += len(annotation["points"]) + sum(len(ring["points"]) for ring in topology["rings"])
                    if retained_points > 65536:
                        raise InferenceError("result_too_complex", "分割结果超过轮廓保留上限，请降低输入尺寸后重新运行")
                    if topology["requiresGeometryReview"]:
                        geometry_diagnostics.append({"annotationId": annotation["id"], **topology})
                        geometry_issues.append({"annotationId": annotation["id"], "code": "segment_topology_unsupported",
                                                "severity": "error", "field": "points",
                                                "message": "分割掩码含孔洞、多个区域或退化边界；全部轮廓已保留，请复核后采用"})
                if self.task == "pose":
                    points = result.keypoints.xy[index].cpu().tolist()
                    if len(points) != len(keypoint_names):
                        raise InferenceError("keypoint_template_mismatch", "模型关键点数量与项目模板不一致")
                    scores = result.keypoints.conf[index].cpu().tolist() if result.keypoints.conf is not None else [None] * len(points)
                    aligned_rows(points, scores)
                    annotation["keypoints"] = []
                    for point_index, ((x, y), point_score) in enumerate(zip(points, scores)):
                        result_number(x, "关键点坐标"); result_number(y, "关键点坐标")
                        if point_score is not None:
                            result_number(point_score, "关键点置信度")
                            if not 0 <= point_score <= 1:
                                raise InferenceError("result_invalid", "关键点置信度必须在 0～1 范围内")
                        # 低于模型阈值的点保留为不可定位，不能用默认位置当作真值。
                        visible = (point_score is None or point_score >= confidence) and (x != 0 or y != 0)
                        annotation["keypoints"].append({"name": keypoint_names[point_index], "x": float(x) if visible else 0,
                                                       "y": float(y) if visible else 0, "visibility": 2 if visible else 0})
                annotations.append(annotation)
        if self.task == "obb":
            for annotation in annotations:
                points = annotation["points"]
                if not all(math.isfinite(point[axis]) for point in points for axis in ("x", "y")):
                    raise InferenceError("result_invalid", "模型返回了非有限旋转框坐标")
                if any(not 0 <= point["x"] <= width or not 0 <= point["y"] <= height for point in points):
                    # 逐点裁剪会破坏旋转矩形；保留原始候选，交给复核处理后才能导出。
                    geometry_issues.append({"annotationId": annotation["id"], "code": "geometry_out_of_bounds",
                                            "severity": "error", "field": "points",
                                            "message": "旋转框部分角点超出图片范围，请检查并调整后再采用"})
        if _capture is not None:
            # 仅给同一请求中的关联步骤保留这一帧；公开 predict 的协议与转换保持不变。
            _capture.append(result)
        return {"assetId": asset_id, "annotations": annotations, "width": int(width), "height": int(height),
                "source": "local_yolo", "taskType": self.task, "modelHash": self.model_hash, "device": self.device,
                "inputHash": input_hash, "requestedDevice": self.device, "observedBackend": observed,
                "elapsedMs": elapsed, "excludedByClassMap": excluded,
                "geometryIssues": geometry_issues, "geometryDiagnostics": geometry_diagnostics,
                "requiresGeometryReview": bool(geometry_issues),
                "vocabularySource": vocabulary_source,
                "vocabularyHash": None if vocabulary_source is None else vocabulary_key(text_classes(requested))}

    def track_sequence(self, payload: dict, request_id: str) -> dict:
        if self.model is None:
            raise InferenceError("model_required", "请先加载本地模型")
        if self.task != "detect" or getattr(self.model, "task", None) != "detect":
            raise InferenceError("tracking_task_unsupported", "自动跟踪首版仅支持 Detect；姿态请使用人工关键帧插值")
        parameters, times = tracking_request(payload)
        if self.model_hash != payload["expectedModelHash"] or self.model_path is None:
            raise InferenceError("input_changed", "已加载的模型与本次固定模型不一致，请重新加载")
        file_hash(self.model_path, self.model_hash)
        factory, indexed_detections, versions = tracking_backend()
        started = time.perf_counter()
        candidate_set = str(uuid.uuid4())
        frames, tracks, top_issues = [], [], []
        tracker, prior_scene, previous_after, epoch = None, None, None, 0
        states, previous_active = {}, {}
        total_objects, associated_objects, unassociated_objects, pair_checks = 0, 0, 0, 0
        pair_budget_reported = False
        mapping = payload["classMap"]
        for frame_index, frame in enumerate(payload["frames"]):
            emit({"type": "event", "id": request_id, "stage": "local_tracking", "inputId": frame["inputId"],
                  "frameIndex": frame_index, "framesTotal": len(payload["frames"])})
            # 进程由 Java 拥有；取消或超时终止进程，绝不发布不完整序列的候选结果。
            capture = []
            prediction = self.predict({"assetId": frame["assetId"], "imagePath": frame["imagePath"],
                                       "expectedInputHash": frame["expectedInputHash"], "classMap": mapping,
                                       **parameters}, request_id, _capture=capture)
            result = capture.pop()
            if (prediction["width"], prediction["height"]) != (frame["width"], frame["height"]):
                raise InferenceError("tracking_input_invalid", "模型实际解码尺寸与固定基准图不一致")
            observed = prediction["observedBackend"]
            if observed is None:
                raise InferenceError("tracking_device_unverified", "不能核对跟踪推理的实际后端，请使用兼容的本地模型环境")
            if observed["kind"] == "pytorch":
                expected_device = "cpu" if self.device == "cpu" else "cuda:" + self.device
                if observed["device"] != expected_device:
                    raise InferenceError("device_unavailable", "跟踪推理未使用明确选择的设备")
            elif observed["kind"] == "onnxruntime":
                providers = observed["providers"]
                if self.device == "cpu" and (not providers or providers[0] != "CPUExecutionProvider"):
                    raise InferenceError("device_unavailable", "跟踪推理未使用明确选择的 CPU 后端")
                if self.device != "cpu":
                    raise InferenceError("tracking_device_unverified", "当前不能核对 ONNX 跟踪的具体 GPU 编号，请明确选择 CPU")
            else:
                raise InferenceError("tracking_device_unverified", "跟踪推理后端尚不能核对")
            raw_classes = result.boxes.cls.cpu().tolist()
            raw_scores = result.boxes.conf.cpu().tolist()
            total_objects += len(raw_classes)
            if total_objects > 10000:
                raise InferenceError("tracking_limit_exceeded", "序列超过 10000 个原始检测，请缩短帧序列后重试")
            if getattr(result.boxes, "is_track", False):
                raise InferenceError("tracking_result_invalid", "预测器带有既存跟踪状态，请重新加载模型后运行")
            issues = []
            scene = frame.get("sceneId")
            unlocatable = "unlocatable" in (frame.get("boundaryBefore"), frame.get("boundaryAfter"))
            reset = tracker is None or scene != prior_scene or frame.get("boundaryBefore") is not None or previous_after is not None
            if reset:
                tracker, states, previous_active = None, {}, {}
                epoch += 1
                if frame_index:
                    issues.append(tracking_issue("tracking_boundary_reset", "已按场景或显式边界重新开始关联", "info"))
            can_associate = scene is not None and not unlocatable
            if scene is None:
                issues.append(tracking_issue("tracking_scene_unchecked", "未提供已确认的场景分段，本帧只保留检测候选，不建立轨迹"))
            if unlocatable:
                issues.append(tracking_issue("tracking_unlocatable_boundary", "当前帧被标记不可定位边界，只保留实际检测，不跨边界关联"))
            if can_associate and tracker is None:
                tracker = factory()
            retained_indices = [index for index, cls in enumerate(raw_classes) if mapping[str(int(cls))] is not None]
            aligned_rows(retained_indices, prediction["annotations"])
            annotations_by_index = dict(zip(retained_indices, prediction["annotations"]))
            usable = []
            for index, annotation in annotations_by_index.items():
                if tracking_box_valid(annotation["bbox"], frame["width"], frame["height"]):
                    usable.append(index)
                else:
                    # 检测原值仍保留；几何错误与关联问题分开，不能把 Kalman 框当修正结果。
                    prediction["geometryIssues"].append(tracking_issue("geometry_invalid_bbox", "对象框退化或超出基准图范围，请修正后采用",
                                                                 "error", annotationId=annotation["id"], field="bbox"))
                    prediction["requiresGeometryReview"] = True
                    issues.append(tracking_issue("tracking_geometry_unusable", "该原始框不适合关联，已保留供几何复核", annotationId=annotation["id"]))
            indexed = indexed_detections(result.boxes.cpu().numpy())
            native_associations = {}
            native_ids = set()
            if can_associate:
                # 每帧只向局部 tracker 提交有效检测；未关联和显式排除的类别互不改变几何。
                indexed = indexed[usable]
                with contextlib.redirect_stdout(sys.stderr):
                    tracked_rows = tracker.update(indexed)
                for row in tracked_rows:
                    if len(row) != 8:
                        raise InferenceError("tracking_result_invalid", "ByteTrack 返回的关联行结构不兼容")
                    values = [result_number(value, "跟踪关联数值") for value in row]
                    native, source_index = values[4], values[7]
                    if native != int(native) or native <= 0 or source_index != int(source_index):
                        raise InferenceError("tracking_result_invalid", "ByteTrack 返回了无效轨迹或检测行号")
                    native, source_index = int(native), int(source_index)
                    if source_index not in usable or source_index in native_associations or native in native_ids or (
                        values[6] != raw_classes[source_index] or abs(values[5] - raw_scores[source_index]) > 1e-6):
                        raise InferenceError("tracking_result_invalid", "ByteTrack 关联与原始检测行不一致，不能生成候选轨迹")
                    native_associations[source_index] = (native, values[:4])
                    native_ids.add(native)
            associations, active = [], {}
            for index, annotation in annotations_by_index.items():
                association = {"annotationId": annotation["id"], "sourceDetectionIndex": index,
                               "logicalTrackId": None, "nativeTrackId": None, "kalmanBBoxDiagnostic": None,
                               "motionDiagnostic": None}
                if index not in native_associations:
                    unassociated_objects += 1
                    if can_associate and index in usable:
                        issues.append(tracking_issue("tracking_detection_unassociated", "真实检测尚未获得关联，原始框已保留",
                                                     annotationId=annotation["id"], sourceDetectionIndex=index))
                else:
                    native, kalman_box = native_associations[index]
                    state = states.get(native)
                    prior = state
                    reason = None
                    if state is not None:
                        if state["sourceClass"] != raw_classes[index] or state["track"]["classId"] != annotation["classId"]:
                            reason = "tracking_class_changed"
                        elif state["lastFrame"] != frame_index - 1:
                            reason = "tracking_reappeared"
                    if state is None or reason is not None:
                        track = {"trackId": str(uuid.uuid5(uuid.UUID(candidate_set), str(len(tracks)))), "source": "local_tracking",
                                 "segmentIndex": len(tracks), "epoch": epoch, "classId": annotation["classId"],
                                 "confirmed": False, "observations": []}
                        tracks.append(track)
                        state = {"track": track, "sourceClass": raw_classes[index]}
                        states[native] = state
                        if reason:
                            issues.append(tracking_issue(reason, "类别变化后已建立新轨迹段" if reason == "tracking_class_changed" else
                                                         "目标缺失后重现，已建立新轨迹段，不跨缺失区间连接",
                                                         annotationId=annotation["id"], nativeTrackId=native,
                                                         previousLogicalTrackId=prior["track"]["trackId"], logicalTrackId=track["trackId"]))
                    elif prior is not None:
                        before, current = prior["bbox"], annotation["bbox"]
                        dt = float(times[frame_index] - times[prior["lastFrame"]])
                        speed = math.hypot(current["x"] + current["width"] / 2 - before["x"] - before["width"] / 2,
                                           current["y"] + current["height"] / 2 - before["y"] - before["height"] / 2) / dt
                        normalized_speed = speed / math.hypot(frame["width"], frame["height"])
                        areas = [box["width"] * box["height"] for box in (before, current)]
                        area_ratio = max(areas) / min(areas)
                        association["motionDiagnostic"] = {"elapsedSeconds": dt, "centerSpeedPixelsPerSecond": speed,
                                                           "centerSpeedDiagonalsPerSecond": normalized_speed, "areaRatio": area_ratio}
                        if normalized_speed > TRACKING_DIAGNOSTICS["centerSpeedDiagonalsPerSecond"]:
                            issues.append(tracking_issue("tracking_fast_motion", "关联目标位移较快，请核对身份；这不是漂移检测结论",
                                                         annotationId=annotation["id"], actual=normalized_speed,
                                                         threshold=TRACKING_DIAGNOSTICS["centerSpeedDiagonalsPerSecond"]))
                        if area_ratio > TRACKING_DIAGNOSTICS["areaRatio"]:
                            issues.append(tracking_issue("tracking_scale_change", "关联目标尺度变化较大，请核对身份",
                                                         annotationId=annotation["id"], actual=area_ratio, threshold=TRACKING_DIAGNOSTICS["areaRatio"]))
                    state.update(lastFrame=frame_index, bbox=annotation["bbox"])
                    observation = {"inputId": frame["inputId"], "annotationId": annotation["id"], "pts": frame["pts"],
                                   "timeBase": frame["timeBase"], "sourceDetectionIndex": index}
                    state["track"]["observations"].append(observation)
                    association.update(logicalTrackId=state["track"]["trackId"], nativeTrackId=native, kalmanBBoxDiagnostic=kalman_box)
                    associated_objects += 1
                    active[native] = state["track"]["trackId"]
                associations.append(association)
            missing = [track_id for native, track_id in previous_active.items() if native not in active]
            if missing:
                issues.append(tracking_issue("tracking_observation_missing", "这些轨迹当前没有真实检测，不输出预测位置或补框", logicalTrackIds=missing))
            overlap_count, overlap_examples = 0, []
            if len(usable) * (len(usable) - 1) // 2 > TRACKING_DIAGNOSTICS["maxOverlapPairChecks"] - pair_checks:
                issues.append(tracking_issue("tracking_ambiguity_not_checked", "本帧重叠歧义检查受计算上限限制，未检查的关联需要复核"))
                if not pair_budget_reported:
                    top_issues.append(tracking_issue("tracking_ambiguity_budget_exceeded", "重叠歧义检查达到计算上限，剩余关联需要复核",
                                                     inputId=frame["inputId"], limit=TRACKING_DIAGNOSTICS["maxOverlapPairChecks"]))
                    pair_budget_reported = True
            for position, left in enumerate(usable):
                for right in usable[position + 1:]:
                    if pair_checks >= TRACKING_DIAGNOSTICS["maxOverlapPairChecks"]:
                        break
                    pair_checks += 1
                    a, b = annotations_by_index[left], annotations_by_index[right]
                    if a["classId"] == b["classId"]:
                        overlap = tracking_box_iou(a["bbox"], b["bbox"])
                        if overlap >= TRACKING_DIAGNOSTICS["overlapIoU"]:
                            overlap_count += 1
                            if len(overlap_examples) < TRACKING_DIAGNOSTICS["maxOverlapExamplesPerFrame"]:
                                overlap_examples.append({"annotationIds": [a["id"], b["id"]], "iou": overlap})
                if pair_checks >= TRACKING_DIAGNOSTICS["maxOverlapPairChecks"]:
                    break
            if overlap_count:
                issues.append(tracking_issue("tracking_identity_ambiguous", "同类检测有明显重叠，身份关联可能存在歧义；全部原始框均保留",
                                             count=overlap_count, examples=overlap_examples, examplesTruncated=overlap_count > len(overlap_examples),
                                             threshold=TRACKING_DIAGNOSTICS["overlapIoU"]))
            frames.append({"inputId": frame["inputId"], "assetId": frame["assetId"], "pts": frame["pts"],
                           "timeBase": frame["timeBase"], "sceneId": scene, "boundaryBefore": frame.get("boundaryBefore"),
                           "boundaryAfter": frame.get("boundaryAfter"), "prediction": prediction, "associations": associations,
                           "trackingIssues": issues, "requiresTrackingReview": any(i["severity"] != "info" for i in issues), "confirmed": False})
            previous_active, prior_scene, previous_after = active, scene, frame.get("boundaryAfter")
            if not can_associate:
                tracker, states, previous_active = None, {}, {}
            del result, indexed
        config = dict(TRACKING_CONFIG)
        config_hash = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        return {"sequenceId": payload["sequenceId"], "candidateSetId": candidate_set, "sourceVideoId": payload["sourceVideoId"],
                "sourceVideoHash": payload["sourceVideoHash"], "templateHash": payload["templateHash"],
                "source": "local_tracking", "taskType": "detect", "modelHash": self.model_hash, "device": self.device,
                "provenance": {"adapterVersion": TRACKING_ADAPTER_VERSION, "workerHash": file_hash(Path(__file__).resolve()),
                               "libraryVersions": versions, "trackerConfig": config, "trackerConfigHash": config_hash,
                               "bufferUnit": "frames", "kalmanStep": "one_per_equal_cadence_frame", "parameters": parameters,
                               "classMap": dict(mapping),
                               "diagnosticThresholds": dict(TRACKING_DIAGNOSTICS), "cadence": payload["cadence"],
                               "sourceVideoIdentity": "caller_frozen_metadata", "coordinateSpace": "baseline_pixels",
                               "geometrySource": "original_detector", "associationScope": "single_request"},
                "frames": frames, "tracks": tracks, "trackingIssues": top_issues,
                "requiresTrackingReview": bool(top_issues) or any(frame["requiresTrackingReview"] for frame in frames),
                "confirmed": False, "statistics": {"frames": len(frames), "rawDetections": total_objects,
                                                     "associatedDetections": associated_objects, "unassociatedDetections": unassociated_objects,
                                                     "excludedByClassMap": sum(f["prediction"]["excludedByClassMap"] for f in frames),
                                                     "tracks": len(tracks), "overlapPairChecks": pair_checks,
                                                     "elapsedMs": round((time.perf_counter() - started) * 1000, 2)}}

    def batch_predict(self, payload: dict, request_id: str) -> dict:
        """单请求多输入：模型指纹整批只核验一次（开始/结束各一次），逐输入推理并按输入顺序带回身份供调用方对齐。

        单项失败以 failed 条目回带，不拖累同批其他输入；事件仍逐输入发出，标识沿用整批请求号。
        """
        items = payload.get("inputs")
        if not isinstance(items, list) or not 1 <= len(items) <= 64:
            raise InferenceError("parameter_invalid", "batch_predict 一次需要 1 至 64 个输入对象")
        if self.model is None:
            raise InferenceError("model_required", "请先加载本地模型")
        if self.model_path is not None:
            file_hash(self.model_path, self.model_hash)
        results = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise InferenceError("parameter_invalid", "批量输入必须是对象")
            entry = dict(item)
            entry.setdefault("assetId", "batch-%d" % index)
            try:
                results.append(self.predict(entry, request_id, _model_verified=True))
            except InferenceError as error:
                results.append({"assetId": entry.get("assetId"), "inputId": entry.get("inputId"),
                                "status": "failed", "errorCode": error.code, "message": str(error)})
        if self.model_path is not None:
            file_hash(self.model_path, self.model_hash)
        return {"results": results, "count": len(results)}

    def dispatch(self, request: dict) -> dict:
        command = request.get("command")
        payload = request.get("payload", {})
        if not isinstance(payload, dict):
            raise InferenceError("parameter_invalid", "参数必须为对象")
        if command == "probe":
            return self.probe()
        if command == "load":
            return self.load(payload)
        if command == "predict":
            return self.predict(payload, request["id"])
        if command == "batch_predict":
            return self.batch_predict(payload, request["id"])
        if command == "track_sequence":
            return self.track_sequence(payload, request["id"])
        raise InferenceError("command_unsupported", "本地推理进程不支持该命令")


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    watch_parent()
    worker = Worker()
    emit({"type": "ready", "protocolVersion": PROTOCOL_VERSION})
    while True:
        line = sys.stdin.readline(1024 * 1024 + 1)
        if not line:
            break
        request_id = None
        try:
            if len(line) > 1024 * 1024:
                raise InferenceError("request_too_large", "请求超过大小限制")
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("id"), str) or len(request["id"]) > 160:
                raise InferenceError("request_invalid", "请求标识无效")
            request_id = request["id"]
            if request.get("command") == "shutdown":
                emit({"type": "response", "id": request_id, "ok": True, "data": {"stopped": True}})
                break
            data = worker.dispatch(request)
            emit({"type": "response", "id": request_id, "ok": True, "data": data})
        except InferenceError as error:
            emit({"type": "response", "id": request_id, "ok": False, "error": {"code": error.code, "message": str(error)}})
        except ImportError:
            emit({"type": "response", "id": request_id, "ok": False, "error": {"code": "inference_environment_missing", "message": "缺少可选推理依赖，请在设置中检查 Python 环境"}})
        except Exception as error:
            # 库异常可能携带本机路径，只暴露稳定分类，不把原始异常串写入协议。
            memory_error = "out of memory" in str(error).lower()
            emit({"type": "response", "id": request_id, "ok": False, "error": {
                "code": "device_memory_insufficient" if memory_error else "inference_failed",
                "message": "显存不足，请降低输入尺寸或改用 CPU" if memory_error else "本地推理失败，请核对模型格式、任务类型与运行环境"}})


if __name__ == "__main__":
    main()
