import type { Asset, Project } from '../shared/protocol.ts';
import { resolveConfiguration } from '../shared/configuration.ts';
import { FLOW_TOOL_DEFINITIONS } from './flow-tools.ts';
import { LOCAL_TOOL_DEFINITIONS } from './inference-tools.ts';
import { MEDIA_TOOL_DEFINITIONS } from './media-tools.ts';
import { TRACK_TOOL_DEFINITIONS } from './track-tools.ts';
import { TRAINING_TOOL_DEFINITIONS } from './training-tools.ts';
import type { AgentContext, EngineClient } from './types.ts';
import { AgentError, fields, id, ids, integer, object, text } from './validation.ts';

export interface ToolEnvironment {
  engine: EngineClient; projectId?: string; context: AgentContext;
  budgetScopeId?: string;
  signal?: AbortSignal;
  openAsset(assetId: string): void;
}
export interface ToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>; mutation: boolean;
  execute(args: Record<string, unknown>, environment: ToolEnvironment): Promise<unknown>;
}
const schema = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const nullableString = { type: ['string', 'null'] };
function projectId(environment: ToolEnvironment): string {
  if (!environment.projectId) throw new AgentError('PROJECT_REQUIRED', '请先打开一个项目');
  return id(environment.projectId, '项目标识');
}
function ensureActive(environment: ToolEnvironment) {
  if (environment.signal?.aborted) throw new AgentError('AGENT_CANCELLED', '对话已停止，未提交新的操作');
}
function exportSelection(environment: ToolEnvironment) {
  const selected = environment.context.assetIds;
  if (selected && !selected.length) throw new AgentError('IMAGES_REQUIRED', '当前未选中素材');
  return { projectId: projectId(environment), ...(selected ? { assetIds: selected } : {}) };
}
async function project(environment: ToolEnvironment): Promise<Project> {
  return environment.engine.request<Project>('project.open', { projectId: projectId(environment) });
}
function annotationConfiguration(p: Project, env: ToolEnvironment) {
  const context = env.context;
  const result = resolveConfiguration('annotation', {}, p.settings, {
    providerId: context.annotationProviderId, model: context.annotationModel, prompt: context.prompt,
    concurrency: context.concurrency, maxRequests: context.maxRequests,
  });
  if (result.issues.length) throw new AgentError('INVALID_CONFIGURATION', result.issues[0].message);
  return result;
}
async function selectedReferences(environment: ToolEnvironment, targets?: string[]) {
  const references = environment.context.referenceAssetIds ?? [];
  if (references.length && !targets)
    throw new AgentError('IMAGES_REQUIRED', '使用项目内参考时，请明确选择待标注图片，并排除参考图片');
  for (const assetId of references) {
    ensureActive(environment);
    if (targets?.includes(assetId)) throw new AgentError('REFERENCE_OVERLAP', '参考图片不能同时作为本次待标注目标');
    const asset = await scopedAsset(assetId, environment);
    if (!['modified', 'confirmed'].includes(asset.status) || !['manual', 'preset_manual'].includes(asset.source))
      throw new AgentError('REFERENCE_HUMAN_REQUIRED', '请先人工修改或确认所选参考，候选和草稿不能作为人工参考');
  }
  return references;
}
async function scopedAsset(assetId: string, environment: ToolEnvironment): Promise<Asset> {
  const asset = await environment.engine.request<Asset>('asset.get', { assetId });
  if (asset.projectId !== projectId(environment)) throw new AgentError('ASSET_SCOPE', '该素材不属于当前项目');
  return asset;
}
function assetSummary(asset: Asset) {
  return { id: asset.id, name: asset.name, width: asset.width, height: asset.height,
    status: asset.status, version: asset.version, annotations: asset.annotations,
    ...(asset.reused ? { reused: true, reusedFrom: asset.reusedFrom ? pick(asset.reusedFrom as unknown as Record<string, unknown>,
      ['sourceRunId', 'sourceSampleId', 'sourceAssetId', 'sourceCandidateVersion', 'sourceAttemptId', 'sourceCompletedAt', 'sourceModel']) : null } : {}) };
}
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function scopedRecord(value: unknown, environment: ToolEnvironment, label: string) {
  const record = object(value, label);
  if (record.projectId !== projectId(environment)) throw new AgentError('PROJECT_SCOPE', `${label}不属于当前项目`);
  return record;
}
function evaluationSummary(value: Record<string, unknown>) {
  const summary = pick(value, ['id', 'projectId', 'setId', 'setVersionId', 'comparisonId', 'status', 'source', 'taskType',
    'createdAt', 'sampleCount', 'match', 'algorithmVersion', 'metrics', 'coverage', 'nearDuplicateCheck', 'pairedComparableSamples']);
  // 对话只拿指标和来源，独立真值与图片副本不能回流到后续模型请求中。
  summary.schemes = Array.isArray(value.schemes) ? value.schemes.map(item => pick(object(item), [
    'id', 'name', 'runId', 'status', 'source', 'sourceRunStatus', 'sourceRunCreatedAt', 'providerId', 'model', 'metrics', 'coverage',
    'statistics', 'usage', 'usageScope', 'requestsUsed', 'scorableSamples', 'failedSamples', 'cost',
  ])) : [];
  return summary;
}
function preflightSummary(value: Record<string, unknown>) {
  return { ...pick(value, ['canEvaluate', 'canStart', 'sampleCount', 'schemeCount', 'plannedRequests', 'estimatedMaxRequests',
      'budgetScopeId', 'maxRequests', 'source', 'pairedComparableSamples', 'nearDuplicateCheck']),
    schemes: Array.isArray(value.schemes) ? value.schemes.map(raw => pick(object(raw), [
      'id', 'name', 'runId', 'status', 'source', 'scorableSamples', 'failedSamples',
    ])) : [],
    issues: Array.isArray(value.issues) ? value.issues.map(raw => pick(object(raw), [
      'code', 'message', 'severity', 'assetId', 'schemeId', 'runId',
    ])) : [] };
}
function providerModels(provider: Record<string, unknown>) {
  const capabilities = provider.capabilities && typeof provider.capabilities === 'object'
    ? object(provider.capabilities, '模型能力记录') : {};
  const names = new Set(Object.keys(capabilities));
  if (typeof provider.model === 'string' && provider.model.trim()) names.add(provider.model);
  return [...names].map(model => ({ model,
    capabilities: Object.fromEntries(Object.entries(object(capabilities[model] ?? {})).filter(([name]) =>
      ['connection', 'text', 'image', 'multiImage', 'structured', 'tools'].includes(name)).map(([name, raw]) =>
      [name, pick(object(raw), ['status', 'testedAt', 'revision'])])),
  }));
}
async function fixedSet(setId: string, setVersionId: string, env: ToolEnvironment) {
  const snapshot = scopedRecord(await env.engine.request('evaluationSet.get', { setId }), env, '评测集');
  const published = Array.isArray(snapshot.publishedVersions) && snapshot.publishedVersions.some(raw => object(raw).id === setVersionId);
  if (snapshot.id !== setId || !published || !Array.isArray(snapshot.assetIds))
    throw new AgentError('EVALUATION_SNAPSHOT_INVALID', '接口没有返回所选的固定评测集版本');
  if (env.context.assetIds) {
    const allowed = new Set(env.context.assetIds);
    if (!snapshot.assetIds.length || snapshot.assetIds.some(raw => !allowed.has(id(raw, '评测素材'))))
      throw new AgentError('ASSET_SCOPE', '固定评测集包含当前选择范围外的素材，请调整助手处理范围');
  }
  return snapshot;
}
const freshComparisonProperties = {
  setId: { type: 'string' }, setVersionId: { type: 'string' },
  schemes: { type: 'array', minItems: 1, maxItems: 6, items: schema({ name: nullableString,
    providerId: nullableString, model: nullableString, prompt: nullableString,
    referenceAssetIds: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 63 },
    concurrency: { type: ['integer', 'null'], minimum: 1, maximum: 32 },
  }) },
  iouThreshold: { type: ['number', 'null'], minimum: 0, maximum: 1 },
};
async function freshComparisonPayload(args: Record<string, unknown>, env: ToolEnvironment) {
  fields(args, ['setId', 'setVersionId', 'schemes', 'iouThreshold']);
  const setId = id(args.setId, '评测集'), setVersionId = id(args.setVersionId, '固定评测版本');
  if (!env.budgetScopeId || env.context.maxRequests == null)
    throw new AgentError('BUDGET_REQUIRED', '请先在助手配置中填写本轮共享请求上限，再启动真实对比');
  if (!Array.isArray(args.schemes) || args.schemes.length < 1 || args.schemes.length > 6)
    throw new AgentError('INVALID_ARGUMENT', '请选择 1～6 个真实重跑方案');
  const threshold = args.iouThreshold == null ? 0.5 : args.iouThreshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new AgentError('INVALID_ARGUMENT', '匹配 IoU 阈值应在 0～1 之间');
  const snapshot = await fixedSet(setId, setVersionId, env);
  const p = await project(env);
  const providers = (await env.engine.request<unknown[]>('provider.list')).map(raw => object(raw, '模型配置'));
  const configuration = annotationConfiguration(p, env);
  const selectedProvider = configuration.providerId;
  const selectedModel = configuration.model;
  const schemes = [];
  for (const raw of args.schemes) {
    ensureActive(env);
    const scheme = object(raw, '重跑方案');
    fields(scheme, ['name', 'providerId', 'model', 'prompt', 'referenceAssetIds', 'concurrency']);
    const providerId = id(scheme.providerId ?? selectedProvider, '方案接口');
    const provider = providers.find(value => value.id === providerId);
    if (!provider) throw new AgentError('MODEL_REQUIRED', '该接口尚未配置，请从设置里已保存的接口中选择');
    const model = text(scheme.model ?? (providerId === selectedProvider ? selectedModel : provider.model), '方案模型', 200);
    if (!(providerId === selectedProvider && model === selectedModel) && !providerModels(provider).some(value => value.model === model))
      throw new AgentError('MODEL_REQUIRED', '该模型尚未在所选接口中配置或验证，不能猜测模型名称');
    const prompt = text(scheme.prompt ?? configuration.prompt, '方案提示词', 16000);
    const references = scheme.referenceAssetIds == null
      ? await selectedReferences(env, snapshot.assetIds as string[]) : ids(scheme.referenceAssetIds, '参考素材', 63);
    if (Array.isArray(scheme.referenceAssetIds) && references.length !== scheme.referenceAssetIds.length)
      throw new AgentError('INVALID_ARGUMENT', '参考素材不能重复');
    for (const assetId of references) {
      if ((snapshot.assetIds as string[]).includes(assetId)) throw new AgentError('REFERENCE_OVERLAP', '评测目标不能作为同次参考');
      await scopedAsset(assetId, env);
    }
    // 同配置的重复方案是独立实验；预算和未知调用仍由 Java 统一控制，默认不自动重试。
    schemes.push({ providerId, model, prompt, referenceAssetIds: references, maxRetries: 0,
      ...(env.context.referenceResources?.length ? { referenceResources: env.context.referenceResources } : {}),
      ...(scheme.name == null ? {} : { name: text(scheme.name, '方案名称', 100) }),
      concurrency: scheme.concurrency == null ? 1 : integer(scheme.concurrency, '方案并发', 1, 32),
    });
  }
  return { setVersionId, schemes, budgetScopeId: id(env.budgetScopeId, '共享预算'),
    maxRequests: integer(env.context.maxRequests, '本轮请求上限', 1, 1_000_000),
    match: { iouThreshold: threshold, poseNormalization: 'image_diagonal' } };
}
function rerunSummary(value: Record<string, unknown>) {
  return { ...pick(value, ['id', 'comparisonId', 'projectId', 'setVersionId', 'source', 'status', 'runIds', 'evaluationId',
    'canFinish', 'budgetScopeId', 'maxRequests', 'plannedRequests', 'estimatedMaxRequests', 'budget', 'createdAt', 'completedAt']),
    schemes: Array.isArray(value.schemes) ? value.schemes.map(raw => pick(object(raw), [
      'id', 'runId', 'name', 'providerId', 'model', 'status', 'statistics',
    ])) : [],
  };
}
const comparisonProperties = {
  setId: { type: 'string' }, setVersionId: { type: 'string' },
  schemes: { type: 'array', minItems: 1, maxItems: 6, items: schema({ runId: { type: 'string' }, name: nullableString }) },
  iouThreshold: { type: ['number', 'null'], minimum: 0, maximum: 1 },
};
async function comparisonPayload(args: Record<string, unknown>, env: ToolEnvironment) {
  fields(args, ['setId', 'setVersionId', 'schemes', 'iouThreshold']);
  const setId = id(args.setId, '评测集标识'), setVersionId = id(args.setVersionId, '评测集版本');
  if (!Array.isArray(args.schemes) || args.schemes.length < 1 || args.schemes.length > 6)
    throw new AgentError('INVALID_ARGUMENT', '请选择 1～6 个已有运行作为评测方案');
  const threshold = args.iouThreshold == null ? 0.5 : args.iouThreshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new AgentError('INVALID_ARGUMENT', '匹配 IoU 阈值应在 0～1 之间');
  const seen = new Set<string>();
  const schemes = args.schemes.map(raw => {
    const scheme = object(raw, '评测方案'); fields(scheme, ['runId', 'name']);
    const runId = id(scheme.runId, '已有任务');
    if (seen.has(runId)) throw new AgentError('INVALID_ARGUMENT', '不能重复选择同一个运行');
    seen.add(runId);
    return { runId, ...(scheme.name == null ? {} : { name: text(scheme.name, '方案名称', 100) }) };
  });
  await fixedSet(setId, setVersionId, env);
  for (const scheme of schemes) scopedRecord(await env.engine.request('run.get', { runId: scheme.runId }), env, '已有任务');
  return { setVersionId, schemes, match: { iouThreshold: threshold, poseNormalization: 'image_diagonal' } };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...FLOW_TOOL_DEFINITIONS,
  ...LOCAL_TOOL_DEFINITIONS,
  ...MEDIA_TOOL_DEFINITIONS,
  ...TRACK_TOOL_DEFINITIONS,
  ...TRAINING_TOOL_DEFINITIONS,
  {
    name: 'project_summary', description: '读取当前项目类别、素材数量和标注状态。',
    parameters: schema({}), mutation: false,
    async execute(args, env) {
      fields(args, []); const p = await project(env);
      return { id: p.id, name: p.name, taskType: p.taskType, classes: p.classes,
        assetCount: p.assetCount, annotatedCount: p.annotatedCount, confirmedCount: p.confirmedCount };
    },
  },
  {
    name: 'list_assets', description: '分页列出当前项目素材，读取真实状态；可按未标注、候选、人工修改、确认等状态筛选。',
    parameters: schema({ offset: { type: ['integer', 'null'], minimum: 0 }, status: nullableString }), mutation: false,
    async execute(args, env) {
      fields(args, ['offset', 'status']);
      const offset = args.offset == null ? 0 : integer(args.offset, '起始位置', 0, 10_000_000);
      const status = args.status == null ? undefined : text(args.status, '筛选状态', 30);
      if (status && !['unlabeled', 'candidate', 'modified', 'confirmed', 'invalid', 'missing'].includes(status))
        throw new AgentError('INVALID_ARGUMENT', '不支持的素材筛选状态');
      const result = await env.engine.request<{ items: Asset[]; total: number }>('asset.list', {
        projectId: projectId(env), offset, limit: 50, ...(status ? { status } : {}),
      });
      return { total: result.total, offset, items: result.items.map(assetSummary) };
    },
  },
  {
    name: 'inspect_asset', description: '读取当前项目一张图片的实际标注对象及状态。',
    parameters: schema({ assetId: { type: 'string' } }), mutation: false,
    async execute(args, env) { fields(args, ['assetId']); return assetSummary(await scopedAsset(id(args.assetId), env)); },
  },
  {
    name: 'open_asset', description: '在工作台定位指定素材；不改变人工确认状态，不覆盖当前编辑内容。',
    parameters: schema({ assetId: { type: 'string' } }), mutation: false,
    async execute(args, env) {
      fields(args, ['assetId']); const asset = await scopedAsset(id(args.assetId), env);
      env.openAsset(asset.id); return { assetId: asset.id, requested: true };
    },
  },
  {
    name: 'list_runs', description: '读取当前项目的真实任务进度、暂停原因和结果状态。',
    parameters: schema({}), mutation: false,
    async execute(args, env) { fields(args, []); return env.engine.request('run.list', { projectId: projectId(env) }); },
  },
  {
    name: 'run_annotation', description: '使用用户已选择的标注接口与模型，提交当前项目的试标或批量任务。默认复用兼容历史候选；用户要求重新调用时用 forceRerun。复用是成功子集，不代表新请求或人工确认。完成状态以 Java 返回记录为准。',
    parameters: schema({
      assetIds: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 1000 },
      prompt: nullableString, concurrency: { type: ['integer', 'null'], minimum: 1, maximum: 32 },
      reuseEnabled: { type: ['boolean', 'null'] }, forceRerun: { type: ['boolean', 'null'] },
      reuseMaxAgeSeconds: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    }), mutation: true,
    async execute(args, env) {
      fields(args, ['assetIds', 'prompt', 'concurrency', 'reuseEnabled', 'forceRerun', 'reuseMaxAgeSeconds']);
      const reusePolicy: Record<string, unknown> = {};
      for (const key of ['reuseEnabled', 'forceRerun']) if (args[key] != null) {
        if (typeof args[key] !== 'boolean') throw new AgentError('INVALID_ARGUMENT', '复用与强制重标开关必须为布尔值');
        reusePolicy[key] = args[key];
      }
      if (args.reuseMaxAgeSeconds === null) reusePolicy.reuseMaxAgeSeconds = null;
      else if (args.reuseMaxAgeSeconds !== undefined)
        reusePolicy.reuseMaxAgeSeconds = integer(args.reuseMaxAgeSeconds, '复用最长时间', 1, Number.MAX_SAFE_INTEGER);
      const p = await project(env);
      const configuration = annotationConfiguration(p, env);
      const { providerId, model } = configuration;
      const prompt = args.prompt ?? configuration.prompt;
      if (!p.classes.length) throw new AgentError('CLASSES_REQUIRED', '请先配置标注类别');
      if (!p.assetCount) throw new AgentError('IMAGES_REQUIRED', '请先导入图片');
      if (!providerId || !model) throw new AgentError('MODEL_REQUIRED', '请先选择标注接口和标注模型');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new AgentError('PROMPT_REQUIRED', '请补充需要标注的对象和规则');
      const selected = args.assetIds == null ? env.context.assetIds : ids(args.assetIds, '素材标识');
      if (selected && !selected.length) throw new AgentError('IMAGES_REQUIRED', '当前未选中素材');
      const allowed = env.context.assetIds ? new Set(env.context.assetIds) : undefined;
      if (selected) {
        for (const assetId of selected) {
          ensureActive(env);
          if (allowed && !allowed.has(assetId)) throw new AgentError('ASSET_SCOPE', '任务包含所选范围之外的素材');
          await scopedAsset(assetId, env);
        }
      }
      const referenceAssetIds = await selectedReferences(env, selected);
      ensureActive(env);
      return env.engine.request('run.create', {
        ...reusePolicy,
        projectId: p.id, providerId: id(providerId, '标注接口'), model: text(model, '标注模型', 200),
        ...(env.budgetScopeId ? { budgetScopeId: env.budgetScopeId } : {}),
        prompt: text(prompt, '标注提示词', 16000), ...(selected ? { assetIds: selected } : {}),
        ...(referenceAssetIds.length ? { referenceAssetIds } : {}),
        ...(env.context.referenceResources?.length ? { referenceResources: env.context.referenceResources } : {}),
        ...(args.concurrency != null || configuration.concurrency != null
          ? { concurrency: integer(args.concurrency ?? configuration.concurrency, '并发数', 1, 32) } : {}),
        ...(configuration.maxRequests != null ? { maxRequests: integer(configuration.maxRequests, '请求上限', 1, 1_000_000) } : {}),
      });
    },
  },
  {
    name: 'control_run', description: '暂停、恢复或取消当前项目指定任务。恢复不会主动重发结果未知的调用。',
    parameters: schema({ runId: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'cancel'] } }), mutation: true,
    async execute(args, env) {
      fields(args, ['runId', 'action']); const runId = id(args.runId, '任务标识');
      const action = text(args.action, '操作', 10);
      if (!['pause', 'resume', 'cancel'].includes(action)) throw new AgentError('INVALID_ARGUMENT', '不支持的任务操作');
      const run = await env.engine.request<{ projectId: string }>('run.get', { runId });
      if (run.projectId !== projectId(env)) throw new AgentError('RUN_SCOPE', '该任务不属于当前项目');
      ensureActive(env);
      return env.engine.request(`run.${action}`, { runId });
    },
  },
  {
    name: 'export_preflight', description: '按助手当前处理范围检查数据集结构、标注几何及缺失素材；未限制素材范围时检查全项目。',
    parameters: schema({}), mutation: false,
    async execute(args, env) { fields(args, []); return env.engine.request('export.preflight', exportSelection(env)); },
  },
  {
    name: 'list_export_formats', description: '列出当前项目可用的导出格式：内置预设与用户保存的模板，含标签格式、目录与命名布局。模板由用户在导出面板维护，助手只读取。',
    parameters: schema({}), mutation: false,
    async execute(args, env) {
      fields(args, []);
      const current = await project(env);
      const formats = await env.engine.request<unknown[]>('export.format.list', { taskType: current.taskType });
      return formats.map(raw => {
        const item = object(raw, '导出格式');
        return pick(item, ['id', 'name', 'category', 'note', 'version', 'builtin', 'taskType',
          'labelFormat', 'precision', 'naming', 'layout', 'includeDataYaml']);
      });
    },
  },
  {
    name: 'export_dataset', description: '把当前项目导出到用户通过桌面选择的目录；用 formatId 指定用户已确认的导出格式，未指定时使用内置 YOLO 默认布局。未选择目录时需用户补充；不能自行构造路径，也不能自定义目录模板。',
    parameters: schema({ onlyConfirmed: { type: 'boolean' }, trainRatio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      formatId: nullableString, formatVersion: { type: ['integer', 'null'], minimum: 0 } }), mutation: true,
    async execute(args, env) {
      fields(args, ['onlyConfirmed', 'trainRatio', 'formatId', 'formatVersion']);
      if (!env.context.exportDir) throw new AgentError('EXPORT_DIRECTORY_REQUIRED', '请先通过导出面板选择保存目录');
      if (typeof args.onlyConfirmed !== 'boolean' || typeof args.trainRatio !== 'number' ||
        !Number.isFinite(args.trainRatio) || args.trainRatio <= 0 || args.trainRatio >= 1)
        throw new AgentError('INVALID_ARGUMENT', '导出筛选或训练集比例不正确');
      ensureActive(env);
      let format: Record<string, unknown> = {};
      if (args.formatId != null) {
        // 只接受用户已保存或内置的格式标识；模型不能在工具参数里自造目录布局。
        const requested = text(args.formatId, '导出格式标识', 128);
        const current = await project(env);
        const available = await env.engine.request<unknown[]>('export.format.list', { taskType: current.taskType });
        const chosen = available.map(raw => object(raw, '导出格式')).find(item => item.id === requested);
        if (!chosen) throw new AgentError('EXPORT_FORMAT_UNKNOWN', '导出格式不存在，请先用 list_export_formats 查看当前可用格式');
        format = { formatId: requested,
          formatVersion: args.formatVersion == null ? Number(chosen.version ?? 1) : integer(args.formatVersion, '格式版本', 0, 2147483647) };
      }
      return env.engine.request('export.create', {
        ...exportSelection(env), ...format, outputDir: env.context.exportDir,
        onlyConfirmed: args.onlyConfirmed, trainRatio: args.trainRatio,
      });
    },
  },
  {
    name: 'list_evaluation_sets', description: '列出当前项目的独立人工真值评测集和已发布版本。已确认标签不自动等于真值；本工具不读取真值答案。',
    parameters: schema({}), mutation: false,
    async execute(args, env) {
      fields(args, []);
      const sets = await env.engine.request<unknown[]>('evaluationSet.list', { projectId: projectId(env) });
      return sets.map(raw => {
        const set = scopedRecord(raw, env, '评测集');
        return { ...pick(set, ['id', 'name', 'taskType', 'revision', 'assetIds', 'truthCount', 'createdAt', 'updatedAt']),
          publishedVersions: Array.isArray(set.publishedVersions) ? set.publishedVersions.map(rawVersion => pick(object(rawVersion), [
            'id', 'version', 'sampleCount', 'truthObjectCount', 'coverage', 'createdAt',
          ])) : [] };
      });
    },
  },
  {
    name: 'list_evaluations', description: '列出当前项目已保存的质量评测摘要，保留固定版本、指标分母和失败覆盖信息。',
    parameters: schema({}), mutation: false,
    async execute(args, env) {
      fields(args, []);
      const records = await env.engine.request<unknown[]>('evaluation.list', { projectId: projectId(env) });
      return records.map(raw => evaluationSummary(scopedRecord(raw, env, '质量评测')));
    },
  },
  {
    name: 'inspect_evaluation', description: '查看一个固定评测的指标和逐图问题摘要。零分母或不可计算不能解释为零错误，不读取独立真值坐标。',
    parameters: schema({ evaluationId: { type: 'string' }, assetId: nullableString, offset: { type: ['integer', 'null'], minimum: 0 } }), mutation: false,
    async execute(args, env) {
      fields(args, ['evaluationId', 'assetId', 'offset']);
      const evaluationId = id(args.evaluationId, '评测标识');
      const evaluation = scopedRecord(await env.engine.request('evaluation.get', { evaluationId }), env, '质量评测');
      const assetId = args.assetId == null ? undefined : id(args.assetId, '素材标识');
      if (assetId) await scopedAsset(assetId, env);
      const offset = args.offset == null ? 0 : integer(args.offset, '起始位置', 0, 10_000_000);
      const results = await env.engine.request<{ items: unknown[]; total: number }>('evaluation.results', {
        evaluationId, ...(assetId ? { assetId } : {}), offset, limit: 25,
      });
      return { evaluation: evaluationSummary(evaluation), total: results.total, offset,
        items: results.items.map(raw => pick(object(raw), ['assetId', 'schemeId', 'candidateVersion', 'status', 'reason',
          'metrics', 'matchedObjects', 'missedObjects', 'extraObjects', 'missingPredictedKeypoints', 'coverage'])) };
    },
  },
  {
    name: 'preflight_comparison', description: '检查同一已发布真值版本和已有运行是否可比较，检查输入与参考泄漏；不发送模型请求，不创建评测。',
    parameters: schema(comparisonProperties), mutation: false,
    async execute(args, env) {
      return preflightSummary(await env.engine.request('evaluation.preflight', await comparisonPayload(args, env)));
    },
  },
  {
    name: 'compare_results', description: '使用已发布的独立人工真值，对所选已有运行建立固定质量评测。不会重跑模型、补齐失败样本或自动生成真值。',
    parameters: schema(comparisonProperties), mutation: true,
    async execute(args, env) {
      const payload = await comparisonPayload(args, env);
      ensureActive(env);
      const preflight = await env.engine.request<Record<string, unknown>>('evaluation.preflight', payload);
      if (preflight.canEvaluate !== true) return { created: false, preflight: preflightSummary(preflight) };
      ensureActive(env);
      const created = scopedRecord(await env.engine.request('evaluation.create', payload), env, '质量评测');
      return { created: true, evaluation: evaluationSummary(created) };
    },
  },
  {
    name: 'list_model_configurations', description: '列出已配置接口及该接口已设置或测试过的模型与能力依据。仅返回选择模型所需信息，不读取密钥或接口请求头。',
    parameters: schema({}), mutation: false,
    async execute(args, env) {
      fields(args, []);
      const records = await env.engine.request<unknown[]>('provider.list');
      return records.map(raw => { const provider = object(raw); return {
        ...pick(provider, ['id', 'name', 'protocol', 'model', 'revision']), models: providerModels(provider),
      }; });
    },
  },
  {
    name: 'preflight_evaluation_rerun', description: '检查固定评测图片上的真实多方案重跑：素材范围、参考重叠、既有模型配置和共享请求预算。只预检，不发送标注请求。',
    parameters: schema(freshComparisonProperties), mutation: false,
    async execute(args, env) {
      return preflightSummary(await env.engine.request('evaluation.rerun.preflight', await freshComparisonPayload(args, env)));
    },
  },
  {
    name: 'run_evaluation', description: '默认用固定评测图片实际重跑 1～6 个方案，并共享本轮明确请求上限。会产生真实调用；独立真值不发给模型，候选不覆盖正式人工版本。仅提交，不能声称评测已完成。',
    parameters: schema(freshComparisonProperties), mutation: true,
    async execute(args, env) {
      const payload = await freshComparisonPayload(args, env);
      ensureActive(env);
      const preflight = await env.engine.request<Record<string, unknown>>('evaluation.rerun.preflight', payload);
      if (preflight.canStart !== true) return { created: false, preflight: preflightSummary(preflight) };
      ensureActive(env);
      return { created: true, comparison: rerunSummary(scopedRecord(await env.engine.request('evaluation.rerun.create', payload), env, '重跑比较')) };
    },
  },
  {
    name: 'inspect_comparison', description: '查询当前项目真实重跑比较的逐方案状态、调用预算及是否可计算指标。暂停或结果未知需要处理，不自动补跑。',
    parameters: schema({ comparisonId: { type: 'string' } }), mutation: false,
    async execute(args, env) {
      fields(args, ['comparisonId']);
      return rerunSummary(scopedRecord(await env.engine.request('evaluation.rerun.get', {
        comparisonId: id(args.comparisonId, '重跑比较'),
      }), env, '重跑比较'));
    },
  },
  {
    name: 'finish_comparison', description: '在全部方案已结束时固定质量指标；未结束只返回进度，不等待、不补跑，不读取独立答案坐标。重复完成返回同一评测。',
    parameters: schema({ comparisonId: { type: 'string' } }), mutation: true,
    async execute(args, env) {
      fields(args, ['comparisonId']); const comparisonId = id(args.comparisonId, '重跑比较');
      const record = scopedRecord(await env.engine.request('evaluation.rerun.get', { comparisonId }), env, '重跑比较');
      if (record.canFinish !== true && !record.evaluationId) return { finished: false, comparison: rerunSummary(record) };
      ensureActive(env);
      return { finished: true, evaluation: evaluationSummary(scopedRecord(await env.engine.request('evaluation.rerun.finish', {
        comparisonId,
      }), env, '质量评测')) };
    },
  },
  {
    name: 'inspect_budget', description: '读取本次助手会话共享的实际请求预算和费用状态。费用阈值不能保证在途请求不超额，未知费用不能当作零。',
    parameters: schema({}), mutation: false,
    async execute(args, env) {
      fields(args, []);
      if (!env.budgetScopeId) throw new AgentError('BUDGET_SCOPE_REQUIRED', '当前会话尚未建立共享预算');
      return env.engine.request('budget.get', { budgetScopeId: id(env.budgetScopeId, '本次会话预算') });
    },
  },
  {
    name: 'estimate_cost', description: '用用户明确给出的请求次数和每次 token 假设、已选择标注模型的配置单价估算费用。不猜测单价或 token，不修改价格与预算，不发送模型请求。',
    parameters: schema({ requests: { type: 'integer', minimum: 1, maximum: 1_000_000 },
      inputTokensPerRequest: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
      outputTokensPerRequest: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
      cachedInputTokensPerRequest: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000_000 },
    }), mutation: false,
    async execute(args, env) {
      fields(args, ['requests', 'inputTokensPerRequest', 'outputTokensPerRequest', 'cachedInputTokensPerRequest']);
      const requests = integer(args.requests, '预估请求次数', 1, 1_000_000);
      const input = integer(args.inputTokensPerRequest, '每次输入 token 假设', 0, 1_000_000_000);
      const output = integer(args.outputTokensPerRequest, '每次输出 token 假设', 0, 1_000_000_000);
      const cached = args.cachedInputTokensPerRequest == null ? undefined
        : integer(args.cachedInputTokensPerRequest, '每次缓存输入 token 假设', 0, input);
      const p = await project(env);
      const { providerId, model } = annotationConfiguration(p, env);
      if (!providerId || !model) throw new AgentError('MODEL_REQUIRED', '请先选择需要估算的标注接口和模型');
      return env.engine.request('budget.estimate', { providerId: id(providerId, '标注接口'), model: text(model, '标注模型', 200),
        requests, inputTokensPerRequest: input, outputTokensPerRequest: output,
        ...(cached == null ? {} : { cachedInputTokensPerRequest: cached }),
      });
    },
  },
  {
    name: 'list_review_items', description: '分页查询当前项目的待复核问题。可随后用 open_asset 打开素材；查询不会完成人工复核、确认标注或重发请求。',
    parameters: schema({ offset: { type: ['integer', 'null'], minimum: 0 }, status: nullableString }), mutation: false,
    async execute(args, env) {
      fields(args, ['offset', 'status']);
      const offset = args.offset == null ? 0 : integer(args.offset, '起始位置', 0, 10_000_000);
      const status = args.status == null ? undefined : text(args.status, '复核状态', 40);
      if (status && !['pending', 'checked', 'dismissed', 'request_relabel'].includes(status))
        throw new AgentError('INVALID_ARGUMENT', '不支持的复核筛选状态');
      const result = await env.engine.request<{ items: unknown[]; total: number }>('review.list', {
        projectId: projectId(env), offset, limit: 50, ...(status ? { status } : {}),
      });
      return { total: result.total, offset, items: result.items.map(raw => pick(scopedRecord(raw, env, '复核项'), [
        'id', 'assetId', 'candidateVersion', 'objectId', 'reason', 'severity', 'source', 'status', 'evaluationId', 'runId', 'sampleId',
      ])) };
    },
  },
];

export function modelTools() {
  return TOOL_DEFINITIONS.map(tool => ({ type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.parameters, strict: true,
  } }));
}
export function findTool(name: string): ToolDefinition {
  const tool = TOOL_DEFINITIONS.find(item => item.name === name);
  if (!tool) throw new AgentError('TOOL_UNKNOWN', '模型请求了未开放的工具');
  return tool;
}
