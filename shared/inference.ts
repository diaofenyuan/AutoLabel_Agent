import type { Annotation, TaskType } from './protocol.ts';
import type { GeometryIssue } from './preprocessing.ts';
import type { InputReuseProvenance, ReusePolicy } from './reuse.ts';

export interface LocalRuntimeState {
  configured: boolean;
  workerAvailable: boolean;
  available: boolean;
  workerHash?: string;
  pythonVersion?: string;
  ultralyticsVersion?: string;
  torchVersion?: string;
  onnxruntimeVersion?: string | null;
  numpyVersion?: string;
  opencvVersion?: string;
  cudaAvailable?: boolean;
  devices: Array<{ id: string; name: string }>;
  slots: Array<{
    device: string; busy: boolean; modelId?: string; modelVersion?: number; runId?: string; inputId?: string;
    classes?: Array<{ id: string; name: string }>;
    workerHash?: string; observedBackend?: ObservedBackend | null;
  }>;
  issue?: { code: string; message: string };
}

export interface LocalModel {
  id: string;
  version: number;
  kind: 'local_model';
  name: string;
  taskType: TaskType;
  format: 'pt' | 'onnx';
  fileName: string;
  modelHash: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalModelRegistration {
  id?: string;
  baseVersion?: number;
  name: string;
  taskType: TaskType;
  modelPath: string;
}

export type ObservedBackend =
  | { kind: 'pytorch'; device: string; providers: null }
  | { kind: 'onnxruntime'; device: null; providers: string[] };

export interface LoadedLocalModel {
  loaded: true;
  model: LocalModel;
  requestedDevice: string;
  observedBackend: ObservedBackend | null;
  classes: Array<{ id: string; name: string }>;
  workerHash: string;
  protocolVersion: 1;
}

export interface LocalParameters extends ReusePolicy {
  modelId: string;
  modelVersion?: number;
  device?: string;
  classMap: Record<string, string | null>;
  confidence?: number;
  iou?: number;
  imageSize?: number;
  maxDetections?: number;
  timeoutMs?: number;
}

export interface FrozenLocalSelection {
  modelId: string;
  modelVersion: number;
  device: string;
}

export interface LocalRunRequest extends LocalParameters {
  projectId: string;
  assetIds?: string[];
  failurePolicy?: 'continue' | 'pause';
}

export interface InputResult {
  id: string;
  runId: string;
  sampleId: string;
  inputId: string;
  assetId: string;
  source: 'api' | 'local' | 'reuse';
  attemptId?: string;
  status: 'succeeded' | 'needs_attention' | 'failed' | 'unknown' | 'cancelled';
  createdAt: string;
  annotations: Annotation[] | null;
  rawResult: Record<string, unknown> | null;
  mappedResult: Record<string, unknown> | null;
  geometryIssues: GeometryIssue[];
  requiresGeometryReview: boolean;
  provenance: Record<string, unknown> & { reusedFrom?: InputReuseProvenance };
  errorCode?: string;
  message?: string;
}

export interface InputProgress {
  baselineTotal: number;
  baselineCompleted: number;
  inputTotal: number;
  inputCompleted: number;
}
