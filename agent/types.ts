import type { EngineEvent } from '../shared/protocol.ts';
import type { ReferenceSelection } from '../shared/resources.ts';

export interface ToolCall { id: string; name: string; arguments: string | Record<string, unknown> }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}
/**
 * 思考深度：接口没有统一的 reasoning 参数，档位只改助手自身的投入（轮次预算与自检要求），
 * 不改服务商请求参数，也不影响标注任务的模型选择。
 */
export type AgentDepth = 'fast' | 'standard' | 'deep';
export interface AgentContext {
  annotationProviderId?: string; annotationModel?: string; assetIds?: string[];
  prompt?: string; concurrency?: number; maxRequests?: number | null; exportDir?: string;
  referenceAssetIds?: string[];
  referenceResources?: ReferenceSelection[];
  depth?: AgentDepth;
}
export interface AgentRequest {
  sessionId: string; projectId?: string; providerId: string; model: string;
  messages: ChatMessage[]; context?: AgentContext; autoExecute?: boolean;
}
export interface AgentAction {
  id: string; name: string; status: 'completed' | 'failed' | 'planned';
  result: unknown;
}
export interface AgentResult {
  content: string; messages: ChatMessage[]; actions: AgentAction[];
  budgetScopeId: string;
  status: 'completed' | 'needs_input' | 'cancelled' | 'limited';
}
export interface EngineClient {
  request<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T>;
}
export interface AgentNotification {
  sessionId: string; type: 'agent.started' | 'agent.tool' | 'agent.finished' | 'agent.open_asset';
  payload: Record<string, unknown>;
}
export interface WorkerRequest { type: 'agent.request'; id: string; payload: AgentRequest }
export type WorkerInput = WorkerRequest
  | { type: 'agent.cancel'; sessionId: string }
  | { type: 'engine.response'; id: string; data?: unknown; error?: { code: string; message: string } };
export type WorkerOutput =
  | { type: 'agent.ready' }
  | { type: 'agent.response'; id: string; data?: AgentResult; error?: { code: string; message: string } }
  | { type: 'engine.request'; id: string; command: string; payload: Record<string, unknown> }
  | { type: 'agent.event'; event: AgentNotification };

export type EventCallback = (event: AgentNotification | EngineEvent) => void;
