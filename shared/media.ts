export interface VideoTimeRange { start: number; end: number }

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
  | { mode: 'interval'; intervalSeconds: number; everyNFrames?: never; targetFps?: never }
  | { mode: 'every_n'; everyNFrames: number; intervalSeconds?: never; targetFps?: never }
  | { mode: 'fps'; targetFps: number; intervalSeconds?: never; everyNFrames?: never }
);

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

export type MediaJobKind = 'video_extract' | 'image_screening';
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
  error?: { code: string; message: string };
}

export type MediaJob = MediaJobState & (
  | { kind: 'video_extract'; parameters: VideoExtractionParameters }
  | { kind: 'image_screening'; parameters: ScreeningParameters }
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
