export type { Annotation, Asset, Project, TaskType, EngineEvent, EngineStatus, LabelClass, Point } from '../../shared/protocol';
/** 思考深度三档：档位含义与真实映射写在设置页的说明里，不在这里另立一套说法。 */
export type ThinkingDepth = 'fast' | 'standard' | 'deep';
export const thinkingDepthNames: Record<ThinkingDepth, string> = { fast: '快速', standard: '标准', deep: '深入' };
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
  /** 训练默认值：设备与数据加载进程数只作为新建训练的初值，并发上限与进度保留由引擎在启动时读取。 */
  trainingDevice: string; trainingWorkers: number; trainingConcurrency: number; trainingRetentionDays: number;
  /** 新对话默认的思考深度；会话内切换只影响当前会话，不回写这里（见实施计划 6.2）。 */
  chatThinkingDepth: ThinkingDepth;
  /** 未配置 AI 时的一次性引导是否已被用户关掉；凭据配好后引导由凭据状态直接隐藏，不看这个值。 */
  aiSetupDismissed?: boolean;
  /** 抽帧产物就绪后是否自动导入项目：默认开，抽帧完成 ≠ 素材可用的那一步不该由人记着。 */
  frameAutoImport?: boolean;
  [key: string]: unknown;
}
export const defaultPreferences: Preferences = {
  theme: 'light', reducedMotion: false, canvasBackground: '#eef0f3', closeBehavior: 'ask', concurrency: 4,
  maxRequests: null, timeout: 120, retries: 2, chatProviderId: '', chatModel: '',
  annotationProviderId: '', annotationModel: '', chatThinkingDepth: 'standard', frameAutoImport: true, trainingDevice: 'gpu-auto', trainingWorkers: 8, trainingConcurrency: 1,
  // 0 表示永久保留逐轮指标；非零时引擎只清理已结束任务超期的逐轮指标记录，产物与日志保留。
  trainingRetentionDays: 0,
};
export const taskNames = { detect: '检测框', obb: '旋转框', segment: '多边形', pose: '关键点', classify: '图片分类' };
export const statusNames: Record<string, string> = {
  unlabeled: '未标注', candidate: '候选标注', modified: '人工修改', confirmed: '已确认', invalid: '无效素材', missing: '文件缺失',
  queued: '排队中', running: '执行中', paused: '已暂停', pausing: '暂停中', cancelling: '取消中', cancelled: '已取消', completed: '已完成',
  succeeded: '已完成', success: '已完成', failed: '失败', partial: '部分失败', unknown: '结果未知', retry_wait: '等待重试',
  completed_with_errors: '完成，有失败样本', needs_attention: '需要处理',
};
