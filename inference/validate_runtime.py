"""加载实际模型并检查本地推理协议与坐标，输出实测设备范围。"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("image", type=Path)
    parser.add_argument("--devices", nargs="+", default=["cpu"])
    parser.add_argument("--task", choices=["detect", "obb", "segment", "pose", "classify"], default="detect")
    parser.add_argument("--allow-reviewable-geometry", action="store_true",
                        help="允许有明确问题标记且保留原始几何的候选；不代表通过采用和导出检查")
    options = parser.parse_args()
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as errors:
        process = subprocess.Popen([sys.executable, "-u", str(Path(__file__).with_name("worker.py"))],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                                   text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        assert json.loads(process.stdout.readline()) == {"type": "ready", "protocolVersion": 1}
        counter = 0

        def request(command, payload=None):
            nonlocal counter
            counter += 1
            request_id = f"validation-{counter}"
            process.stdin.write(json.dumps({"id": request_id, "command": command, "payload": payload or {}}) + "\n")
            process.stdin.flush()
            events = []
            while line := process.stdout.readline():
                message = json.loads(line)
                assert message["id"] == request_id, "推理结果错配到其他请求"
                if message["type"] == "event":
                    events.append(message)
                    continue
                return message, events
            raise AssertionError("推理进程提前退出")

        try:
            probe, _ = request("probe")
            assert probe["ok"] and probe["data"]["available"]
            results = []
            for device in options.devices:
                loaded, _ = request("load", {"modelPath": str(options.model.resolve()), "taskType": options.task, "device": device})
                assert loaded["ok"], loaded
                mapping = {item["id"]: f"class-{item['id']}" for item in loaded["data"]["classes"]}
                predicted, events = request("predict", {"imagePath": str(options.image.resolve()), "assetId": "validation-image",
                                                         "classMap": mapping, "imageSize": 640,
                                                         "keypointNames": [f"point-{i}" for i in range(17)]})
                assert predicted["ok"], predicted
                data = predicted["data"]
                assert data["assetId"] == "validation-image"
                assert data["requestedDevice"] == device
                backend = data.get("observedBackend")
                if options.model.suffix.lower() == ".pt":
                    assert backend and backend["kind"] == "pytorch", "未观测到实际 PyTorch 后端"
                    expected_device = "cpu" if device == "cpu" else f"cuda:{device}"
                    assert backend["device"] == expected_device, "实际权重设备与所选设备不一致"
                assert data["annotations"], "验证图片没有返回目标，需要更换匹配模型任务的样本"
                assert events and events[0]["stage"] == "local_inference"
                out_of_bounds = set()
                for annotation in data["annotations"]:
                    assert annotation["type"] == options.task and annotation["classId"] in mapping.values()
                    assert 0 <= annotation["confidence"] <= 1
                    if "bbox" in annotation:
                        box = annotation["bbox"]
                        assert 0 <= box["x"] < data["width"] and 0 <= box["y"] < data["height"]
                        assert box["width"] > 0 and box["height"] > 0
                        assert box["x"] + box["width"] <= data["width"] + 0.01
                        assert box["y"] + box["height"] <= data["height"] + 0.01
                    if options.task in ("obb", "segment"):
                        points = annotation["points"]
                        assert len(points) == 4 if options.task == "obb" else len(points) >= 3
                        within_bounds = all(0 <= p["x"] <= data["width"] and 0 <= p["y"] <= data["height"] for p in points)
                        if not within_bounds:
                            out_of_bounds.add(annotation["id"])
                            assert options.task == "obb" and options.allow_reviewable_geometry, "角点越界，严格几何验收未通过"
                        if options.task == "obb":
                            edges = [(points[(i + 1) % 4]["x"] - p["x"], points[(i + 1) % 4]["y"] - p["y"]) for i, p in enumerate(points)]
                            for i, (dx, dy) in enumerate(edges):
                                nx, ny = edges[(i + 1) % 4]
                                assert abs(dx * nx + dy * ny) <= 0.002 * max(1, (dx * dx + dy * dy) ** 0.5 * (nx * nx + ny * ny) ** 0.5), "旋转矩形发生有损角点变形"
                    if options.task == "pose":
                        assert len(annotation["keypoints"]) == 17
                        for i, point in enumerate(annotation["keypoints"]):
                            assert point["name"] == f"point-{i}" and point["visibility"] in (0, 1, 2)
                            assert 0 <= point["x"] <= data["width"] and 0 <= point["y"] <= data["height"]
                            if point["visibility"] == 0:
                                assert point["x"] == 0 and point["y"] == 0
                marked = {issue["annotationId"] for issue in data.get("geometryIssues", []) if issue["code"] == "geometry_out_of_bounds"}
                assert marked == out_of_bounds, "几何问题必须准确关联原始越界候选"
                issues = data.get("geometryIssues", [])
                assert data.get("requiresGeometryReview", False) == bool(issues)
                assert not issues or options.allow_reviewable_geometry, "存在需复核的原始几何"
                diagnostic_ids = {entry["annotationId"] for entry in data.get("geometryDiagnostics", []) if entry["rings"]}
                topology_ids = {issue["annotationId"] for issue in issues if issue["code"] == "segment_topology_unsupported"}
                assert topology_ids <= diagnostic_ids, "不支持的分割拓扑必须保留完整环与层级"
                results.append({"device": device, "objects": len(data["annotations"]), "elapsedMs": data["elapsedMs"],
                                "observedBackend": backend,
                                "geometryReviewCount": len({issue["annotationId"] for issue in issues}),
                                "topologyDiagnostics": len(topology_ids), "basicStructureAndBoundsPassed": not out_of_bounds,
                                "adoptionValidation": "requires_java_validation",
                                "taskType": data["taskType"], "width": data["width"], "height": data["height"]})
            bad_map, _ = request("predict", {"imagePath": str(options.image.resolve()), "assetId": "validation-image", "classMap": {}})
            assert not bad_map["ok"] and bad_map["error"]["code"] == "class_map_required"
            wrong_task = "pose" if options.task != "pose" else "detect"
            wrong, _ = request("load", {"modelPath": str(options.model.resolve()), "taskType": wrong_task, "device": "cpu"})
            assert not wrong["ok"] and wrong["error"]["code"] == "model_task_mismatch", wrong
            stale, _ = request("predict", {"imagePath": str(options.image.resolve()), "assetId": "validation-image", "classMap": {}})
            assert not stale["ok"] and stale["error"]["code"] == "model_required"
            print(json.dumps({"environment": probe["data"], "verified": results,
                              "taskMismatchRejected": True, "missingClassMapRejected": True, "failedLoadClearsModel": True}, ensure_ascii=False))
        finally:
            if process.poll() is None:
                request("shutdown")
                process.wait(timeout=10)


if __name__ == "__main__":
    main()
