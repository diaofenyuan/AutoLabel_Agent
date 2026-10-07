export interface VideoTimeRange { start: number; end: number }

/** 引擎接受的时间段终点上限；超过该值的长视频需要在界面中分段处理。 */
export const VIDEO_MAX_RANGE_SECONDS = 604800;

export interface VideoOutputSize {
  width: number;
  height: number;
  fit?: 'contain' | 'stretch';
}

interface VideoExtractionOptions {
  /** 相对于首个实际解码帧的秒数，范围为左闭右开且不能重叠。 */
  ranges: VideoTimeRange[];
  outputSize?: VideoOutputSize;
  format?: 'png' | 'jpg';
  jpegQuality?: number;
  streamIndex?: number;
  maxFrames?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export type VideoExtractionParameters = VideoExtractionOptions & (
  | { mode: 'interval'; intervalSeconds: number; everyNFrames?: never; targetFps?: never; sceneThreshold?: never; minIntervalSeconds?: never }
  | { mode: 'every_n'; everyNFrames: number; intervalSeconds?: never; targetFps?: never; sceneThreshold?: never; minIntervalSeconds?: never }
  | { mode: 'fps'; targetFps: number; intervalSeconds?: never; everyNFrames?: never; sceneThreshold?: never; minIntervalSeconds?: never }
  /** 场景变化抽帧：画面明显变化才留帧，相近的帧自动跳过；首帧必留，帧数由内容决定。 */
  | { mode: 'scene'; sceneThreshold?: number; minIntervalSeconds?: number; intervalSeconds?: never; everyNFrames?: never; targetFps?: never }
);

/** 采样密度档位：把「采样模式 + 自由数值」收敛为首屏的五选一，自定义才展开原有模式。 */
export type VideoDensity = 'scene' | 'dense' | 'standard' | 'sparse' | 'custom';
export const VIDEO_DENSITY_SECONDS: Record<Exclude<VideoDensity, 'custom' | 'scene'>, number> = { dense: 0.5, standard: 1, sparse: 2 };
export const VIDEO_DENSITY_LABELS: Record<VideoDensity, string> = { scene: '场景变化（推荐）', dense: '每 0.5 秒一帧', standard: '每 1 秒一帧', sparse: '每 2 秒一帧', custom: '自定义…' };
/** 场景变化档的推荐值：候选帧与上一张保留帧的灰度差异（0～1）达到阈值才留下；minIntervalSeconds 是取样间隔，也保证保留帧的最小间隔（首帧必留）。 */
export const VIDEO_SCENE_THRESHOLD = 0.15;
export const VIDEO_SCENE_MIN_INTERVAL_SECONDS = 1;
/**
 * 场景抽帧两个参数的允许范围。
 *
 * 桌面校验与助手工具共用同一份口径：引擎 VideoFrames/MediaJobs 里这两个范围是硬约束，
 * 若 TS 两层各写一份字面量，任何一边改了范围就会出现「界面能提交、助手被拒」或反向的假失败。
 */
export const VIDEO_SCENE_THRESHOLD_RANGE = { min: 0.05, max: 1 } as const;
export const VIDEO_SCENE_MIN_INTERVAL_RANGE = { min: 0.001, max: 600 } as const;

/** 引擎单次抽帧上限，与 VideoFrames.java 的 maxFrames 默认值一致；超过就整单失败，所以在 UI 侧提前拦截。 */
export const VIDEO_MAX_FRAMES = 10000;

/**
 * 默认降采样阈值与目标长边（单个抽帧面板与一键抽帧共用同一组默认值）。
 * 走查的对照测试证明体积不是超时的主因（4 MiB 与 100 KB 的失败率都约 70%），
 * 但它确实是放大项：先按住最容易放大问题的那个因素，同时不把「降采样」当成重试出口的替代品。
 */
export const VIDEO_DOWNSAMPLE_THRESHOLD = 1600;
export const VIDEO_DOWNSAMPLE_LONG_EDGE = 1024;

/**
 * 抽帧配方：固化「同一类素材往往会重复选择」的那部分选项。
 *
 * 由引擎按 kind 分类保存，跟随数据目录与备份一起走；内置推荐配方的 id 带 `builtin:` 前缀，只存在于
 * 引擎代码里，不入库。数值字段是数字而不是表单字符串 —— 存储层不该承担界面取值的形态。
 * 时间范围不进来（随每段视频变化）；taskType 与 classNames 是「这条配方面向什么标注」的可空意图，
 * 供界面与当前项目核对，不参与抽帧本身。
 */
export interface VideoExtractionRecipe {
  id: string;
  kind: 'video_extract';
  name: string;
  builtin: boolean;
  version: number;
  density: VideoDensity;
  customMode: 'interval' | 'every_n' | 'fps';
  customValue: number;
  resize: boolean;
  width: number;
  height: number;
  fit: 'contain' | 'stretch';
  format: 'png' | 'jpg';
  quality: number;
  /** 配方面向的标注任务；null 表示不限。 */
  taskType: string | null;
  /** 类别集按名称记录：类别 id 是项目内的，换项目就对不上。 */
  classNames: string[];
  note: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 保存配方的载荷：名称必填，其余缺省值由引擎补齐；带 id 时走向更新分支。 */
export type VideoRecipeDraft = {
  name: string; id?: string; baseVersion?: number;
} & Partial<Pick<VideoExtractionRecipe,
  'density' | 'customMode' | 'customValue' | 'resize' | 'width' | 'height' | 'fit' | 'format' | 'quality' | 'taskType' | 'classNames' | 'note'>>;

export interface ScreeningParameters {
  deduplicate?: boolean;
  nearEnabled?: boolean;
  blurEnabled?: boolean;
  nearMaxDistance?: number;
  aspectRatioTolerance?: number;
  maxComparisons?: number;
  maxPairs?: number;
  /** 缩小分析图的 Laplacian 方差阈值，仅作为需检查提示。 */
  blurThreshold?: number;
}

export interface MediaRuntimeState {
  configured: boolean;
  ffmpegConfigured: boolean;
  ffprobeConfigured: boolean;
  busy: boolean;
}

/** 分子分母须为安全整数；PTS 使用字符串，避免经过 JSON 后失去时间身份。 */
export interface MediaTimeBase { numerator: number; denominator: number }

export interface VideoInspection {
  sourceName: string;
  sourceVideoId: string;
  sourceHash: string;
  streamIndex: number;
  width: number;
  height: number;
  durationSeconds: number | null;
  reportedFrameRate: string | null;
  reportedFrameCount: number | null;
  timeBase: MediaTimeBase;
  sampleAspectRatioAssumed: boolean;
  geometryNotice: string | null;
}

export interface VideoCreateRequest {
  projectId: string;
  sourcePath: string;
  expectedSourceHash?: string;
  parameters: VideoExtractionParameters;
}

export interface ScreeningCreateRequest {
  projectId: string;
  assetIds?: string[];
  parameters: ScreeningParameters;
}

/**
 * 媒体任务类型：抽帧、图像筛选，以及大批量导入转成的后台任务。
 *
 * 三种任务同库同列表，读列表的一方（桌面校验、助手工具、界面）必须认识全部取值，
 * 否则一个批量导入任务就能让整页读取失败或显示成别的类型。这里保持唯一真源。
 */
export const MEDIA_JOB_KINDS = ['video_extract', 'image_screening', 'asset_import'] as const;
export type MediaJobKind = (typeof MEDIA_JOB_KINDS)[number];

/** 运行期收窄：引擎返回的类型未知，读列表/详情前必须显式判定。 */
export function isMediaJobKind(value: unknown): value is MediaJobKind {
  return typeof value === 'string' && (MEDIA_JOB_KINDS as readonly string[]).includes(value);
}

export type MediaJobStatus = 'queued' | 'running' | 'cancelling' | 'cancelled'
  | 'completed' | 'failed' | 'interrupted';
export type MediaJobStage = 'queued' | 'inspecting' | 'extracting' | 'validating'
  | 'ready' | 'importing' | 'screening' | 'done';

export interface MediaProgress {
  phase: string;
  completed: number;
  total: number | null;
  completedFrames?: number;
  decodedFrames?: number;
  sourceTimeSeconds?: number;
  outputBytes?: number;
  /** 后台批量导入逐个文件统计：跳过（已在项目里）与失败（坏图、读不了）分开记。 */
  skipped?: number;
  errors?: number;
}

/** 后台批量导入任务的参数：方式与总数；具体文件清单由引擎保管，不进任务行也不外露。 */
export interface AssetImportParameters {
  mode: 'copy' | 'reference';
  total: number;
}

/**
 * 后台批量导入的结果摘要。
 *
 * 与抽帧不同，这类任务边导边分批入库，没有「产物封存」这一步：completed 即表示这批已处理完，
 * 真实结果看 imported/skipped/errorsTotal。失败/取消时会带 partial 标记，说明已入库的部分保留。
 */
export interface AssetImportSummary {
  imported: number;
  skipped: number;
  errorsTotal: number;
  total: number;
  /** 完整错误清单在任务目录中的文件名；仅当错误超过 50 条时才有。 */
  errorsFile?: string;
  partial?: boolean;
}

interface MediaJobState {
  id: string;
  projectId: string;
  status: MediaJobStatus;
  stage: MediaJobStage;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  canCancel: boolean;
  canRetry: boolean;
  artifactCommitted: boolean;
  assetsCommitted: boolean;
  canImport: boolean;
  originalJobId?: string;
  sourceVideoId?: string;
  sourceName?: string;
  progress: MediaProgress;
  summary?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export type MediaJob = MediaJobState & (
  | { kind: 'video_extract'; parameters: VideoExtractionParameters }
  | { kind: 'image_screening'; parameters: ScreeningParameters }
  | { kind: 'asset_import'; parameters: AssetImportParameters; summary?: AssetImportSummary }
);

export interface MediaJobListRequest {
  projectId?: string;
  kind?: MediaJobKind;
  limit?: number;
  offset?: number;
}
export interface MediaJobList { items: MediaJob[]; total: number }

export interface VideoFrame {
  frameId: string;
  assetId?: string;
  contentHash: string;
  width: number;
  height: number;
  bytes: number;
  sourceVideoId: string;
  sourceHash: string;
  streamIndex: number;
  sourcePresentationIndex: number;
  sourcePts: string;
  originPts: string;
  relativePts: string;
  timeBase: MediaTimeBase;
  timeSeconds: number;
  rangeIndex: number;
  bucketIndex: number | null;
  codedVideoToFrame: [number, number, number, number, number, number];
  selectionVersion: string;
}
export interface VideoFrameList { items: VideoFrame[]; total: number }

export type ScreeningRecommendation = 'keep' | 'keep_protected' | 'review_suggested' | 'exclude_suggested';
export interface ScreeningReason {
  code: string;
  requiresReview?: boolean;
  [key: string]: unknown;
}
export interface ScreeningFeature {
  featureVersion: string;
  contentHash: string;
  width: number;
  height: number;
  normalizationVersion: string;
  inputVersion: number;
  dHash64: string;
  laplacianVariance: number | null;
  analysisWidth: number;
  analysisHeight: number;
  laplacianSamples: number;
  grayStdDev: number;
}
export interface ScreeningItem {
  assetId: string;
  input: Record<string, unknown>;
  feature: ScreeningFeature;
  protected: boolean;
  recommendation: ScreeningRecommendation;
  reasons: ScreeningReason[];
  exactRepresentativeAssetId?: string;
}
export interface ScreeningExactGroup {
  contentHash: string;
  representativeAssetId: string;
  members: string[];
  partitions: string[];
  crossPartition: boolean;
}
export interface ScreeningSourceGroup {
  kind: 'sourceVideoId' | 'groupId';
  sourceId: string;
  members: string[];
  representativeAssetId: string;
  partitions: string[];
  requiresReview: true;
}
export interface ScreeningNearPair {
  leftAssetId: string;
  rightAssetId: string;
  distance: number;
  threshold: number;
  aspectRatioDifference: number;
  aspectRatioTolerance: number;
  lowInformation: boolean;
  crossPartition: boolean;
  requiresReview: true;
  action: 'candidate_only';
}
export interface ScreeningSummary {
  status: 'complete' | 'incomplete';
  nearCheck: {
    status: 'disabled' | 'complete' | 'incomplete';
    scope: 'distinct_content_groups';
    totalContentPairs: number;
    comparedContentPairs: number;
    hammingComparisons: number;
    aspectIncompatibleContentPairs: number;
    unexaminedContentPairs: number;
    unexaminedIdentityPairUpperBound: number;
    stopReason: string | null;
    reportedPairs: number;
  };
  partitionCheck: { status: 'complete' | 'incomplete'; unassignedInputs: number };
  unexaminedBlurAssetIds: string[];
  inputCount: number;
  distinctContentCount: number;
  identityMerge: false;
  changesApplied: false;
  scoreMeaning?: string;
}
export interface ScreeningSectionMap {
  items: ScreeningItem;
  exactGroups: ScreeningExactGroup;
  nearPairs: ScreeningNearPair;
  sourceLeakageGroups: ScreeningSourceGroup;
}
export type ScreeningSection = keyof ScreeningSectionMap;
export interface ScreeningResult<Section extends ScreeningSection = 'items'> {
  jobId: string;
  section: Section;
  parameters: ScreeningParameters;
  summary: ScreeningSummary;
  items: ScreeningSectionMap[Section][];
  total: number;
  offset: number;
  limit: number;
}
