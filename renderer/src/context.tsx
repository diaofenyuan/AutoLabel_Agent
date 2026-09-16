import { createContext, useContext } from 'react';
import { Box, LayoutGrid, ListTodo, MessageSquare, Settings, type LucideIcon } from 'lucide-react';
import type { ChatSessionSummary } from '../../shared/chat';
import type { Asset, EngineEvent, EngineStatus, Preferences, Project, Provider } from './types';

export type Page = 'chat' | 'overview' | 'tasks' | 'models' | 'settings';
/**
 * 设置页的区块键，与 `Settings.tsx` 的标签栏一一对应。
 * 单独抽出来是为了让「深链到指定区块」有类型约束：媒体错误里的「打开媒体运行时设置」靠它落到视频工具。
 */
export type SettingsSection = 'appearance' | 'workspace' | 'storage' | 'chats' | 'execution' | 'local' | 'media' | 'samples' | 'shortcuts' | 'updates' | 'diagnostics';

/** 扁平导航注册表：侧栏主入口与 Ctrl+K 快速跳转共用同一份页面清单，避免两处各自维护而漂移。 */
export interface NavEntry { key: Page; label: string; icon: LucideIcon }
/** 主导航只有对话、任务、设置三项；其余视图不再占导航位（见实施计划 §3.2）。 */
export const navRegistry: NavEntry[] = [
  { key: 'chat', label: '对话', icon: MessageSquare },
  { key: 'tasks', label: '任务', icon: ListTodo },
  { key: 'settings', label: '设置', icon: Settings },
];
/** 不占导航位、但由项目入口打开的视图：项目概览聚合素材、数据集版本与导出记录。 */
export const navViews: NavEntry[] = [
  { key: 'overview', label: '项目概览', icon: LayoutGrid },
];
/** 过渡期仍可从快速跳转直接进入的视图：模型中心的配置能力在「软件 AI 配置」完成后一并移除。 */
export const navLegacy: NavEntry[] = [
  { key: 'models', label: '模型中心', icon: Box },
];
/** 快速跳转与顶栏标题共用的完整清单：主导航在前，项目视图与过渡期视图在后。 */
export const navAll: NavEntry[] = [...navRegistry, ...navViews, ...navLegacy];
export function navLabel(page: Page): string {
  return navAll.find(entry => entry.key === page)?.label ?? '';
}

export interface ChatSession {
  id: string; messages: Array<{ role: 'user'|'assistant'; content: string }>;
  referenceResources?:import('../../shared/resources').ReferenceSelection[];
  input: string; busy: boolean; cancelRequested?: boolean; exportDir: string; scope: 'current'|'project'|'page'|'selected'; autoExecute: boolean; runningScope?: string;
  streamingText?: string; streamSinceSequence?: number;
  /** 欢迎页把首条消息随会话一起交出来：会话页挂载后立即发出，用户不必再按一次发送。 */
  sendOnOpen?: boolean;
  /**
   * 会话级的模型与思考深度覆盖：只影响这一段对话，新会话回落到设置里的默认值。
   * 未设置时取全局默认，因此这里只保存「用户显式改过」的值。
   */
  providerId?: string; model?: string; depth?: import('./types').ThinkingDepth;
  /** 先看方案时 agent 返回的待执行操作：确认卡片据此渲染，确认前不会执行任何写操作。 */
  planned?: import('./AgentActivity').AgentStep[];
}
/** 会话按会话标识存放（不再按项目），空会话初值统一从这里取，避免各处默认值不一致。 */
export function blankChatSession(id: string, scope: ChatSession['scope'] = 'project'): ChatSession {
  return { id, messages: [], input: '', busy: false, exportDir: '', scope, autoExecute: true };
}
export interface AppState {
  page: Page;
  /** 第二个参数是设置页的落点区块；其它页面忽略它。 */
  navigate: (page: Page, section?: SettingsSection) => Promise<void>;
  /** 设置页进入时应落在哪个区块：深链与手动进入共用这一份初值，手动进入等价于 `appearance`。 */
  settingsSection: SettingsSection;
  mediaTaskId: string; setMediaTaskId: (id: string) => void;
  projects: Project[]; project: Project | null; assets: Asset[];
  assetOffset: number; assetTotal: number; assetPageSize: number; assetsLoading: boolean;
  loadAssetPage: (offset: number) => Promise<Asset[]>;
  selectedAssetIds: string[]; setSelectedAssetIds: React.Dispatch<React.SetStateAction<string[]>>;
  /**
   * 工作台的视图与当前素材提升到应用层：切页会卸载工作台，这两项若留在页面内，
   * 从任务中心回来就会丢失，用户只能重新找刚才那张图。
   */
  workbenchView: 'images' | 'video';
  setWorkbenchView: React.Dispatch<React.SetStateAction<'images' | 'video'>>;
  activeAssetId: string | null;
  setActiveAssetId: React.Dispatch<React.SetStateAction<string | null>>;
  /**
   * 正在跟踪的抽帧任务。放在应用层而不是工作台内部：抽帧常常要等几十秒，
   * 用户中途去任务中心看一眼再回来，卡片与自动导入都不该丢。
   * timelineId 记录这批帧对应的时间轴：导入后自动建轴，用户点「进入视频轨迹」时直接落到这一条，
   * 而不是在一串历史时间轴里重新找。
   */
  mediaJob: { id: string; temporarySource?: string; timelineId?: string } | null;
  setMediaJob: React.Dispatch<React.SetStateAction<{ id: string; temporarySource?: string; timelineId?: string } | null>>;
  setAssets: React.Dispatch<React.SetStateAction<Asset[]>>;
  setProject: React.Dispatch<React.SetStateAction<Project | null>>;
  /** 第二个参数是随项目一起发出的首条消息：用于「描述即建项目」后立刻开始第一条对话。 */
  openProject: (project: Project, firstMessage?: string) => Promise<void>;
  refreshProjects: () => Promise<void>; refreshAssets: () => Promise<void>;
  prefs: Preferences; setPrefs: React.Dispatch<React.SetStateAction<Preferences>>; savePrefs: (prefs: Preferences) => Promise<void>;
  providers: Provider[]; refreshProviders: () => Promise<void>;
  syncWindowDirtySource: (source: string, dirty: boolean) => void;
  events: EngineEvent[]; engine: EngineStatus; loading: boolean;
  notify: (message: string, error?: boolean) => void;
  guard: React.MutableRefObject<null | (() => Promise<void>)>;
  chats: Record<string, ChatSession>; setChats: React.Dispatch<React.SetStateAction<Record<string, ChatSession>>>;
  /** 从 `chat.history.list` 恢复的持久化会话列表，侧栏按置顶 / 项目 / 最近分组展示。 */
  chatSessions: ChatSessionSummary[];
  refreshChatSessions: (projectId?: string) => Promise<void>;
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  /** 新建对话：会话必须挂在项目下，这里把界面交回欢迎页，由描述建好项目后再开会话。 */
  startProjectChat: () => Promise<void>;
  openJumper: () => void;
  openHelp: () => void;
  /** 侧栏项目项的「删除…」入口：只触发回调，三步确认弹窗由阶段 4 接入。 */
  requestDeleteProject: (project: Project) => void;
}
export const Context = createContext<AppState>(null!);
export const useApp = () => useContext(Context);
