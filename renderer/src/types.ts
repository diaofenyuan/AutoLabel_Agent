export type { Annotation, Asset, Project, TaskType, EngineEvent, EngineStatus, LabelClass, Point } from '../../shared/protocol';
export interface Provider {
  id: string; name: string; baseUrl: string; protocol: string; model?: string;
  concurrency?: number; requestsPerMinute?: number; timeoutMs?: number; maxRetries?: number; maxImages?: number;
  headers?: Record<string,string>; extraParameters?: Record<string,unknown>;
  pricing?: import('./CostControls').Pricing | null;
  hasCredential?: boolean; tests?: Record<string, { status: string; message?: string; testedAt?: string }>;
}
export interface Resource { id: string; name: string; kind: string; content: unknown; updatedAt?: string }
export interface Run {
  id: string; projectId?: string; kind?: 'api' | 'local'; status: string; model?: string; createdAt?: string;
  modelId?: string; modelVersion?: number; device?: string;
  prompt?: string; samples?: Array<{ id?: string; assetId: string; name?: string; status: string; error?: string; candidateVersion?: number; attemptCount?: number; reused?: boolean; reusedFrom?: import('../../shared/reuse').CandidateReuseProvenance; inputReusedFrom?: import('../../shared/reuse').InputReuseProvenance; inputId?: string; resultId?: string }>;
  statistics?: Record<string, number>; total?: number; completed?: number;
  [key: string]: unknown;
}
export interface Preferences {
  theme: 'light' | 'dark' | 'system'; reducedMotion: boolean; canvasBackground: string;
  closeBehavior: 'ask' | 'tray' | 'quit';
  concurrency: number; maxRequests: number | null; timeout: number; retries: number;
  chatProviderId: string; chatModel: string; annotationProviderId: string; annotationModel: string;
  [key: string]: unknown;
}
export const defaultPreferences: Preferences = {
  theme: 'light', reducedMotion: false, canvasBackground: '#eef0f3', closeBehavior: 'ask', concurrency: 4,
  maxRequests: null, timeout: 120, retries: 2, chatProviderId: '', chatModel: '',
  annotationProviderId: '', annotationModel: '',
};
export const taskNames = { detect: '检测框', obb: '旋转框', segment: '多边形', pose: '关键点', classify: '图片分类' };
export const statusNames: Record<string, string> = {
  unlabeled: '未标注', candidate: '候选标注', modified: '人工修改', confirmed: '已确认', invalid: '无效素材', missing: '文件缺失',
  queued: '排队中', running: '执行中', paused: '已暂停', pausing: '暂停中', cancelling: '取消中', cancelled: '已取消', completed: '已完成',
  succeeded: '已完成', success: '已完成', failed: '失败', partial: '部分失败', unknown: '结果未知', retry_wait: '等待重试',
  completed_with_errors: '完成，有失败样本', needs_attention: '需要处理',
};
