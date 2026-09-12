"""真实视频帧的轨迹保存验证；几何与场景由夹具设定，不是人工效率或模型准确率测量。"""

import argparse
import importlib.util
import json
import math
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("backup_runtime", Path(__file__).with_name("validate-backup-runtime.py"))
BACKUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKUP)


def wait_job(command, name, key, identity):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        result = command(name, {key: identity})
        if result["status"] not in ("queued", "running", "cancelling"):
            assert result["status"] == "completed", (name, result["status"], result.get("error"), result.get("summary"))
            return result
        time.sleep(0.1)
    raise AssertionError(f"等待 {name} 超时")


def box(identity, x):
    return {"id": identity, "classId": "person", "type": "detect",
            "bbox": {"x": x, "y": 100, "width": 40, "height": 80}}


def run(args, directory):
    # 保留原片真实 PTS，并故意选取不等间隔帧，验证插值没有按列表索引均分。
    source = directory / "不等间隔 视频.mkv"
    selected = [0, 1, 2, 3, 4, 5, 7, 8, 9]
    expression = "+".join(f"eq(n\\,{index})" for index in selected)
    process = subprocess.run([str(args.ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                              "-i", str(args.video), "-map", "0:v:0", "-an", "-vf", f"select={expression}",
                              "-fps_mode", "vfr", "-c:v", "ffv1", str(source)],
                             capture_output=True, text=True, timeout=90,
                             creationflags=subprocess.CREATE_NO_WINDOW if BACKUP.os.name == "nt" else 0)
    assert process.returncode == 0, process.stderr[-1500:]
    frozen_jar = directory / "engine.jar"
    shutil.copyfile(args.jar, frozen_jar)
    startup = {"mediaFfmpegPath": str(args.ffmpeg), "mediaFfprobePath": str(args.ffprobe)}
    engine = BACKUP.Engine(args.java, frozen_jar, directory, startup)
    try:
        command = engine.command
        project = command("project.create", {"name": "真实帧轨迹事务验收", "taskType": "detect",
                                             "classes": [{"id": "person", "name": "行人", "color": "#4377cc"}]})
        job = command("media.video.create", {"projectId": project["id"], "sourcePath": str(source),
                      "parameters": {"mode": "every_n", "everyNFrames": 1,
                                     "ranges": [{"start": 0, "end": 1}], "maxFrames": 20, "format": "png"}})
        wait_job(command, "media.job.get", "jobId", job["id"])
        command("media.video.import", {"jobId": job["id"]})
        imported = wait_job(command, "media.job.get", "jobId", job["id"])
        assert imported["assetsCommitted"] is True
        timeline = command("track.timeline.create", {"projectId": project["id"], "mediaJobId": job["id"]})
        assert command("track.timeline.create", {"projectId": project["id"], "mediaJobId": job["id"]})["id"] == timeline["id"]
        frames = command("track.timeline.frames", {"timelineId": timeline["id"], "limit": 100})["items"]
        assert len(frames) == len(selected)
        times = [frame["timeSeconds"] for frame in frames]
        assert all(math.isclose(actual, index / 10, abs_tol=1e-9) for actual, index in zip(times, selected)), times
        assert all(isinstance(frame["relativePts"], str) for frame in frames)
        timeline = command("track.timeline.update", {"timelineId": timeline["id"], "baseVersion": timeline["version"],
                           "scenes": [{"startFrameId": frames[0]["frameId"], "endFrameId": frames[-1]["frameId"],
                                       "sceneId": "fixture-scene-one"}]})["timeline"]

        def current_track(identity):
            return command("track.get", {"trackId": identity})

        def current_frame(index):
            page = command("track.timeline.frames", {"timelineId": timeline["id"], "offset": index, "limit": 1})
            return page["items"][0]

        def save_key(track, index, x, keyframe_id=None):
            fixed = current_track(track["id"])
            target = command("asset.get", {"assetId": frames[index]["assetId"]})
            selected_annotation = box(f"fixture-{fixed['id']}-{index}", x)
            annotations = [item for item in target["annotations"] if item["id"] != selected_annotation["id"]]
            annotations.append(selected_annotation)
            # 关键帧绑定已保存对象；先走原有整图人工保存，使端点同样进入普通导出。
            command("annotation.save", {"assetId": target["id"], "baseVersion": target["version"], "annotations": annotations})
            saved = command("asset.get", {"assetId": target["id"]})
            selected_annotation = next(item for item in saved["annotations"] if item["id"] == selected_annotation["id"])
            frame = current_frame(index)
            payload = {"trackId": fixed["id"], "baseVersion": fixed["version"], "timelineVersion": timeline["version"],
                       "frameId": frame["frameId"], "state": "located", "annotation": selected_annotation,
                       "baseAnnotationVersion": frame["annotationVersion"], "baseDraftSavedAt": frame["draftSavedAt"]}
            if keyframe_id:
                payload["keyframeId"] = keyframe_id
            return command("track.keyframe.save", payload)["track"]

        def generate(track):
            fixed = current_track(track["id"])
            payload = {"trackId": fixed["id"], "baseVersion": fixed["version"], "timelineVersion": timeline["version"],
                       "scope": "affected"}
            preview = command("track.generate.preview", payload)
            assert preview["canGenerate"] is True, preview.get("issues")
            submitted = command("track.generate", {**payload, "expectedPlanHash": preview["planHash"]})
            final = wait_job(command, "track.generation.get", "generationId", submitted["id"])
            assert final["requestsUsed"] == 0 and final["candidateOnly"] is True and final["humanConfirmed"] is False
            result = command("track.generation.results", {"generationId": final["id"], "section": "frames", "limit": 100})
            return final, result

        track_a = command("track.create", {"timelineId": timeline["id"], "timelineVersion": timeline["version"],
                                           "classId": "person", "name": "夹具轨迹 A"})
        for index in [0, 3, 6, 8]:
            track_a = save_key(track_a, index, 40 + 100 * times[index])
        generated_a, _ = generate(track_a)
        track_b = command("track.create", {"timelineId": timeline["id"], "timelineVersion": timeline["version"],
                                           "classId": "person", "name": "夹具轨迹 B"})
        for index in [0, 8]:
            track_b = save_key(track_b, index, 300 + 50 * times[index])
        generated_b, _ = generate(track_b)

        def asset(index):
            return command("asset.get", {"assetId": frames[index]["assetId"]})

        overlap = asset(2)
        assert len(overlap["annotations"]) == 2, "后生成轨迹覆盖了其他轨迹"
        assert sorted(round(item["bbox"]["x"], 8) for item in overlap["annotations"]) == [60, 310]
        preserved = asset(1)
        command("annotation.save", {"assetId": preserved["id"], "baseVersion": preserved["version"],
                                    "annotations": preserved["annotations"]})
        protected = asset(1)
        outside = asset(4)
        keys = command("track.keyframe.list", {"trackId": track_a["id"], "limit": 100})["items"]
        first_key = next(key for key in keys if key["frameId"] == frames[0]["frameId"])
        track_a = save_key(track_a, 0, 50, first_key["keyframeId"])
        changed, changed_results = generate(track_a)
        protected_after, outside_after = asset(1), asset(4)
        for before, after in [(protected, protected_after), (outside, outside_after)]:
            assert (before["version"], before["annotations"]) == (after["version"], after["annotations"])
        updated = asset(2)
        xs = sorted(item["bbox"]["x"] for item in updated["annotations"])
        assert len(xs) == 2 and math.isclose(xs[0], 50 + 20 * 2 / 3, abs_tol=1e-8) and xs[1] == 310
        affected_ids = {row["frameId"] for row in changed_results["items"]}
        assert frames[4]["frameId"] not in affected_ids, "相邻区间修改不应扩大到无关区间"
        export = command("export.create", {"projectId": project["id"], "outputDir": str(directory / "轨迹 导出"),
                                            "trainRatio": 0.8})
        assert export["status"] == "completed"
        manifest = json.loads((Path(export["path"]) / "manifest.json").read_text(encoding="utf-8"))
        assert len({item["split"] for item in manifest["assets"]}) == 1
        labels = list(Path(export["path"]).glob("labels/**/*.txt"))
        assert labels and all(len(line.split()) == 5 for label in labels for line in label.read_text().splitlines())
        with sqlite3.connect(directory / "autolabel.db") as database:
            assert database.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 0
            assert database.execute("SELECT COUNT(*) FROM budgets").fetchone()[0] == 0
        report = {"passed": True, "projectId": project["id"], "mediaJobId": job["id"], "timelineId": timeline["id"],
                  "frames": len(frames), "actualTimes": times, "trackIds": [track_a["id"], track_b["id"]],
                  "generationIds": [generated_a["id"], generated_b["id"], changed["id"]],
                  "twoTracksPreserved": True, "manualVersionProtected": True, "unaffectedIntervalPreserved": True,
                  "geometrySource": "programmatic_fixture", "sceneSource": "programmatic_fixture",
                  "annotationApiRequests": 0, "agentRequests": 0, "exportDir": export["path"]}
    finally:
        engine.close()
    restarted = BACKUP.Engine(args.java, frozen_jar, directory, startup)
    try:
        assert restarted.command("track.timeline.get", {"timelineId": timeline["id"]})["frameCount"] == len(frames)
        assert restarted.command("track.get", {"trackId": track_a["id"]})["version"] == track_a["version"]
        assert restarted.command("track.generation.get", {"generationId": changed["id"]})["status"] == "completed"
        saved = restarted.command("asset.get", {"assetId": protected["id"]})
        assert (saved["version"], saved["annotations"]) == (protected["version"], protected["annotations"])
        report["restartPreserved"] = True
    finally:
        restarted.close()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for flag in ("java", "jar", "ffmpeg", "ffprobe", "video"):
        parser.add_argument("--" + flag, required=True, type=Path)
    args = parser.parse_args()
    for flag in ("java", "jar", "ffmpeg", "ffprobe", "video"):
        value = getattr(args, flag)
        assert value.is_absolute() and value.is_file(), f"{flag} 需要已有文件的绝对路径"
    directory = ROOT / ".qa" / f"track-runtime-{int(time.time() * 1000)}"
    directory.mkdir(parents=True)
    report = run(args, directory)
    output = directory / "verification.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": True, "report": str(output)}, ensure_ascii=False))
