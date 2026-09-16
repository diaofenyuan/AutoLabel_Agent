import { TRAINING_LIMITS, TRAINING_OPTIMIZERS } from '../shared/training.ts';
import type { ToolDefinition, ToolEnvironment } from './tools.ts';
import { registeredLocalModel } from './inference-tools.ts';
import { AgentError, fields, id, integer, object, text } from './validation.ts';

const schema = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const nullableBoolean = { type: ['boolean', 'null'] };
const nullableInteger = (minimum: number, maximum: number) => ({ type: ['integer', 'null'], minimum, maximum });
const jobStatuses = ['queued', 'preparing', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
const metricKeys = ['boxLoss', 'clsLoss', 'dflLoss', 'loss', 'mAP50', 'mAP50_95', 'precision', 'recall', 'top1', 'top5'];
const devicePattern = /^(gpu-auto|cpu|0|[1-9][0-9]{0,2})$/;
const parameterKeys = [...Object.keys(TRAINING_LIMITS), 'batch', 'device', 'baseModel', 'optimizer', 'cosLr', 'augment', 'resume'];

function active(env: ToolEnvironment) {
  if (env.signal?.aborted) throw new AgentError('AGENT_CANCELLED', '对话已停止，未提交新的训练操作');
}
function projectId(env: ToolEnvironment) {
  if (!env.projectId) throw new AgentError('PROJECT_REQUIRED', '请先打开一个项目');
  return id(env.projectId, '项目标识');
}
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function page(value: unknown, label: string, offset: number, limit: number) {
  const raw = object(value, label);
  const total = integer(raw.total, `${label}总数`, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(raw.items) || raw.items.length > limit || raw.offset !== offset || raw.limit !== limit
    || (offset < total && !raw.items.length) || offset + raw.items.length > total)
    throw new AgentError('TRAINING_RESPONSE_INVALID', `${label}分页响应不完整`);
  return { total, items: raw.items as unknown[] };
}
function metrics(value: unknown, label: string) {
  if (value == null) return undefined;
  const raw = object(value, label);
  return Object.fromEntries(metricKeys.filter(key => typeof raw[key] === 'number' && Number.isFinite(raw[key])).map(key => [key, raw[key]]));
}
function issues(value: unknown, label: string) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new AgentError('TRAINING_RESPONSE_INVALID', `${label}格式不正确`);
  return value.slice(0, 50).map(item => pick(object(item, label), ['severity', 'code', 'message']));
}
function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** 数据集版本是训练数据的唯一来源：只读取已生成版本的摘要，不返回清单内容与任何路径。 */
function versionSummary(value: unknown, project: string) {
  const version = object(value, '数据集版本');
  const versionId = id(version.id, '数据集版本');
  if (version.projectId !== project) throw new AgentError('PROJECT_SCOPE', '数据集版本不属于当前项目');
  return compact({ id: versionId, ...pick(version, ['projectId', 'number', 'name', 'status', 'sourceKind', 'taskType', 'annotationScope',
    'recipeHash', 'contentHash', 'manifestHash', 'createdAt', 'completedAt']),
    summary: version.summary == null ? undefined : pick(object(version.summary, '版本摘要'), ['images', 'excluded', 'objects', 'bytes', 'groups', 'issues', 'errors', 'warnings']),
    split: version.split == null ? undefined : pick(object(version.split, '版本划分'), ['seed', 'train', 'val', 'test', 'groups']),
    build: version.build == null ? undefined : pick(object(version.build, '版本构建'), ['status']),
    failure: version.failure == null ? undefined : pick(object(version.failure, '版本失败原因'), ['code', 'message']) });
}
/** 训练快照与任务都带项目归属：跨项目的数据集不返回，避免对话里出现别的项目内容。 */
function datasetSummary(value: unknown, project: string) {
  const dataset = object(value, '训练数据集');
  const datasetId = id(dataset.id, '训练数据集');
  if (dataset.projectId !== project) throw new AgentError('PROJECT_SCOPE', '训练数据集不属于当前项目');
  if (dataset.status !== 'ready' && dataset.status !== 'invalid') throw new AgentError('TRAINING_RESPONSE_INVALID', '训练数据集状态不受支持');
  const inspection = dataset.inspection == null ? undefined : object(dataset.inspection, '数据集体检');
  return compact({ id: datasetId, ...pick(dataset, ['projectId', 'origin', 'taskType', 'status', 'createdAt', 'snapshotHash', 'bytes']),
    classes: Array.isArray(dataset.classes) ? dataset.classes.slice(0, 1000).map(item => pick(object(item, '数据集类别'), ['id', 'name'])) : [],
    keypointNames: Array.isArray(dataset.keypointNames) ? dataset.keypointNames.slice(0, 64) : [],
    summary: inspection?.summary == null ? undefined : pick(object(inspection.summary, '体检摘要'),
      ['images', 'objects', 'emptyLabels', 'bytes', 'classes', 'keypoints', 'splits', 'classCounts', 'errors', 'warnings', 'usable']),
    issues: inspection == null ? [] : issues(inspection.issues, '数据集体检问题') });
}
function jobSummary(value: unknown, project: string) {
  const job = object(value, '训练任务');
  const jobId = id(job.id, '训练任务');
  if (job.projectId != null && job.projectId !== project) throw new AgentError('PROJECT_SCOPE', '训练任务不属于当前项目');
  if (typeof job.status !== 'string' || !jobStatuses.includes(job.status)) throw new AgentError('TRAINING_RESPONSE_INVALID', '训练任务状态不受支持');
  return compact({ id: jobId, ...pick(job, ['datasetId', 'taskType', 'status', 'stage', 'message', 'parameters', 'requestedDevice', 'actualDevice',
    'fallback', 'environment', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'elapsedMs', 'etaSeconds', 'etaEstimated', 'completedEpochs', 'epochs',
    'bestEpoch', 'cancelRequested', 'stalledAt', 'snapshotHash', 'parametersHash', 'classNames', 'keypointNames', 'metricsPrunedAt', 'metricsRetentionDays',
    'progress', 'progressKnown']),
    lastMetrics: metrics(job.lastMetrics, '最近一轮指标'),
    bestMetrics: metrics(job.bestMetrics, '最优轮指标'),
    error: job.error == null ? undefined : pick(object(job.error, '训练失败原因'), ['code', 'message']),
    artifacts: Array.isArray(job.artifacts) ? job.artifacts.slice(0, 100).map(item => pick(object(item, '训练产物'), ['kind', 'name', 'size', 'hash'])) : [] });
}
function preflightSummary(value: unknown) {
  const report = object(value, '训练预检');
  return { ok: report.ok === true, issues: issues(report.issues, '训练预检问题'),
    estimates: report.estimates == null ? undefined : pick(object(report.estimates, '训练规模估算'),
      ['datasetBytes', 'images', 'objects', 'epochs', 'estimatedPeakBytes']),
    resolvedParameters: report.resolvedParameters == null ? undefined : pick(object(report.resolvedParameters, '生效训练参数'),
      ['epochs', 'learningRate', 'batch', 'imgsz', 'device', 'optimizer', 'momentum', 'weightDecay', 'warmupEpochs', 'patience', 'workers', 'seed',
        'closeMosaic', 'valPeriod', 'cosLr', 'augment', 'resume', 'requestedDevice', 'actualDevice', 'fallback', 'classNames', 'keypointNames',
        'snapshotHash', 'cudaAvailable', 'ultralyticsVersion', 'torchVersion', 'workerHash']) };
}
async function trainingParameters(value: unknown, env: ToolEnvironment) {
  const parameters = object(value, '训练参数');
  fields(parameters, parameterKeys);
  const result: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(TRAINING_LIMITS)) {
    // 批次大小允许字符串 auto，单独处理；其余数值参数与 TRAINING_LIMITS 一一对应。
    if (key === 'batch' || parameters[key] == null) continue;
    result[key] = integer(parameters[key], '训练参数', limit.min, limit.max);
  }
  if (result.imgsz != null && (result.imgsz as number) % TRAINING_LIMITS.imgsz.step !== 0)
    throw new AgentError('INVALID_ARGUMENT', '训练输入尺寸必须是 32 的倍数');
  if (parameters.batch != null) {
    if (parameters.batch !== 'auto' && typeof parameters.batch !== 'number') throw new AgentError('INVALID_ARGUMENT', '批次大小只能是数值或 auto');
    result.batch = parameters.batch === 'auto' ? 'auto' : integer(parameters.batch, '批次大小', TRAINING_LIMITS.batch.min, TRAINING_LIMITS.batch.max);
  }
  if (parameters.device != null) {
    if (typeof parameters.device !== 'string' || !devicePattern.test(parameters.device))
      throw new AgentError('INVALID_ARGUMENT', '训练设备应为 gpu-auto、cpu 或 0～999 的设备编号');
    result.device = parameters.device;
  }
  if (parameters.optimizer != null) {
    if (!TRAINING_OPTIMIZERS.includes(parameters.optimizer as never)) throw new AgentError('INVALID_ARGUMENT', '优化器不受支持');
    result.optimizer = parameters.optimizer;
  }
  for (const key of ['cosLr', 'augment', 'resume']) {
    if (parameters[key] == null) continue;
    if (typeof parameters[key] !== 'boolean') throw new AgentError('INVALID_ARGUMENT', '训练开关必须是布尔值');
    result[key] = parameters[key];
  }
  if (parameters.baseModel != null) {
    const base = object(parameters.baseModel, '基础权重');
    fields(base, ['modelId', 'modelVersion']);
    const registered = await registeredLocalModel(env, id(base.modelId, '基础权重'),
      base.modelVersion == null ? undefined : integer(base.modelVersion, '基础权重版本', 1, 2147483647));
    result.baseModel = { modelId: registered.id, modelVersion: registered.version };
  }
  return result;
}
async function dataset(value: unknown, env: ToolEnvironment) {
  active(env);
  const datasetId = id(value, '训练数据集');
  const summary = datasetSummary(await env.engine.request('training.dataset.get', { datasetId }), projectId(env));
  if (summary.id !== datasetId) throw new AgentError('TRAINING_RESPONSE_INVALID', '训练数据集响应与请求不一致');
  return summary;
}
/** 提交前先跑一次引擎预检：预检不通过时不创建任务，也不会留下排队记录。 */
async function createPayload(args: Record<string, unknown>, env: ToolEnvironment) {
  fields(args, ['datasetId', 'parameters']);
  const datasetId = id(args.datasetId, '训练数据集');
  await dataset(datasetId, env);
  const parameters = args.parameters == null ? undefined : await trainingParameters(args.parameters, env);
  return { datasetId, ...(parameters && Object.keys(parameters).length ? { parameters } : {}) };
}
function jobId(value: unknown, env: ToolEnvironment) {
  active(env);
  return id(value, '训练任务');
}

export const TRAINING_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'list_dataset_versions', description: '分页列出当前项目已生成的数据集版本：划分比例、规模与构建状态。版本不可变，这里只读取摘要；不会创建、修改或删除版本，也不返回清单与文件路径。',
    parameters: schema({ offset: nullableInteger(0, 2147483647), limit: nullableInteger(1, 100) }), mutation: false,
    async execute(args, env) {
      fields(args, ['offset', 'limit']); active(env);
      const offset = integer(args.offset ?? 0, '分页位置', 0, 2147483647), limit = integer(args.limit ?? 20, '每页数量', 1, 100);
      const result = page(await env.engine.request('dataset.version.list', { projectId: projectId(env), offset, limit }), '数据集版本', offset, limit);
      const items = result.items.map(item => versionSummary(item, projectId(env)));
      if (new Set(items.map(item => item.id)).size !== items.length) throw new AgentError('TRAINING_RESPONSE_INVALID', '数据集版本分页重复');
      return { total: result.total, offset, limit, nextOffset: offset + items.length < result.total ? offset + items.length : null, items };
    } },
  { name: 'list_training_datasets', description: '分页列出当前项目已固定的训练数据快照及体检结论。快照不可变、按内容哈希标识；这里只读取，不会重新生成或改写。',
    parameters: schema({ offset: nullableInteger(0, 2147483647), limit: nullableInteger(1, 100) }), mutation: false,
    async execute(args, env) {
      fields(args, ['offset', 'limit']); active(env);
      const offset = integer(args.offset ?? 0, '分页位置', 0, 2147483647), limit = integer(args.limit ?? 20, '每页数量', 1, 100);
      const result = page(await env.engine.request('training.dataset.list', { projectId: projectId(env), offset, limit }), '训练数据集', offset, limit);
      const items = result.items.map(item => datasetSummary(item, projectId(env)));
      if (new Set(items.map(item => item.id)).size !== items.length) throw new AgentError('TRAINING_RESPONSE_INVALID', '训练数据集分页重复');
      return { total: result.total, offset, limit, nextOffset: offset + items.length < result.total ? offset + items.length : null, items };
    } },
  { name: 'create_training_dataset', description: '从一个已生成的数据集版本建立不可变训练数据快照并做体检。只接受版本标识，不接受目录或文件路径；快照建立后不会随项目素材变化，可反复用于训练。体检未通过时先按问题修复数据，不要直接开训。',
    parameters: schema({ versionId: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: ['string', 'null'], maxLength: 200 } }), mutation: true,
    async execute(args, env) {
      fields(args, ['versionId', 'name']);
      const project = projectId(env), versionId = id(args.versionId, '数据集版本');
      const name = args.name == null ? undefined : text(args.name, '数据集名称', 200);
      active(env);
      const created = await env.engine.request('training.dataset.create',
        { projectId: project, source: 'version', versionId, ...(name == null ? {} : { name }) });
      return datasetSummary(created, project);
    } },
  { name: 'preflight_training', description: '按数据集快照与训练参数做引擎预检：环境、设备、基础权重一致性、磁盘与生效参数。只预检，不创建任务、不启动进程；自动批次在只有 CPU 时会报错而不是静默降级。',
    parameters: schema({ datasetId: { type: 'string', minLength: 1, maxLength: 128 },
      parameters: { anyOf: [{ type: 'null' }, trainingParameterSchema()] } }), mutation: false,
    async execute(args, env) {
      const payload = await createPayload(args, env);
      return preflightSummary(await env.engine.request('training.job.preflight', payload));
    } },
  { name: 'start_training', description: '先预检再提交训练任务。预检不通过不会排队；提交成功只代表进入队列，不代表训练完成，进度与指标要用 inspect_training_job 查询。训练与本地推理互斥，设备被占用时任务不会抢占；本轮不占用标注 API 预算，进程中断不会自动重跑。',
    parameters: schema({ datasetId: { type: 'string', minLength: 1, maxLength: 128 },
      parameters: { anyOf: [{ type: 'null' }, trainingParameterSchema()] } }), mutation: true,
    async execute(args, env) {
      const payload = await createPayload(args, env);
      const report = preflightSummary(await env.engine.request('training.job.preflight', payload));
      if (!report.ok) return { started: false, preflight: report };
      active(env);
      const job = await env.engine.request('training.job.create', { ...payload, confirm: true });
      return { started: true, job: jobSummary(job, projectId(env)) };
    } },
  { name: 'list_training_jobs', description: '分页读取当前项目训练任务的真实状态、设备与进度。进度只在引擎报告过总轮数时给出；interrupted 表示进程中断且未自动重跑，需要用户决定是否重试。',
    parameters: schema({ status: { type: ['string', 'null'], enum: [...jobStatuses, null] },
      offset: nullableInteger(0, 2147483647), limit: nullableInteger(1, 100) }), mutation: false,
    async execute(args, env) {
      fields(args, ['status', 'offset', 'limit']); active(env);
      if (args.status != null && !jobStatuses.includes(args.status as string)) throw new AgentError('INVALID_ARGUMENT', '训练状态不受支持');
      const offset = integer(args.offset ?? 0, '分页位置', 0, 2147483647), limit = integer(args.limit ?? 20, '每页数量', 1, 100);
      const request = { projectId: projectId(env), offset, limit, ...(args.status == null ? {} : { status: args.status }) };
      const result = page(await env.engine.request('training.job.list', request), '训练任务', offset, limit);
      const items = result.items.map(item => jobSummary(item, projectId(env)));
      if (new Set(items.map(item => item.id)).size !== items.length) throw new AgentError('TRAINING_RESPONSE_INVALID', '训练任务分页重复');
      return { total: result.total, offset, limit, nextOffset: offset + items.length < result.total ? offset + items.length : null, items };
    } },
  { name: 'inspect_training_job', description: '读取一个训练任务的真实状态、失败原因、产物清单与逐轮指标尾部。指标缺失就是缺失，不补零；etaSeconds 是按已完成轮次估算，不是承诺。训练失败或 OOM 都不会自动重跑。',
    parameters: schema({ jobId: { type: 'string', minLength: 1, maxLength: 128 }, metricOffset: nullableInteger(0, 2147483647),
      metricLimit: nullableInteger(1, 200) }), mutation: false,
    async execute(args, env) {
      fields(args, ['jobId', 'metricOffset', 'metricLimit']);
      const project = projectId(env), target = jobId(args.jobId, env);
      const offset = integer(args.metricOffset ?? 0, '指标分页位置', 0, 2147483647), limit = integer(args.metricLimit ?? 50, '指标每页数量', 1, 200);
      const job = jobSummary(await env.engine.request('training.job.get', { jobId: target }), project);
      if (job.id !== target) throw new AgentError('TRAINING_RESPONSE_INVALID', '训练任务响应与请求不一致');
      const raw = await env.engine.request('training.job.metrics', { jobId: target, offset, limit });
      const result = page(raw, '训练逐轮指标', offset, limit);
      const epochs = result.items.map(item => {
        const epoch = object(item, '训练轮次');
        return compact({ epoch: epoch.epoch, epochs: epoch.epochs, metrics: metrics(epoch.metrics, '训练轮次指标'),
          elapsedMs: epoch.elapsedMs, etaSeconds: epoch.etaSeconds, at: epoch.at });
      });
      return { job, metrics: { total: result.total, offset, limit, items: epochs } };
    } },
  { name: 'cancel_training_job', description: '取消排队中或运行中的训练任务：当前轮次结束后停止并保留已产出的权重与逐轮指标。已经结束的任务不会被改写；取消需要时间，提交后请用 inspect_training_job 确认最终状态。',
    parameters: schema({ jobId: { type: 'string', minLength: 1, maxLength: 128 } }), mutation: true,
    async execute(args, env) {
      fields(args, ['jobId']);
      const project = projectId(env), target = jobId(args.jobId, env);
      const current = jobSummary(await env.engine.request('training.job.get', { jobId: target }), project);
      if (!['queued', 'preparing', 'running'].includes(current.status as string)) return { unchanged: true, job: current };
      active(env);
      return { unchanged: false, job: jobSummary(await env.engine.request('training.job.cancel', { jobId: target }), project) };
    } },
];

/** 训练参数与引擎 TrainingParameters 一一对应；未填写的字段由引擎按默认值解析，这里不猜。 */
function trainingParameterSchema() {
  const properties: Record<string, unknown> = {
    epochs: nullableInteger(TRAINING_LIMITS.epochs.min, TRAINING_LIMITS.epochs.max),
    learningRate: { type: ['number', 'null'], minimum: TRAINING_LIMITS.learningRate.min, maximum: TRAINING_LIMITS.learningRate.max },
    batch: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: TRAINING_LIMITS.batch.min, maximum: TRAINING_LIMITS.batch.max }, { type: 'string', enum: ['auto'] }] },
    imgsz: nullableInteger(TRAINING_LIMITS.imgsz.min, TRAINING_LIMITS.imgsz.max),
    device: { type: ['string', 'null'], pattern: '^(gpu-auto|cpu|0|[1-9][0-9]{0,2})$' },
    baseModel: { anyOf: [{ type: 'null' }, schema({ modelId: { type: 'string', minLength: 1, maxLength: 128 },
      modelVersion: nullableInteger(1, 2147483647) })] },
    optimizer: { type: ['string', 'null'], enum: [...TRAINING_OPTIMIZERS, null] },
    cosLr: nullableBoolean, augment: nullableBoolean, resume: nullableBoolean,
  };
  for (const key of ['momentum', 'weightDecay'] as const) properties[key] = { type: ['number', 'null'], minimum: 0, maximum: 1 };
  for (const key of ['warmupEpochs', 'patience', 'workers', 'seed', 'closeMosaic', 'valPeriod'] as const)
    properties[key] = nullableInteger(TRAINING_LIMITS[key].min, TRAINING_LIMITS[key].max);
  return schema(properties);
}
