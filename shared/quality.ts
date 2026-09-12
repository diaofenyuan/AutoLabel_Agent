import type { Annotation, Project, TaskType } from './protocol.ts';
import type { BudgetCost, RequestBudget } from './budget.ts';

export type EvaluationSource = 'existing_run_snapshot' | 'fresh_run_snapshot';

export interface EvaluationSetVersionSummary {
  id: string; version: number; sampleCount: number; createdAt: string;
}
export interface EvaluationSet {
  id: string; projectId: string; name: string; taskType: TaskType; revision: number;
  assetIds: string[]; truthCount: number; template: Project;
  publishedVersions: EvaluationSetVersionSummary[]; createdAt: string; updatedAt: string;
}
export interface TruthVersion {
  setId: string; assetId: string; truthVersion: number; annotations: Annotation[];
  source: 'manual' | 'imported_human'; note: string; savedAt: string;
}
export interface QualityMetrics {
  metricKind?: 'object_overlap' | 'classification';
  overlapMetric?: 'bbox_iou' | 'rotated_iou' | 'polygon_iou' | null;
  scorableTruthObjects: number | null; scorablePredictedObjects: number | null;
  matchedObjects: number | null; missedObjects: number | null; extraObjects: number | null;
  missedRate: number | null; extraRate: number | null; meanMatchedIoU: number | null;
  meanCenterErrorPixels: number | null; pairedKeypoints: number | null; locatedTruthKeypoints: number | null;
  missingPredictedKeypoints: number | null; unmatchedObjectKeypoints: number | null; ignoredUnknownTruthKeypoints: number | null;
  meanPointErrorPixels: number | null; meanPointErrorNormalized: number | null;
  notApplicableReasons: Record<string, 'zero_denominator' | 'task_not_applicable'>;
  scorableSamples?: number; failedSamples?: number; unknownSamples?: number; pendingSamples?: number;
  missingSamples?: number; invalidSamples?: number; totalTruthObjects?: number | null;
  totalTruthLabels?: number;
  classification?: { samples: number; correct: number; incorrect: number; missingPrediction: number;
    accuracy: number | null; confusion: Array<{ truthClassId: string; predictionClassId: string | null; count: number }> };
}
export interface EvaluationScheme {
  id: string; runId: string; name: string; model: string; providerId: string;
  source: EvaluationSource; sourceRunStatus: string; sourceRunCreatedAt: string;
  requestsUsed: number; usageScope: 'whole_source_run'; capturedAt: string; metrics: QualityMetrics;
  cost?: BudgetCost;
}
export interface Evaluation {
  id: string; projectId: string; setVersionId: string; status: 'completed';
  source: EvaluationSource; taskType: TaskType; sampleCount: number; comparisonId?: string;
  schemes: EvaluationScheme[]; pairedComparableSamples: number; nearDuplicateCheck: 'manual_review_required';
  match: { iouThreshold: number; poseNormalization: 'image_diagonal'; algorithmVersion: string;
    overlapMetric?: 'bbox_iou' | 'rotated_iou' | 'polygon_iou' | null };
  createdAt: string;
}
export interface FreshComparison {
  id: string; comparisonId: string; projectId: string; setVersionId: string; source: 'fresh_run_snapshot';
  status: 'running' | 'needs_attention' | 'ready' | 'completed'; canFinish?: boolean;
  runIds: string[]; schemes: Array<{ id: string; runId: string; name: string; providerId: string; model: string;
    status?: string; statistics?: Record<string, number> }>;
  budgetScopeId: string; maxRequests: number; plannedRequests: number; estimatedMaxRequests: number;
  budget?: RequestBudget; evaluationId?: string; createdAt: string; completedAt?: string;
}
export interface EvaluationResult {
  id: string; evaluationId: string; schemeId: string; runId: string; assetId: string; name: string;
  truthVersion: number; candidateVersion: number | null;
  status: 'scorable' | 'failed' | 'unknown' | 'pending' | 'missing' | 'invalid';
  mediaUrl: string; truthAnnotations: Annotation[]; predictionAnnotations: Annotation[] | null;
  errorCode?: string | null; metrics?: QualityMetrics;
  pairs?: Array<{ truthId: string; predictionId: string; iou: number; centerErrorPixels: number;
    keypointErrors: Array<{ index: number; name: string; errorPixels: number; errorNormalized: number }>;
    missingPredictedKeypoints: string[] }>;
  unmatchedTruthIds?: string[]; unmatchedPredictionIds?: string[];
  classResult?: { truthClassId: string; predictionClassId: string | null; correct: boolean; missingPrediction: boolean };
}
export interface ReviewItem {
  id: string; projectId: string; assetId: string; candidateVersion: number | null;
  objectId?: string | null; reason: string; severity: 'error' | 'warning' | 'info';
  source: 'execution' | 'truth_comparison' | 'random';
  status: 'pending' | 'checked' | 'dismissed' | 'request_relabel';
  evaluationId?: string; runId?: string; sampleId?: string; createdAt: string; note?: string;
}
