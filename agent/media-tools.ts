import type { MediaJob, ScreeningParameters, ScreeningSection } from '../shared/media.ts';
import type { ToolDefinition, ToolEnvironment } from './tools.ts';
import { AgentError, fields, id, ids, integer, object } from './validation.ts';

const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nullableBoolean = { type: ['boolean', 'null'] };
const int = (minimum: number, maximum: number) => ({ type: ['integer', 'null'], minimum, maximum });
const kinds = ['video_extract', 'image_screening'];
const statuses = ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'];
const stages = ['queued', 'inspecting', 'extracting', 'validating', 'ready', 'importing', 'screening', 'done'];
const sections: ScreeningSection[] = ['items', 'exactGroups', 'nearPairs', 'sourceLeakageGroups'];
const pageProperties = { offset: int(0, 2147483647), limit: int(1, 500) };
const jobProperties = { jobId: { type: 'string', minLength: 1, maxLength: 160 } };
export const SCREENING_PARAMETER_PROPERTIES = {
  deduplicate: { ...nullableBoolean, description: '仅生成精确重复的筛选建议，不删除或合并素材。' },
  nearEnabled: nullableBoolean, blurEnabled: nullableBoolean,
  nearMaxDistance: int(0, 64), aspectRatioTolerance: { type: ['number', 'null'], minimum: 0, maximum: 1 },
  maxComparisons: int(0, 2000000), maxPairs: int(0, 20000),
  blurThreshold: { type: ['number', 'null'], minimum: 0, description: '启用模糊检查时必填；是缩小分析图的方差阈值，不是原图清晰度准确率。' },
};

function active(env: ToolEnvironment) {
  if (env.signal?.aborted) throw new AgentError('AGENT_CANCELLED', '对话已停止，未提交媒体操作');
}
function projectId(env: ToolEnvironment) {
  if (!env.projectId) throw new AgentError('PROJECT_REQUIRED', '请先打开一个项目');
  return id(env.projectId, '项目标识');
}
function invalid(message: string): never { throw new AgentError('MEDIA_RESPONSE_INVALID', message); }
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))
    .filter(key => typeof value[key] !== 'number' || Number.isFinite(value[key])).map(key => [key, value[key]]));
}
function uniqueIds(value: unknown, label: string, allowEmpty = false) {
  const result = ids(value, label, 10000);
  if ((!allowEmpty && !result.length) || result.length !== (value as unknown[]).length)
    throw new AgentError('INVALID_ARGUMENT', `${label}不能为空或重复`);
  return result;
}
function allowed(env: ToolEnvironment) {
  return env.context.assetIds == null ? undefined : new Set(uniqueIds(env.context.assetIds, '助手素材范围'));
}
function assertScope(assetIds: string[], env: ToolEnvironment) {
  const scope = allowed(env);
  if (scope && assetIds.some(value => !scope.has(value))) throw new AgentError('ASSET_SCOPE', '媒体结果包含助手当前选择范围外的素材');
}
export function screeningParameters(value: unknown): ScreeningParameters {
  const input = object(value, '图像筛选参数'); fields(input, Object.keys(SCREENING_PARAMETER_PROPERTIES));
  const result: Record<string, unknown> = {};
  for (const key of ['deduplicate', 'nearEnabled', 'blurEnabled']) if (input[key] != null) {
    if (typeof input[key] !== 'boolean') throw new AgentError('INVALID_ARGUMENT', '筛选开关必须为布尔值');
    result[key] = input[key];
  }
  for (const [key, maximum] of [['nearMaxDistance', 64], ['maxComparisons', 2000000], ['maxPairs', 20000]] as const)
    if (input[key] != null) result[key] = integer(input[key], key, 0, maximum);
  for (const key of ['aspectRatioTolerance', 'blurThreshold']) if (input[key] != null) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key === 'aspectRatioTolerance' && value > 1))
      throw new AgentError('INVALID_ARGUMENT', '筛选阈值必须是范围内的有限数值');
    result[key] = value;
  }
  if (result.blurEnabled === true && result.blurThreshold == null)
    throw new AgentError('SCREENING_THRESHOLD_REQUIRED', '启用模糊检查时请填写分析图方差阈值');
  return result;
}
async function mediaRequest(env: ToolEnvironment, command: string, payload: Record<string, unknown>) {
  active(env);
  try { const value = await env.engine.request(command, payload); if (command !== 'media.screening.create') active(env); return value; }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['unknown_command', 'command_not_implemented', 'UNKNOWN_COMMAND', 'COMMAND_NOT_IMPLEMENTED'].includes(code)
      || error instanceof Error && /\b(?:unknown_command|command_not_implemented)\b/.test(error.message))
      throw new AgentError('MEDIA_CAPABILITY_REQUIRED', '当前引擎尚不支持此媒体命令，请在桌面应用更新并启用对应能力');
    throw error;
  }
}
function job(value: unknown, env: ToolEnvironment): MediaJob {
  const raw = object(value, '媒体任务');
  id(raw.id, '媒体任务');
  if (raw.projectId !== projectId(env)) throw new AgentError('PROJECT_SCOPE', '媒体任务不属于当前项目');
  if (!kinds.includes(raw.kind as string) || !statuses.includes(raw.status as string) || !stages.includes(raw.stage as string)
    || ['canCancel', 'canRetry', 'artifactCommitted', 'assetsCommitted', 'canImport'].some(key => typeof raw[key] !== 'boolean'))
    invalid('媒体任务状态或提交标记不完整');
  integer(raw.sequence, '媒体任务事件位置', 0, Number.MAX_SAFE_INTEGER);
  return raw as unknown as MediaJob;
}
export async function mediaJob(env: ToolEnvironment, jobId: string): Promise<MediaJob> {
  const result = job(await mediaRequest(env, 'media.job.get', { jobId }), env);
  if (result.id !== jobId) invalid('媒体任务响应与请求标识不一致');
  return result;
}
export async function completedVideoJob(env: ToolEnvironment, jobId: string): Promise<MediaJob> {
  const result = await mediaJob(env, jobId);
  if (result.kind !== 'video_extract') throw new AgentError('MEDIA_JOB_KIND_INVALID', '流程导入需要已提取的视频任务');
  if (result.status !== 'completed' || !result.artifactCommitted)
    throw new AgentError('MEDIA_ARTIFACT_REQUIRED', '视频任务尚未成功提交抽帧产物，请先在媒体任务中完成提取');
  return result;
}
function jobSummary(value: MediaJob) {
  const raw = value as unknown as Record<string, unknown>, progress = object(raw.progress, '媒体进度');
  const result: Record<string, unknown> = pick(raw, ['id', 'projectId', 'kind', 'status', 'stage', 'sequence', 'createdAt', 'updatedAt', 'completedAt',
    'canCancel', 'canRetry', 'artifactCommitted', 'assetsCommitted', 'canImport', 'originalJobId', 'sourceVideoId', 'sourceName']);
  result.progress = pick(progress, ['phase', 'completed', 'total', 'completedFrames', 'decodedFrames', 'sourceTimeSeconds', 'outputBytes']);
  // ready 只描述产物阶段；素材是否入库始终读取独立的提交标记。
  if (raw.summary != null) result.summary = pick(object(raw.summary), ['status', 'frameCount', 'importedAssets', 'inputCount', 'distinctContentCount', 'completedFrames', 'decodedFrames', 'outputBytes']);
  if (raw.error != null) result.error = pick(object(raw.error), ['code']);
  if (value.kind === 'image_screening') result.parameters = screeningParameters(value.parameters);
  else {
    const parameters = object(raw.parameters);
    result.parameters = { ...pick(parameters, ['mode', 'intervalSeconds', 'everyNFrames', 'targetFps', 'format', 'jpegQuality', 'streamIndex', 'maxFrames', 'maxOutputBytes', 'timeoutMs']),
      ...(parameters.outputSize == null ? {} : { outputSize: pick(object(parameters.outputSize), ['width', 'height', 'fit']) }),
      ...(Array.isArray(parameters.ranges) ? { rangeCount: parameters.ranges.length, ranges: parameters.ranges.slice(0, 32).map(value => pick(object(value), ['start', 'end'])) } : {}) };
  }
  return result;
}
function page(args: Record<string, unknown>, maximum = 500) {
  return { offset: integer(args.offset ?? 0, '分页位置', 0, 2147483647), limit: integer(args.limit ?? 100, '每页数量', 1, maximum) };
}
function checkedPage(value: unknown, offset: number, limit: number) {
  const raw = object(value), total = integer(raw.total, '结果总数', 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(raw.items) || raw.items.length > limit || (offset < total && (!raw.items.length || offset + raw.items.length > total))
    || (offset >= total && raw.items.length)) invalid('媒体分页响应不完整');
  return { raw, items: raw.items as unknown[], total };
}
function pagination(total: number, offset: number, limit: number, length: number) {
  return { total, offset, limit, nextOffset: offset + length < total ? offset + length : null };
}
export async function videoFramesPage(env: ToolEnvironment, jobId: string, offset: number, limit: number) {
  const result = checkedPage(await mediaRequest(env, 'media.video.frames', { jobId, offset, limit }), offset, limit);
  const seen = new Set<string>(), scope = allowed(env);
  const items: Record<string, unknown>[] = result.items.map(value => {
    const raw = object(value), frameId = id(raw.frameId, '视频帧');
    if (seen.has(frameId)) invalid('视频帧分页重复'); seen.add(frameId);
    if (raw.assetId != null) id(raw.assetId, '帧素材');
    if (scope && (raw.assetId == null || !scope.has(raw.assetId as string)))
      throw new AgentError('ASSET_SCOPE', '视频帧尚未入库或超出助手当前素材范围');
    for (const key of ['sourcePts', 'originPts', 'relativePts'])
      if (typeof raw[key] !== 'string' || !/^-?\d+$/.test(raw[key]) || raw[key].length > 80) invalid('视频帧缺少实际 PTS 字符串');
    const timeBase = object(raw.timeBase);
    integer(timeBase.numerator, '时间基准分子', 1, Number.MAX_SAFE_INTEGER); integer(timeBase.denominator, '时间基准分母', 1, Number.MAX_SAFE_INTEGER);
    integer(raw.sourcePresentationIndex, '源呈现序号', 0, Number.MAX_SAFE_INTEGER);
    if (typeof raw.timeSeconds !== 'number' || !Number.isFinite(raw.timeSeconds) || raw.timeSeconds < 0) invalid('视频帧时间无效');
    return { ...pick(raw, ['frameId', 'assetId', 'width', 'height', 'bytes', 'sourceVideoId', 'streamIndex', 'sourcePresentationIndex',
      'sourcePts', 'originPts', 'relativePts', 'timeSeconds', 'rangeIndex', 'bucketIndex', 'selectionVersion']),
      timeBase: pick(timeBase, ['numerator', 'denominator']) };
  });
  return { ...pagination(result.total, offset, limit, items.length), items };
}
export function screeningReasons(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) invalid('筛选原因列表不完整或超出范围');
  return value.map(value => pick(object(value), ['code', 'requiresReview', 'reason', 'representativeAssetId', 'identityPreserved', 'score', 'threshold', 'analysisWidth', 'analysisHeight']));
}
function screeningSummary(value: unknown) {
  const raw = object(value), unexamined = raw.unexaminedBlurAssetIds;
  if (!['complete', 'incomplete'].includes(raw.status as string) || raw.identityMerge !== false || raw.changesApplied !== false
    || !Array.isArray(unexamined) || unexamined.length > 10000) invalid('筛选摘要缺少真实覆盖或只建议标记');
  return { ...pick(raw, ['status', 'inputCount', 'distinctContentCount', 'identityMerge', 'changesApplied', 'scoreMeaning']),
    nearCheck: pick(object(raw.nearCheck), ['status', 'scope', 'totalContentPairs', 'comparedContentPairs', 'hammingComparisons',
      'aspectIncompatibleContentPairs', 'unexaminedContentPairs', 'unexaminedIdentityPairUpperBound', 'stopReason', 'reportedPairs']),
    partitionCheck: pick(object(raw.partitionCheck), ['status', 'unassignedInputs']), unexaminedBlurCount: unexamined.length };
}
function screeningRow(value: unknown, section: ScreeningSection, env: ToolEnvironment) {
  const raw = object(value);
  if (section === 'items') {
    assertScope([id(raw.assetId, '筛选素材')], env);
    if (!['keep', 'keep_protected', 'review_suggested', 'exclude_suggested'].includes(raw.recommendation as string) || typeof raw.protected !== 'boolean') invalid('筛选建议无效');
    const input = object(raw.input), feature = object(raw.feature);
    return { ...pick(raw, ['assetId', 'protected', 'recommendation', 'exactRepresentativeAssetId']), reasons: screeningReasons(raw.reasons),
      input: { ...pick(input, ['assetId', 'width', 'height', 'inputVersion', 'normalizationVersion', 'status', 'version', 'partition', 'sourceVideoId', 'groupId', 'sourcePts', 'sourcePresentationIndex', 'timeSeconds']),
        ...(input.metadata == null ? {} : { metadata: pick(object(input.metadata), ['sourceVideoId', 'groupId', 'sourcePts', 'sourcePresentationIndex', 'timeSeconds']) }) },
      feature: pick(feature, ['featureVersion', 'width', 'height', 'normalizationVersion', 'inputVersion', 'laplacianVariance', 'analysisWidth', 'analysisHeight', 'laplacianSamples', 'grayStdDev']) };
  }
  if (section === 'nearPairs') {
    assertScope([id(raw.leftAssetId, '左侧素材'), id(raw.rightAssetId, '右侧素材')], env);
    if (raw.action !== 'candidate_only' || raw.requiresReview !== true) invalid('近重复结果必须是待复核候选');
    integer(raw.distance, '近重复距离', 0, 64); integer(raw.threshold, '近重复阈值', 0, 64);
    return pick(raw, ['leftAssetId', 'rightAssetId', 'distance', 'threshold', 'aspectRatioDifference', 'aspectRatioTolerance', 'lowInformation', 'crossPartition', 'requiresReview', 'action']);
  }
  const members = uniqueIds(raw.members, '筛选分组成员'); assertScope(members, env);
  const representative = id(raw.representativeAssetId, '分组代表');
  if (!members.includes(representative)) invalid('筛选分组代表不属于成员');
  if (section === 'sourceLeakageGroups' && (!['sourceVideoId', 'groupId'].includes(raw.kind as string) || raw.requiresReview !== true)) invalid('来源分组必须保留真实来源和复核标记');
  return { ...pick(raw, section === 'exactGroups' ? ['representativeAssetId', 'crossPartition'] : ['kind', 'sourceId', 'representativeAssetId', 'requiresReview']),
    memberCount: members.length, memberSample: members.slice(0, 20), membersTruncated: members.length > 20,
    partitions: Array.isArray(raw.partitions) ? raw.partitions.filter(value => typeof value === 'string').slice(0, 20) : [] };
}

export const MEDIA_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'list_media_jobs', description: '分页读取当前项目媒体任务的真实状态与提交标记。completed/ready 不代表素材已入库；assetsCommitted 才表示已入库。不会配置工具或读取文件路径。',
    parameters: schema({ kind: { type: ['string', 'null'], enum: [...kinds, null] }, offset: int(0, 2147483647), limit: int(1, 100) }), mutation: false,
    async execute(args, env) {
      fields(args, ['kind', 'offset', 'limit']);
      if (args.kind != null && !kinds.includes(args.kind as string)) throw new AgentError('INVALID_ARGUMENT', '媒体任务类型不受支持');
      const { offset, limit } = page(args, 100), result = checkedPage(await mediaRequest(env, 'media.job.list', { projectId: projectId(env), offset, limit, ...(args.kind == null ? {} : { kind: args.kind }) }), offset, limit);
      const records = result.items.map(value => job(value, env));
      if (new Set(records.map(value => value.id)).size !== records.length || args.kind != null && records.some(value => value.kind !== args.kind)) invalid('媒体任务分页重复或类型不匹配');
      return { ...pagination(result.total, offset, limit, records.length), items: records.map(jobSummary) };
    } },
  { name: 'get_media_job', description: '读取同项目媒体任务状态、真实进度和是否提交产物/入库，不将后台执行中或 ready 状态宣称已完成导入。', parameters: schema(jobProperties), mutation: false,
    async execute(args, env) { fields(args, ['jobId']); return jobSummary(await mediaJob(env, id(args.jobId, '媒体任务'))); } },
  { name: 'get_video_frames', description: '分页读取已完成视频产物的帧身份、真实 PTS 与时间，保留同画面不同帧。未绑定 assetId 的帧尚未入库，不返回图像或文件路径。',
    parameters: schema({ ...jobProperties, ...pageProperties }), mutation: false,
    async execute(args, env) {
      fields(args, ['jobId', 'offset', 'limit']); const jobId = id(args.jobId, '媒体任务'), source = await completedVideoJob(env, jobId), { offset, limit } = page(args);
      const result = await videoFramesPage(env, jobId, offset, limit);
      if (result.items.some(frame => frame.sourceVideoId !== source.sourceVideoId)) invalid('视频帧来源与媒体任务不一致');
      return { job: jobSummary(source), ...result };
    } },
  { name: 'get_screening_result', description: '分页读取筛选建议、近重复候选或来源分组。incomplete 必须保留未检查数量；近重复/模糊不证明应删除，分组仅返回代表和至多 20 个成员样例。',
    parameters: schema({ ...jobProperties, section: { type: ['string', 'null'], enum: [...sections, null] }, ...pageProperties }), mutation: false,
    async execute(args, env) {
      fields(args, ['jobId', 'section', 'offset', 'limit']); const jobId = id(args.jobId, '媒体任务'), source = await mediaJob(env, jobId), section = (args.section ?? 'items') as ScreeningSection;
      if (!sections.includes(section)) throw new AgentError('INVALID_ARGUMENT', '筛选结果分类不受支持');
      if (source.kind !== 'image_screening') throw new AgentError('MEDIA_JOB_KIND_INVALID', '此任务不是图像筛选任务');
      if (source.status !== 'completed' || !source.artifactCommitted) throw new AgentError('MEDIA_ARTIFACT_REQUIRED', '筛选结果尚未成功提交，请等待媒体任务完成');
      const { offset, limit } = page(args), result = checkedPage(await mediaRequest(env, 'media.screening.result', { jobId, section, offset, limit }), offset, limit);
      if (result.raw.jobId !== jobId || result.raw.section !== section || result.raw.offset !== offset || result.raw.limit !== limit) invalid('筛选结果身份或分页与请求不一致');
      const items = result.items.map(value => screeningRow(value, section, env));
      const keys = result.items.map(value => { const row = object(value); return section === 'items' ? row.assetId : section === 'nearPairs'
        ? [row.leftAssetId, row.rightAssetId].sort().join(':') : section === 'exactGroups' ? row.representativeAssetId : `${row.kind}:${row.sourceId}`; });
      if (new Set(keys).size !== keys.length) invalid('筛选结果当前页存在重复项');
      return { job: jobSummary(source), jobId, section, ...pagination(result.total, offset, limit, items.length), parameters: screeningParameters(result.raw.parameters), summary: screeningSummary(result.raw.summary), items };
    } },
  { name: 'preview_image_screening', description: '对明确选择的 1～10000 张同项目素材提交后台筛选任务，返回真实 job，需后续查询结果。零 API 调用；仅建议，不删除文件、不改标注、不自动排除近重复或模糊素材。',
    parameters: schema({ assetIds: { type: 'array', minItems: 1, maxItems: 10000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } }, parameters: schema(SCREENING_PARAMETER_PROPERTIES) }), mutation: true,
    async execute(args, env) {
      fields(args, ['assetIds', 'parameters']); const assetIds = uniqueIds(args.assetIds, '筛选素材'), parameters = screeningParameters(args.parameters);
      assertScope(assetIds, env); const pid = projectId(env);
      for (let offset = 0; offset < assetIds.length; offset += 10) {
        active(env); await Promise.all(assetIds.slice(offset, offset + 10).map(async assetId => {
          const asset = object(await env.engine.request('asset.get', { assetId }));
          if (asset.id !== assetId || asset.projectId !== pid) throw new AgentError('ASSET_SCOPE', '筛选素材不属于当前项目或响应身份不符');
        }));
      }
      const result = job(await mediaRequest(env, 'media.screening.create', { projectId: pid, assetIds, parameters }), env);
      if (result.kind !== 'image_screening') invalid('引擎没有返回图像筛选任务');
      return { submitted: true, job: jobSummary(result) };
    } },
];
