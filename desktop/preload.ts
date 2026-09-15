import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, EngineEvent, EngineStatus, AgentEvent, FileSelection } from '../shared/protocol';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) {
    // Electron 隔离桥复制 Error 时不保证保留自定义属性，错误码同时进入标准消息。
    const error = new Error(`[${result.error.code}] ${result.error.message}`) as Error & { code: string };
    error.code = result.error.code;
    throw error;
  }
  return result.data as T;
}
function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('监听器必须为函数');
  // 不跨隔离上下文暴露 Electron 事件对象，只转交业务数据。
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}
const bridge: DesktopBridge = Object.freeze({
  request: <T>(command: string, payload?: Record<string, unknown>) => invoke<T>('autolabel:request', command, payload ?? {}),
  onEvent: (listener: (event: EngineEvent) => void) => subscribe('autolabel:event', listener),
  engineStatus: () => invoke<EngineStatus>('autolabel:engine-status'),
  onEngineStatus: (listener: (status: EngineStatus) => void) => subscribe('autolabel:status', listener),
  onAgentEvent: (listener: (event: AgentEvent) => void) => subscribe('autolabel:agent-event', listener),
  chooseFiles: (options: FileSelection) => invoke<string[]>('autolabel:choose-files', options),
  transcodeVideo: (options: { sourcePath: string }) => invoke<{ path: string }>('autolabel:transcode-video', options),
  discardTranscode: (options: { path: string }) => invoke<void>('autolabel:discard-transcode', options),
  saveFile: (options: { title: string; defaultPath?: string; extension?: string }) => invoke<string | null>('autolabel:save-file', options),
  openPath: (value: string) => invoke<void>('autolabel:open-path', value),
  restartEngine: () => invoke<EngineStatus>('autolabel:restart-engine'),
  setWindowDirty: (dirty: boolean) => invoke<void>('autolabel:window-dirty', dirty),
  windowAction: (action: 'minimize' | 'maximize' | 'close') => invoke<void>('autolabel:window-action', action),
});
contextBridge.exposeInMainWorld('autoLabel', bridge);
