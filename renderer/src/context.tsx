import { createContext, useContext } from 'react';
import { Box, FlaskConical, Library, ListTodo, MessageSquare, Scan, Settings, Workflow, type LucideIcon } from 'lucide-react';
import type { ChatSessionSummary } from '../../shared/chat';
import type { Asset, EngineEvent, EngineStatus, Preferences, Project, Provider } from './types';

export type Page = 'chat' | 'workbench' | 'workflow' | 'tasks' | 'resources' | 'models' | 'training' | 'settings';
/**
 * 设置页的区块键，与 `Settings.tsx` 的标签栏一一对应。
 * 单独抽出来是为了让「深链到指定区块」有类型约束：媒体错误里的「打开媒体运行时设置」靠它落到视频工具。
 */
export type SettingsSection = 'appearance' | 'workspace' | 'storage' | 'chats' | 'execution' | 'local' | 'media' | 'samples' | 'shortcuts' | 'updates' | 'diagnostics';

/** 扁平导航注册表：侧栏主入口与 Ctrl+K 快速跳转共用同一份页面清单，避免两处各自维护而漂移。 */
export interface NavEntry { key: Page; label: string; icon: LucideIcon }
export const navRegistry: NavEntry[] = [
  { key: 'chat', label: '对话', icon: MessageSquare },
  { key: 'workbench', label: '标注工作台', icon: Scan },
  { key: 'workflow', label: '流程编辑器', icon: Workflow },
  { key: 'tasks', label: '任务中心', icon: ListTodo },
  { key: 'resources', label: '资源库', icon: Library },
  { key: 'models', label: '模型中心', icon: Box },
  { key: 'training', label: '模型训练', icon: FlaskConical },
  { key: 'settings', label: '设置', icon: Settings },
];
export function navLabel(page: Page): string { return navRegistry.find(entry => entry.key === page)?.label ?? ''; }

export interface ChatSession {
  id: string; messages: Array<{ role: 'user'|'assistant'; content: string }>;
  referenceResources?:import('../../shared/resources').ReferenceSelection[];
  input: string; busy: boolean; cancelRequested?: boolean; exportDir: string; scope: 'current'|'project'|'page'|'selected'; autoExecute: boolean; runningScope?: string;
  streamingText?: string; streamSinceSequence?: number;
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
  openProject: (project: Project) => Promise<void>;
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
  newChatSession: () => Promise<void>;
  openJumper: () => void;
  openHelp: () => void;
  /** 侧栏项目项的「删除…」入口：只触发回调，三步确认弹窗由阶段 4 接入。 */
  requestDeleteProject: (project: Project) => void;
}
export const Context = createContext<AppState>(null!);
export const useApp = () => useContext(Context);
