import { resolveConfiguration } from '../shared/configuration.ts';
import type { FlowDefinition, FlowExecution, FlowInput, FlowStartRequest } from '../shared/flow.ts';
import type { Project } from '../shared/protocol.ts';
import type { ToolDefinition, ToolEnvironment } from './tools.ts';
import { localClassId, localRuntime, registeredLocalModel } from './inference-tools.ts';
import { completedVideoJob, SCREENING_PARAMETER_PROPERTIES, screeningParameters, screeningReasons, videoFramesPage } from './media-tools.ts';
import { AgentError, fields, id, ids, integer, object, text } from './validation.ts';

const schema = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };
const number = (minimum: number, maximum: number) => ({ type: ['integer', 'null'], minimum, maximum });
const choice = (values: string[], nullable = false) => ({ type: nullable ? ['string', 'null'] : 'string', enum: nullable ? [...values, null] : values });
const idList = { type: ['array', 'null'], items: string, minItems: 1, maxItems: 10000, uniqueItems: true };
const statuses = ['unlabeled', 'candidate', 'modified', 'confirmed', 'invalid', 'missing'];
const dimension = { type: 'integer', minimum: 1, maximum: 20000 };
const transformOperations = { type: ['array', 'null'], maxItems: 30, items: { anyOf: [
  schema({ kind: choice(['crop']), x: { type: 'integer', minimum: 0, maximum: 20000 }, y: { type: 'integer', minimum: 0, maximum: 20000 }, width: dimension, height: dimension }),
  schema({ kind: choice(['resize']), width: dimension, height: dimension, fit: choice(['contain', 'stretch'], true) }),
  schema({ kind: choice(['tile']), width: dimension, height: dimension, overlapX: number(0, 19999), overlapY: number(0, 19999) }),
] } };
const stepParameters = {
  import: { mediaJobId: { ...nullableString, description: '用户已完成的视频抽帧任务；须同项目且产物已提交。视频抽帧本身需用户点击「选择视频抽帧」或拖入视频发起，助手不能代选本地文件。此参数只接受任务标识，不接受文件路径。' } },
  transform: { operations: transformOperations, background: { type: ['string', 'null'], pattern: '^#[0-9a-fA-F]{6}$' } },
  local: { modelId: nullableString, modelVersion: number(1, 2147483647), device: { type: ['string', 'null'], pattern: '^(cpu|0|[1-9][0-9]{0,2})$' },
    classMap: { type: ['array', 'null'], maxItems: 10000, description: '逐一列出模型全部类别；忽略类别也须明确设 projectClassId 为 null。',
      items: schema({ modelClassId: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 32 }, projectClassId: nullableString }) },
    // 开放词汇模型的类别就是这份文本列表，classMap 的键是它的下标（0 起）。
    textClasses: { type: ['array', 'null'], minItems: 1, maxItems: 200, uniqueItems: true, description: '开放词汇模型的文本类别名，顺序即类别号（0 起）；仅开放词汇模型可用。',
      items: { type: 'string', minLength: 1, maxLength: 100 } },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 }, iou: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    imageSize: number(32, 4096), maxDetections: number(1, 10000), timeoutMs: number(1000, 600000),
    reuseEnabled: { ...nullableBoolean, description: '是否复用匹配的历史本地输入结果；null 使用引擎默认 true。' },
    forceRerun: { ...nullableBoolean, description: '是否跳过复用并重新本地计算；null 使用引擎默认 false，不产生 API 请求或占用 API 预算。' },
    reuseMaxAgeSeconds: { ...number(1, Number.MAX_SAFE_INTEGER), description: '历史结果有效期，单位秒；null 表示不限制时间。' } },
  filter: { assetIds: idList, statuses: { type: ['array', 'null'], items: choice(statuses), minItems: 1, maxItems: 6, uniqueItems: true },
    minWidth: number(1, 100000), minHeight: number(1, 100000), maxWidth: number(1, 100000), maxHeight: number(1, 100000), deduplicate: nullableBoolean,
    screening: { anyOf: [{ type: 'null' }, schema(SCREENING_PARAMETER_PROPERTIES)] },
    excludeAssetIds: { ...idList, description: '明确排除的素材 ID；不根据近重复或模糊提示自动填写，人工版本保护由引擎执行。' } },
  api: { providerId: nullableString, model: nullableString, prompt: { type: ['string', 'null'], maxLength: 100000 },
    concurrency: number(1, 32), maxRetries: number(0, 6), maxRequests: number(1, 1000000),
    reuseEnabled: { ...nullableBoolean, description: '是否复用匹配的历史成功候选；null 使用引擎默认 true。' },
    forceRerun: { ...nullableBoolean, description: '是否跳过复用并重新请求；null 使用引擎默认 false，真实请求仍受共享预算约束。' },
    reuseMaxAgeSeconds: { ...number(1, Number.MAX_SAFE_INTEGER), description: '历史结果有效期，单位秒；null 表示不限制时间。' } },
  review: { buildIssues: nullableBoolean, randomSample: { anyOf: [{ type: 'null' }, schema({ count: { type: 'integer', minimum: 1, maximum: 1000 }, seed: { type: 'string', minLength: 1, maxLength: 256 } })] }, waitForHuman: nullableBoolean },
  export: { trainRatio: { type: ['number', 'null'], exclusiveMinimum: 0, exclusiveMaximum: 1 }, onlyConfirmed: nullableBoolean, annotationSelection: choice(['protected', 'candidate'], true) },
};
const definitionSchema = schema({ version: { type: 'integer', enum: [1] }, name: { type: 'string', minLength: 1, maxLength: 200 },
  steps: { type: 'array', minItems: 1, maxItems: 30, items: { anyOf: Object.entries(stepParameters).map(([kind, parameters]) => schema({
    id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.-]+$' },
    kind: choice([kind]), enabled: { type: 'boolean' }, parameters: schema(parameters),
  })) } } });
const inputSchema = { anyOf: [
  schema({ source: choice(['project']), selection: choice(['all', 'unlabeled']) }),
  schema({ source: choice(['project']), selection: choice(['explicit']), assetIds: { ...idList, type: 'array' } }),
  schema({ source: choice(['artifact']), artifactId: string }),
] };
const startProperties = { definition: definitionSchema, input: inputSchema,
  execution: { anyOf: [{ type: 'null' }, schema({ mode: choice(['all']) }), schema({ mode: choice(['single']), stepId: string })] },
  failurePolicy: choice(['continue', 'pause'], true) };
const stepStatisticKeys = ['total', 'processed', 'succeeded', 'failed', 'unknown', 'excluded', 'queued', 'inFlight', 'reused'];
const runStatisticKeys = ['stepsTotal', 'stepsCompleted', 'stepsFailed', 'inputAssets', 'inputViews', 'outputAssets', 'requestsUsed', 'reused'];

function active(env: ToolEnvironment) {
  if (env.signal?.aborted) throw new AgentError('AGENT_CANCELLED', '对话已停止，未提交新的操作');
}
function projectId(env: ToolEnvironment) {
  if (!env.projectId) throw new AgentError('PROJECT_REQUIRED', '请先打开一个项目');
  return id(env.projectId, '项目标识');
}
function stepId(value: unknown) {
  const result = text(value, '步骤标识', 128);
  if (!/^[A-Za-z0-9_.-]+$/.test(result)) throw new AgentError('INVALID_ARGUMENT', '步骤标识格式不正确');
  return result;
}
function uniqueIds(value: unknown, label: string, maximum = 10000, allowEmpty = false) {
  const result = ids(value, label, maximum);
  if ((!result.length && !allowEmpty) || result.length !== (value as unknown[]).length)
    throw new AgentError('INVALID_ARGUMENT', `${label}不能为空或重复`);
  return result;
}
function enumValue(value: unknown, values: string[], label: string) {
  if (typeof value !== 'string' || !values.includes(value)) throw new AgentError('INVALID_ARGUMENT', `${label}不受支持`);
  return value;
}
function bool(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new AgentError('INVALID_ARGUMENT', `${label}必须是布尔值`);
  return value;
}
function transformParameters(value: Record<string, unknown>) {
  fields(value, Object.keys(stepParameters.transform));
  const result: Record<string, unknown> = {};
  if (value.background != null) {
    if (typeof value.background !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.background))
      throw new AgentError('INVALID_ARGUMENT', '背景颜色必须是六位十六进制颜色');
    result.background = value.background;
  }
  if (value.operations != null) {
    if (!Array.isArray(value.operations) || value.operations.length > 30) throw new AgentError('INVALID_ARGUMENT', '图像处理操作最多 30 个');
    let tiled = false;
    result.operations = value.operations.map(raw => {
      const operation = object(raw, '图像处理操作'), kind = enumValue(operation.kind, ['crop', 'resize', 'tile'], '图像处理操作');
      fields(operation, ['kind', 'width', 'height', ...(kind === 'crop' ? ['x', 'y'] : kind === 'resize' ? ['fit'] : ['overlapX', 'overlapY'])]);
      const width = integer(operation.width, '处理宽度', 1, 20000), height = integer(operation.height, '处理高度', 1, 20000);
      if (width * height > 40000000) throw new AgentError('INVALID_ARGUMENT', '处理图像不能超过 4000 万像素');
      const fixed: Record<string, unknown> = { kind, width, height };
      if (kind === 'crop') Object.assign(fixed, { x: integer(operation.x, '裁剪横坐标', 0, 20000), y: integer(operation.y, '裁剪纵坐标', 0, 20000) });
      if (kind === 'resize' && operation.fit != null) fixed.fit = enumValue(operation.fit, ['contain', 'stretch'], '缩放方式');
      if (kind === 'tile') {
        if (tiled) throw new AgentError('INVALID_ARGUMENT', '同一处理步骤最多执行一次切片');
        tiled = true;
        if (operation.overlapX != null) fixed.overlapX = integer(operation.overlapX, '水平重叠', 0, width - 1);
        if (operation.overlapY != null) fixed.overlapY = integer(operation.overlapY, '垂直重叠', 0, height - 1);
      }
      return fixed;
    });
  }
  return result;
}
async function localParameters(value: Record<string, unknown>, env: ToolEnvironment, executing: boolean, historical = false, requireReady = false) {
  fields(value, Object.keys(stepParameters.local));
  const result: Record<string, unknown> = reusePolicy(value);
  if (value.modelId != null) result.modelId = id(value.modelId, '本地模型');
  if (value.modelVersion != null) result.modelVersion = integer(value.modelVersion, '本地模型版本', 1, 2147483647);
  if (value.device != null) {
    if (typeof value.device !== 'string' || !/^(cpu|0|[1-9][0-9]{0,2})$/.test(value.device))
      throw new AgentError('INVALID_ARGUMENT', '本地设备应为 cpu 或 0～999 的设备编号');
    result.device = value.device;
  }
  for (const key of ['confidence', 'iou']) if (value[key] != null) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)
      throw new AgentError('INVALID_ARGUMENT', '置信度和交并比必须在 0～1 之间');
    result[key] = value[key];
  }
  if (value.imageSize != null) result.imageSize = integer(value.imageSize, '本地推理尺寸', 32, 4096);
  if (value.maxDetections != null) result.maxDetections = integer(value.maxDetections, '最大目标数', 1, 10000);
  if (value.timeoutMs != null) result.timeoutMs = integer(value.timeoutMs, '本地推理超时毫秒', 1000, 600000);
  if (value.classMap != null) {
    // strict 工具参数使用固定字段数组；持久化定义始终使用 Engine 的映射对象。
    const entries = historical ? Object.entries(object(value.classMap, '历史模型类别映射')) : (() => {
      if (!Array.isArray(value.classMap)) throw new AgentError('INVALID_ARGUMENT', '模型类别映射必须为列表');
      return value.classMap.map(raw => {
        const entry = object(raw, '模型类别映射'); fields(entry, ['modelClassId', 'projectClassId']);
        if (entry.projectClassId === undefined) throw new AgentError('INVALID_ARGUMENT', '忽略模型类别时必须显式设置 null');
        return [entry.modelClassId, entry.projectClassId];
      });
    })();
    if (entries.length > 10000) throw new AgentError('INVALID_ARGUMENT', '模型类别映射最多 10000 项');
    const seen = new Set<string>();
    result.classMap = Object.fromEntries(entries.map(([from, to]) => {
      const classId = localClassId(from);
      if (seen.has(classId)) throw new AgentError('INVALID_ARGUMENT', '模型类别映射不能重复');
      seen.add(classId);
      return [classId, to === null ? null : id(to, '项目类别')];
    }));
  }
  if (value.textClasses != null) {
    if (!Array.isArray(value.textClasses) || !value.textClasses.length || value.textClasses.length > 200) throw new AgentError('INVALID_ARGUMENT', '文本类别必须为 1 至 200 条的列表');
    const names = value.textClasses.map(raw => String(raw).trim());
    if (names.some(name => !name || name.length > 100)) throw new AgentError('INVALID_ARGUMENT', '文本类别不能为空或超过 100 字符');
    if (new Set(names).size !== names.length) throw new AgentError('INVALID_ARGUMENT', '文本类别不能重复');
    result.textClasses = names;
  }
  if (requireReady && (!result.modelId || !result.modelVersion || !result.classMap))
    throw new AgentError('LOCAL_MODEL_REQUIRED', '请先选择已登记模型的固定版本并填写完整类别映射（开放词汇模型请同时给出 textClasses）');
  if (historical && result.modelId && result.modelVersion == null)
    throw new AgentError('LOCAL_MODEL_VERSION_REQUIRED', '历史流程缺少固定本地模型版本，请在流程编辑器处理');
  const project = result.modelId || result.classMap != null ? await currentProject(env) : undefined;
  if (result.classMap != null) {
    const targets = new Set(project!.classes.map(entry => entry.id));
    if (Object.values(object(result.classMap)).some(target => target !== null && !targets.has(target as string)))
      throw new AgentError('CLASS_MAP_SCOPE', '模型类别映射不属于当前项目');
  }
  if (result.modelId) {
    const registered = await registeredLocalModel(env, result.modelId as string, result.modelVersion as number | undefined);
    if (registered.taskType !== project!.taskType) throw new AgentError('LOCAL_MODEL_TASK_MISMATCH', '本地模型任务类型与当前项目不一致');
    result.modelVersion = registered.version;
    if (executing) {
      const runtime = await localRuntime(env);
      // 未显式指定设备时，优先复用同一模型版本已加载的空闲 GPU；
      // 没有 GPU 载入版本时保留 CPU 默认，避免为了提速偷偷触发模型加载。
      if (result.device == null) {
        const loadedGpu = runtime.slots.find(slot => !slot.busy && slot.device !== 'cpu'
          && slot.modelId === registered.id && slot.modelVersion === registered.version && slot.classes?.length);
        if (loadedGpu) result.device = loadedGpu.device;
      }
      const slot = runtime.slots.find(slot => slot.device === (result.device ?? 'cpu') && slot.modelId === registered.id && slot.modelVersion === registered.version);
      // available 来自上次环境探测；已加载的固定版本仍以实际槽与引擎预检为准。
      if (requireReady && (!runtime.configured || !runtime.workerAvailable || !slot?.classes))
        throw new AgentError('LOCAL_MODEL_NOT_LOADED', '请在设置 · 软件 AI 配置里加载所选固定版本并读取完整类别');
      if (slot?.classes && result.classMap != null) {
        const mapping = object(result.classMap);
        // 开放词汇的类别由 textClasses 决定（下标即类别号），固定类别表模型才比对载入时的类别表。
        const expected = registered.openVocabulary
          ? Object.keys((result.textClasses as string[] | undefined) ?? [])
          : (slot.classes as Array<{ id: string }>).map(entry => entry.id);
        if (expected.length !== Object.keys(mapping).length || !expected.every(key => Object.hasOwn(mapping, key)))
          throw new AgentError('CLASS_MAP_INCOMPLETE', '模型每个类别都须明确映射，忽略类别请设置 null');
      }
    }
  }
  return result;
}
function assertAvailable(definition: FlowDefinition, available: unknown, execution: FlowExecution = { mode: 'all' }) {
  const required = definition.steps.filter(step => step.enabled && ['transform', 'local'].includes(step.kind)
    && (execution.mode === 'all' || execution.stepId === step.id));
  if (required.some(step => !Array.isArray(available) || !available.includes(step.kind)))
    throw new AgentError('FLOW_STEP_UNAVAILABLE', '当前引擎尚不支持所选图像处理或本地预标注步骤');
}
function reusePolicy(value: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  if (value.reuseEnabled != null) result.reuseEnabled = bool(value.reuseEnabled, '复用历史结果');
  if (value.forceRerun != null) result.forceRerun = bool(value.forceRerun, '强制重新计算');
  // Java 还校验秒数乘 1000 不溢出 long；JS 安全整数上界更小，先保住传输精度。
  if (value.reuseMaxAgeSeconds !== undefined) result.reuseMaxAgeSeconds = value.reuseMaxAgeSeconds === null ? null
    : integer(value.reuseMaxAgeSeconds, '结果有效期秒数', 1, Number.MAX_SAFE_INTEGER);
  return result;
}
function scoped(value: unknown, env: ToolEnvironment, label: string) {
  const record = object(value, label);
  if (record.projectId !== projectId(env)) throw new AgentError('PROJECT_SCOPE', `${label}不属于当前项目`);
  return record;
}
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function budgetSummary(value: unknown) {
  if (value == null) return undefined;
  const record = object(value);
  return { ...pick(record, ['budgetScopeId', 'maxRequests', 'requestsUsed', 'remaining']),
    ...(record.cost == null ? {} : { cost: pick(object(record.cost), ['currency', 'knownCost', 'knownCalls', 'unknownCalls', 'inFlightCalls',
      'limit', 'control', 'hardLimit', 'basis', 'providerBilledAmount']) }) };
}
function summaryStats(value: unknown, keys = stepStatisticKeys) { return value == null ? undefined : pick(object(value), keys); }
function runSummary(run: Record<string, unknown>) {
  return { ...pick(run, ['id', 'projectId', 'name', 'revision', 'sourceFlowRunId', 'status', 'pauseReason', 'createdAt', 'updatedAt',
    'completedAt', 'inputArtifactId', 'budgetScopeId', 'sequence']), statistics: summaryStats(run.statistics, runStatisticKeys),
    budget: budgetSummary(run.budget),
    steps: Array.isArray(run.steps) ? run.steps.map(raw => {
      const step = object(raw);
      return { ...pick(step, ['stepId', 'kind', 'order', 'status', 'enabled', 'inputArtifactId', 'outputArtifactId', 'childRunId',
        'startedAt', 'completedAt', 'errorCode', 'message']), statistics: summaryStats(step.statistics),
        ...(step.local == null ? {} : { local: pick(object(step.local), ['modelId', 'modelVersion', 'device']) }),
        inheritedFrom: step.inheritedFrom == null ? undefined : pick(object(step.inheritedFrom), ['flowRunId', 'stepId', 'artifactId']) };
    }) : [] };
}
function preflightSummary(result: Record<string, unknown>) {
  return { ...pick(result, ['canStart', 'projectId', 'inputCount', 'plannedRequests', 'estimatedMaxRequests', 'manualProtectedCount', 'availableSteps']),
    issues: Array.isArray(result.issues) ? result.issues.map(raw => pick(object(raw), ['stepId', 'code', 'message', 'severity'])) : [],
    steps: Array.isArray(result.steps) ? result.steps.map(raw => pick(object(raw), ['stepId', 'kind', 'enabled', 'inputCount', 'plannedRequests'])) : [] };
}
function artifactSummary(result: Record<string, unknown>) {
  return { ...pick(result, ['id', 'projectId', 'flowRunId', 'stepId', 'kind', 'createdAt', 'total', 'exportId', 'reviewSampleId']),
    statistics: summaryStats(result.statistics), items: (result.items as unknown[]).map(raw => {
      const item = object(raw);
      return { ...pick(item, ['id', 'assetId', 'name', 'contentHash', 'width', 'height', 'selectedVersion', 'candidateVersion', 'outcome', 'reason', 'sourceRunId', 'sourceArtifactId',
        'inputId', 'viewId', 'planHash', 'resultId', 'requiresGeometryReview', 'screeningRecommendation']),
        ...(item.screeningReasons == null ? {} : { screeningReasons: screeningReasons(item.screeningReasons) }),
        ...(item.metadata == null ? {} : { metadata: sourceSummary(item.metadata) }),
        ...(item.inputSnapshot == null ? {} : { inputSnapshot: pick(object(item.inputSnapshot), ['inputId', 'kind', 'assetId', 'contentHash', 'width', 'height',
          'normalizationVersion', 'viewId', 'planHash', 'pixelTransformVersion']) }),
        ...(item.reused === true ? { reused: true,
          ...(item.reusedFrom == null ? {} : { reusedFrom: reuseSummary(item.reusedFrom) }),
          ...(item.inputReusedFrom == null ? {} : { inputReusedFrom: inputReuseSummary(item.inputReusedFrom) }) } : {}) };
    }) };
}
function sourceSummary(value: unknown) {
  const source = object(value, '素材来源');
  return Object.fromEntries(['sourceVideoId', 'groupId', 'sourcePresentationIndex', 'sourcePts', 'originPts', 'relativePts', 'timeSeconds', 'rangeIndex', 'bucketIndex', 'selectionVersion']
    .filter(key => source[key] === null || typeof source[key] === 'string' || typeof source[key] === 'number' && Number.isFinite(source[key]))
    .map(key => [key, source[key]]));
}
function reuseSummary(value: unknown) {
  const source = object(value, '复用来源');
  const modelVersion = source.sourceModelVersion == null ? {} : object(source.sourceModelVersion, '来源模型版本');
  return { ...pick(source, ['sourceRunId', 'sourceSampleId', 'sourceAssetId', 'sourceCandidateVersion', 'sourceAttemptId', 'sourceCompletedAt', 'sourceModel']),
    ...(source.sourceModelVersion == null ? {} : { sourceModelVersion: Object.fromEntries(['model', 'model_version', 'system_fingerprint']
      .filter(key => typeof modelVersion[key] === 'string').map(key => [key, modelVersion[key]])) }) };
}
function inputReuseSummary(value: unknown) {
  const origin = object(value, '输入结果复用来源');
  if (origin.source !== 'api' && origin.source !== 'local')
    throw new AgentError('INVALID_ENGINE_RESPONSE', '输入结果复用来源类型不受支持');
  const result: Record<string, unknown> = { source: origin.source,
    ...Object.fromEntries(['sourceResultId', 'sourceRunId', 'sourceSampleId', 'sourceInputId', 'sourceAssetId', 'sourceCompletedAt', 'sourceModel']
      .filter(key => typeof origin[key] === 'string').map(key => [key, origin[key]])) };
  // 两种真实来源保留各自的版本形态，不能把本地计算补成 API attempt 或旧候选复用。
  if (origin.source === 'api') {
    if (typeof origin.sourceAttemptId === 'string') result.sourceAttemptId = origin.sourceAttemptId;
    if (origin.sourceModelVersion != null) {
      const version = object(origin.sourceModelVersion, '来源接口模型版本');
      result.sourceModelVersion = Object.fromEntries(['model', 'model_version', 'system_fingerprint']
        .filter(key => typeof version[key] === 'string').map(key => [key, version[key]]));
    }
  } else {
    if (typeof origin.sourceModelId === 'string') result.sourceModelId = origin.sourceModelId;
    if (Number.isSafeInteger(origin.sourceModelVersion) && (origin.sourceModelVersion as number) > 0)
      result.sourceModelVersion = origin.sourceModelVersion;
    if (typeof origin.sourceRequestedDevice === 'string') result.sourceRequestedDevice = origin.sourceRequestedDevice;
    if (origin.sourceObservedBackend === null) result.sourceObservedBackend = null;
    else if (origin.sourceObservedBackend != null) {
      const backend = object(origin.sourceObservedBackend, '实际本地推理后端');
      if (backend.kind === 'pytorch' && typeof backend.device === 'string' && backend.providers === null)
        result.sourceObservedBackend = { kind: 'pytorch', device: backend.device, providers: null };
      if (backend.kind === 'onnxruntime' && backend.device === null && Array.isArray(backend.providers) && backend.providers.every(value => typeof value === 'string'))
        result.sourceObservedBackend = { kind: 'onnxruntime', device: null, providers: backend.providers };
    }
  }
  return result;
}
function selection(env: ToolEnvironment) {
  return env.context.assetIds == null ? undefined : new Set(uniqueIds(env.context.assetIds, '助手素材范围'));
}
async function assets(assetIds: string[], env: ToolEnvironment, allowed: Set<string> | undefined | null = selection(env)) {
  if (allowed && assetIds.some(assetId => !allowed.has(assetId))) throw new AgentError('ASSET_SCOPE', '素材超出助手当前选择范围');
  const result: Record<string, unknown>[] = [];
  // 有界并发避免大范围校验同时压满引擎连接，也不会因首屏截断而遗漏授权范围。
  for (let offset = 0; offset < assetIds.length; offset += 10) {
    active(env);
    result.push(...await Promise.all(assetIds.slice(offset, offset + 10).map(async assetId => {
      const asset = scoped(await env.engine.request('asset.get', { assetId }), env, '素材');
      if (asset.id !== assetId) throw new AgentError('ASSET_SCOPE', '素材响应与请求不匹配');
      return asset;
    })));
  }
  return result;
}
async function videoImport(jobId: string, env: ToolEnvironment, targetIds?: string[]) {
  const source = await completedVideoJob(env, jobId);
  const scope = targetIds ? new Set(targetIds) : selection(env);
  if (!scope) return;
  // 有明确素材范围时，尚未入库的新帧不能借导入步骤扩大当前授权集合。
  let offset = 0, total: number | undefined; const seen = new Set<string>();
  do {
    const page = await videoFramesPage(env, jobId, offset, 500);
    if (page.total > 10000 || total !== undefined && total !== page.total) throw new AgentError('MEDIA_RESPONSE_INVALID', '视频帧范围过大或分页发生变化');
    total = page.total;
    for (const frame of page.items) {
      if (frame.sourceVideoId !== source.sourceVideoId) throw new AgentError('MEDIA_RESPONSE_INVALID', '视频帧来源与媒体任务不一致');
      if (typeof frame.assetId !== 'string' || !scope.has(frame.assetId))
        throw new AgentError('MEDIA_IMPORT_SCOPE_REQUIRED', '此视频包含未入库或当前范围外的帧，请在素材任务详情里将其导入项目，并把助手素材范围调到包含这些帧');
      const frameId = id(frame.frameId, '视频帧');
      if (seen.has(frameId)) throw new AgentError('MEDIA_RESPONSE_INVALID', '视频帧跨页重复'); seen.add(frameId);
    }
    offset += page.items.length;
  } while (offset < total);
}
async function filterParameters(value: Record<string, unknown>, env: ToolEnvironment, targetIds?: string[]) {
  fields(value, Object.keys(stepParameters.filter)); const parameters: Record<string, unknown> = {}, target = targetIds ? new Set(targetIds) : undefined;
  for (const key of ['assetIds', 'excludeAssetIds']) if (value[key] != null) {
    const selected = uniqueIds(value[key], key === 'assetIds' ? '筛选素材' : '明确排除素材');
    if (target && selected.some(assetId => !target.has(assetId))) throw new AgentError('ASSET_SCOPE', '筛选或排除素材必须属于流程输入');
    await assets(selected, env); parameters[key] = selected;
  }
  if (value.statuses != null) {
    if (!Array.isArray(value.statuses) || !value.statuses.length || value.statuses.length > 6)
      throw new AgentError('INVALID_ARGUMENT', '素材状态应为 1～6 项列表');
    const selected = value.statuses.map(status => enumValue(status, statuses, '素材状态'));
    if (new Set(selected).size !== selected.length) throw new AgentError('INVALID_ARGUMENT', '素材状态不能重复');
    parameters.statuses = selected;
  }
  for (const key of ['minWidth', 'minHeight', 'maxWidth', 'maxHeight']) if (value[key] != null) parameters[key] = integer(value[key], '筛选尺寸', 1, 100000);
  for (const dimension of ['Width', 'Height']) if (parameters[`min${dimension}`] != null && parameters[`max${dimension}`] != null
    && (parameters[`min${dimension}`] as number) > (parameters[`max${dimension}`] as number)) throw new AgentError('INVALID_ARGUMENT', '最小尺寸不能大于最大尺寸');
  if (value.deduplicate != null) parameters.deduplicate = bool(value.deduplicate, '内容去重');
  if (value.screening != null) parameters.screening = screeningParameters(value.screening);
  return parameters;
}
async function artifactPage(artifactId: string, env: ToolEnvironment, offset = 0, limit = 500) {
  active(env);
  const result = scoped(await env.engine.request('flow.artifact', { artifactId, offset, limit }), env, '流程产物');
  if (result.id !== artifactId || !Array.isArray(result.items) || result.items.length > limit)
    throw new AgentError('FLOW_ARTIFACT_INVALID', '流程产物响应不完整');
  integer(result.total, '产物总数', 0, Number.MAX_SAFE_INTEGER);
  return result;
}
async function artifactScope(artifactId: string, env: ToolEnvironment, collect = false) {
  const first = await artifactPage(artifactId, env);
  const allowed = selection(env);
  if (!allowed && !collect) return { first, assetIds: undefined };
  const total = integer(first.total, '产物总数', 0, 10000);
  const assetIds = new Set<string>(), itemIds = new Set<string>();
  let offset = 0, page = first;
  while (offset < total) {
    const items = page.items as unknown[];
    if (!items.length || offset + items.length > total || page.total !== total || page.flowRunId !== first.flowRunId)
      throw new AgentError('FLOW_ARTIFACT_INVALID', '流程产物分页不完整，请重新读取');
    for (const raw of items) {
      const item = object(raw), itemId = id(item.id, '产物项'), assetId = id(item.assetId, '产物素材');
      if (itemIds.has(itemId)) throw new AgentError('FLOW_ARTIFACT_INVALID', '流程产物分页重复');
      itemIds.add(itemId);
      if (allowed && !allowed.has(assetId)) throw new AgentError('ASSET_SCOPE', '流程产物包含助手当前选择范围外的素材');
      assetIds.add(assetId);
    }
    offset += items.length;
    if (offset < total) page = await artifactPage(artifactId, env, offset);
  }
  if (!total && (first.items as unknown[]).length) throw new AgentError('FLOW_ARTIFACT_INVALID', '流程产物总数与内容不一致');
  return { first, assetIds: [...assetIds] };
}
async function normalizeInput(raw: unknown, env: ToolEnvironment): Promise<{ input: FlowInput; targetIds?: string[] }> {
  const input = object(raw, '流程输入');
  if (input.source === 'artifact') {
    fields(input, ['source', 'artifactId']);
    const artifactId = id(input.artifactId, '输入产物');
    const checked = await artifactScope(artifactId, env, !!env.context.referenceAssetIds?.length);
    return { input: { source: 'artifact', artifactId }, targetIds: checked.assetIds };
  }
  fields(input, input.selection === 'explicit' ? ['source', 'selection', 'assetIds'] : ['source', 'selection']);
  if (input.source !== 'project') throw new AgentError('INVALID_ARGUMENT', '流程输入来源不受支持');
  const mode = enumValue(input.selection, ['all', 'unlabeled', 'explicit'], '素材选择');
  const allowed = selection(env);
  if (mode === 'explicit') {
    const assetIds = uniqueIds(input.assetIds, '输入素材');
    await assets(assetIds, env, allowed);
    return { input: { source: 'project', selection: 'explicit', assetIds }, targetIds: assetIds };
  }
  if (allowed) {
    const checked = await assets([...allowed], env, allowed);
    const assetIds = checked.filter(asset => mode !== 'unlabeled' || asset.status === 'unlabeled').map(asset => asset.id as string);
    if (!assetIds.length) throw new AgentError('IMAGES_REQUIRED', '当前选择范围内没有符合条件的素材');
    return { input: { source: 'project', selection: 'explicit', assetIds }, targetIds: assetIds };
  }
  return { input: { source: 'project', selection: mode as 'all' | 'unlabeled' } };
}
function references(env: ToolEnvironment) {
  const local = uniqueIds(env.context.referenceAssetIds ?? [], '人工参考', 63, true);
  const resources = env.context.referenceResources ?? [];
  if (local.length + resources.length > 63) throw new AgentError('INVALID_ARGUMENT', '人工参考合计不能超过 63 项');
  const seen = new Set<string>();
  const fixed = resources.map(raw => {
    const resourceId = id(raw.resourceId, '参考资源');
    if (seen.has(resourceId)) throw new AgentError('INVALID_ARGUMENT', '不能重复选择同一参考资源');
    seen.add(resourceId);
    if (raw.version == null) throw new AgentError('REFERENCE_VERSION_REQUIRED', '请在助手配置中选择人工参考的固定版本');
    const version = integer(raw.version, '参考版本', 0, 2147483647);
    const classMap = raw.classMap == null ? undefined : Object.fromEntries(Object.entries(object(raw.classMap)).map(([from, to]) => [id(from, '参考类别'), id(to, '项目类别')]));
    if (classMap && Object.keys(classMap).length > 10000) throw new AgentError('INVALID_ARGUMENT', '参考类别映射过多');
    return { resourceId, version, ...(classMap ? { classMap } : {}) };
  });
  return { local, fixed };
}
function configuredModels(provider: Record<string, unknown>) {
  const capabilities = provider.capabilities == null ? {} : object(provider.capabilities);
  return new Set([typeof provider.model === 'string' ? provider.model : '', ...Object.keys(capabilities)]);
}
function contextConfiguration(p: Project, env: ToolEnvironment) {
  return resolveConfiguration('annotation', {}, p.settings, { providerId: env.context.annotationProviderId, model: env.context.annotationModel,
    prompt: env.context.prompt, concurrency: env.context.concurrency, maxRequests: env.context.maxRequests });
}
async function currentProject(env: ToolEnvironment) {
  const result = await env.engine.request<Project>('project.open', { projectId: projectId(env) });
  if (result.id !== projectId(env)) throw new AgentError('PROJECT_SCOPE', '项目响应与请求不匹配');
  return result;
}
function budget(env: ToolEnvironment) {
  if (!env.budgetScopeId || env.context.maxRequests == null)
    throw new AgentError('BUDGET_REQUIRED', '请先在助手配置中填写本轮共享请求上限');
  return { budgetScopeId: id(env.budgetScopeId, '共享预算'), maxRequests: integer(env.context.maxRequests, '本轮请求上限', 1, 1000000) };
}
async function normalizeDefinition(raw: unknown, env: ToolEnvironment, execution: FlowExecution, targetIds?: string[]): Promise<FlowDefinition> {
  const definition = object(raw, '流程定义'); fields(definition, ['version', 'name', 'steps']);
  if (definition.version !== 1 || !Array.isArray(definition.steps) || definition.steps.length < 1 || definition.steps.length > 30)
    throw new AgentError('INVALID_ARGUMENT', '流程必须使用版本 1，并包含 1～30 个步骤');
  const name = text(definition.name, '流程名称', 200);
  const seen = new Set<string>();
  let configuration: ReturnType<typeof contextConfiguration> | undefined;
  let providers: Record<string, unknown>[] | undefined;
  let checkedReferences = false;
  const steps: FlowDefinition['steps'] = [];
  for (const rawStep of definition.steps) {
    active(env);
    const step = object(rawStep, '步骤'); fields(step, ['id', 'kind', 'enabled', 'parameters']);
    const sid = stepId(step.id), kind = enumValue(step.kind, Object.keys(stepParameters), '流程模块') as keyof typeof stepParameters;
    if (seen.has(sid)) throw new AgentError('INVALID_ARGUMENT', '流程步骤标识不能重复');
    seen.add(sid);
    const enabled = bool(step.enabled, '是否启用步骤'), value = object(step.parameters, '步骤参数');
    const executing = enabled && (execution.mode === 'all' || execution.stepId === sid);
    fields(value, Object.keys(stepParameters[kind]));
    const parameters: Record<string, unknown> = {};
    if (kind === 'import') {
      if (value.mediaJobId != null) { parameters.mediaJobId = id(value.mediaJobId, '视频抽帧任务'); if (executing) await videoImport(parameters.mediaJobId as string, env, targetIds); }
    } else if (kind === 'filter') {
      Object.assign(parameters, await filterParameters(value, env, targetIds));
    } else if (kind === 'transform') {
      Object.assign(parameters, transformParameters(value));
    } else if (kind === 'local') {
      Object.assign(parameters, await localParameters(value, env, executing));
    } else if (kind === 'api') {
      if (executing && !configuration) configuration = contextConfiguration(await currentProject(env), env);
      const current = executing ? configuration : undefined;
      const selectedProvider = value.providerId ?? current?.providerId;
      const providerId = selectedProvider == null ? undefined : id(selectedProvider, '标注接口');
      if (providerId && !providers) providers = (await env.engine.request<unknown[]>('provider.list')).map(raw => object(raw, '模型配置'));
      const provider = providers?.find(item => item.id === providerId);
      if (providerId && !provider) throw new AgentError('MODEL_REQUIRED', '请从已配置的接口中选择');
      const selectedModel = value.model ?? (providerId === current?.providerId ? current?.model : provider?.model);
      const model = selectedModel == null ? undefined : text(selectedModel, '标注模型', 200);
      if (model && provider && !(providerId === current?.providerId && model === current?.model) && !configuredModels(provider).has(model))
        throw new AgentError('MODEL_REQUIRED', '该模型尚未在所选接口中配置，不能猜测模型名称');
      if (current?.issues.some(issue => issue.field !== 'model')) throw new AgentError('INVALID_CONFIGURATION', current.issues.find(issue => issue.field !== 'model')!.message);
      const refs = executing ? references(env) : { local: [], fixed: [] };
      if (!checkedReferences && refs.local.length) {
        if (!targetIds) throw new AgentError('IMAGES_REQUIRED', '使用项目内人工参考时，请明确选择目标素材');
        if (refs.local.some(assetId => targetIds.includes(assetId))) throw new AgentError('REFERENCE_OVERLAP', '人工参考不能同时作为流程输入');
        const local = await assets(refs.local, env, null);
        if (local.some(asset => !['modified', 'confirmed'].includes(asset.status as string) || !['manual', 'preset_manual'].includes(asset.source as string)))
          throw new AgentError('REFERENCE_HUMAN_REQUIRED', '请先人工修改或确认所选参考');
        checkedReferences = true;
      }
      const prompt = value.prompt ?? current?.prompt;
      const concurrency = value.concurrency ?? current?.concurrency ?? (executing ? 1 : undefined);
      const maxRetries = value.maxRetries ?? (executing ? 0 : undefined);
      Object.assign(parameters, { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}),
        ...(prompt == null ? {} : { prompt: text(prompt, '标注提示词', 100000) }),
        ...(concurrency == null ? {} : { concurrency: integer(concurrency, '步骤并发', 1, 32) }),
        ...(maxRetries == null ? {} : { maxRetries: integer(maxRetries, '失败重试次数', 0, 6) }),
        ...(refs.local.length ? { referenceAssetIds: refs.local } : {}), ...(refs.fixed.length ? { referenceResources: refs.fixed } : {}) });
      if (value.maxRequests != null) parameters.maxRequests = integer(value.maxRequests, '步骤请求上限', 1, 1000000);
      Object.assign(parameters, reusePolicy(value));
    } else if (kind === 'review') {
      if (value.buildIssues != null) parameters.buildIssues = bool(value.buildIssues, '建立复核问题');
      if (value.waitForHuman != null) parameters.waitForHuman = bool(value.waitForHuman, '等待人工检查');
      if (value.randomSample != null) {
        const sample = object(value.randomSample, '随机抽样'); fields(sample, ['count', 'seed']);
        parameters.randomSample = { count: integer(sample.count, '抽样数量', 1, 1000), seed: text(sample.seed, '抽样种子', 256) };
      }
    } else if (kind === 'export') {
      if (executing && env.context.exportDir != null) parameters.outputDir = text(env.context.exportDir, '用户选择的导出目录', 32767);
      if (value.trainRatio != null) {
        if (typeof value.trainRatio !== 'number' || !Number.isFinite(value.trainRatio) || value.trainRatio <= 0 || value.trainRatio >= 1)
          throw new AgentError('INVALID_ARGUMENT', '训练集比例应大于 0 且小于 1');
        parameters.trainRatio = value.trainRatio;
      }
      if (value.onlyConfirmed != null) parameters.onlyConfirmed = bool(value.onlyConfirmed, '仅导出已确认');
      if (value.annotationSelection != null) parameters.annotationSelection = enumValue(value.annotationSelection, ['protected', 'candidate'], '标注版本选择');
    }
    steps.push({ id: sid, kind, enabled, parameters });
  }
  return { version: 1, name, steps };
}
async function startPayload(args: Record<string, unknown>, env: ToolEnvironment): Promise<FlowStartRequest> {
  fields(args, Object.keys(startProperties)); active(env);
  let execution: FlowExecution = { mode: 'all' };
  if (args.execution != null) {
    const raw = object(args.execution, '执行方式'); fields(raw, raw.mode === 'single' ? ['mode', 'stepId'] : ['mode']);
    const mode = enumValue(raw.mode, ['all', 'single'], '执行方式');
    if (mode === 'single') execution = { mode, stepId: stepId(raw.stepId) };
  }
  const input = await normalizeInput(args.input, env);
  const definition = await normalizeDefinition(args.definition, env, execution, input.targetIds);
  if (execution.mode === 'single') {
    const sid = execution.stepId, enabled = definition.steps.filter(step => step.enabled);
    if (!enabled.some(step => step.id === sid)) throw new AgentError('INVALID_ARGUMENT', '单步执行必须选择启用的步骤');
    if (enabled[0]?.id !== sid && input.input.source !== 'artifact') throw new AgentError('FLOW_ARTIFACT_REQUIRED', '非首步骤必须提供固定输入产物');
  }
  const usesApi = definition.steps.some(step => step.enabled && step.kind === 'api' && (execution.mode === 'all' || execution.stepId === step.id));
  // 预检保留缺项，由引擎汇总到对应节点；正式创建还会在预检之后核对本轮授权。
  const requestBudget = usesApi ? {
    ...(env.budgetScopeId == null ? {} : { budgetScopeId: id(env.budgetScopeId, '共享预算') }),
    ...(env.context.maxRequests == null ? {} : { maxRequests: integer(env.context.maxRequests, '本轮请求上限', 1, 1000000) }),
  } : {};
  return { projectId: projectId(env), definition, input: input.input, execution,
    ...requestBudget, failurePolicy: args.failurePolicy == null ? 'continue' : enumValue(args.failurePolicy, ['continue', 'pause'], '失败策略') as 'continue' | 'pause' };
}
async function assertStartReady(payload: FlowStartRequest, env: ToolEnvironment) {
  for (const step of payload.definition.steps) {
    if (!step.enabled || (payload.execution?.mode === 'single' && payload.execution.stepId !== step.id)) continue;
    if (step.kind === 'import' && step.parameters.mediaJobId != null) {
      await videoImport(id(step.parameters.mediaJobId, '视频抽帧任务'), env, payload.input.source === 'project' && payload.input.selection === 'explicit' ? payload.input.assetIds : undefined);
    } else if (step.kind === 'api') {
      const authorized = budget(env);
      if (payload.budgetScopeId !== authorized.budgetScopeId || payload.maxRequests !== authorized.maxRequests)
        throw new AgentError('BUDGET_REQUIRED', '本轮共享请求上限已变化，请重新预检流程');
      id(step.parameters.providerId, '标注接口'); text(step.parameters.model, '标注模型', 200); text(step.parameters.prompt, '标注提示词', 100000);
    } else if (step.kind === 'local') {
      await localParameters(step.parameters, env, true, true, true);
    } else if (step.kind === 'export') {
      const outputDir = text(env.context.exportDir, '用户选择的导出目录', 32767);
      if (step.parameters.outputDir !== outputDir) throw new AgentError('FLOW_PATH_PERMISSION', '当前导出目录已变化，请重新预检流程');
    }
  }
}
async function getFlow(flowRunId: string, env: ToolEnvironment) {
  active(env);
  const run = scoped(await env.engine.request('flow.get', { flowRunId }), env, '流程运行');
  if (run.id !== flowRunId) throw new AgentError('PROJECT_SCOPE', '流程响应与请求不匹配');
  return run;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function historicalDefinition(run: Record<string, unknown>, env: ToolEnvironment, rerun = false): Promise<FlowDefinition> {
  const definition = object(run.definition, '已保存流程');
  if (definition.version !== 1 || !Array.isArray(definition.steps) || !definition.steps.length || definition.steps.length > 30)
    throw new AgentError('FLOW_SNAPSHOT_INVALID', '已保存流程定义不可用');
  const refs = references(env), allowedLocal = new Set(refs.local), allowedResources = new Set(refs.fixed.map(canonical));
  const steps: FlowDefinition['steps'] = [];
  const usesExplicitFilter = definition.steps.some(raw => { const step = object(raw); return step.kind === 'filter' && ['assetIds', 'excludeAssetIds'].some(key => object(step.parameters)[key] != null); });
  const frozenInput = await artifactScope(id(run.inputArtifactId, '流程固定输入'), env, usesExplicitFilter);
  let providers: Record<string, unknown>[] | undefined;
  let configuration: ReturnType<typeof contextConfiguration> | undefined;
  for (const raw of definition.steps) {
    const step = object(raw), parameters = { ...object(step.parameters) };
    const kind = enumValue(step.kind, Object.keys(stepParameters), '历史流程模块') as keyof typeof stepParameters;
    const extra = kind === 'api' ? ['referenceAssetIds', 'referenceResources'] : kind === 'import' ? ['paths', 'mode'] : kind === 'export' ? ['outputDir'] : [];
    fields(parameters, [...Object.keys(stepParameters[kind]), ...extra]);
    if (kind === 'import' && parameters.mediaJobId != null && parameters.paths != null)
      throw new AgentError('FLOW_IMPORT_CONFLICT', '视频任务与文件路径不能同时作为导入来源');
    if (kind === 'import' && parameters.paths != null && (!Array.isArray(parameters.paths) || parameters.paths.length))
      throw new AgentError('FLOW_PATH_PERMISSION', '此流程含文件导入，请在流程编辑器中继续、重试或重跑');
    if (kind === 'import' && parameters.mediaJobId != null) { const jobId = id(parameters.mediaJobId, '历史视频抽帧任务'); if (step.enabled === true) await videoImport(jobId, env); }
    if (kind === 'filter') {
      const state = Array.isArray(run.steps) ? run.steps.map(value => object(value)).find(value => value.stepId === step.id) : undefined;
      const input = state?.inputArtifactId != null && ['assetIds', 'excludeAssetIds'].some(key => parameters[key] != null)
        ? await artifactScope(id(state.inputArtifactId, '筛选固定输入'), env, true) : frozenInput;
      await filterParameters(parameters, env, input.assetIds);
    }
    if (kind === 'transform') transformParameters(parameters);
    if (kind === 'local') {
      const state = Array.isArray(run.steps) ? run.steps.map(value => object(value)).find(value => value.stepId === step.id) : undefined;
      if (state?.local != null) {
        const frozen = object(state.local, '本地模型固定选择');
        const frozenModel = id(frozen.modelId, '历史本地模型'), frozenVersion = integer(frozen.modelVersion, '历史本地模型版本', 1, 2147483647);
        if (parameters.modelId !== frozenModel || (parameters.modelVersion != null && parameters.modelVersion !== frozenVersion)
          || (parameters.device != null && parameters.device !== frozen.device))
          throw new AgentError('LOCAL_MODEL_VERSION_MISMATCH', '历史本地模型参数与运行固定选择不一致');
        parameters.modelVersion = frozenVersion;
        parameters.device = frozen.device;
      }
      await localParameters(parameters, env, false, true);
    }
    if (kind === 'export') {
      if (!env.context.exportDir || (!rerun && parameters.outputDir !== env.context.exportDir))
        throw new AgentError('FLOW_PATH_PERMISSION', '请在助手配置中选择此流程的导出目录，或在流程编辑器中操作');
      parameters.outputDir = text(env.context.exportDir, '用户选择的导出目录', 32767);
    }
    if (kind === 'api') {
      Object.assign(parameters, reusePolicy(parameters));
      if (!providers) providers = (await env.engine.request<unknown[]>('provider.list')).map(raw => object(raw, '模型配置'));
      if (!configuration) configuration = contextConfiguration(await currentProject(env), env);
      const providerId = id(parameters.providerId, '历史标注接口'), model = text(parameters.model, '历史标注模型', 200);
      const provider = providers.find(value => value.id === providerId);
      if (!provider || (!(providerId === configuration.providerId && model === configuration.model) && !configuredModels(provider).has(model)))
        throw new AgentError('MODEL_REQUIRED', '历史流程使用的接口或模型已不在当前配置中，请在流程编辑器调整');
      const local = uniqueIds(parameters.referenceAssetIds ?? [], '历史人工参考', 63, true);
      if (local.some(assetId => !allowedLocal.has(assetId))) throw new AgentError('REFERENCE_SCOPE', '历史流程使用了当前助手未选择的人工参考');
      if (parameters.referenceResources != null && (!Array.isArray(parameters.referenceResources) || parameters.referenceResources.some(raw => !allowedResources.has(canonical(raw)))))
        throw new AgentError('REFERENCE_SCOPE', '历史流程使用了当前助手未选择的参考版本或映射');
    }
    steps.push({ id: stepId(step.id), kind, enabled: bool(step.enabled, '是否启用步骤'), parameters });
  }
  const result: FlowDefinition = { version: 1, name: text(definition.name, '流程名称', 200), steps };
  if (steps.some(step => step.enabled && ['transform', 'local'].includes(step.kind)))
    assertAvailable(result, object(await env.engine.request('flow.capabilities', {})).availableSteps);
  return result;
}
function reviewWaiting(run: Record<string, unknown>) {
  return Array.isArray(run.steps) && run.steps.some(raw => { const step = object(raw); return step.kind === 'review' && step.status === 'needs_attention'; });
}

export const FLOW_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'preflight_flow', description: '预检当前项目线性流程、固定输入和共享预算，不发送模型请求。import 可使用同项目已完成且产物已提交的视频 mediaJobId，不接受路径；filter 可生成筛选建议或按明确 excludeAssetIds 排除，近重复和模糊不自动排除。缺项由引擎逐节点说明。',
    parameters: schema(startProperties), mutation: false,
    async execute(args, env) {
      const payload = await startPayload(args, env);
      return preflightSummary(scoped(await env.engine.request('flow.preflight', { ...payload }), env, '流程预检'));
    } },
  { name: 'start_flow', description: '先实际预检再提交流程。返回的是引擎当前状态，queued/running 不代表已完成。API 默认可复用匹配候选；reused 是成功项的子集，不代表新增调用或人工确认，真实调用以 requestsUsed 为准。最多 30 步，不导入模型指定文件。',
    parameters: schema(startProperties), mutation: true,
    async execute(args, env) {
      const payload = await startPayload(args, env);
      const checked = scoped(await env.engine.request('flow.preflight', { ...payload }), env, '流程预检');
      if (checked.canStart !== true) return { started: false, preflight: preflightSummary(checked) };
      assertAvailable(payload.definition, checked.availableSteps, payload.execution);
      await assertStartReady(payload, env);
      active(env);
      const run = scoped(await env.engine.request('flow.create', { ...payload }), env, '流程运行');
      return { started: true, run: runSummary(run) };
    } },
  { name: 'list_flows', description: '分页读取当前项目流程运行的真实状态与步骤摘要，不返回内部文件路径或完整配置。',
    parameters: schema({ offset: number(0, 1000000), limit: number(1, 100) }), mutation: false,
    async execute(args, env) {
      fields(args, ['offset', 'limit']); active(env);
      const result = object(await env.engine.request('flow.list', { projectId: projectId(env), offset: integer(args.offset ?? 0, '分页位置', 0, 1000000), limit: integer(args.limit ?? 20, '每页数量', 1, 100) }));
      if (!Array.isArray(result.items)) throw new AgentError('FLOW_RESPONSE_INVALID', '流程列表响应不完整');
      return { total: integer(result.total, '流程总数', 0, Number.MAX_SAFE_INTEGER), items: result.items.map(raw => runSummary(scoped(raw, env, '流程运行'))) };
    } },
  { name: 'inspect_flow', description: '读取当前项目指定流程的真实步骤、进度、失败与暂停原因。reused 是 succeeded 的子集，不算新增调用，实际调用以 requestsUsed 为准；不会把提交成功当作运行完成。',
    parameters: schema({ flowRunId: string }), mutation: false,
    async execute(args, env) { fields(args, ['flowRunId']); return runSummary(await getFlow(id(args.flowRunId, '流程运行'), env)); } },
  { name: 'inspect_flow_artifact', description: '分页读取固定流程产物的版本、输入/视图标识与几何复核门槛。单张基准图可有多个输入，requiresGeometryReview 仍须人工检查；reused 是历史候选复用，不是新增调用或人工确认。核对项目与当前素材范围，不返回图片路径或完整标签。',
    parameters: schema({ artifactId: string, offset: number(0, 10000), limit: number(1, 500) }), mutation: false,
    async execute(args, env) {
      fields(args, ['artifactId', 'offset', 'limit']);
      const artifactId = id(args.artifactId, '流程产物'), offset = integer(args.offset ?? 0, '分页位置', 0, 10000), limit = integer(args.limit ?? 100, '每页数量', 1, 500);
      await artifactScope(artifactId, env);
      return artifactSummary(await artifactPage(artifactId, env, offset, limit));
    } },
  { name: 'control_flow', description: '暂停、恢复或取消当前项目流程。恢复不重发未知调用，不增加既有请求上限；等待人工检查的步骤必须由用户在流程编辑器放行。',
    parameters: schema({ flowRunId: string, action: choice(['pause', 'resume', 'cancel']) }), mutation: true,
    async execute(args, env) {
      fields(args, ['flowRunId', 'action']);
      const flowRunId = id(args.flowRunId, '流程运行'), action = enumValue(args.action, ['pause', 'resume', 'cancel'], '流程操作');
      const run = await getFlow(flowRunId, env);
      if (selection(env)) await artifactScope(id(run.inputArtifactId, '流程固定输入'), env);
      if (action === 'resume') {
        if (reviewWaiting(run)) throw new AgentError('FLOW_HUMAN_REVIEW_REQUIRED', '该步骤正在等待人工检查，请由用户在流程编辑器放行');
        await historicalDefinition(run, env);
      }
      const unchanged = action === 'pause' ? ['paused', 'pausing'].includes(run.status as string)
        : action === 'cancel' ? ['cancelled', 'cancelling'].includes(run.status as string) : ['running', 'queued'].includes(run.status as string);
      if (unchanged) return { unchanged: true, run: runSummary(run) };
      active(env);
      return { unchanged: false, run: runSummary(scoped(await env.engine.request(`flow.${action}`, { flowRunId }), env, '流程运行')) };
    } },
  { name: 'retry_flow', description: '沿原流程快照重试失败或未完成项。始终不重试结果未知的请求，不增加预算，不改写已完成下游；带文件导入的流程请在编辑器操作。',
    parameters: schema({ flowRunId: string, stepId: nullableString, assetIds: idList }), mutation: true,
    async execute(args, env) {
      fields(args, ['flowRunId', 'stepId', 'assetIds']);
      const flowRunId = id(args.flowRunId, '流程运行'), run = await getFlow(flowRunId, env);
      if (reviewWaiting(run)) throw new AgentError('FLOW_HUMAN_REVIEW_REQUIRED', '流程正在等待人工检查，不能通过重试越过');
      await historicalDefinition(run, env);
      const payload: Record<string, unknown> = { flowRunId, retryUnknown: false };
      if (args.stepId != null) payload.stepId = stepId(args.stepId);
      if (args.assetIds != null) { payload.assetIds = uniqueIds(args.assetIds, '重试素材'); await assets(payload.assetIds as string[], env); }
      active(env);
      return runSummary(scoped(await env.engine.request('flow.retry', payload), env, '流程运行'));
    } },
  { name: 'rerun_flow', description: '从指定步骤建立新修订，旧运行与旧产物保持不变。使用原流程参数，导出只使用当前用户选择目录，API 使用本轮共享预算；返回失效步骤和新运行真实状态。',
    parameters: schema({ flowRunId: string, fromStepId: string }), mutation: true,
    async execute(args, env) {
      fields(args, ['flowRunId', 'fromStepId']);
      const flowRunId = id(args.flowRunId, '流程运行'), fromStepId = stepId(args.fromStepId), run = await getFlow(flowRunId, env);
      const definition = await historicalDefinition(run, env, true);
      const index = definition.steps.findIndex(step => step.id === fromStepId && step.enabled);
      if (index < 0) throw new AgentError('INVALID_ARGUMENT', '重跑起点必须是原流程中启用的步骤');
      const waiting = Array.isArray(run.steps) ? run.steps.map(raw => object(raw)).find(step => step.kind === 'review' && step.status === 'needs_attention') : undefined;
      if (waiting && definition.steps.findIndex(step => step.id === waiting.stepId) < index)
        throw new AgentError('FLOW_HUMAN_REVIEW_REQUIRED', '不能从下游重跑越过尚未完成的人工检查');
      const usesApi = definition.steps.slice(index).some(step => step.enabled && step.kind === 'api');
      active(env);
      const result = object(await env.engine.request('flow.rerun', { flowRunId, fromStepId, definition, ...(usesApi ? budget(env) : {}) }));
      const next = scoped(result.run, env, '新流程运行');
      if (next.id === flowRunId || !Number.isInteger(next.revision) || (next.revision as number) <= (run.revision as number))
        throw new AgentError('FLOW_RESPONSE_INVALID', '引擎未返回独立的新修订，不能宣称重跑已建立');
      if (!Array.isArray(result.invalidatedStepIds)) throw new AgentError('FLOW_RESPONSE_INVALID', '引擎未返回失效步骤');
      return { run: runSummary(next), invalidatedStepIds: result.invalidatedStepIds.map(stepId) };
    } },
];
