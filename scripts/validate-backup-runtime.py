"""在隔离目录验证已有模型结果的备份恢复，不注入凭据或重新调用模型。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]


class Engine:
    def __init__(self, java, jar, directory, startup=None):
        self.token = uuid.uuid4().hex + uuid.uuid4().hex
        self.process = subprocess.Popen(
            [str(java), "-jar", str(jar)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.process.stdin.write(json.dumps({**(startup or {}), "token": self.token, "dataDir": str(directory), "protocolVersion": 1}) + "\n")
        self.process.stdin.flush()
        line = queue.Queue(maxsize=1)
        threading.Thread(target=lambda: line.put(self.process.stdout.readline()), daemon=True).start()
        try:
            ready = json.loads(line.get(timeout=20))
            assert ready["type"] == "ready", "引擎没有返回就绪状态"
        except Exception:
            self.process.kill()
            self.process.wait(timeout=10)
            raise
        self.url = f'http://127.0.0.1:{ready["port"]}/command'

    def command(self, name, payload=None):
        request = urllib.request.Request(self.url, data=json.dumps({"command": name, "payload": payload or {}}).encode(),
                                         headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
        assert result["ok"], f'{name}: {result.get("error", {}).get("code", "unknown")}'
        return result["data"]

    def close(self):
        try:
            if self.process.poll() is None:
                self.command("engine.shutdown")
                self.process.wait(timeout=15)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=10)


def connect(directory):
    database = sqlite3.connect((directory / "autolabel.db").as_uri() + "?mode=ro", uri=True)
    database.row_factory = sqlite3.Row
    return database


def snapshot(directory):
    with connect(directory) as db:
        schema_version = db.execute("PRAGMA user_version").fetchone()[0]
        assets = {row["id"]: json.loads(row["data"]) for row in db.execute("SELECT id,data FROM assets")}
        counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in
                  ("projects", "assets", "versions", "drafts", "runs", "samples", "attempts", "exports", "budgets")}
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        extended_counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in
                           ("run_baselines", "input_results", "run_asset_results", "media_jobs", "video_sources", "screening_features",
                            "track_timelines", "timeline_frames", "tracks", "track_versions", "track_generations",
                            "track_generation_frames", "track_contributions", "track_contribution_heads", "track_dirty_frames",
                            "track_generation_plans")
                           if table in tables}
        budgets = [tuple(row) for row in db.execute("SELECT id,max_requests,used FROM budgets ORDER BY id")]
        attempts = [tuple(row) for row in db.execute("SELECT id,status FROM attempts ORDER BY id")]
        samples = [tuple(row) for row in db.execute("SELECT id,status,attempt_count FROM samples ORDER BY id")]
        exports = [json.loads(row[0]) for row in db.execute("SELECT data FROM exports WHERE json_extract(data,'$.status')='completed'")]
        paths = [row[0] for row in db.execute("SELECT path FROM assets")]
    fields = ("id", "projectId", "version", "status", "source", "contentHash", "width", "height", "annotations")
    return {"schemaVersion": schema_version,
            "assets": {key: {field: asset.get(field) for field in fields} for key, asset in assets.items()},
            "counts": counts, "extendedCounts": extended_counts, "budgets": budgets,
            "attempts": attempts, "samples": samples, "exports": exports, "paths": paths}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-data", required=True, type=Path)
    parser.add_argument("--engine-jar", required=True, type=Path)
    args = parser.parse_args()
    source = args.source_data.resolve(strict=True)
    jar = args.engine_jar.resolve(strict=True)
    directory = ROOT / ".qa" / ("backup-runtime-" + str(time.time_ns() // 1_000_000))
    cloned = directory / "source-snapshot"
    archives = directory / "archives"
    restored_parent = directory / "恢复 工作空间"
    outputs = directory / "reproduced-exports"
    for folder in (cloned, archives, restored_parent, outputs):
        folder.mkdir(parents=True)
    # 原数据只读连接使用 SQLite 备份 API，避免复制主库时遗漏 WAL。
    with connect(source) as original, sqlite3.connect(cloned / "autolabel.db") as destination:
        original.backup(destination)
    for name in ("evaluation-sets", "resource-library", "media", "flow-inputs", "media-jobs"):
        if (source / name).is_dir():
            shutil.copytree(source / name, cloned / name)
    runtime = directory / "engine.jar"
    shutil.copyfile(jar, runtime)
    java_root = Path((ROOT / "engine/build/runtime-path.txt").read_text(encoding="utf-8").strip())
    java = java_root / "bin" / ("java.exe" if os.name == "nt" else "java")
    # 启动前保留旧库基线，避免只比较迁移后的备份而漏掉升级时的数据丢失。
    original_snapshot = snapshot(cloned)
    engine = Engine(java, runtime, cloned)
    try:
        before = snapshot(cloned)
        for field in ("assets", "counts", "budgets", "attempts", "samples", "exports"):
            assert original_snapshot[field] == before[field], f"迁移后 {field} 不一致"
        for table, count in original_snapshot["extendedCounts"].items():
            assert before["extendedCounts"].get(table) == count, f"迁移后 {table} 记录数量不一致"
        assert before["assets"], "验收源目录没有已保存素材"
        owner = {"operationId": uuid.uuid4().hex}
        state = engine.command("system.prepareDataMaintenance", owner)
        assert state["ready"] and state["locked"], "原记录尚未静止，不能备份"
        created = engine.command("backup.create", {**owner, "outputDir": str(archives)})
        inspected = engine.command("backup.inspect", {"backupPath": created["backupPath"]})
        assert inspected["valid"] and inspected["credentialsIncluded"] is False
        prepared = engine.command("restore.prepare", {**owner, "backupPath": created["backupPath"], "targetParent": str(restored_parent)})
        engine.command("system.cancelDataMaintenance", owner)
    finally:
        engine.close()
    restored = Path(prepared["dataDir"])
    engine = Engine(java, runtime, restored)
    try:
        after = snapshot(restored)
        for field in ("assets", "counts", "extendedCounts", "budgets", "attempts", "samples"):
            assert before[field] == after[field], f"恢复后 {field} 不一致"
        assert all(Path(value).resolve().is_relative_to(restored) and Path(value).is_file() for value in after["paths"])
        for project in engine.command("project.list"):
            engine.command("project.open", {"projectId": project["id"]})
        for asset in before["assets"].values():
            actual = engine.command("asset.get", {"assetId": asset["id"]})
            assert actual["annotations"] == asset["annotations"]
        for export in after["exports"]:
            old_manifest = Path(export["path"]) / "manifest.json"
            assert hashlib.sha256(old_manifest.read_bytes()).hexdigest() == export["manifestHash"]
            reproduced = engine.command("export.reproduce", {"exportId": export["id"], "outputDir": str(outputs)})
            new_manifest = Path(reproduced["path"]) / "manifest.json"
            old = json.loads(old_manifest.read_text(encoding="utf-8"))
            new = json.loads(new_manifest.read_text(encoding="utf-8"))
            assert new["sourceExportId"] == export["id"]
            # 重导出有独立身份和创建时间，图片、标签、模板及划分内容必须相同。
            omitted = {"id", "createdAt", "sourceExportId"}
            assert {k: v for k, v in old.items() if k not in omitted} == {k: v for k, v in new.items() if k not in omitted}
            for file in old_manifest.parent.rglob("*"):
                if file.is_file() and file.name != "manifest.json":
                    # Ultralytics 读取后建立的索引缓存不是导出版本的固定内容。
                    if file.relative_to(old_manifest.parent).as_posix() in ("labels/train.cache", "labels/val.cache"):
                        continue
                    target = new_manifest.parent / file.relative_to(old_manifest.parent)
                    assert hashlib.sha256(file.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest()
        assert snapshot(restored)["attempts"] == before["attempts"], "恢复验收产生了新调用"
        report = {"passed": True, "sourceReadOnly": True, "counts": before["counts"],
                  "extendedCounts": before["extendedCounts"],
                  "migrationPreserved": True, "schemaBefore": original_snapshot["schemaVersion"],
                  "schemaAfter": before["schemaVersion"],
                  "taskTypes": sorted({label["type"] for asset in before["assets"].values() for label in asset["annotations"]}),
                  "unknownAttemptsPreserved": sum(row[1] == "unknown" for row in before["attempts"]),
                  "historicalExportsReproduced": len(after["exports"]), "credentialsInjected": False,
                  "newModelCalls": 0, "restoredDataDir": str(restored)}
        (directory / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"passed": True, "report": str(directory / "verification.json"), "counts": before["counts"], "newModelCalls": 0}))
    finally:
        engine.close()


if __name__ == "__main__":
    main()
