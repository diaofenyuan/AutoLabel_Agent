export class AgentError extends Error {
  constructor(publicCode: string, message: string) {
    super(message); this.name = 'AgentError'; this.code = publicCode;
  }
  readonly code: string;
}
export function object(value: unknown, label = '参数'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('INVALID_ARGUMENT', `${label}必须是对象`);
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key))
    throw new AgentError('INVALID_ARGUMENT', `不支持的参数：${key}`);
}
export function text(value: unknown, label: string, maximum = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new AgentError('INVALID_ARGUMENT', `${label}不能为空，且不能超过 ${maximum} 个字符`);
  return value.trim();
}
export function id(value: unknown, label = '标识'): string {
  const result = text(value, label, 160);
  if (!/^[\w-]+$/.test(result)) throw new AgentError('INVALID_ARGUMENT', `${label}格式不正确`);
  return result;
}
export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new AgentError('INVALID_ARGUMENT', `${label}应为 ${minimum}～${maximum} 的整数`);
  return value as number;
}
export function ids(value: unknown, label: string, maximum = 1000): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new AgentError('INVALID_ARGUMENT', `${label}应为最多 ${maximum} 项的列表`);
  return [...new Set(value.map(item => id(item, label)))];
}
export function parseArguments(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value === 'string') {
    if (value.length > 32000) throw new AgentError('INVALID_ARGUMENT', '工具参数过长');
    try { return object(JSON.parse(value)); }
    catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('INVALID_ARGUMENT', '工具参数不是有效 JSON');
    }
  }
  return object(value);
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentError) return { code: error.code, message: error.message };
  // 未知异常可能包含请求头或绝对路径，不直接返回模型与界面。
  return { code: 'AGENT_OPERATION_FAILED', message: '操作未完成，请在任务中心或设置中查看诊断' };
}
