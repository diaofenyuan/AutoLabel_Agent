import type { ObservedBackend } from './inference.ts';

export interface ReusePolicy {
  reuseEnabled?: boolean;
  forceRerun?: boolean;
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
