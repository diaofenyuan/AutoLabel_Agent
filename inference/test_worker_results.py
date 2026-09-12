"""用不依赖模型库的异常结果检查协议边界，防止损坏输出被当作合法空标注。"""
import contextlib
import io
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from worker import InferenceError, Worker, segment_topology


class Tensor:
    def __init__(self, values):
        self.values = values

    def cpu(self):
        return self

    def tolist(self):
        return self.values

    def __len__(self):
        return len(self.values)

    def __getitem__(self, index):
        return Tensor(self.values[index])


def result(boxes=None, classes=None, scores=None):
    return SimpleNamespace(orig_shape=(100, 200), masks=None, keypoints=None, obb=None,
                           boxes=SimpleNamespace(xyxy=Tensor([[10, 10, 40, 40]] if boxes is None else boxes),
                                                 cls=Tensor([0] if classes is None else classes),
                                                 conf=Tensor([0.9] if scores is None else scores)))


class WorkerResultsTest(unittest.TestCase):
    def test_probe_records_versions_and_missing_optional_backend(self):
        modules = {"torch": SimpleNamespace(__version__="torch-fixed", cuda=SimpleNamespace(is_available=lambda: False)),
                   "ultralytics": SimpleNamespace(__version__="ultra-fixed"),
                   "numpy": SimpleNamespace(__version__="numpy-fixed"), "cv2": SimpleNamespace(__version__="cv-fixed")}
        for ort in [SimpleNamespace(__version__="ort-fixed"), None]:
            with self.subTest(ort=ort), patch.dict(sys.modules, {**modules, "onnxruntime": ort}):
                state = Worker().probe()
                self.assertTrue(state["available"])
                self.assertEqual(state["numpyVersion"], "numpy-fixed")
                self.assertEqual(state["opencvVersion"], "cv-fixed")
                self.assertEqual(state["onnxruntimeVersion"], "ort-fixed" if ort else None)

    def predict(self, value, task="detect", **payload):
        worker = Worker()
        worker.task, worker.model_hash = task, "fixture-model"
        worker.model = SimpleNamespace(predict=lambda **_: [value])
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            image = Path(directory) / "基准图.png"
            image.touch()
            return worker.predict({"imagePath": str(image.resolve()), "assetId": "fixture",
                                   "classMap": {"0": "vehicle"}, "keypointNames": ["left", "right"],
                                   **payload}, "request-1")

    def assert_invalid(self, value, task="detect"):
        with self.assertRaises(InferenceError) as caught:
            self.predict(value, task)
        self.assertEqual(caught.exception.code, "result_invalid")

    def test_box_and_obb_mismatch_cannot_become_empty(self):
        for classes, scores in [([], [0.9]), ([0], []), ([0, 0], [0.9])]:
            with self.subTest(classes=classes, scores=scores):
                self.assert_invalid(result(classes=classes, scores=scores))
                value = result()
                value.obb = SimpleNamespace(xyxyxyxy=Tensor([[[10, 10], [40, 10], [40, 40], [10, 40]]]),
                                            cls=Tensor(classes), conf=Tensor(scores))
                self.assert_invalid(value, "obb")

    def test_empty_boxes_cannot_discard_masks_or_keypoints(self):
        value = result([], [], [])
        value.masks = SimpleNamespace(xy=[[[10, 10], [40, 10], [40, 40]]])
        self.assert_invalid(value, "segment")
        value.keypoints = SimpleNamespace(xy=Tensor([[[10, 10], [30, 30]]]), conf=None)
        self.assert_invalid(value, "pose")

    def test_pose_scores_must_match_each_point(self):
        value = result()
        for scores in [[], [[0.9]], [[0.9, float("nan")]]]:
            with self.subTest(scores=scores):
                value.keypoints = SimpleNamespace(xy=Tensor([[[10, 10], [30, 30]]]), conf=Tensor(scores))
                self.assert_invalid(value, "pose")
        value.keypoints = SimpleNamespace(xy=Tensor([[[10, 10], [30, 30]]]), conf=Tensor([[0.9, 0.1]]))
        points = self.predict(value, "pose")["annotations"][0]["keypoints"]
        self.assertEqual(points[0]["visibility"], 2)
        self.assertEqual(points[1], {"name": "right", "x": 0, "y": 0, "visibility": 0})

    def test_invalid_numbers_cannot_change_category_or_visibility(self):
        for category in [0.5, -1, float("nan")]:
            with self.subTest(category=category):
                self.assert_invalid(result(classes=[category]))
        self.assert_invalid(result(scores=[float("nan")]))
        self.assert_invalid(result(boxes=[[float("nan"), 10, 40, 40]]))

    def test_valid_empty_and_reviewable_geometry_remain_distinct(self):
        empty = self.predict(result([], [], []))
        self.assertEqual(empty["annotations"], [])
        self.assertFalse(empty["requiresGeometryReview"])
        self.assertEqual(len(self.predict(result())["annotations"]), 1)
        value = result()
        value.obb = SimpleNamespace(xyxyxyxy=Tensor([[[-5, 10], [40, 10], [40, 40], [-5, 40]]]),
                                    cls=Tensor([0]), conf=Tensor([0.9]))
        mapped = self.predict(value, "obb")
        self.assertTrue(mapped["requiresGeometryReview"])
        self.assertEqual(mapped["annotations"][0]["points"][0]["x"], -5)
        self.assertEqual(mapped["geometryIssues"][0]["annotationId"], mapped["annotations"][0]["id"])

    def test_segment_preserves_holes_and_disconnected_regions(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("分割拓扑专项需要可选推理环境中的 OpenCV 和 NumPy")
        mask = np.zeros((100, 200), dtype=np.uint8)
        mask[10:40, 10:40] = 1
        mask[20:30, 20:30] = 0
        mask[50:60, 80:90] = 1
        value = result()
        # 库的 xy 已丢失孔洞；即使外轮廓本身合法，也必须由原始掩码触发复核。
        value.masks = SimpleNamespace(xy=[[[10, 10], [39, 10], [39, 39], [10, 39]]], data=np.array([mask]))
        mapped = self.predict(value, "segment")
        self.assertTrue(mapped["requiresGeometryReview"])
        diagnostic = mapped["geometryDiagnostics"][0]
        self.assertEqual((diagnostic["outerCount"], diagnostic["holeCount"]), (2, 1))
        self.assertEqual(len(diagnostic["rings"]), 3)
        self.assertEqual(diagnostic["annotationId"], mapped["annotations"][0]["id"])
        hole = next(ring for ring in diagnostic["rings"] if ring["hole"])
        self.assertIsNotNone(hole["parentRingId"])
        self.assertEqual(mapped["geometryIssues"][0]["code"], "segment_topology_unsupported")
        mask[20:30, 20:30], mask[50:60, 80:90] = 1, 0
        value.masks.data = np.array([mask])
        simple = self.predict(value, "segment")
        self.assertFalse(simple["requiresGeometryReview"])
        self.assertEqual(simple["geometryDiagnostics"], [])

    def test_segment_mask_mapping_and_invalid_data(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("分割拓扑专项需要可选推理环境中的 OpenCV 和 NumPy")
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[30:40, 10:20] = 1
        mapped = segment_topology(mask, (100, 200))
        self.assertEqual(mapped["maskToBaseline"], [2, 0, 0, 0, 2, -50])
        points = mapped["rings"][0]["points"]
        self.assertEqual((min(p["x"] for p in points), min(p["y"] for p in points)), (20, 10))
        self.assertFalse(mapped["requiresGeometryReview"])
        mask[0, 0] = 1
        self.assertTrue(segment_topology(mask, (100, 200))["outOfBounds"])
        for invalid in [np.zeros((0, 10)), np.array([[float("nan")]]), np.array([[0.5]])]:
            with self.subTest(shape=invalid.shape), self.assertRaises(InferenceError):
                segment_topology(invalid, (100, 200))
        value = result()
        value.masks = SimpleNamespace(xy=[[[10, 10], [40, 10], [40, 40]]])
        self.assert_invalid(value, "segment")

    def test_input_fingerprint_mismatch_is_not_inferred(self):
        with self.assertRaises(InferenceError) as caught:
            self.predict(result(), expectedInputHash="0" * 64)
        self.assertEqual(caught.exception.code, "input_changed")

    def test_failed_model_fingerprint_clears_previous_model(self):
        worker = Worker()
        worker.model, worker.model_hash, worker.task = object(), "previous", "detect"
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "fixture.pt"
            model.write_bytes(b"fixed model")
            with self.assertRaises(InferenceError) as caught:
                worker.load({"modelPath": str(model.resolve()), "taskType": "detect", "expectedModelHash": "0" * 64})
        self.assertEqual(caught.exception.code, "input_changed")
        self.assertIsNone(worker.model)
        self.assertIsNone(worker.model_hash)

    def test_onnx_task_comes_from_session_and_load_keeps_device(self):
        for actual_task, device, providers, error_code in [
            ("detect", "cpu", ["CPUExecutionProvider"], None),
            ("pose", "cpu", ["CPUExecutionProvider"], "model_task_mismatch"),
            (None, "cpu", ["CPUExecutionProvider"], "model_task_unverified"),
            ("detect", "0", ["CPUExecutionProvider"], "device_unavailable"),
        ]:
            with self.subTest(task=actual_task, device=device), tempfile.TemporaryDirectory() as directory:
                model_path = Path(directory) / "fixture.onnx"
                model_path.write_bytes(b"isolated metadata fixture")
                selected = {}
                session = SimpleNamespace(get_modelmeta=lambda: SimpleNamespace(custom_metadata_map={"task": actual_task}),
                                          get_providers=lambda: providers)
                backend = SimpleNamespace(onnx=True, session=session, names={0: "vehicle"})
                predictor = SimpleNamespace(model=backend, setup_model=lambda **_: None)

                def factory(**kwargs):
                    selected.update(kwargs["overrides"])
                    return predictor

                model = SimpleNamespace(task="detect", model=str(model_path), overrides={"device": "wrong-default"},
                                        callbacks={}, predictor=None, _smart_load=lambda _: factory)
                torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, device_count=lambda: 1))
                worker = Worker()
                worker.model = object()
                with patch.dict(sys.modules, {"torch": torch, "ultralytics": SimpleNamespace(YOLO=lambda *_, **__: model)}):
                    if error_code:
                        with self.assertRaises(InferenceError) as caught:
                            worker.load({"modelPath": str(model_path), "taskType": "detect", "device": device})
                        self.assertEqual(caught.exception.code, error_code)
                        self.assertIsNone(worker.model)
                    else:
                        loaded = worker.load({"modelPath": str(model_path), "taskType": "detect", "device": device})
                        self.assertEqual(loaded["classes"], [{"id": "0", "name": "vehicle"}])
                        self.assertEqual(loaded["observedBackend"]["providers"], providers)
                        self.assertIs(worker.model.predictor, predictor)
                self.assertEqual(selected["device"], device)
                self.assertFalse(selected["save"])

    @unittest.skipUnless(os.name == "nt", "Windows 父进程句柄专项")
    def test_parent_termination_stops_blocked_worker(self):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        child_code = "from worker import watch_parent; import time; watch_parent(); print('ready', flush=True); time.sleep(60)"
        parent_code = (
            "import os, subprocess, sys, time; "
            "environment=dict(os.environ, AUTOLABEL_PARENT_PID=str(os.getpid())); "
            f"child=subprocess.Popen([sys.executable, '-u', '-c', {child_code!r}], env=environment, "
            "stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, creationflags=subprocess.CREATE_NO_WINDOW); "
            "assert child.stdout.readline().strip() == 'ready'; print(child.pid, flush=True); time.sleep(60)"
        )
        parent = subprocess.Popen([sys.executable, "-u", "-c", parent_code], cwd=Path(__file__).parent,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
        messages = queue.Queue()
        threading.Thread(target=lambda: messages.put(parent.stdout.readline()), daemon=True).start()
        handle = None
        try:
            child_id = int(messages.get(timeout=5).strip())
            handle = kernel.OpenProcess(0x00100001, False, child_id)
            self.assertTrue(handle, "未取得本测试拥有的 worker 句柄")
            parent.terminate()
            parent.wait(timeout=5)
            self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0, "父进程退出后仍遗留阻塞 worker")
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=5)
            if handle:
                if kernel.WaitForSingleObject(handle, 0) != 0:
                    kernel.TerminateProcess(handle, 1)
                kernel.CloseHandle(handle)
            parent.stdout.close()


if __name__ == "__main__":
    unittest.main()
