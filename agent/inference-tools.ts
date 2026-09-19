import type { LocalModel, LocalRuntimeState } from '../shared/inference.ts';
import type { ToolDefinition, ToolEnvironment } from './tools.ts';
import { AgentError, fields, id, integer, object, text } from './validation.ts';

const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const taskTypes = ['detect', 'obb', 'segment', 'pose', 'classify'];
function active(env: ToolEnvironment) {
  if (env.signal?.aborted) throw new AgentError('AGENT_CANCELLED', '对话已停止，未读取本地模型');
}
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
export function localClassId(value: unknown) {
  const result = text(value, '模型类别标识', 32);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new AgentError('INVALID_ARGUMENT', '模型类别标识必须为无前导零的非负整数');
  return result;
}
type ModelSummary = Omit<LocalModel, 'fileName'>;
function model(value: unknown): ModelSummary {
  const raw = object(value, '本地模型');
  id(raw.id, '本地模型'); integer(raw.version, '本地模型版本', 1, 2147483647);
  if (raw.kind !== 'local_model' || !taskTypes.includes(raw.taskType as string) || !['pt', 'onnx'].includes(raw.format as string))
    throw new AgentError('LOCAL_RESPONSE_INVALID', '本地模型登记信息不完整');
  return pick(raw, ['id', 'version', 'kind', 'name', 'taskType', 'format', 'modelHash', 'sizeBytes', 'createdAt', 'updatedAt']) as unknown as ModelSummary;
}
export async function registeredLocalModel(env: ToolEnvironment, modelId: string, modelVersion?: number): Promise<ModelSummary> {
  active(env);
  // 专用公开元数据入口不会解析模型路径，也不会加载或授予文件执行权限。
  const result = model(await env.engine.request('local.model.get', { modelId, ...(modelVersion == null ? {} : { modelVersion }) }));
  if (result.id !== modelId || (modelVersion != null && result.version !== modelVersion))
    throw new AgentError('LOCAL_MODEL_VERSION_MISMATCH', '本地模型响应与选定版本不一致');
  return result;
}
export async function localRuntime(env: ToolEnvironment): Promise<LocalRuntimeState> {
  active(env);
  const raw = object(await env.engine.request('local.runtime.get', {}), '本地运行环境');
  if (!Array.isArray(raw.devices) || !Array.isArray(raw.slots) || raw.devices.length > 1001 || raw.slots.length > 1001
      || ['configured', 'workerAvailable', 'available'].some(key => typeof raw[key] !== 'boolean'))
    throw new AgentError('LOCAL_RESPONSE_INVALID', '本地运行环境响应不完整');
  const slots = raw.slots.map(value => {
    const slot = object(value, '本地设备槽');
    if (typeof slot.device !== 'string' || !/^(cpu|0|[1-9][0-9]{0,2})$/.test(slot.device) || typeof slot.busy !== 'boolean')
      throw new AgentError('LOCAL_RESPONSE_INVALID', '本地设备槽信息不完整');
    if (slot.modelId != null) id(slot.modelId, '已加载模型');
    if (slot.modelVersion != null) integer(slot.modelVersion, '已加载模型版本', 1, 2147483647);
    const result = pick(slot, ['device', 'busy', 'modelId', 'modelVersion', 'runId', 'inputId', 'workerHash']);
    if (slot.classes != null) {
      if (!Array.isArray(slot.classes) || slot.classes.length > 10000) throw new AgentError('LOCAL_RESPONSE_INVALID', '本地模型类别列表超出范围');
      const seen = new Set<string>();
      result.classes = slot.classes.map(value => {
        const entry = object(value, '本地模型类别'), classId = localClassId(entry.id);
        if (seen.has(classId)) throw new AgentError('LOCAL_RESPONSE_INVALID', '本地模型类别列表重复');
        seen.add(classId);
        return { id: classId, name: text(entry.name, '模型类别名称') };
      });
    }
    if (slot.observedBackend != null) {
      const backend = object(slot.observedBackend);
      if (backend.kind === 'pytorch' && typeof backend.device === 'string') result.observedBackend = { kind: 'pytorch', device: backend.device, providers: null };
      else if (backend.kind === 'onnxruntime' && Array.isArray(backend.providers) && backend.providers.length <= 100 && backend.providers.every(value => typeof value === 'string'))
        result.observedBackend = { kind: 'onnxruntime', device: null, providers: backend.providers };
    }
    return result as LocalRuntimeState['slots'][number];
  });
  if (new Set(slots.map(slot => slot.device)).size !== slots.length) throw new AgentError('LOCAL_RESPONSE_INVALID', '本地设备槽重复');
  return { ...pick(raw, ['configured', 'workerAvailable', 'available', 'workerHash', 'pythonVersion', 'ultralyticsVersion', 'torchVersion', 'cudaAvailable']),
    devices: raw.devices.map(value => pick(object(value), ['id', 'name'])), slots,
    ...(raw.issue == null ? {} : { issue: pick(object(raw.issue), ['code', 'message']) }) } as LocalRuntimeState;
}

export const LOCAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'list_local_models', description: '分页读取 UI 已登记的本地模型及实际版本。返回总数与下一页位置，当前页不代表全部模型；不会登记、加载或授权模型文件。',
    parameters: schema({ taskType: { type: ['string', 'null'], enum: [...taskTypes, null] }, offset: { type: ['integer', 'null'], minimum: 0, maximum: 2147483647 },
      limit: { type: ['integer', 'null'], minimum: 1, maximum: 500 } }), mutation: false,
    async execute(args, env) {
      fields(args, ['taskType', 'offset', 'limit']); active(env);
      if (args.taskType != null && !taskTypes.includes(args.taskType as string)) throw new AgentError('INVALID_ARGUMENT', '本地模型任务类型不受支持');
      const offset = integer(args.offset ?? 0, '分页位置', 0, 2147483647), limit = integer(args.limit ?? 100, '每页数量', 1, 500);
      const raw = object(await env.engine.request('local.model.list', { ...(args.taskType == null ? {} : { taskType: args.taskType }), offset, limit }));
      const total = integer(raw.total, '模型总数', 0, Number.MAX_SAFE_INTEGER);
      if (!Array.isArray(raw.items) || raw.items.length > limit || (offset < total && !raw.items.length) || (offset < total && offset + raw.items.length > total)
          || (offset >= total && raw.items.length)) throw new AgentError('LOCAL_RESPONSE_INVALID', '本地模型分页响应不完整');
      const items = raw.items.map(model);
      if (new Set(items.map(item => item.id)).size !== items.length || (args.taskType != null && items.some(item => item.taskType !== args.taskType)))
        throw new AgentError('LOCAL_RESPONSE_INVALID', '本地模型分页重复或任务类型不匹配');
      return { total, offset, limit, nextOffset: offset + items.length < total ? offset + items.length : null, items };
    } },
  { name: 'get_local_runtime', description: '只读查看本地环境、设备槽、已加载模型的固定版本和完整类别，不启动 Python。缺少环境或类别时请用户在设置 · 软件 AI 配置里加载；不会代替用户授权模型文件。',
    parameters: schema({}), mutation: false,
    async execute(args, env) { fields(args, []); return localRuntime(env); } },
  { name: 'list_builtin_models', description: '只读列出软件自带的模型库：哪些模型已随安装包提供或已下载、体积、是否开放词汇，以及是否已被用户启用（启用后才有可用的模型标识与版本）。'
      + '用于在对话里替用户挑一个本机模型；不会下载、不会启用、也不会授权执行——这些都只能由用户在模型库里点击完成。',
    parameters: schema({}), mutation: false,
    async execute(args, env) {
      fields(args, []); active(env);
      const raw = object(await env.engine.request('model.library.status', {}), '模型库状态');
      if (!Array.isArray(raw.entries) || raw.entries.length > 200 || typeof raw.ready !== 'number' || typeof raw.total !== 'number')
        throw new AgentError('LOCAL_RESPONSE_INVALID', '模型库状态响应不完整');
      const models = object(await env.engine.request('local.model.list', { offset: 0, limit: 500 }), '本地模型清单');
      const registered = Array.isArray(models.items) ? models.items.map(item => object(item, '本地模型')) : [];
      const entries = raw.entries.map(value => {
        const entry = object(value, '模型库条目');
        const catalogId = id(entry.id, '模型库标识');
        if (typeof entry.name !== 'string' || typeof entry.state !== 'string' || typeof entry.sizeBytes !== 'number')
          throw new AgentError('LOCAL_RESPONSE_INVALID', '模型库条目信息不完整');
        const model = registered.find(item => item.catalogId === catalogId);
        return { id: catalogId, name: String(entry.name), state: entry.state, taskType: entry.taskType ?? null,
          openVocabulary: entry.openVocabulary === true, tier: entry.tier, sizeBytes: entry.sizeBytes,
          group: typeof entry.group === 'string' ? entry.group : '', note: typeof entry.note === 'string' ? entry.note : '',
          ...(entry.message ? { message: String(entry.message) } : {}),
          // 只有已启用的模型才有能直接用于标注的标识与版本。
          ...(model ? { modelId: id(model.id, '本地模型'), modelVersion: integer(model.version, '本地模型版本', 1, 2147483647) } : {}) };
      });
      return { ready: raw.ready, total: raw.total, entries };
    } },
];
