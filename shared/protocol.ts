import type { CandidateReuseProvenance } from './reuse.ts';

export const PROTOCOL_VERSION = 1 as const;

export type TaskType = 'detect' | 'obb' | 'segment' | 'pose' | 'classify';
export interface LabelClass { id: string; name: string; color: string }
export interface Point { x: number; y: number }
export interface Keypoint extends Point { name: string; visibility: 0 | 1 | 2 }
export interface Annotation {
  id: string; classId: string; type: TaskType;
  bbox?: { x: number; y: number; width: number; height: number };
  rotation?: number; points?: Point[]; keypoints?: Keypoint[];
  attributes?: Record<string, string | number | boolean>;
  confidence?: number;
}
export interface Project {
  id: string; name: string; description: string; taskType: TaskType;
  classes: LabelClass[]; createdAt: string; updatedAt: string;
  assetCount: number; annotatedCount: number; confirmedCount: number;
  settings: Record<string, unknown>;
}
export interface Asset {
  id: string; projectId: string; name: string; width: number; height: number;
  mediaUrl?: string; thumbnailUrl?: string; contentHash: string;
  status: 'unlabeled' | 'candidate' | 'modified' | 'confirmed' | 'invalid' | 'missing';
  annotations: Annotation[]; version: number; source: string;
  draft?: Annotation[]; metadata?: Record<string, unknown>;
  reused?: boolean; reusedFrom?: CandidateReuseProvenance;
}
export interface EngineEvent {
  sequence: number; type: string; timestamp: string;
  runId?: string; flowRunId?: string; stepId?: string; assetId?: string; attemptId?: string;
  sampleId?: string; inputId?: string; resultId?: string;
  mediaJobId?: string; timelineId?: string; trackId?: string; generationId?: string;
  payload: Record<string, unknown>;
}
export interface EngineStatus {
  state: 'starting' | 'ready' | 'disconnected' | 'error' | 'stopped';
  version?: string; protocolVersion?: number; message?: string;
}
export interface AgentEvent {
  sessionId: string; type: 'agent.started' | 'agent.tool' | 'agent.finished' | 'agent.open_asset';
  payload: Record<string, unknown>;
}
export interface FileSelection {
  kind: 'images' | 'video' | 'model' | 'python' | 'ffmpeg' | 'ffprobe' | 'directory' | 'backup' | 'labels';
  multiple?: boolean;
}
export interface DesktopBridge {
  request<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
  onAgentEvent?(listener: (event: AgentEvent) => void): () => void;
  engineStatus(): Promise<EngineStatus>;
  onEngineStatus(listener: (status: EngineStatus) => void): () => void;
  chooseFiles(options: FileSelection): Promise<string[]>;
  /** 用本机 FFmpeg 生成几何与色彩恒定的临时副本，绕开引擎「不猜测」的严格校验；返回受管临时路径。 */
  transcodeVideo(options: { sourcePath: string }): Promise<{ path: string }>;
  /** 删除 transcodeVideo 产出的临时副本；只接受该功能自己创建的路径。 */
  discardTranscode(options: { path: string }): Promise<void>;
  saveFile(options: { title: string; defaultPath?: string; extension?: string }): Promise<string | null>;
  openPath(path: string): Promise<void>;
  restartEngine(): Promise<EngineStatus>;
  setWindowDirty(dirty: boolean): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
}

declare global { interface Window { autoLabel?: DesktopBridge } }
