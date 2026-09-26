import type { CandidateReuseProvenance } from './reuse.ts';
import type { ModelLibraryProgress } from './model-library.ts';

export const PROTOCOL_VERSION = 1 as const;

/**
 * 接口能力测试的规范名称，必须与引擎 Providers.test 的支持集逐字一致。
 * 界面、桌面校验、Agent 工具三处都从这里取，避免某一处改名后另一个入口静默失效
 * （曾出现校验用 multi-image、其余用 multiImage，导致「多图输入」测试按钮必然被拒绝）。
 */
export const providerCapabilities = ['connection', 'text', 'image', 'multiImage', 'structured', 'tools'] as const;
export type ProviderCapability = typeof providerCapabilities[number];
/** 缺省能力：没有它们，模型无法承担对话与标注；其余能力按接口实际情况可选。 */
export const requiredProviderCapabilities: readonly ProviderCapability[] = ['connection', 'text', 'image', 'structured'];

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
  /** 项目概览的全局审核分类；与原始标注状态分开，失败来自最近运行样本。 */
  resultState?: 'candidate' | 'empty' | 'failed' | 'confirmed' | 'unlabeled' | 'other';
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
  /**
   * 模型库下载进度。模型权重最大有几百 MB，只给「正在下载」等于让用户干等；
   * 这是桌面自己的任务，不混进引擎事件流。
   */
  onModelLibraryProgress?(listener: (progress: ModelLibraryProgress) => void): () => void;
  chooseFiles(options: FileSelection): Promise<string[]>;
  /**
   * 列出已授权目录里的可用素材。
   * 渲染层拿不到文件系统，而引擎的目录扫描只收 jpg/jpeg/png：没有这一步，
   * 「选了文件夹却静默少收素材」就无法如实告知，也无法列出待抽帧的视频。
   * 只读已授权目录，不新增授权、不访问目录以外的路径。
   */
  listDirectory?(options: { path: string; kind: 'images' | 'video' }): Promise<{ directory: string; files: string[]; unsupported: number; truncated: boolean }>;
  /** 用本机 FFmpeg 生成几何与色彩恒定的临时副本，绕开引擎「不猜测」的严格校验；返回受管临时路径。 */
  transcodeVideo(options: { sourcePath: string }): Promise<{ path: string }>;
  /** 删除 transcodeVideo 产出的临时副本；只接受该功能自己创建的路径。 */
  discardTranscode(options: { path: string }): Promise<void>;
  saveFile(options: { title: string; defaultPath?: string; extension?: string }): Promise<string | null>;
  openPath(path: string): Promise<void>;
  restartEngine(): Promise<EngineStatus>;
  setWindowDirty(dirty: boolean): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  /** 拖入的 File 拿不到磁盘路径（Electron 32 起已移除 File.path），必须由 preload 解析。 */
  pathForFile?(file: File): string;
  /**
   * 拖入等于用户显式选择：把文件与文件夹登记进桌面授权表，否则后续命令会以「路径未授权」被拒。
   * 拒绝项带原因是刻意的：界面要能分清「格式不支持」「路径失效」「一次拖太多」并分别给出下一步。
   */
  grantDroppedFiles?(paths: string[]): Promise<{ granted: string[]; rejected: Array<{ name: string; reason: string }>; overLimit?: { limit: number; received: number } }>;
}

declare global { interface Window { autoLabel?: DesktopBridge } }
