import type { RequestBudget } from './budget.ts';
import type { Asset } from './protocol.ts';
import type { ReferenceSelection } from './resources.ts';
import type { CandidateReuseProvenance, InputReuseProvenance, ReusePolicy } from './reuse.ts';
import type { ModelInputSnapshot, TransformParameters } from './preprocessing.ts';
import type { FrozenLocalSelection, LocalParameters } from './inference.ts';
import type { ScreeningParameters, ScreeningReason, ScreeningRecommendation } from './media.ts';

export type StepKind = 'import' | 'filter' | 'transform' | 'local' | 'api' | 'review' | 'export';
export interface FlowStep {
  id: string; kind: StepKind; enabled: boolean; parameters: Record<string, unknown>;
}
export interface FlowDefinition { version: 1; name: string; steps: FlowStep[] }
export interface FlowIssue { stepId?: string; code: string; message: string }
export interface FlowCapabilities {
  definitionVersion: 1;
  availableSteps: StepKind[];
  unavailableSteps: StepKind[];
  maxSteps: number;
  viewReuse?: boolean;
}
export interface FlowParameterMap {
  import: { paths?: string[]; mode?: 'copy' | 'reference'; mediaJobId?: string };
  transform: TransformParameters;
  local: LocalParameters;
  filter: {
    assetIds?: string[]; statuses?: Asset['status'][];
    minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number;
    deduplicate?: boolean;
    screening?: ScreeningParameters;
    excludeAssetIds?: string[];
  };
  api: ReusePolicy & {
    providerId: string; model: string; prompt: string;
    referenceAssetIds?: string[]; referenceResources?: ReferenceSelection[];
    concurrency?: number; maxRetries?: number; maxRequests?: number;
  };
  review: { buildIssues?: boolean; randomSample?: { count: number; seed: string }; waitForHuman?: boolean };
  export: { outputDir: string; trainRatio?: number; onlyConfirmed?: boolean; annotationSelection?: 'protected' | 'candidate';
    // 流程只引用已保存或内置的导出格式；流程快照不内嵌自定义目录模板，避免跨版本难以复核。
    formatId?: string; formatVersion?: number };
}
export type FlowInput =
  | { source: 'project'; selection: 'all' | 'unlabeled'; assetIds?: never }
  | { source: 'project'; selection: 'explicit'; assetIds: string[] }
  | { source: 'artifact'; artifactId: string };
export type FlowExecution = { mode: 'all'; stepId?: never } | { mode: 'single'; stepId: string };
export interface FlowStartRequest {
  projectId: string;
  definition: FlowDefinition;
  input: FlowInput;
  execution?: FlowExecution;
  budgetScopeId?: string;
  maxRequests?: number;
  failurePolicy?: 'continue' | 'pause';
}
export interface FlowPreflight {
  canStart: boolean;
  issues: Array<FlowIssue & { severity: 'error' | 'warning' }>;
  projectId: string;
  inputCount: number | null;
  plannedRequests: number | null;
  estimatedMaxRequests: number | null;
  manualProtectedCount: number;
  steps: Array<{ stepId: string; kind: StepKind; enabled: boolean; inputCount: number | null; plannedRequests: number | null }>;
  availableSteps: StepKind[];
}
export type FlowRunStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled'
  | 'completed' | 'completed_with_errors' | 'failed' | 'needs_attention';
export type FlowStepStatus = 'pending' | 'running' | 'paused' | 'completed' | 'completed_with_errors'
  | 'failed' | 'cancelled' | 'needs_attention' | 'skipped';
export interface FlowStepStatistics {
  total: number; processed: number; succeeded: number; failed: number; unknown: number;
  excluded: number; queued: number; inFlight: number; reused: number;
}
export interface FlowStepState {
  stepId: string; kind: StepKind; order: number; status: FlowStepStatus; enabled: boolean;
  inputArtifactId?: string; outputArtifactId?: string; childRunId?: string;
  startedAt?: string; completedAt?: string; errorCode?: string; message?: string;
  statistics: FlowStepStatistics;
  local?: FrozenLocalSelection;
  inheritedFrom?: { flowRunId: string; stepId: string; artifactId: string };
}
export interface FlowRun {
  id: string; projectId: string; name: string; revision: number; sourceFlowRunId?: string;
  status: FlowRunStatus; pauseReason?: string; createdAt: string; updatedAt: string; completedAt?: string;
  definition: FlowDefinition; inputArtifactId: string; budgetScopeId?: string; budget?: RequestBudget;
  statistics: {
    stepsTotal: number; stepsCompleted: number; stepsFailed: number;
    inputAssets: number; outputAssets: number; requestsUsed: number; reused: number;
    inputViews?: number;
  };
  steps: FlowStepState[];
  sequence: number;
}
export interface FlowArtifactItem {
  id: string; assetId?: string; name: string; contentHash?: string; width?: number; height?: number;
  selectedVersion: number | null; candidateVersion?: number | null;
  outcome: 'included' | 'excluded' | 'failed' | 'unknown'; reason?: string;
  sourceRunId?: string; sourceArtifactId?: string;
  reused?: boolean; reusedFrom?: CandidateReuseProvenance;
  inputReusedFrom?: InputReuseProvenance;
  inputId?: string; viewId?: string; planHash?: string;
  inputSnapshot?: ModelInputSnapshot; resultId?: string; requiresGeometryReview?: boolean;
  screeningReasons?: ScreeningReason[];
  screeningRecommendation?: ScreeningRecommendation;
  metadata?: Record<string, unknown>;
}
export interface FlowArtifact {
  id: string; projectId: string; flowRunId: string; stepId?: string;
  kind: 'assets' | 'annotations' | 'review' | 'export' | 'views' | 'view_annotations'; createdAt: string; total: number;
  statistics: FlowStepStatistics; items: FlowArtifactItem[]; exportId?: string; reviewSampleId?: string;
}
export interface FlowResumeRequest { flowRunId: string; acknowledgeReviewStepId?: string; maxRequests?: number }
export interface FlowRetryRequest { flowRunId: string; stepId?: string; assetIds?: string[]; retryUnknown?: boolean; maxRequests?: number }
export interface FlowRerunRequest { flowRunId: string; fromStepId: string; definition?: FlowDefinition; budgetScopeId?: string; maxRequests?: number }
export interface FlowRerunResult { run: FlowRun; invalidatedStepIds: string[] }
export const STEP_LABELS: Record<StepKind, string> = {
  import: '导入素材', filter: '素材筛选', transform: '图像处理', local: '本地预标注',
  api: 'API 标注', review: '检查与复核', export: '数据集导出',
};
export interface FlowEnvironment {
  hasImages: boolean; hasAnnotations: boolean; hasClasses: boolean;
  imageModelReady: boolean; localReady: boolean; availableSteps: StepKind[];
}
export function validateFlow(flow: FlowDefinition, environment: FlowEnvironment): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (flow.version !== 1 || !Array.isArray(flow.steps) || flow.steps.length > 30)
    return [{ code: 'FLOW_INVALID', message: '流程版本或步骤数量不受支持' }];
  let images = environment.hasImages;
  let annotations = environment.hasAnnotations;
  let exported = false;
  const seen = new Set<string>();
  for (const step of flow.steps) {
    const add = (code: string, message: string) => issues.push({ stepId: step.id, code, message });
    if (seen.has(step.id)) add('STEP_ID_DUPLICATE', '流程步骤标识重复');
    seen.add(step.id);
    if (!step.enabled) continue;
    if (!(step.kind in STEP_LABELS)) { add('STEP_UNKNOWN', '未知流程模块'); continue; }
    if (!environment.availableSteps.includes(step.kind)) {
      add('STEP_UNAVAILABLE', `${STEP_LABELS[step.kind]}尚不可用`); continue;
    }
    if (exported) add('AFTER_EXPORT', '导出应为最后一个启用的步骤');
    if (step.kind === 'import') { images = true; continue; }
    if (!images) add('IMAGES_REQUIRED', '请先导入图片');
    if (step.kind === 'local' || step.kind === 'api') {
      if (!environment.hasClasses) add('CLASSES_REQUIRED', '请先配置标注类别');
      if (step.kind === 'api' && !environment.imageModelReady) add('MODEL_REQUIRED', '请选择可接收图片的标注模型');
      if (step.kind === 'local' && !environment.localReady) add('LOCAL_RUNTIME_REQUIRED', '请配置可选本地推理环境');
      annotations = true;
    }
    if (step.kind === 'review' && !annotations) add('ANNOTATIONS_REQUIRED', '检查与复核需要已有标注或上游标注步骤');
    if (step.kind === 'export') {
      if (!environment.hasClasses) add('CLASSES_REQUIRED', '导出需要配置类别');
      if (!annotations) add('ANNOTATIONS_REQUIRED', '请先完成人工或自动标注；合法无目标图片需要明确记录');
      exported = true;
    }
  }
  if (!flow.steps.some(step => step.enabled)) issues.push({ code: 'FLOW_EMPTY', message: '请至少启用一个步骤' });
  return issues;
}
export function defaultFlow(): FlowDefinition {
  return { version: 1, name: '图片标注流程', steps: [
    { id: 'import', kind: 'import', enabled: true, parameters: {} },
    { id: 'api', kind: 'api', enabled: true, parameters: {} },
    { id: 'review', kind: 'review', enabled: true, parameters: {} },
    { id: 'export', kind: 'export', enabled: true, parameters: {} },
  ] };
}
