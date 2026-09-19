"""开放词汇（YOLO-World）端到端验收：load → predict 用中文类别名跑通，且三级词表都能兑现。

覆盖四件事，每一件都对应一条用户可见的承诺：
1. 内置词表命中：不下载 CLIP 也能用「人 / 汽车 / 交通标志」这类常用名，`vocabularySource` 为 builtin；
2. 第二次同样的类别名走缓存（`cache`），证明没有重复编码；
3. 词表里没有的**中文**类别名 → 必须报 `vocabulary_term_needs_english`（CLIP 只认英文，下载编码器也不生效）；
4. 词表里没有的**英文**类别名 + 本机没有编码器 → 必须报 `vocabulary_encoder_missing`，且不新建任何文件（不联网）；
5. 编码器就位时，未命中的英文类别名可以现场编码（`encoded`），并写回缓存。

用法：

    py -3.11 inference/validate_vocabulary.py <模型.pt> <图片.jpg> [--encoder <含 ViT-B-32.pt 的目录>]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

WORKER = Path(__file__).resolve().parent / "worker.py"
CLASSES = ["人", "汽车", "交通标志"]
# 未命中内置词表的中文名：CLIP 只认英文，必须报「需要英文名」——下载编码器也救不了。
NOVEL_CHINESE = ["街角的邮筒", "蒸汽机车锅炉"]
# 未命中内置词表的英文名：没有编码器时报 vocabulary_encoder_missing，有编码器时现场编码并写回缓存。
NOVEL = ["lampshade", "steam locomotive"]


def main() -> int:
    parser = argparse.ArgumentParser(description="开放词汇推理验收")
    parser.add_argument("model", help="YOLO-World 权重（.pt）")
    parser.add_argument("image", help="测试图片（.jpg/.png）")
    parser.add_argument("--encoder", default="", help="含 ViT-B-32.pt 的目录；缺省用空目录验证「没有编码器」分支")
    args = parser.parse_args()

    model, image = Path(args.model).resolve(), Path(args.image).resolve()
    for path in (model, image):
        if not path.is_file():
            raise SystemExit(f"缺少夹具：{path}")
    workspace = Path(tempfile.mkdtemp(prefix="autolabel-vocabulary-"))
    cache = workspace / "vocab-cache"
    encoder = Path(args.encoder).resolve() if args.encoder else workspace / "text-encoder"
    encoder.mkdir(parents=True, exist_ok=True)

    environment = {**os.environ, "YOLO_AUTOINSTALL": "false", "YOLO_VERBOSE": "false", "PYTHONUTF8": "1",
                   "AUTOLABEL_VOCAB_CACHE": str(cache), "AUTOLABEL_TEXT_ENCODER": str(encoder)}
    process = subprocess.Popen([sys.executable, "-u", str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, cwd=str(WORKER.parent), env=environment, text=True, encoding="utf-8")
    counter = 0

    def request(command: str, payload: dict) -> dict:
        nonlocal counter
        counter += 1
        process.stdin.write(json.dumps({"id": f"v{counter}", "command": command, "payload": payload}, ensure_ascii=False) + "\n")
        process.stdin.flush()
        while True:
            line = process.stdout.readline()
            if not line:
                raise SystemExit(f"worker 未响应 {command}；stderr：{process.stderr.read()[-2000:]}")
            message = json.loads(line)
            if message.get("type") == "ready":
                continue
            if message.get("type") == "event":
                continue
            if message.get("type") != "response" or message.get("id") != f"v{counter}":
                raise SystemExit(f"协议异常：{message}")
            if not message.get("ok"):
                error = message["error"]
                return {"__error__": error.get("code"), "message": error.get("message")}
            return message["data"]

    def expect_error(result: dict, code: str, note: str) -> None:
        if result.get("__error__") != code:
            raise SystemExit(f"{note}：期望 {code}，实际 {json.dumps(result, ensure_ascii=False)}")

    try:
        ready = json.loads(process.stdout.readline())
        assert ready.get("type") == "ready", ready
        loaded = request("load", {"modelPath": str(model), "taskType": "detect", "device": "cpu", "openVocabulary": True})
        assert loaded.get("openVocabulary") is True, f"载入响应未标记开放词汇：{loaded}"
        assert len(loaded["classes"]) > 0, "开放词汇模型应返回自带类别表"

        first = request("predict", {"imagePath": str(image), "assetId": "vocabulary-check", "confidence": 0.25,
                                    "classMap": {str(index): name for index, name in enumerate(CLASSES)}, "textClasses": CLASSES})
        if first.get("__error__"):
            raise SystemExit(f"常用中文类别名应当直接可用，实际失败：{json.dumps(first, ensure_ascii=False)}")
        assert first.get("vocabularySource") == "builtin", f"常用中文类别名应命中内置词表：{first.get('vocabularySource')}"
        assert isinstance(first.get("vocabularyHash"), str) and len(first["vocabularyHash"]) == 64, "缺少词表摘要"
        labels = {item["classId"] for item in first["annotations"]}
        assert labels <= set(CLASSES), f"标注引用了未请求的类别：{labels}"
        assert first["width"] > 0 and first["height"] > 0

        second = request("predict", {"imagePath": str(image), "assetId": "vocabulary-check", "confidence": 0.25,
                                     "classMap": {str(index): name for index, name in enumerate(CLASSES)}, "textClasses": CLASSES})
        assert second.get("vocabularySource") == "cache", f"第二次应命中缓存：{second.get('vocabularySource')}"
        # 标注 id 每次都是新的 uuid，比较的是「框在哪、属于哪一类、多少分」这些真正影响结果的字段。
        def geometry(data: dict) -> list:
            return sorted((item["classId"], round(item.get("confidence", 0), 6),
                           tuple(sorted((key, round(value, 4)) for key, value in (item.get("bbox") or {}).items())))
                          for item in data["annotations"])
        assert geometry(second) == geometry(first), "同一张图与同一份类别名必须得到同样的框"

        # 中文新词：不论有没有编码器都必须明确拒绝，并指出改填英文名。
        blockedChinese = request("predict", {"imagePath": str(image), "assetId": "vocabulary-check", "confidence": 0.25,
                                            "classMap": {str(index): name for index, name in enumerate(NOVEL_CHINESE)}, "textClasses": NOVEL_CHINESE})
        expect_error(blockedChinese, "vocabulary_term_needs_english", "中文新词必须明确报「需要英文名」，不能静默编码成无意义的向量")
        assert "英文名" in str(blockedChinese.get("error", {}).get("message", "")), "中文新词的失败原因要指出改填英文名"

        encoded = None
        if not args.encoder:
            blocked = request("predict", {"imagePath": str(image), "assetId": "vocabulary-check", "confidence": 0.25,
                                          "classMap": {str(index): name for index, name in enumerate(NOVEL)}, "textClasses": NOVEL})
            expect_error(blocked, "vocabulary_encoder_missing", "英文新词在本机没有编码器时必须明确报错而不是联网")
            assert sorted(path.name for path in cache.glob("*.npz")) == [f"{first['vocabularyHash']}.npz"], "失败请求不得留下缓存文件"
        else:
            encoded = request("predict", {"imagePath": str(image), "assetId": "vocabulary-check", "confidence": 0.25,
                                          "classMap": {str(index): name for index, name in enumerate(NOVEL)}, "textClasses": NOVEL})
            assert encoded.get("vocabularySource") == "encoded", f"编码器就位时应现场编码：{encoded.get('vocabularySource')}"
            cached = request("predict", {"imagePath": str(image), "assetId": "vocabulary-check", "confidence": 0.25,
                                         "classMap": {str(index): name for index, name in enumerate(NOVEL)}, "textClasses": NOVEL})
            assert cached.get("vocabularySource") == "cache", "现场编码过的词表应写回缓存"

        print(json.dumps({"model": model.name, "classes": len(loaded["classes"]), "firstSource": first["vocabularySource"],
                          "secondSource": second["vocabularySource"], "annotations": len(first["annotations"]),
                          "labels": sorted(labels), "encoderMissingRejected": not args.encoder,
                          "encodedSource": None if encoded is None else encoded["vocabularySource"],
                          "cacheFiles": sorted(path.name for path in cache.glob("*.npz"))}, ensure_ascii=False))
        return 0
    finally:
        try:
            process.stdin.write(json.dumps({"id": "shutdown", "command": "shutdown", "payload": {}}) + "\n")
            process.stdin.flush()
        except Exception:
            pass
        process.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
