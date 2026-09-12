import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DesktopError, assertAgentCommand } from './validation';
export class AgentManager extends EventEmitter {
  private worker?: UtilityProcess;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private filename: string, private engineRequest: (command: string, payload: unknown) => Promise<unknown>) { super(); }
  private start(): UtilityProcess {
    if (this.worker) return this.worker;
    // Worker 仅获得静态入口和父进程 RPC，不向其传递回环令牌或用户凭据。
    const worker = utilityProcess.fork(this.filename, [], { serviceName: 'AutoLabel Agent', stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' } });
    this.worker = worker;
    worker.on('message', async message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'agent.event') this.emit('event', message.event);
      if (message.type === 'agent.response') {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new DesktopError(message.error.code, message.error.message)); else pending.resolve(message.data);
      }
      if (message.type === 'engine.request') {
        try {
          assertAgentCommand(message.command, message.payload);
          const data = await this.engineRequest(message.command, message.payload);
          if (this.worker === worker) worker.postMessage({ type: 'engine.response', id: message.id, data });
        } catch (error) {
          if (this.worker === worker) worker.postMessage({ type: 'engine.response', id: message.id, error: { code: error instanceof DesktopError ? error.code : 'AGENT_ENGINE_ERROR', message: error instanceof DesktopError ? error.message : '引擎操作未完成' } });
        }
      }
    });
    worker.once('exit', () => {
      if (this.worker === worker) this.worker = undefined;
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new DesktopError('AGENT_EXITED', '对话工作进程已退出；已发送的任务请到任务中心核对')); }
      this.pending.clear();
    });
    return worker;
  }
  async request(command: string, payload: Record<string, unknown>): Promise<unknown> {
    if (command === 'agent.cancel') { this.worker?.postMessage({ type: 'agent.cancel', sessionId: payload.sessionId }); return { cancelled: true }; }
    if (this.pending.size >= 4) throw new DesktopError('AGENT_BUSY', '当前对话正在处理，请等待或取消后再试');
    const worker = this.start(); const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); worker.postMessage({ type: 'agent.cancel', sessionId: payload.sessionId }); reject(new DesktopError('AGENT_TIMEOUT', '对话等待超时，已发送的任务请到任务中心核对')); }, 600000);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: 'agent.request', id, payload });
    });
  }
  stop(): void { this.worker?.kill(); }
  get activeCount(): number { return this.pending.size; }
}
