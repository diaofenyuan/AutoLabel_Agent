import type { TaskType } from './protocol.ts';

/** 训练参数边界：与引擎 TrainingParameters 一一对应，界面只做同样范围的内联校验。 */
export const TRAINING_LIMITS = {
  epochs: { min: 1, max: 10000, default: 100 },
  learningRate: { min: 1e-6, max: 1, default: 0.01 },
  batch: { min: 1, max: 1024, default: 16 },
  imgsz: { min: 32, max: 4096, step: 32, default: 640 },
  momentum: { min: 0, max: 1, default: 0.937 },
  weightDecay: { min: 0, max: 1, default: 0.0005 },
  warmupEpochs: { min: 0, max: 100, default: 3 },
  patience: { min: 1, max: 10000, default: 100 },
  workers: { min: 0, max: 32, default: 8 },
  seed: { min: 0, max: 2147483647, default: 0 },
  closeMosaic: { min: 0, max: 10000, default: 10 },
  valPeriod: { min: 1, max: 1000, default: 1 },
} as const;

export const TRAINING_OPTIMIZERS = ['auto', 'SGD', 'Adam', 'AdamW'] as const;
export type TrainingOptimizer = (typeof TRAINING_OPTIMIZERS)[number];

/** gpu-auto 由引擎在启动前解析：优先 GPU，不可用时回退 cpu 并记录原因。 */
export const TRAINING_DEFAULT_DEVICE = 'gpu-auto';

export type TrainingOrigin = 'upload' | 'export';
export type TrainingDatasetStatus = 'ready' | 'invalid';
export type TrainingJobStatus = 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface TrainingBaseModel {
  modelId: string;
  modelVersion?: number;
}

export interface TrainingParameters {
  epochs?: number;
  learningRate?: number;
  batch?: number | 'auto';
  imgsz?: number;
  device?: string;
  baseModel?: TrainingBaseModel | null;
  optimizer?: TrainingOptimizer;
  momentum?: number;
  weightDecay?: number;
  warmupEpochs?: number;
  patience?: number;
  workers?: number;
  seed?: number;
  closeMosaic?: number;
  valPeriod?: number;
  cosLr?: boolean;
  augment?: boolean;
  resume?: boolean;
}

export interface TrainingDatasetIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface TrainingDatasetSummary {
  issues: number;
  errors: number;
  warnings: number;
  splits: Record<string, number>;
  classCounts: number[];
  images: number;
  objects: number;
  emptyLabels: number;
  bytes: number;
  classes: number;
  keypoints: number;
  usable: boolean;
}

export interface TrainingDatasetFile {
  split: string;
  image: string;
  hash: string;
  bytes: number;
  width: number;
  height: number;
  label?: string;
  labelHash?: string;
  className?: string;
  objects: number;
}

export interface TrainingDataset {
  id: string;
  projectId: string | null;
  origin: TrainingOrigin;
  taskType: TaskType;
  status: TrainingDatasetStatus;
  createdAt: string;
  snapshotHash: string;
  bytes?: number;
  classes: Array<{ id: string; name: string }>;
  keypointNames: string[];
  inspection: { issues: TrainingDatasetIssue[]; summary: TrainingDatasetSummary };
  originDetail?: { kind: TrainingOrigin; exportId?: string; manifestHash?: string; dataYaml?: boolean; labelFormat?: string;[key: string]: unknown };
  files: TrainingDatasetFile[];
  dataYaml?: { hash: string };
}

export interface TrainingDatasetListing {
  items: TrainingDataset[];
  total: number;
  offset: number;
  limit: number;
}

export interface TrainingDeviceInfo {
  id: string;
  name: string;
  freeMemoryMb?: number | null;
}

export interface TrainingRuntimeState {
  configured: boolean;
  workerAvailable: boolean;
  available: boolean;
  cudaAvailable: boolean;
  devices: TrainingDeviceInfo[];
  defaultDevice: string;
  minimumGpuMemoryMb: number;
  busyBy: string[];
  /** 正被训练任务占用的设备：这些设备上的本地推理会被明确拒绝。 */
  busyByTraining?: string[];
  capabilities?: { valPeriod?: boolean; ampProbeCached?: boolean };
  workerHash?: string;
  pythonVersion?: string;
  ultralyticsVersion?: string;
  torchVersion?: string;
  numpyVersion?: string;
  opencvVersion?: string;
  issue?: { code: string; message: string };
}

export interface TrainingPreflightEstimates {
  datasetBytes: number;
  images: number;
  objects: number;
  epochs: number;
  estimatedPeakBytes: number;
}

export interface TrainingResolvedParameters extends TrainingParameters {
  requestedDevice: string;
  actualDevice: string;
  fallback: { requested: string; actual: string; reason: string } | null;
  classNames: string[];
  keypointNames: string[];
  snapshotHash: string;
  cudaAvailable?: boolean;
  ultralyticsVersion?: string;
  torchVersion?: string;
  workerHash?: string;
}

export interface TrainingPreflight {
  ok: boolean;
  issues: TrainingDatasetIssue[];
  estimates: TrainingPreflightEstimates;
  resolvedParameters: TrainingResolvedParameters;
}

/** 逐轮指标：只包含 ultralytics 真实上报的字段，缺失的指标不会补零。 */
export interface TrainingMetrics {
  boxLoss?: number;
  clsLoss?: number;
  dflLoss?: number;
  loss?: number;
  mAP50?: number;
  mAP50_95?: number;
  precision?: number;
  recall?: number;
  top1?: number;
  top5?: number;
}

export interface TrainingJobArtifact {
  kind: string;
  name: string;
  size: number;
  hash: string;
}

export interface TrainingJob {
  id: string;
  datasetId: string;
  projectId?: string | null;
  taskType: TaskType;
  status: TrainingJobStatus;
  device?: string;
  stage?: string;
  message?: string;
  parameters?: TrainingParameters;
  requestedDevice?: string;
  actualDevice?: string;
  fallback?: { requested: string; actual: string; reason: string } | null;
  environment?: { device?: string; cudaAvailable?: boolean; pythonVersion?: string; ultralyticsVersion?: string; torchVersion?: string; workerHash?: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  etaSeconds?: number;
  etaEstimated?: boolean;
  completedEpochs?: number;
  epochs?: number;
  lastMetrics?: TrainingMetrics;
  bestMetrics?: TrainingMetrics;
  bestEpoch?: number;
  error?: { code: string; message: string };
  cancelRequested?: boolean;
  stalledAt?: string;
  workerHash?: string;
  parametersHash?: string;
  snapshotHash?: string;
  classNames?: string[];
  keypointNames?: string[];
  result?: { completedEpochs?: number; bestEpoch?: number; bestFitness?: number | null };
  artifacts: TrainingJobArtifact[];
  progressKnown: boolean;
  progress: number;
}

export interface TrainingEpoch {
  jobId: string;
  epoch: number;
  epochs: number;
  metrics: TrainingMetrics;
  elapsedMs: number;
  etaSeconds?: number | null;
  etaEstimated?: boolean;
  at: string;
}

export interface TrainingJobListing {
  items: TrainingJob[];
  total: number;
  offset: number;
  limit: number;
  concurrency: number;
}

export interface TrainingMetricsListing {
  items: TrainingEpoch[];
  total: number;
  offset: number;
  limit: number;
}

export interface TrainingLog {
  jobId: string;
  available: boolean;
  log: string;
  truncated: boolean;
  bytes?: number;
}

export const TRAINING_JOB_STATUS: Record<TrainingJobStatus, string> = {
  queued: '排队中', preparing: '准备中', running: '训练中', succeeded: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
};

/** 训练中的任务与排队中的任务都占用队列位置。 */
export function activeTrainingJob(status: TrainingJobStatus): boolean {
  return status === 'queued' || status === 'preparing' || status === 'running';
}

export function defaultTrainingParameters(): TrainingParameters {
  return {
    epochs: TRAINING_LIMITS.epochs.default,
    learningRate: TRAINING_LIMITS.learningRate.default,
    batch: TRAINING_LIMITS.batch.default,
    imgsz: TRAINING_LIMITS.imgsz.default,
    device: TRAINING_DEFAULT_DEVICE,
    baseModel: null,
    optimizer: 'auto',
    momentum: TRAINING_LIMITS.momentum.default,
    weightDecay: TRAINING_LIMITS.weightDecay.default,
    warmupEpochs: TRAINING_LIMITS.warmupEpochs.default,
    patience: TRAINING_LIMITS.patience.default,
    workers: TRAINING_LIMITS.workers.default,
    seed: TRAINING_LIMITS.seed.default,
    closeMosaic: TRAINING_LIMITS.closeMosaic.default,
    valPeriod: TRAINING_LIMITS.valPeriod.default,
    cosLr: false,
    augment: true,
    resume: false,
  };
}
