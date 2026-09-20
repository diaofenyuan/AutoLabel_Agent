"""构建期工具：把内置类别名用 CLIP 编码成文本向量，产出 inference/vocab/builtin.npz。

为什么需要它：开放词汇模型的类别名要先变成文本向量才能推理，而这一步默认要下载 350 MB 的
CLIP 编码器。常见类别名（COCO 80 类及其常用中文说法）在构建期先算好，用户不下载编码器也能直接用；
只有内置词表里没有的名字才需要编码器，届时明确提示，不静默联网。

用法（需要本机有 clip 与 CLIP 权重）：

    py -3.11 inference/tools/build_vocab.py --encoder <含 ViT-B-32.pt 的目录>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

# 规范词表（英文）。CLIP 的文本编码器只认英文：直接把中文名喂进去会被切成未知 token，
# 编码出来的向量没有意义（实测「人」查不到任何目标，而「person」能查到 5 个）。
# 因此中文名一律先映射到这里的英文规范名，再取它已经算好的向量。
CANONICAL_NAMES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog",
    "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich",
    "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
    "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
    # COCO 之外但标注现场常见的目标，用来承接下面的中文别名。
    "traffic sign", "helmet", "safety vest", "container", "dump truck", "tractor", "excavator",
    "crane", "bicycle rack", "street light", "billboard", "trash can", "wire pole", "fence",
    "stairs", "door", "window", "puddle", "wheelchair", "stroller", "fire truck", "license plate",
    # 桌面 / 摆件场景：手办、公仔这类目标是零样本标注里最常问的，且 CLIP 认不出中文名。
    "figurine", "action figure", "anime figure", "plush toy", "doll", "statue", "ornament",
    "figurine stand", "display case",
]
# 中文别名 → 英文规范名。别名本身不单独编码，用规范名的向量，检索效果与英文一致。
ALIASES = {
    "人": "person", "行人": "person", "人群": "person", "人脸": "person",
    "自行车": "bicycle", "单车": "bicycle", "汽车": "car", "轿车": "car", "小汽车": "car",
    "摩托车": "motorcycle", "电动车": "motorcycle", "飞机": "airplane", "船": "boat",
    "公交车": "bus", "巴士": "bus", "客车": "bus", "火车": "train", "火车车厢": "train",
    "卡车": "truck", "货车": "truck", "载重车": "dump truck", "自卸车": "dump truck",
    "拖拉机": "tractor", "挖掘机": "excavator", "塔吊": "crane", "起重机": "crane",
    "交通灯": "traffic light", "红绿灯": "traffic light", "信号灯": "traffic light",
    "交通标志": "traffic sign", "标志牌": "traffic sign", "停车标志": "stop sign",
    "消防栓": "fire hydrant", "车位": "parking meter", "长椅": "bench", "长凳": "bench",
    "鸟": "bird", "猫": "cat", "狗": "dog", "马": "horse", "羊": "sheep", "牛": "cow",
    "大象": "elephant", "熊": "bear", "斑马": "zebra", "长颈鹿": "giraffe",
    "背包": "backpack", "雨伞": "umbrella", "手提包": "handbag", "领带": "tie", "行李箱": "suitcase",
    "飞盘": "frisbee", "滑雪板": "skis", "滑板": "skateboard", "网球拍": "tennis racket",
    "瓶子": "bottle", "酒杯": "wine glass", "杯子": "cup", "叉子": "fork", "刀": "knife",
    "勺子": "spoon", "碗": "bowl", "香蕉": "banana", "苹果": "apple", "三明治": "sandwich",
    "橙子": "orange", "西兰花": "broccoli", "胡萝卜": "carrot", "热狗": "hot dog",
    "披萨": "pizza", "甜甜圈": "donut", "蛋糕": "cake", "椅子": "chair", "沙发": "couch",
    "盆栽": "potted plant", "绿植": "potted plant", "床": "bed", "餐桌": "dining table",
    "马桶": "toilet", "电视": "tv", "显示器": "tv", "笔记本电脑": "laptop", "鼠标": "mouse",
    "键盘": "keyboard", "手机": "cell phone", "微波炉": "microwave", "烤箱": "oven",
    "冰箱": "refrigerator", "水槽": "sink", "书": "book", "钟": "clock", "花瓶": "vase",
    "剪刀": "scissors", "玩具熊": "teddy bear", "吹风机": "hair drier", "牙刷": "toothbrush",
    "安全帽": "helmet", "头盔": "helmet", "反光背心": "safety vest", "集装箱": "container",
    "垃圾桶": "trash can", "广告牌": "billboard", "电线杆": "wire pole", "路灯": "street light",
    "围栏": "fence", "护栏": "fence", "楼梯": "stairs", "门": "door", "窗": "window",
    "积水": "puddle", "轮椅": "wheelchair", "婴儿车": "stroller", "车位锁": "bicycle rack",
    "消防车": "fire truck", "救火车": "fire truck",
    # 界面侧同义词表（shared/vocabulary.ts）里已经有、但这里以前缺的常见叫法：
    # 缺了它们，本机路径就只剩「下载编码器」一条路，而实际上英文规范名早就在词表里。
    "车辆": "car", "机动车": "car", "汽车": "car", "越野车": "car",
    "单车": "bicycle", "列车": "train", "火车车厢": "train", "船舶": "boat", "轮船": "boat",
    "客机": "airplane", "指示牌": "traffic sign", "座椅": "chair", "犬": "dog", "面部": "person",
    "号牌": "license plate", "安全背心": "safety vest",
    # 桌面 / 摆件场景：中文名一律先映射到英文规范名，CLIP 不会去编码中文。
    "手办": "figurine", "手办模型": "figurine", "人偶": "figurine", "小人偶": "figurine",
    "可动人偶": "action figure", "黏土人": "figurine", "粘土人": "figurine",
    "公仔": "plush toy", "毛绒公仔": "plush toy", "毛绒玩具": "plush toy", "毛绒玩偶": "plush toy",
    "玩偶": "doll", "布偶": "doll", "娃娃": "doll",
    "摆件": "ornament", "雕像": "statue", "塑像": "statue", "桌面摆件": "ornament",
    "展示盒": "display case", "防尘罩": "display case",
}


def validate_tables() -> list[str]:
    names = list(dict.fromkeys(CANONICAL_NAMES))
    unknown = sorted({target for target in ALIASES.values() if target not in names})
    if unknown:
        raise SystemExit(f"别名指向了规范词表里没有的名字：{unknown}")
    return names


def write_aliases(output: Path) -> None:
    """把「中文别名 → 英文规范名」单独落成 JSON。

    worker 会在取向量之前先查这张表：这样「车辆 → car」这类名字不用等 npz 重建、也不用下载编码器就能用，
    而不在表里的中文名仍然会被明确拒绝（CLIP 编码中文得到的是没有意义的向量）。
    这张表不依赖 torch / CLIP，构建机上没有权重也能重新生成。
    """
    names = validate_tables()
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "canonicalNames": names, "aliases": {name: ALIASES[name] for name in sorted(ALIASES)}}
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"别名表已生成：{output}（{len(ALIASES)} 条中文别名 → {len(names)} 个英文规范名，不需要 CLIP 权重）")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成内置开放词汇词表（inference/vocab/builtin.npz）与别名表（inference/vocab/aliases.json）")
    parser.add_argument("--encoder", default="", help="包含 ViT-B-32.pt 的目录（CLIP 权重所在处）")
    parser.add_argument("--aliases-only", action="store_true", help="只重新生成别名表（不需要 CLIP 权重）")
    parser.add_argument("--output", default=str(Path(__file__).resolve().parent.parent / "vocab" / "builtin.npz"))
    args = parser.parse_args()

    aliases_output = Path(args.output).with_name("aliases.json")
    write_aliases(aliases_output)
    if args.aliases_only:
        return 0

    import numpy
    import torch
    import clip

    names = validate_tables()
    if not args.encoder:
        raise SystemExit("重建向量词表需要 --encoder（包含 ViT-B-32.pt 的目录）；只要别名表请加 --aliases-only")
    encoder = Path(args.encoder)
    if not (encoder / "ViT-B-32.pt").is_file():
        raise SystemExit(f"没有找到 CLIP 权重：{encoder / 'ViT-B-32.pt'}")
    model, _ = clip.load("ViT-B/32", device="cpu", download_root=str(encoder))
    with torch.no_grad():
        tokens = clip.tokenize(names)
        embeddings = model.encode_text(tokens).float().numpy()
    # 必须与 ultralytics 的文本编码器保持一致：它会把向量做 L2 归一化（nn/text_model.py），
    # 而 OpenAI 原始 encode_text 不归一化。少了这一步，向量量纲差一倍，模型一个目标都框不出来。
    norms = numpy.linalg.norm(embeddings, axis=-1, keepdims=True)
    if not numpy.allclose(norms, 1, atol=1e-3):
        embeddings = embeddings / norms
    if embeddings.shape != (len(names), 512):
        raise SystemExit(f"文本向量形状异常：{embeddings.shape}")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    numpy.savez_compressed(output, names=numpy.asarray(names), embeddings=embeddings.astype("float32"),
                           alias_names=numpy.asarray(sorted(ALIASES)), alias_targets=numpy.asarray([ALIASES[name] for name in sorted(ALIASES)]))
    print(f"内置词表已生成：{output}（{len(names)} 个规范名 + {len(ALIASES)} 条中文别名，{output.stat().st_size // 1024} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
