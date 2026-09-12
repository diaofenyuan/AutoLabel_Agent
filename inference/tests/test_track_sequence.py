"""有限帧跟踪协议夹具；真实模型短片由 verify_track_sequence_video.py 单独验证。"""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


class Tensor:
    def __init__(self, values):
        self.values = values

    def cpu(self):
        return self

    def tolist(self):
        return self.values


class Boxes:
    is_track = False

    def __init__(self, rows):
        self.rows = rows
        self.xyxy = Tensor([row[:4] for row in rows])
        self.conf = Tensor([row[4] for row in rows])
        self.cls = Tensor([row[5] for row in rows])

    def cpu(self):
        return self

    def numpy(self):
        return self


class Indexed:
    def __init__(self, boxes, indices=None):
        self.boxes = boxes
        self.indices = list(range(len(boxes.rows))) if indices is None else indices

    def __getitem__(self, selection):
        return Indexed(self.boxes, [self.indices[index] for index in selection])


def png(path, width=200, height=100):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
                     chunk(b"IDAT", zlib.compress((b"\0" + b"\0" * width * 3) * height)) + chunk(b"IEND", b""))


class TrackSequenceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.image = Path(self.directory.name) / "基准图.png"
        self.model = Path(self.directory.name) / "fixture.pt"
        png(self.image)
        self.model.write_bytes(b"fixed model")
        self.worker = worker.Worker()
        self.worker.model_path, self.worker.model_hash, self.worker.task = self.model, worker.file_hash(self.model), "detect"
        self.orig_shape = (100, 200)
        self.rows = [[[10, 10, 40, 40, .9, 0]], [[11, 10, 41, 40, .9, 0]]]
        self.index, self.factories = 0, 0
        self.native = lambda index, row: index + 1 if row[4] >= .25 else None
        self.corrupt = None
        backend = SimpleNamespace(pt=True, model=SimpleNamespace(parameters=lambda: iter([SimpleNamespace(device="cpu")])))
        self.worker.model = SimpleNamespace(task="detect", predict=self.predict, predictor=SimpleNamespace(model=backend))
        self.payload = {"sequenceId": "sequence", "sourceVideoId": "source", "sourceVideoHash": "a" * 64,
                        "expectedModelHash": self.worker.model_hash, "templateHash": "b" * 64, "classMap": {"0": "person", "1": "car"},
                        "cadence": {"numerator": "1", "denominator": "10"}, "frames": self.frames(2)}
        self.patcher = patch.object(worker, "tracking_backend", return_value=(self.factory, Indexed, {"lap": "fixture"}))
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def frames(self, count):
        return [{"inputId": f"input-{index}", "assetId": f"asset-{index}", "sourceVideoId": "source", "imagePath": str(self.image),
                 "expectedInputHash": worker.file_hash(self.image), "width": 200, "height": 100, "pts": str(index),
                 "timeBase": {"numerator": "1", "denominator": "10"}, "sceneId": "scene-1"} for index in range(count)]

    def predict(self, **kwargs):
        self.assertEqual(kwargs["max_det"], self.payload.get("parameters", {}).get("maxDetections", 100))
        rows = self.rows[self.index % len(self.rows)]
        self.index += 1
        return [SimpleNamespace(orig_shape=self.orig_shape, boxes=Boxes(rows), masks=None, keypoints=None, obb=None)]

    def factory(self):
        self.factories += 1

        def update(indexed):
            rows = []
            for index in indexed.indices:
                row = indexed.boxes.rows[index]
                native = self.native(index, row)
                if native is not None:
                    # 故意移动滤波框，验证标准标注仍来自原始检测。
                    rows.append([row[0] + 2, row[1], row[2] + 2, row[3], native, row[4], row[5], index])
            return self.corrupt(rows) if self.corrupt else rows
        return SimpleNamespace(update=update)

    def run_sequence(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.worker.dispatch({"id": "request", "command": "track_sequence", "payload": self.payload})

    def assert_error(self, code):
        with self.assertRaises(worker.InferenceError) as caught:
            self.run_sequence()
        self.assertEqual(caught.exception.code, code)

    def codes(self, value):
        return {issue["code"] for frame in value["frames"] for issue in frame["trackingIssues"]} | {i["code"] for i in value["trackingIssues"]}

    def test_clean_association_has_original_geometry_and_no_forced_review(self):
        value = self.run_sequence()
        self.assertFalse(value["requiresTrackingReview"])
        self.assertFalse(value["confirmed"])
        self.assertEqual(value["statistics"]["associatedDetections"], 2)
        self.assertEqual(len(value["tracks"]), 1)
        frame = value["frames"][0]
        annotation = frame["prediction"]["annotations"][0]
        self.assertEqual(annotation["bbox"]["x"], 10)
        self.assertEqual(frame["associations"][0]["kalmanBBoxDiagnostic"][0], 12)
        self.assertNotIn("trackId", annotation)
        self.assertNotIn("logicalTrackId", annotation)
        self.assertEqual(value["provenance"]["associationScope"], "single_request")
        self.assertEqual(value["provenance"]["trackerConfigHash"], hashlib.sha256(json.dumps(
            worker.TRACKING_CONFIG, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        self.assertEqual(len(value["provenance"]["workerHash"]), 64)

    def test_ignored_and_unassociated_rows_preserve_original_indices(self):
        self.payload["classMap"]["1"] = None
        self.rows = [[[5, 5, 15, 15, .9, 1], [30, 10, 50, 30, .2, 0], [60, 10, 80, 30, .9, 0]]]
        value = self.run_sequence()
        frame = value["frames"][0]
        self.assertEqual([a["sourceDetectionIndex"] for a in frame["associations"]], [1, 2])
        self.assertIsNone(frame["associations"][0]["logicalTrackId"])
        self.assertIsNotNone(frame["associations"][1]["logicalTrackId"])
        self.assertEqual(len(frame["prediction"]["annotations"]), 2)
        self.assertFalse(frame["prediction"]["requiresGeometryReview"])
        self.assertEqual(value["statistics"]["excludedByClassMap"], 2)
        self.assertEqual(value["statistics"]["unassociatedDetections"], 2)
        self.assertIn("tracking_detection_unassociated", self.codes(value))
        for score in (float("nan"), float("inf"), float("-inf"), -.1, 1.1, True):
            with self.subTest(ignored_score=score):
                self.rows = [[[5, 5, 15, 15, score, 1]]]
                self.assert_error("result_invalid")
        self.rows = [[[5, 5, 15, 15, 0, 1], [30, 10, 50, 30, 1, 1]]]
        excluded = self.run_sequence()
        self.assertEqual(excluded["statistics"]["excludedByClassMap"], 4)
        self.assertTrue(all(not frame["prediction"]["annotations"] for frame in excluded["frames"]))

    def test_missing_reappearance_and_class_change_start_new_segments(self):
        self.payload["frames"] = self.frames(4)
        self.rows = [[[10, 10, 40, 40, .9, 0]], [], [[12, 10, 42, 40, .9, 0]], [[13, 10, 43, 40, .9, 1]]]
        value = self.run_sequence()
        self.assertEqual([len(t["observations"]) for t in value["tracks"]], [1, 1, 1])
        self.assertEqual(value["frames"][1]["prediction"]["annotations"], [])
        self.assertTrue({"tracking_observation_missing", "tracking_reappeared", "tracking_class_changed"} <= self.codes(value))
        self.assertEqual([a["nativeTrackId"] for f in value["frames"] for a in f["associations"]], [1, 1, 1])

    def test_scene_enter_exit_and_unlocatable_reset_association(self):
        for change in ("scene", "enter", "exit", "unlocatable", "missing"):
            with self.subTest(change=change):
                self.index, self.factories = 0, 0
                self.payload["frames"] = self.frames(3)
                if change == "scene":
                    self.payload["frames"][1]["sceneId"] = "scene-2"
                elif change == "enter":
                    self.payload["frames"][1]["boundaryBefore"] = "enter"
                elif change == "exit":
                    self.payload["frames"][0]["boundaryAfter"] = "exit"
                elif change == "unlocatable":
                    self.payload["frames"][1]["boundaryBefore"] = "unlocatable"
                else:
                    del self.payload["frames"][1]["sceneId"]
                value = self.run_sequence()
                self.assertGreaterEqual(len(value["tracks"]), 2)
                if change in ("unlocatable", "missing"):
                    frame = value["frames"][1]
                    self.assertIsNone(frame["associations"][0]["logicalTrackId"])
                    self.assertTrue(frame["requiresTrackingReview"])
                    self.assertFalse(frame["prediction"]["requiresGeometryReview"])
                else:
                    self.assertFalse(value["requiresTrackingReview"])

    def test_time_is_exact_signed_and_not_sorted(self):
        self.payload["frames"][0].update(pts="-2")
        self.payload["frames"][1].update(pts="-2", timeBase={"numerator": "1", "denominator": "20"})
        self.assertEqual(len(self.run_sequence()["frames"]), 2)
        for stamp in ("-4", "-3", "0"):
            self.payload["frames"][1]["pts"] = stamp
            self.assert_error("tracking_cadence_unsupported")
        self.payload["frames"][1]["pts"] = "9" * 81
        self.assert_error("tracking_time_invalid")
        self.payload["frames"][1]["pts"] = 0
        self.assert_error("tracking_time_invalid")
        self.payload["frames"][1]["pts"] = "-2"
        self.payload["frames"][1]["timeBase"]["numerator"] = "-1"
        self.assert_error("tracking_time_invalid")

    def test_sparse_unequal_duplicate_source_dimensions_and_fingerprints_rejected(self):
        original = copy.deepcopy(self.payload)
        changes = [
            (lambda: self.payload.update(cadence={"numerator": "1", "denominator": "1"}), "tracking_cadence_unsupported"),
            (lambda: self.payload["frames"][1].update(pts="2"), "tracking_cadence_unsupported"),
            (lambda: self.payload["frames"][1].update(inputId="input-0"), "tracking_input_invalid"),
            (lambda: self.payload["frames"][1].update(sourceVideoId="other"), "tracking_input_invalid"),
            (lambda: self.payload["frames"][1].update(width=201), "tracking_input_invalid"),
            (lambda: self.payload["frames"][0].update(expectedInputHash="0" * 64), "input_changed"),
            (lambda: self.payload.update(expectedModelHash="0" * 64), "input_changed"),
            (lambda: self.payload.update(tracker={}), "parameter_invalid"),
        ]
        for change, code in changes:
            self.payload = copy.deepcopy(original)
            change()
            self.assert_error(code)
        self.payload = copy.deepcopy(original)
        for shape in (None, (100,), (100, 200, 3), (100.5, 200), (100, 200.5), (float("nan"), 200),
                      (100, float("inf")), (True, 200), (100, False), (0, 200), (-100, 200), ("100", 200)):
            with self.subTest(actual_shape=shape):
                self.orig_shape = shape
                self.assert_error("result_invalid")
        import numpy as np
        self.orig_shape = (np.int64(100), np.int32(200))
        actual = self.run_sequence()["frames"][0]["prediction"]
        self.assertEqual((actual["height"], actual["width"]), (100, 200))
        self.assertIs(type(actual["height"]), int)
        self.assertIs(type(actual["width"]), int)

    def test_limits_and_actual_total_detection_budget(self):
        self.payload["frames"] = self.frames(121)
        self.assert_error("tracking_limit_exceeded")
        self.payload["frames"] = self.frames(52)
        self.payload["cadence"] = {"numerator": "1", "denominator": "5"}
        for frame in self.payload["frames"]:
            frame["timeBase"] = self.payload["cadence"]
        self.assert_error("tracking_limit_exceeded")
        self.payload["frames"] = self.frames(2)
        self.payload["cadence"] = {"numerator": "1", "denominator": "10"}
        self.payload["parameters"] = {"maxDetections": 101}
        self.assert_error("parameter_invalid")
        del self.payload["parameters"]
        self.rows = [[[10, 10, 40, 40, .9, 0]] * 101]
        self.assert_error("result_invalid")
        self.rows = [[[10, 10, 40, 40, .9, 0]] * 100]
        self.payload["frames"] = self.frames(101)
        # 显式忽略也计入原始对象资源预算，不能用映射绕过总量上限。
        self.payload["classMap"]["0"] = None
        self.assert_error("tracking_limit_exceeded")

    def test_invalid_association_cannot_be_silently_published(self):
        for corrupt in (lambda rows: rows + rows, lambda rows: [rows[0][:-1] + [99]],
                        lambda rows: [rows[0][:6] + [1, 0]], lambda rows: [[float("nan")] + rows[0][1:]]):
            self.corrupt = corrupt
            with self.assertRaises(worker.InferenceError) as caught:
                self.run_sequence()
            self.assertIn(caught.exception.code, ("tracking_result_invalid", "result_invalid"))

    def test_motion_scale_and_overlap_diagnostics_do_not_replace_detections(self):
        self.payload["cadence"] = {"numerator": "1", "denominator": "100"}
        self.payload["frames"][1]["timeBase"] = self.payload["cadence"]
        self.rows = [[[10, 10, 20, 20, .9, 0]], [[110, 10, 150, 50, .9, 0], [111, 11, 151, 51, .9, 0]]]
        value = self.run_sequence()
        self.assertTrue({"tracking_fast_motion", "tracking_scale_change", "tracking_identity_ambiguous"} <= self.codes(value))
        self.assertEqual(len(value["frames"][1]["prediction"]["annotations"]), 2)
        self.assertFalse(value["frames"][1]["prediction"]["requiresGeometryReview"])
        motion = value["frames"][1]["associations"][0]["motionDiagnostic"]
        self.assertEqual(motion["elapsedSeconds"], .01)
        self.assertEqual(motion["areaRatio"], 16)
        with patch.dict(worker.TRACKING_DIAGNOSTICS, {"maxOverlapPairChecks": 0}):
            bounded = self.run_sequence()
        self.assertEqual(bounded["statistics"]["overlapPairChecks"], 0)
        self.assertIn("tracking_ambiguity_budget_exceeded", self.codes(bounded))

    def test_invalid_geometry_preserved_but_not_associated(self):
        self.rows = [[[10, 10, 10, 40, .9, 0]]]
        value = self.run_sequence()
        self.assertEqual(value["tracks"], [])
        self.assertEqual(value["frames"][0]["prediction"]["annotations"][0]["bbox"]["width"], 0)
        self.assertTrue(value["frames"][0]["prediction"]["requiresGeometryReview"])
        self.assertIn("tracking_geometry_unusable", self.codes(value))

    def test_optional_dependency_task_device_and_model_identity(self):
        self.patcher.stop()
        with patch.dict(sys.modules, {"lap": None}):
            self.assert_error("tracking_dependency_missing")
            self.payload["parameters"] = {"maxDetections": 300}
            with contextlib.redirect_stdout(io.StringIO()):
                ordinary = self.worker.predict({**self.payload["frames"][0], "classMap": self.payload["classMap"]}, "normal")
            self.assertEqual(len(ordinary["annotations"]), 1)
        self.patcher.start()
        self.payload.pop("parameters", None)
        self.worker.task = "pose"
        self.assert_error("tracking_task_unsupported")
        self.worker.task = "detect"
        with patch.object(self.worker, "observed_backend", return_value=None):
            self.assert_error("tracking_device_unverified")
        with patch.object(self.worker, "observed_backend", return_value={"kind": "pytorch", "device": "cuda:0", "providers": None}):
            self.assert_error("device_unavailable")
        self.model.write_bytes(b"changed")
        self.assert_error("input_changed")

    def test_requests_do_not_share_tracking_state_and_valid_empty_is_not_failure(self):
        first, second = self.run_sequence(), self.run_sequence()
        self.assertNotEqual(first["candidateSetId"], second["candidateSetId"])
        self.assertNotEqual(first["tracks"][0]["trackId"], second["tracks"][0]["trackId"])
        self.assertEqual(self.factories, 2)
        self.rows = [[]]
        value = self.run_sequence()
        self.assertFalse(value["requiresTrackingReview"])
        self.assertEqual(value["tracks"], [])
        self.assertTrue(all(not f["prediction"]["requiresGeometryReview"] for f in value["frames"]))


if __name__ == "__main__":
    unittest.main()
