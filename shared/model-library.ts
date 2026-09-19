import type { TaskType } from './protocol.ts';

/**
 * 内置模型目录：模型库的唯一声明源。
 *
 * 界面、桌面主进程与打包脚本都从这里读同一份清单，避免出现「列表里有的模型装不上、
 * 装上的模型列表里没有」这类只在交付时才暴露的偏差。权重在打包前由 scripts/desktop-models.mjs
 * 按 sha256 校验，校验不通过就不产出安装包。
 *
 * 分发方式分两档：
 * - `bundled`：随安装包一起提供（<安装目录>/resources/models），用户点一下就能用，不花流量；
 * - `download`：体积较大或只在大模型上才需要，由用户在模型库里显式点击后下载到 <存储根>/models。
 *   任何情况下都不会自动联网下载。
 */
export interface CatalogModel {
  /** 稳定标识，界面命令与存储目录名都用它。 */
  id: string;
  /** 中文显示名。 */
  name: string;
  /** 任务类型；文本编码器不属于任务模型，为 null。 */
  taskType: TaskType | null;
  /** 开放词汇模型：类别由文本提示（textClasses）决定，而不是模型自带的固定类别表。 */
  openVocabulary: boolean;
  /** 权重文件名，落地目录与打包目录都用同一个名字。 */
  fileName: string;
  sizeBytes: number;
  /** 权重的 sha256；下载完成后逐字节核对，文件被改动即视为不可用。 */
  sha256: string;
  tier: 'bundled' | 'download';
  /** 列表分组标题，同组的模型排在一起。 */
  group: string;
  /** 官方下载地址。 */
  downloadUrl: string;
  /** 备用下载地址，按顺序尝试；内容与官方一致，最终以 sha256 为准。 */
  mirrorUrls: string[];
  license: string;
  /** 一句话说明这个模型适合什么场景，首次出现时给不懂术语的人一个直白解释。 */
  note: string;
}

const RELEASE = 'https://github.com/ultralytics/assets/releases/download/v8.3.0';
/** 国内网络直连 GitHub 常超时；下面几个中转地址内容相同，最终仍以 sha256 判定真伪。 */
const mirrors = (file: string) => [
  `https://ghfast.top/${RELEASE}/${file}`,
  `https://gh-proxy.com/${RELEASE}/${file}`,
  `https://ghproxy.net/${RELEASE}/${file}`,
];

const ultralytics = (file: string): { downloadUrl: string; mirrorUrls: string[] } => ({ downloadUrl: `${RELEASE}/${file}`, mirrorUrls: mirrors(file) });
const ULTRALYTICS_LICENSE = 'AGPL-3.0（Ultralytics）';

/** CLIP 文本编码器：YOLO-World 用它把类别名编码成文本向量。原文件来自 OpenAI CLIP 官方发布。 */
const CLIP_ENCODER_URL = 'https://openaipublic.azureedge.net/clip/models/40d365715913c9da98579312b702a82c18be219cc2a73407c4526f58eba950af/ViT-B-32.pt';

export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'yolov8s-worldv2', name: 'YOLO-World v2 S（开放词汇）', taskType: 'detect', openVocabulary: true,
    fileName: 'yolov8s-worldv2.pt', sizeBytes: 25923032, sha256: '9b2c17ab6124a913e9b3a5c170617920d91b0f01111a8479da69f00e2cf27792', tier: 'bundled', group: '开放词汇',
    ...ultralytics('yolov8s-worldv2.pt'), license: ULTRALYTICS_LICENSE,
    note: '开放词汇检测：类别不写死在模型里，你在对话里写「人 / 汽车 / 交通标志」就能按这些词去框。本机运行，不产生接口费用。' },
  { id: 'yolov8m-worldv2', name: 'YOLO-World v2 M（开放词汇）', taskType: 'detect', openVocabulary: true,
    fileName: 'yolov8m-worldv2.pt', sizeBytes: 57233192, sha256: 'b614d33aa35b8e61d988041ff6939dfb3ed627af88ccaf643e4cdb822eb41d71', tier: 'download', group: '开放词汇',
    ...ultralytics('yolov8m-worldv2.pt'), license: ULTRALYTICS_LICENSE,
    note: '与 S 同族但更大：小目标与复杂场景通常更准，速度更慢、需要下载约 55 MB。' },
  { id: 'clip-vit-b32', name: 'CLIP 文本编码器 ViT-B/32', taskType: null, openVocabulary: true,
    fileName: 'ViT-B-32.pt', sizeBytes: 353976522, sha256: '40d365715913c9da98579312b702a82c18be219cc2a73407c4526f58eba950af', tier: 'download', group: '文本编码器',
    downloadUrl: CLIP_ENCODER_URL, mirrorUrls: [], license: 'MIT（OpenAI CLIP）',
    note: '把类别名转成模型能读的文本向量。只在类别名不在内置词表里时才需要，一次下载长期复用；没有它时不会偷偷联网，而是明确提示。' },
  { id: 'yolo11n', name: 'YOLO11n 通用检测', taskType: 'detect', openVocabulary: false,
    fileName: 'yolo11n.pt', sizeBytes: 5613764, sha256: '0ebbc80d4a7680d14987a577cd21342b65ecfd94632bd9a8da63ae6417644ee1', tier: 'bundled', group: '通用检测',
    ...ultralytics('yolo11n.pt'), license: ULTRALYTICS_LICENSE,
    note: '最常用的目标检测模型，能框出 80 种常见物体；体积小、CPU 上也能跑。' },
  { id: 'yolo11s', name: 'YOLO11s 通用检测', taskType: 'detect', openVocabulary: false,
    fileName: 'yolo11s.pt', sizeBytes: 19313732, sha256: '85a76fe86dd8afe384648546b56a7a78580c7cb7b404fc595f97969322d502d5', tier: 'download', group: '通用检测',
    ...ultralytics('yolo11s.pt'), license: ULTRALYTICS_LICENSE,
    note: '与 n 同族但更大：精度更高、速度更慢，需要下载约 18 MB。' },
  { id: 'yolo11n-seg', name: 'YOLO11n 实例分割', taskType: 'segment', openVocabulary: false,
    fileName: 'yolo11n-seg.pt', sizeBytes: 6182636, sha256: '55ed65c56c91713d23e8402371c6c49a6fd84f257f7dce452e8d70e41dcbe152', tier: 'bundled', group: '实例分割',
    ...ultralytics('yolo11n-seg.pt'), license: ULTRALYTICS_LICENSE,
    note: '除了矩形框，还会沿着物体轮廓勾出每个像素范围。' },
  { id: 'yolo11n-pose', name: 'YOLO11n 关键点', taskType: 'pose', openVocabulary: false,
    fileName: 'yolo11n-pose.pt', sizeBytes: 6255593, sha256: '869e83fcdffdc7371fa4e34cd8e51c838cc729571d1635e5141e3075e9319dc0', tier: 'bundled', group: '关键点',
    ...ultralytics('yolo11n-pose.pt'), license: ULTRALYTICS_LICENSE,
    note: '识别人体的 17 个骨骼关键点（肩、肘、腕、膝等），用于姿态类标注。' },
  { id: 'yolo11n-obb', name: 'YOLO11n 旋转框', taskType: 'obb', openVocabulary: false,
    fileName: 'yolo11n-obb.pt', sizeBytes: 5795654, sha256: 'b62898ebf38940ca4df323863e45ee9d84a1a46d5d11ebdde529fb33aa9f3a32', tier: 'bundled', group: '旋转框',
    ...ultralytics('yolo11n-obb.pt'), license: ULTRALYTICS_LICENSE,
    note: '用带角度的矩形框住目标，适合航拍、遥感里斜着摆放的物体。' },
  { id: 'yolo11n-cls', name: 'YOLO11n 图像分类', taskType: 'classify', openVocabulary: false,
    fileName: 'yolo11n-cls.pt', sizeBytes: 5790624, sha256: 'c62d41bf9625777760018bf914d2e6cd472420ccd01706d97a61cb6c82502bd7', tier: 'bundled', group: '图像分类',
    ...ultralytics('yolo11n-cls.pt'), license: ULTRALYTICS_LICENSE,
    note: '给整张图判一个类别，不框位置。' },
];

/** 分组显示顺序：先能直接用的常用模型，再放按需下载的大件。 */
export const MODEL_GROUP_ORDER = ['通用检测', '开放词汇', '实例分割', '关键点', '旋转框', '图像分类', '文本编码器'];

/** 内置权重合计体积上限；超过它安装包体积会明显变大，打包前直接拦下。 */
export const BUNDLED_MODEL_BUDGET_BYTES = 60 * 1024 * 1024;

export const MODEL_CATALOG_BY_ID: Map<string, CatalogModel> = new Map(MODEL_CATALOG.map(model => [model.id, model]));

export function catalogModel(catalogId: string): CatalogModel | undefined {
  return MODEL_CATALOG_BY_ID.get(catalogId);
}

export function bundledModels(): CatalogModel[] {
  return MODEL_CATALOG.filter(model => model.tier === 'bundled');
}

export function bundledModelBytes(): number {
  return bundledModels().reduce((total, model) => total + model.sizeBytes, 0);
}

/** 按目录顺序分组，供界面直接渲染，避免界面各自排序导致两处顺序不一致。 */
export function catalogGroups(): Array<{ group: string; models: CatalogModel[] }> {
  const groups = new Map<string, CatalogModel[]>();
  for (const model of MODEL_CATALOG) groups.set(model.group, [...(groups.get(model.group) ?? []), model]);
  return [...groups.entries()].sort(([left], [right]) => MODEL_GROUP_ORDER.indexOf(left) - MODEL_GROUP_ORDER.indexOf(right))
    .map(([group, models]) => ({ group, models }));
}

export type ModelEntryState = 'ready' | 'missing' | 'corrupt';
export type ModelLocation = 'builtin' | 'storage';

/** 单个模型在库里的实际情况；`state` 为结果，`message` 说明为什么没就绪、下一步做什么。 */
export interface ModelLibraryEntry {
  id: string; name: string; group: string; taskType: TaskType | null; openVocabulary: boolean;
  tier: 'bundled' | 'download'; fileName: string; sizeBytes: number; sha256: string; license: string; note: string;
  state: ModelEntryState;
  /** 就绪时的来源：随安装包提供，或已下载到用户存储目录。 */
  location: ModelLocation | null;
  /** 磁盘上的实际大小；与目录不一致时界面能直接说明差在哪。 */
  actualBytes: number;
  message?: string;
}

/** 下载进度：界面据此显示已下载多少，而不是一个不知道还要多久的转圈。 */
export interface ModelLibraryProgress {
  catalogId: string;
  fileName: string;
  receivedBytes: number;
  totalBytes: number;
}

export interface ModelLibraryState {
  /** 内置权重目录：<安装目录>/resources/models。 */
  builtinRoot: string;
  /** 用户态模型目录：<存储根>/models；下载的模型与文本编码器都落在这里。 */
  modelsRoot: string;
  entries: ModelLibraryEntry[];
  ready: number;
  total: number;
  /** 内置权重的目录体积合计；界面用它说明「内置模型占多大」。 */
  bundledBytes: number;
}

export function formatModelBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
