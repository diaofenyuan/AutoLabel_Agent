"""使用本机实际 Ultralytics 加载器核对导出版本，不启动训练或推理。"""
import argparse
import json
from pathlib import Path

import yaml
from ultralytics.cfg import get_cfg
from ultralytics.data.dataset import ClassificationDataset, YOLODataset


def validate(directory: Path) -> dict:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    task = manifest["taskType"]
    assets = manifest["assets"]
    classes = manifest["classes"]
    if not assets:
        raise AssertionError("导出版本没有素材")
    args = get_cfg(overrides={"imgsz": 640, "cache": False, "workers": 0})
    if task != "classify":
        data = yaml.safe_load((directory / "data.yaml").read_text(encoding="utf-8"))
        assert len(data["names"]) == len(classes), "类别表与导出清单不一致"
        if task == "pose":
            assert data["kpt_shape"] == [len(manifest["keypointNames"]), 3]
    result = {"path": str(directory), "task": task, "splits": {}}
    for split in ("train", "val"):
        expected = [asset for asset in assets if asset["split"] == split]
        if not expected:
            result["splits"][split] = {"samples": 0, "loaded": False, "reason": "此版本在该划分没有样本"}
            continue
        if task == "classify":
            dataset = ClassificationDataset(str(directory / split), args, augment=False)
        else:
            dataset = YOLODataset(
                img_path=str(directory / "images" / split), imgsz=640, batch_size=1,
                augment=False, hyp=args, rect=False, cache=False, stride=32, data=data, task=task,
            )
        assert len(dataset) == len(expected), f"{task}/{split}：加载器丢弃了样本"
        object_count = 0
        for index in range(len(dataset)):
            item = dataset[index]
            assert tuple(item["img"].shape) == (3, 640, 640), "图片未正确解码为训练张量"
            if task == "classify":
                assert 0 <= int(item["cls"]) < len(classes)
                object_count += 1
            else:
                object_count += len(item["cls"])
                if task == "pose":
                    assert item["keypoints"].shape[1:] == (len(manifest["keypointNames"]), 3)
        expected_count = sum(len(asset["annotations"]) for asset in expected)
        assert object_count == expected_count, f"{task}/{split}：标注对象在加载中丢失"
        result["splits"][split] = {"samples": len(dataset), "objects": object_count, "loaded": True}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datasets", nargs="+", type=Path, help="包含 manifest.json 的导出版本目录")
    options = parser.parse_args()
    for dataset_path in options.datasets:
        print(json.dumps(validate(dataset_path.resolve()), ensure_ascii=False))
