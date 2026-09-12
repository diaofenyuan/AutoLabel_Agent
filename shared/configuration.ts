export type ModelRole = 'chat' | 'annotation';
export type ConfigurationSource = 'global' | 'project' | 'step';
type Settings = Record<string, unknown>;
type ConfigurationField = 'providerId' | 'model' | 'prompt' | 'concurrency' | 'maxRequests';

export interface ResolvedConfiguration {
  providerId?: string;
  model?: string;
  prompt?: string;
  concurrency?: number;
  maxRequests?: number | null;
  sources: Partial<Record<ConfigurationField, ConfigurationSource>>;
  issues: Array<{ field: ConfigurationField; code: 'configuration_invalid' | 'model_required'; message: string }>;
}

/** 界面与助手复用相同覆盖规则；返回本次值及来源，不修改任何一层配置。 */
export function resolveConfiguration(role: ModelRole, global: Settings = {}, project: Settings = {}, step: Settings = {}): ResolvedConfiguration {
  const result: ResolvedConfiguration = { sources: {}, issues: [] };
  const layers: Array<[ConfigurationSource, Settings]> = [['global', global], ['project', project], ['step', step]];
  const stringValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  for (const [source, settings] of layers) {
    const roleProvider = stringValue(settings[source === 'step' ? 'providerId' : `${role}ProviderId`]);
    const legacyProvider = source === 'project' && role === 'annotation' ? stringValue(settings.providerId) : undefined;
    const provider = roleProvider ?? legacyProvider;
    const model = stringValue(settings[source === 'step' ? 'model' : `${role}Model`])
      ?? (source === 'project' && role === 'annotation' && (!roleProvider || roleProvider === legacyProvider)
        ? stringValue(settings.model) : undefined);
    if (provider) {
      // 切换接口时不能把下层另一接口的模型名带过来，即使名称可能恰好相同。
      if (provider !== result.providerId) { delete result.model; delete result.sources.model; }
      result.providerId = provider;
      result.sources.providerId = source;
    }
    if (model) { result.model = model; result.sources.model = source; }
    const prompt = stringValue(settings.prompt);
    if (prompt) { result.prompt = prompt; result.sources.prompt = source; }
    for (const field of ['concurrency', 'maxRequests'] as const) {
      if (!Object.hasOwn(settings, field) || settings[field] === undefined) continue;
      const value = settings[field];
      result.issues = result.issues.filter(issue => issue.field !== field);
      result.sources[field] = source;
      if (field === 'maxRequests' && value === null) { result.maxRequests = null; continue; }
      const maximum = field === 'concurrency' ? 32 : 1_000_000;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
        delete result[field];
        result.issues.push({ field, code: 'configuration_invalid', message: field === 'concurrency' ? '并发数应为 1～32 的整数。' : '请求上限应为 1～1000000 的整数，或明确不设上限。' });
      } else result[field] = value;
    }
  }
  if (result.providerId && !result.model)
    result.issues.push({ field: 'model', code: 'model_required', message: '请为当前接口选择模型；其他接口的模型不会自动沿用。' });
  return result;
}
