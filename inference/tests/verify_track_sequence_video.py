"""使用本机已有模型和视频验证生产 stdio 跟踪命令，不安装依赖或下载模型。"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dependency-path", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if not output.is_relative_to((repo / ".qa").resolve()):
        raise ValueError("验证输出必须限制在 .qa")
    for path in (args.video, args.model, args.ffprobe):
        if not path.is_file():
            raise ValueError("需要已存在的模型、视频和 FFprobe")
    import cv2
    output.mkdir(parents=True, exist_ok=True)
    timeline = json.loads(subprocess.run([str(args.ffprobe), "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#20",
                                         "-show_frames", "-show_streams", "-show_entries", "frame=pts:stream=width,height,time_base",
                                         "-of", "json", str(args.video)], check=True, capture_output=True, text=True, timeout=30).stdout)
    stream, stamps = timeline["streams"][0], timeline["frames"]
    assert len(stamps) == 20
    numerator, denominator = stream["time_base"].split("/")
    time_base = {"numerator": numerator, "denominator": denominator}
    capture = cv2.VideoCapture(str(args.video))
    frames = []
    try:
        for index, stamp in enumerate(stamps):
            ok, image = capture.read()
            assert ok and image.shape[:2] == (stream["height"], stream["width"])
            path = output / f"frame-{index:03}.png"
            assert cv2.imwrite(str(path), image)
            frames.append({"inputId": f"input-{index}", "assetId": f"asset-{index}", "sourceVideoId": "opencv-vtest",
                           "imagePath": str(path), "expectedInputHash": sha(path), "width": stream["width"], "height": stream["height"],
                           "pts": str(stamp["pts"]), "timeBase": time_base, "sceneId": "supplied-scene-first-20"})
    finally:
        capture.release()
    class_map = {str(index): f"class-{index}" for index in range(80)}
    payload = {"sequenceId": "actual-vtest-first-20", "sourceVideoId": "opencv-vtest", "sourceVideoHash": sha(args.video),
               "expectedModelHash": sha(args.model), "templateHash": hashlib.sha256(json.dumps(class_map, sort_keys=True).encode()).hexdigest(),
               "classMap": class_map, "parameters": {"confidence": .1, "iou": .7, "imageSize": 640, "maxDetections": 50},
               "cadence": {"numerator": "1", "denominator": "10"}, "frames": frames}
    requests = [{"id": "load", "command": "load", "payload": {"modelPath": str(args.model.resolve()), "expectedModelHash": payload["expectedModelHash"],
                                                               "taskType": "detect", "device": "cpu"}},
                {"id": "track", "command": "track_sequence", "payload": payload},
                {"id": "after", "command": "predict", "payload": {**frames[0], "classMap": class_map, **payload["parameters"]}},
                {"id": "stop", "command": "shutdown"}]
    environment = dict(os.environ, PYTHONPATH=str(args.dependency_path.resolve()), PYTHONDONTWRITEBYTECODE="1",
                       YOLO_CONFIG_DIR=str(output / "config"), YOLO_AUTOINSTALL="false", YOLO_OFFLINE="true")
    # 子进程内阻断所有网络连接；在环境已有依赖的前提下验证无自动下载。
    bootstrap = ("import runpy,socket; "
                 "socket.socket.connect=lambda *a,**k: (_ for _ in ()).throw(AssertionError('network disabled')); "
                 f"runpy.run_path({str(repo / 'inference/worker.py')!r},run_name='__main__')")
    started = time.perf_counter()
    child = subprocess.run([sys.executable, "-B", "-u", "-c", bootstrap], input="\n".join(json.dumps(r) for r in requests) + "\n",
                           capture_output=True, text=True, encoding="utf-8", env=environment, timeout=180,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    (output / "worker-stderr.txt").write_text(child.stderr, encoding="utf-8")
    assert child.returncode == 0, child.stderr[-1000:]
    events = [json.loads(line) for line in child.stdout.splitlines()]
    responses = {event["id"]: event for event in events if event["type"] == "response"}
    assert all(response["ok"] for response in responses.values()), responses
    result = responses["track"]["data"]
    assert len(result["frames"]) == 20 and not result["confirmed"]
    assert all(frame["prediction"]["observedBackend"]["device"] == "cpu" for frame in result["frames"])
    assert all(frame["prediction"]["inputHash"] == expected["expectedInputHash"] for frame, expected in zip(result["frames"], frames))
    assert all("trackId" not in annotation and "logicalTrackId" not in annotation for frame in result["frames"] for annotation in frame["prediction"]["annotations"])
    assert "associations" not in responses["after"]["data"]
    stats = result["statistics"]
    assert stats["rawDetections"] == stats["associatedDetections"] + stats["unassociatedDetections"] + stats["excludedByClassMap"]
    long_tracks = [track for track in result["tracks"] if len(track["observations"]) >= 15]
    assert long_tracks, "真实短片未形成可验证的连续轨迹"
    annotation_lookup = {annotation["id"]: annotation for frame in result["frames"] for annotation in frame["prediction"]["annotations"]}
    movement = []
    for track in long_tracks:
        first, last = [annotation_lookup[o["annotationId"]]["bbox"] for o in (track["observations"][0], track["observations"][-1])]
        dx = last["x"] + last["width"] / 2 - first["x"] - first["width"] / 2
        dy = last["y"] + last["height"] / 2 - first["y"] - first["height"] / 2
        movement.append({"trackId": track["trackId"], "observations": len(track["observations"]), "centerDisplacementPixels": (dx * dx + dy * dy) ** .5})
    assert any(item["centerDisplacementPixels"] > 5 for item in movement)
    (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {"status": "passed", "runtimeSeconds": round(time.perf_counter() - started, 3), "statistics": stats,
               "provenance": result["provenance"], "sourceVideoHash": payload["sourceVideoHash"], "modelHash": result["modelHash"],
               "requiresTrackingReview": result["requiresTrackingReview"], "issues": dict(Counter(
                   issue["code"] for frame in result["frames"] for issue in frame["trackingIssues"])),
               "longTrackMovement": movement, "normalPredictAfterTracking": True, "networkBlocked": True}
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
