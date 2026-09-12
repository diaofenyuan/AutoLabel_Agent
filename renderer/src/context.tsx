import { createContext, useContext } from 'react';
import type { Asset, EngineEvent, EngineStatus, Preferences, Project, Provider } from './types';

export type Page = 'projects' | 'workbench' | 'workflow' | 'tasks' | 'resources' | 'models' | 'settings';
export interface ChatSession {
  id: string; messages: Array<{ role: 'user'|'assistant'; content: string }>;
  referenceResources?:import('../../shared/resources').ReferenceSelection[];
  input: string; busy: boolean; cancelRequested?: boolean; exportDir: string; scope: 'current'|'project'|'page'|'selected'; autoExecute: boolean; runningScope?: string;
  streamingText?: string; streamSinceSequence?: number;
}
export interface AppState {
  page: Page; navigate: (page: Page) => Promise<void>;
  mediaTaskId: string; setMediaTaskId: (id: string) => void;
  projects: Project[]; project: Project | null; assets: Asset[];
  assetOffset: number; assetTotal: number; assetPageSize: number; assetsLoading: boolean;
  loadAssetPage: (offset: number) => Promise<Asset[]>;
  selectedAssetIds: string[]; setSelectedAssetIds: React.Dispatch<React.SetStateAction<string[]>>;
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
}
export const Context = createContext<AppState>(null!);
export const useApp = () => useContext(Context);
