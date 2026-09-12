import { randomUUID } from 'node:crypto';
import { AgentController } from './orchestrator.ts';
import type { WorkerInput, WorkerOutput } from './types.ts';
import { AgentError, publicError } from './validation.ts';

interface ParentPort {
  postMessage(value: WorkerOutput): void;
  on(event: 'message', listener: (event: { data: WorkerInput }) => void): void;
}
const parent = (process as typeof process & { parentPort?: ParentPort }).parentPort;
if (!parent) throw new Error('Agent 工作进程必须由桌面主进程启动');
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const controller = new AgentController({
  request<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new AgentError('ENGINE_REPLY_TIMEOUT', '引擎响应等待超时，请检查任务记录；该操作不会自动重试'));
      }, 600_000);
      pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
      parent.postMessage({ type: 'engine.request', id: requestId, command, payload });
    });
  },
}, event => parent.postMessage({ type: 'agent.event', event }));

parent.on('message', async ({ data: message }) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'engine.response') {
    const request = pending.get(message.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new AgentError(message.error.code, message.error.message));
    else request.resolve(message.data);
  } else if (message.type === 'agent.cancel') {
    try { controller.cancel(message.sessionId); } catch { /* 无效取消不影响其他对话。 */ }
  } else if (message.type === 'agent.request') {
    try {
      const data = await controller.run(message.payload);
      parent.postMessage({ type: 'agent.response', id: message.id, data });
    } catch (error) {
      parent.postMessage({ type: 'agent.response', id: message.id, error: publicError(error) });
    }
  }
});
parent.postMessage({ type: 'agent.ready' });
