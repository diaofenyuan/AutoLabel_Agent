import type { ObservedBackend } from './inference.ts';

/**
 * 复用匹配口径。引擎（CandidateReuse / Runs.validateReuse）、桌面校验与 Agent 工具 schema 共用这一份，
 * 保证「模型看到的可选值」与「引擎实际接受的取值」逐字一致。
 */
export const reuseScopes = ['hint', 'template', 'none'] as const;
export type ReuseScope = typeof reuseScopes[number];

export interface ReusePolicy {
  reuseEnabled?: boolean;
  forceRerun?: boolean;
  /** 匹配口径：hint（提示词与模板提示只记录不比对）/ template（严格）/ none（不复用）。缺省 template。 */
  reuseScope?: ReuseScope | null;
  reuseMaxAgeSeconds?: number | null;
}

export interface CandidateReuseProvenance {
  sourceRunId: string;
  sourceSampleId: string;
  sourceAssetId: string;
  sourceCandidateVersion: number;
  sourceAttemptId: string;
  sourceCompletedAt: string;
  sourceModel?: string;
  sourceModelVersion: Record<string, unknown>;
  reuseFingerprint: string;
}

export interface ReusedCandidate {
  reused: true;
  reusedFrom: CandidateReuseProvenance;
}

interface InputReuseOrigin {
  sourceResultId: string;
  sourceRunId: string;
  sourceSampleId: string;
  sourceInputId: string;
  sourceAssetId: string;
  sourceCompletedAt: string;
  sourceModel?: string;
  reuseFingerprint: string;
}

export type InputReuseProvenance = InputReuseOrigin & (
  | { source: 'api'; sourceAttemptId: string; sourceModelVersion?: Record<string, unknown> }
  | {
    source: 'local'; sourceModelId: string; sourceModelVersion: number;
    sourceModelHash: string; sourceWorkerHash: string;
    sourceRequestedDevice?: string; sourceObservedBackend?: ObservedBackend | null;
  }
);
