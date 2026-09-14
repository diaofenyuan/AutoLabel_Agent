import type { Annotation } from './protocol.ts';
import type { MediaTimeBase } from './media.ts';
import type { TaskTemplateSnapshot } from './templates.ts';

export type TrackTaskType = 'detect' | 'pose';
export type TrackKeyframeState = 'located' | 'occluded' | 'enter' | 'exit' | 'unlocatable';
export type TrackAnnotationState = 'empty' | 'candidate' | 'manual' | 'confirmed';
export interface TrackPage<T> { items: T[]; total: number }
export interface TrackPageRequest { offset?: number; limit?: number }
export interface TrackRational { numerator: string; denominator: string }

/** 时间轴固定已入库的抽帧任务与模板语义；不同批次不能按视频摘要合并。 */
export interface TrackTimeline {
  id: string; projectId: string; mediaJobId: string; sourceVideoId: string;
  name: string; version: number; taskType: TrackTaskType; templateHash: string;
  frameCount: number; width: number; height: number;
  createdAt: string; updatedAt: string; sequence: number;
}
export interface TrackTimelineDetail extends TrackTimeline { template: TaskTemplateSnapshot }
export interface TrackSceneRange {
  /** 两个端点均包含；null 表示场景尚未检查。 */
  startFrameId: string; endFrameId: string; sceneId: string | null;
}
export interface TrackKeyframeSnapshot {
  keyframeId: string; frameId: string; objectId: string;
  state: TrackKeyframeState; annotation: Annotation | null;
}
export interface TrackKeyframe extends TrackKeyframeSnapshot {
  assetId: string; sourcePts: string; timeSeconds: number;
}
export interface TrackContributionSummary {
  contributionId: string; trackId: string; generationId: string;
  requiresReview: boolean;
}
export interface TrackFrame {
  frameId: string; assetId: string; sourceFrameId: string;
  sourcePresentationIndex: number; sourcePts: string; originPts: string; relativePts: string;
  timeBase: MediaTimeBase; timeSeconds: number; rangeIndex: number; sceneId: string | null;
  contentHash: string; width: number; height: number; inputVersion: number;
  annotationVersion: number; annotationState: TrackAnnotationState;
  draftSavedAt: string | null; protected: boolean;
  keyframe?: TrackKeyframe | null; contributions?: TrackContributionSummary[];
}
export interface Track {
  id: string; timelineId: string; sourceVideoId: string; objectId: string;
  classId: string; name: string; version: number;
  status: 'active' | 'deleted' | 'superseded'; templateHash: string;
  keyframeCount: number; needsRecompute: boolean; pendingFrameCount: number;
  createdAt: string; updatedAt: string; sequence: number;
}
export interface TrackIssue {
  code: string; message: string; severity: 'warning' | 'error';
  keypointNames?: string[]; fields?: string[]; frameId?: string; attributeId?: string; path?: string;
  metricValue?: number; thresholdName?: string; threshold?: number;
}
export interface TrackInterval {
  intervalId: string; leftKeyframeId: string; rightKeyframeId: string;
  leftFrameId: string; rightFrameId: string; leftKeyframeHash: string; rightKeyframeHash: string;
  startTime: TrackRational; endTime: TrackRational;
}
export interface TrackAffectedInterval extends TrackInterval { phase: 'before' | 'after' }
export interface TrackChangedKeyframe {
  keyframeId: string; before: TrackKeyframeSnapshot | null; after: TrackKeyframeSnapshot | null;
}
export interface TrackAffectedScope {
  algorithmVersion?: string; sourceVideoId?: string; trackId?: string; templateHash?: string;
  beforeTrackHash?: string; afterTrackHash?: string; candidateOnly: true; humanConfirmed: false;
  changedKeyframes: TrackChangedKeyframe[]; affectedIntervals: TrackAffectedInterval[];
  affectedFrameIds: string[]; mutableCandidateFrameIds: string[]; eligibleCandidateFrameIds: string[];
  protectedFrames: TrackSkippedFrame[]; applyPreconditions: TrackApplyPrecondition[];
  requiresRecompute: boolean; planHash: string;
}
export interface TrackApplyPrecondition {
  frameId: string; baselineAssetId: string; baselineContentHash: string; baselineVersion: number;
  expectedAnnotationVersion: number; allowedAnnotationStates: ['empty', 'candidate']; candidateOnly: true;
}
export interface TrackMutation { track: Track; affected: TrackAffectedScope; generation?: TrackGeneration }
export interface TrackTimelineMutation {
  timeline: TrackTimeline; affectedTrackIds: string[];
}
export interface TrackTimelineCreateRequest { projectId: string; mediaJobId: string; name?: string }
export interface TrackTimelineUpdateRequest {
  timelineId: string; baseVersion: number; name?: string; scenes?: TrackSceneRange[];
}
export interface TrackTimelineFramesRequest extends TrackPageRequest {
  timelineId: string; trackId?: string;
  /** 与 offset 互斥；返回页围绕该帧，页起点以响应 offset 为准。 */
  aroundFrameId?: string;
}
export interface TrackFramePage extends TrackPage<TrackFrame> { offset: number; limit: number }
export interface TrackCreateRequest { timelineId: string; timelineVersion: number; classId: string; name?: string }
export interface TrackVersionRequest { trackId: string; baseVersion: number }
export interface TrackWriteRequest extends TrackVersionRequest { timelineVersion: number }
export interface TrackUpdateRequest extends TrackVersionRequest { name: string }
export interface TrackKeyframeSaveRequest extends TrackWriteRequest {
  keyframeId?: string; frameId: string; state: TrackKeyframeState;
  annotation?: Annotation | null; baseAnnotationVersion: number; baseDraftSavedAt?: string | null;
}
export interface TrackKeyframeDeleteRequest extends TrackWriteRequest { keyframeId: string }
export interface TrackKeyframeListRequest extends TrackPageRequest { trackId: string; aroundFrameId?: string }
export interface TrackKeyframePage extends TrackPage<TrackKeyframe> {
  previous?: TrackKeyframe | null; next?: TrackKeyframe | null;
}
export interface TrackSplitRequest extends TrackWriteRequest {
  splitFrameId: string; leftName?: string; rightName?: string;
}
export interface TrackSplitResult {
  sourceTrack: Track; leftTrack: Track; rightTrack: Track; affected: TrackAffectedScope;
  generation?: TrackGeneration;
}
export interface TrackMergeRequest {
  leftTrackId: string; leftVersion: number; rightTrackId: string; rightVersion: number;
  timelineVersion: number; name?: string;
  /** 不同对象身份只能由用户明确确认合并；默认拒绝。 */
  confirmSameObject?: boolean;
}
export interface TrackMergeResult {
  sourceTracks: Track[]; track: Track; affected: TrackAffectedScope; generation?: TrackGeneration;
}

export interface TrackGenerationParameters {
  maxGapSeconds?: number; maxCenterSpeedPixelsPerSecond?: number;
  maxKeypointSpeedPixelsPerSecond?: number; maxScaleFactor?: number;
}
export interface TrackGeneratePreviewRequest extends TrackWriteRequest {
  parameters?: TrackGenerationParameters; scope?: 'affected' | 'all';
}
export interface TrackGenerateRequest extends TrackGeneratePreviewRequest { expectedPlanHash?: string }
export interface TrackGenerationInterval extends TrackInterval {
  blocked: boolean; requiresReview: boolean; reviewIssues: TrackIssue[];
  metrics: Record<string, unknown>; thresholds: Required<TrackGenerationParameters>;
  scenePolicy: 'input_supplied_scene_ids'; trackingPerformed: false;
  candidateCount?: number; protectedFrameCount?: number;
}
export interface TrackGenerationPreview {
  canGenerate: boolean; issues: TrackIssue[]; issueCount: number; planHash: string;
  frameCount: number; affectedCount: number; protectedCount: number;
  intervals: TrackGenerationInterval[]; intervalsTotal: number; intervalsTruncated: boolean;
  parameters: Required<TrackGenerationParameters>;
}
export type TrackGenerationStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed'
  | 'completed_with_errors' | 'interrupted' | 'failed';
export interface TrackGeneration {
  id: string; trackId: string; timelineId: string; trackVersion: number; timelineVersion: number;
  involvedTrackIds?: string[]; originalGenerationId?: string;
  status: TrackGenerationStatus; sequence: number; createdAt: string; updatedAt: string; canCancel: boolean;
  parameters: Required<TrackGenerationParameters>; scope: 'affected' | 'all';
  progress: { phase: string; completed: number; total: number; applied: number; protected: number; conflicts: number; failed: number };
  summary?: Record<string, unknown>; error?: { code: string; message: string };
  candidateOnly: true; humanConfirmed: false; requestsUsed: 0;
}
/** 本地 Detect 序列跟踪的前端契约；结果只能作为待复核候选。 */
export interface TrackLocalSequenceRequest {
  timelineId: string; timelineVersion: number; modelId: string; modelVersion?: number;
  device?: string; timeoutMs?: number; classMap: Record<string, string | null>;
  scope?: 'affected' | 'all'; detector: 'detect';
}
export interface TrackLocalSequenceResult {
  status: 'queued' | 'running' | 'completed' | 'failed'; candidateCount?: number;
  frameCount?: number; associatedCount?: number; reviewRequired: boolean; trackingPerformed: true; candidateOnly: true;
  candidateId?: string; candidateSetId?: string; provenance?: Record<string, unknown>; statistics?: Record<string, unknown>;
  frames?: Array<Record<string, unknown>>; tracks?: Array<Record<string, unknown>>;
  trackingIssues?: Array<Record<string, unknown>>; error?: { code: string; message: string };
}
/** 已落盘的本地跟踪候选；request/result 均为完整快照，查询不会改变人工状态。 */
export interface TrackLocalSequenceCandidate extends TrackLocalSequenceResult {
  candidateId: string; timelineId: string; status: 'completed'; createdAt: string; updatedAt: string;
  candidateOnly: true; humanConfirmed: false;
  request: Record<string, unknown>; result: Record<string, unknown>;
  sourceVideoHash?: string; templateHash?: string; modelHash?: string; workerHash?: string;
  confirmation?: { status: 'manual_review_required'; confirmedAt: string; timelineVersion: number; formalContributionCreated: false; nextAction: string };
  /** 用户显式确认后由引擎建立的生成任务摘要；不改变候选本身的人工确认状态。 */
  promotion?: TrackLocalSequencePromotionSummary;
}
export interface TrackLocalSequencePromotionSummary {
  generationId: string; promotedAt: string; timelineVersion: number;
  trackCount: number; frameCount: number; candidateAnnotationCount: number;
  skippedTrackCount: number; skippedFrameCount: number;
  formalContributionPending: boolean; requiresManualReview: boolean;
}
/** 本地跟踪候选提升为正式轨迹生成的结果；产物仍是待复核候选贡献，不是人工确认标注。 */
export interface TrackLocalSequencePromotion {
  candidateId: string; timelineId: string; generationId: string; status: TrackGenerationStatus;
  trackCount: number; frameCount: number; candidateAnnotationCount: number;
  skippedTrackCount: number; skippedFrameCount: number;
  tracks: Array<{ trackId: string; sourceTrackId: string; classId: string }>;
  issues: TrackIssue[]; candidateOnly: true; humanConfirmed: false;
  requiresManualReview: true; formalContributionCreated: false; nextAction: string;
}
export interface TrackLocalSequenceConfirmation {
  candidateId: string; timelineId: string; status: 'manual_review_required'; candidateOnly: true; humanConfirmed: false;
  requiresManualReview: true; formalContributionCreated: false; confirmation: NonNullable<TrackLocalSequenceCandidate['confirmation']>; nextAction: string;
}
export interface TrackGenerationFrame {
  frameId: string; assetId: string;
  status: 'applied' | 'protected' | 'blocked' | 'unchanged' | 'conflict' | 'removed';
  contributionId?: string; candidateVersion?: number; annotations?: Annotation[];
  requiresReview: boolean; reasons: TrackIssue[];
}
export interface TrackSkippedFrame {
  frameId: string; reason: string; message: string;
  annotationState: TrackAnnotationState; annotationVersion: number;
}
export interface TrackGenerationSections {
  frames: TrackGenerationFrame; intervals: TrackGenerationInterval; skipped: TrackSkippedFrame;
}
export type TrackGenerationSection = keyof TrackGenerationSections;
export type TrackGenerationResults<S extends TrackGenerationSection = TrackGenerationSection> = {
  [K in S]: TrackPage<TrackGenerationSections[K]> & { generationId: string; section: K; offset: number; limit: number }
}[S];

export interface TrackCommandMap {
  'track.timeline.create': { request: TrackTimelineCreateRequest; response: TrackTimeline };
  'track.timeline.list': { request: TrackPageRequest & { projectId: string }; response: TrackPage<TrackTimeline> };
  'track.timeline.get': { request: { timelineId: string }; response: TrackTimelineDetail };
  'track.timeline.frames': { request: TrackTimelineFramesRequest; response: TrackFramePage };
  'track.timeline.update': { request: TrackTimelineUpdateRequest; response: TrackTimelineMutation };
  'track.create': { request: TrackCreateRequest; response: Track };
  'track.list': { request: TrackPageRequest & { timelineId: string; includeArchived?: boolean }; response: TrackPage<Track> };
  'track.get': { request: { trackId: string; version?: number }; response: Track };
  'track.update': { request: TrackUpdateRequest; response: TrackMutation };
  'track.delete': { request: TrackWriteRequest; response: TrackMutation };
  'track.keyframe.list': { request: TrackKeyframeListRequest; response: TrackKeyframePage };
  'track.keyframe.save': { request: TrackKeyframeSaveRequest; response: TrackMutation };
  'track.keyframe.delete': { request: TrackKeyframeDeleteRequest; response: TrackMutation };
  'track.split': { request: TrackSplitRequest; response: TrackSplitResult };
  'track.merge': { request: TrackMergeRequest; response: TrackMergeResult };
  'track.generate.preview': { request: TrackGeneratePreviewRequest; response: TrackGenerationPreview };
  'track.generate': { request: TrackGenerateRequest; response: TrackGeneration };
  'track.generation.get': { request: { generationId: string }; response: TrackGeneration };
  'track.generation.list': { request: TrackPageRequest & { trackId: string }; response: TrackPage<TrackGeneration> };
  'track.generation.results': { request: TrackPageRequest & { generationId: string; section?: TrackGenerationSection }; response: TrackGenerationResults };
  'track.generation.cancel': { request: { generationId: string }; response: TrackGeneration };
  'track.generation.retry': { request: { generationId: string }; response: TrackGeneration };
  'track.local.sequence': { request: TrackLocalSequenceRequest; response: TrackLocalSequenceResult };
  'track.local.sequence.get': { request: { candidateId: string }; response: TrackLocalSequenceCandidate };
  'track.local.sequence.list': { request: TrackPageRequest & { timelineId: string }; response: TrackPage<TrackLocalSequenceCandidate> };
  'track.local.sequence.confirm': { request: { candidateId: string; timelineId: string; timelineVersion: number; confirm: true }; response: TrackLocalSequenceConfirmation };
  'track.local.sequence.promote': { request: { candidateId: string; timelineId: string; timelineVersion: number; confirm: true }; response: TrackLocalSequencePromotion };
}
