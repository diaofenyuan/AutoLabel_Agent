import type { TrackGenerationParameters, TrackGenerationSection } from '../shared/tracks.ts';
import type { ToolDefinition, ToolEnvironment } from './tools.ts';
import { AgentError, fields, id, ids, integer, object } from './validation.ts';

type Row = Record<string, unknown>;
const schema = (properties: Row) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const identifier = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[\\w-]+$' };
const nullableId = { ...identifier, type: ['string', 'null'] };
const int = (minimum: number, maximum: number) => ({ type: ['integer', 'null'], minimum, maximum });
const versionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const pages = { offset: int(0, 2147483647), limit: int(1, 500) };
const listPages = { offset: pages.offset, limit: int(1, 100) };
const parameterNames = ['maxGapSeconds', 'maxCenterSpeedPixelsPerSecond', 'maxKeypointSpeedPixelsPerSecond', 'maxScaleFactor'] as const;
const parameterSchema = schema(Object.fromEntries(parameterNames.map(key => [key, { type: ['number', 'null'],
  ...(key === 'maxScaleFactor' ? { minimum: 1 } : { exclusiveMinimum: 0 }), maximum: 1e12 }])));
const generationArgs = { trackId: identifier, baseVersion: versionSchema, timelineVersion: versionSchema,
  parameters: { ...parameterSchema, type: ['object', 'null'] }, scope: { type: ['string', 'null'], enum: ['affected', 'all', null] } };
const generationStatuses = ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'interrupted', 'failed'];
const annotationStates = ['empty', 'candidate', 'manual', 'confirmed'];
const sections: TrackGenerationSection[] = ['frames', 'intervals', 'skipped'];
const maximumFrames = 10000;

function invalid(message: string): never { throw new AgentError('TRACK_RESPONSE_INVALID', message); }
function conflict(): never { throw new AgentError('TRACK_VERSION_CONFLICT', '轨迹、时间轴或预览计划已变化，请重新读取并预览'); }
function active(env: ToolEnvironment) {
  if (env.signal?.aborted) throw new AgentError('AGENT_CANCELLED', '对话已停止，未提交后续轨迹操作');
}
function projectId(env: ToolEnvironment) {
  if (!env.projectId) throw new AgentError('PROJECT_REQUIRED', '请先打开一个项目');
  return id(env.projectId, '项目标识');
}
function scope(env: ToolEnvironment) {
  if (env.context.assetIds == null) return undefined;
  const values = ids(env.context.assetIds, '助手素材范围', maximumFrames);
  if (values.length !== env.context.assetIds.length) throw new AgentError('INVALID_ARGUMENT', '助手素材范围不能重复');
  return new Set(values);
}
function assertScope(assetId: string, selected: Set<string> | undefined) {
  if (selected && !selected.has(assetId)) throw new AgentError('ASSET_SCOPE', '轨迹数据包含助手当前选择范围外的素材');
}
async function request(env: ToolEnvironment, command: string, payload: Row) {
  active(env); projectId(env);
  try {
    const value = await env.engine.request(command, payload);
    // 已成功提交的操作必须如实回传，不能因随后停止聊天而伪装成未提交。
    if (command !== 'track.generate' && command !== 'track.generation.cancel') active(env);
    return value;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (/^(?:unknown_command|command_not_implemented)$/i.test(code)
      || error instanceof Error && /\b(?:unknown_command|command_not_implemented)\b/i.test(error.message))
      throw new AgentError('TRACK_CAPABILITY_REQUIRED', '当前引擎尚不支持轨迹命令，请在桌面应用更新并启用轨迹能力');
    throw error;
  }
}
function pick(value: Row, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))
    .filter(key => typeof value[key] !== 'number' || Number.isFinite(value[key])).map(key => [key, value[key]]));
}
function bool(raw: Row, key: string) { if (typeof raw[key] !== 'boolean') invalid('轨迹响应缺少真实状态标记'); return raw[key] as boolean; }
function count(value: unknown, label = '数量', maximum = maximumFrames) { return integer(value, label, 0, maximum); }
function version(value: unknown) { return integer(value, '版本', 1, Number.MAX_SAFE_INTEGER); }
function finite(value: unknown, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) invalid('轨迹响应数值无效');
  return value as number;
}
function pts(value: unknown) {
  if (typeof value !== 'string' || value.length > 80 || !/^-?\d+$/.test(value)) invalid('帧时间必须保留实际 PTS 整数字符串');
  return value as string;
}
function page(args: Row, maximum = 500) {
  return { offset: integer(args.offset ?? 0, '分页位置', 0, 2147483647), limit: integer(args.limit ?? 100, '每页数量', 1, maximum) };
}
function checkedPage(value: unknown, offset: number, limit: number) {
  const raw = object(value), total = count(raw.total, '结果总数', Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(raw.items) || raw.items.length > limit || (offset < total && (!raw.items.length || offset + raw.items.length > total))
    || (offset >= total && raw.items.length)) invalid('轨迹分页响应不完整');
  return { raw, items: raw.items.map(value => object(value)), total };
}
function unique(rows: Row[], key: string) {
  const values = rows.map(row => id(row[key], key));
  if (new Set(values).size !== values.length) invalid('轨迹分页包含重复身份');
}
function pagination(total: number, offset: number, limit: number, length: number) {
  return { total, offset, limit, nextOffset: offset + length < total ? offset + length : null };
}
function parameters(value: unknown, complete = false): TrackGenerationParameters {
  const raw = object(value ?? {}, '插值阈值'); fields(raw, parameterNames);
  const result: Row = {};
  for (const key of parameterNames) {
    const value = raw[key];
    if (value == null && !complete) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e12 || key === 'maxScaleFactor' && value < 1)
      throw new AgentError('INVALID_ARGUMENT', '插值阈值应为有限正数且不超过 1e12，尺寸倍率至少为 1');
    result[key] = value;
  }
  return result;
}
function timeline(value: unknown, env: ToolEnvironment) {
  const raw = object(value, '时间轴'); id(raw.id); id(raw.mediaJobId); id(raw.sourceVideoId);
  if (raw.projectId !== projectId(env)) throw new AgentError('PROJECT_SCOPE', '时间轴不属于当前项目');
  if (!['detect', 'pose'].includes(raw.taskType as string)) invalid('时间轴任务类型不受支持');
  version(raw.version); integer(raw.frameCount, '时间轴帧数', 1, maximumFrames); count(raw.sequence, '事件位置', Number.MAX_SAFE_INTEGER);
  return raw;
}
function timelineSummary(raw: Row) {
  return pick(raw, ['id', 'projectId', 'mediaJobId', 'sourceVideoId', 'name', 'version', 'taskType', 'frameCount', 'width', 'height', 'createdAt', 'updatedAt', 'sequence']);
}
async function getTimeline(env: ToolEnvironment, timelineId: string) {
  const result = timeline(await request(env, 'track.timeline.get', { timelineId }), env);
  if (result.id !== timelineId) invalid('时间轴响应标识不一致');
  return result;
}
function track(value: unknown, source: Row) {
  const raw = object(value, '轨迹'); id(raw.id); id(raw.objectId); id(raw.classId);
  if (raw.timelineId !== source.id || raw.sourceVideoId !== source.sourceVideoId) invalid('轨迹不属于请求的时间轴或视频来源');
  if (!['active', 'deleted', 'superseded'].includes(raw.status as string)) invalid('轨迹状态无效');
  version(raw.version); count(raw.keyframeCount); count(raw.pendingFrameCount); bool(raw, 'needsRecompute');
  return raw;
}
function trackSummary(raw: Row) {
  return pick(raw, ['id', 'timelineId', 'sourceVideoId', 'objectId', 'classId', 'name', 'version', 'status', 'keyframeCount',
    'needsRecompute', 'pendingFrameCount', 'createdAt', 'updatedAt', 'sequence']);
}
async function getTrack(env: ToolEnvironment, trackId: string) {
  const raw = object(await request(env, 'track.get', { trackId }));
  if (raw.id !== trackId) invalid('轨迹响应标识不一致');
  const source = await getTimeline(env, id(raw.timelineId, '时间轴'));
  return { track: track(raw, source), timeline: source };
}
function sameTimeline(before: Row, after: Row) {
  if (['id', 'projectId', 'mediaJobId', 'sourceVideoId', 'version', 'frameCount', 'sequence'].some(key => before[key] !== after[key])) conflict();
}
function frame(value: Row, source: Row) {
  id(value.frameId); id(value.assetId); id(value.sourceFrameId);
  if (value.sourceVideoId != null && value.sourceVideoId !== source.sourceVideoId
    || value.timelineId != null && value.timelineId !== source.id
    || value.projectId != null && value.projectId !== source.projectId) invalid('帧响应的时间轴、项目或视频来源不一致');
  for (const key of ['sourcePts', 'originPts', 'relativePts']) pts(value[key]);
  const timeBase = object(value.timeBase); version(timeBase.numerator); version(timeBase.denominator);
  count(value.sourcePresentationIndex, '源呈现序号', Number.MAX_SAFE_INTEGER); finite(value.timeSeconds);
  if (!annotationStates.includes(value.annotationState as string)) invalid('帧标注状态无效');
  bool(value, 'protected'); count(value.annotationVersion, '标注版本', Number.MAX_SAFE_INTEGER);
  return value;
}
type FrameIndex = { frames: Map<string, Row>; positions: Map<string, number>; outside: number[] };
async function allFrames(env: ToolEnvironment, source: Row, requireEntireScope = false): Promise<FrameIndex> {
  const frames = new Map<string, Row>(), positions = new Map<string, number>(), assets = new Set<string>();
  const selected = scope(env), outside = [0]; let lastIndex = -1;
  // 数量、身份、顺序和末次版本都固定，截断或串页不能被视作完整的写入范围。
  for (let offset = 0; offset < (source.frameCount as number);) {
    const result = checkedPage(await request(env, 'track.timeline.frames', { timelineId: source.id, offset, limit: 500 }), offset, 500);
    if (result.total !== source.frameCount || result.total > maximumFrames || result.items.length !== Math.min(500, result.total - offset)) invalid('时间轴分页总数变化、截断或超出范围');
    for (const raw of result.items) {
      const entry = frame(raw, source), frameId = entry.frameId as string, assetId = entry.assetId as string;
      if (frames.has(frameId) || assets.has(assetId) || (entry.sourcePresentationIndex as number) <= lastIndex) invalid('时间轴分页包含重复身份或不稳定顺序');
      lastIndex = entry.sourcePresentationIndex as number; positions.set(frameId, frames.size); frames.set(frameId, entry); assets.add(assetId);
      const excluded = selected != null && !selected.has(assetId);
      if (excluded && requireEntireScope) throw new AgentError('ASSET_SCOPE', '生成或取消要求完整时间轴均在助手当前选择范围内');
      outside.push(outside.at(-1)! + Number(excluded));
    }
    offset += result.items.length;
  }
  sameTimeline(source, await getTimeline(env, source.id as string));
  return { frames, positions, outside };
}
function member(index: FrameIndex, frameId: unknown, env: ToolEnvironment, assetId?: unknown) {
  const result = index.frames.get(id(frameId, '时间轴帧'));
  if (!result || assetId != null && result.assetId !== assetId) invalid('结果帧或素材不属于请求的时间轴');
  const position = index.positions.get(result.frameId as string)!;
  if (index.outside[position + 1] !== index.outside[position]) throw new AgentError('ASSET_SCOPE', '轨迹数据包含助手当前选择范围外的素材');
  return result;
}
function keyframe(raw: Row, source: Row, index: FrameIndex, env: ToolEnvironment) {
  const actual = member(index, raw.frameId, env, raw.assetId); id(raw.keyframeId);
  if (raw.objectId !== source.objectId || !['located', 'occluded', 'enter', 'exit', 'unlocatable'].includes(raw.state as string)) invalid('关键帧对象或状态不一致');
  if (pts(raw.sourcePts) !== actual.sourcePts || finite(raw.timeSeconds) !== actual.timeSeconds) invalid('关键帧时间与固定帧不一致');
  return pick(raw, ['keyframeId', 'frameId', 'assetId', 'objectId', 'state', 'sourcePts', 'timeSeconds']);
}
function frameSummary(raw: Row, env: ToolEnvironment, selected: Set<string> | undefined, sourceTrack?: Row) {
  assertScope(raw.assetId as string, selected);
  const result = { ...pick(raw, ['frameId', 'assetId', 'sourceFrameId', 'sourcePresentationIndex', 'sourcePts', 'originPts', 'relativePts',
    'timeSeconds', 'rangeIndex', 'sceneId', 'width', 'height', 'inputVersion', 'annotationVersion', 'annotationState', 'draftSavedAt', 'protected']),
    timeBase: pick(object(raw.timeBase), ['numerator', 'denominator']) } as Row;
  if (raw.keyframe != null) {
    if (!sourceTrack) invalid('帧响应带有未指定轨迹的关键帧');
    const index = { frames: new Map([[raw.frameId as string, raw]]), positions: new Map([[raw.frameId as string, 0]]), outside: [0, 0] };
    result.keyframe = keyframe(object(raw.keyframe), sourceTrack, index, env);
  }
  if (raw.contributions != null) {
    if (!Array.isArray(raw.contributions) || raw.contributions.length > maximumFrames) invalid('候选来源数量超出范围');
    const entries = raw.contributions.map(value => object(value));
    for (const entry of entries) { id(entry.contributionId); id(entry.trackId); id(entry.generationId); bool(entry, 'requiresReview'); }
    result.contributionCount = entries.length; result.reviewContributionCount = entries.filter(value => value.requiresReview).length;
  }
  return result;
}
function issues(value: unknown, index: FrameIndex, env: ToolEnvironment) {
  if (!Array.isArray(value) || value.length > maximumFrames) invalid('轨迹问题列表超出范围');
  const entries = value.map(value => {
    const raw = object(value); id(raw.code, '问题代码');
    if (!['warning', 'error'].includes(raw.severity as string)) invalid('轨迹问题严重度无效');
    if (raw.frameId != null) member(index, raw.frameId, env);
    return pick(raw, ['code', 'severity', 'frameId', 'attributeId', 'metricValue', 'thresholdName', 'threshold']);
  });
  return { issueCount: entries.length, issues: entries.slice(0, 20), issuesTruncated: entries.length > 20 };
}
function rational(value: unknown) {
  const raw = object(value), numerator = pts(raw.numerator), denominator = pts(raw.denominator);
  if (BigInt(denominator) <= 0n) invalid('时间分母必须大于零');
  return { numerator, denominator };
}
function interval(raw: Row, index: FrameIndex, env: ToolEnvironment) {
  id(raw.intervalId); id(raw.leftKeyframeId); id(raw.rightKeyframeId);
  member(index, raw.leftFrameId, env); member(index, raw.rightFrameId, env);
  const left = index.positions.get(raw.leftFrameId as string)!, right = index.positions.get(raw.rightFrameId as string)!;
  if (left >= right) invalid('轨迹区间端点顺序无效');
  if (index.outside[right + 1] !== index.outside[left]) throw new AgentError('ASSET_SCOPE', '轨迹区间包含助手当前选择范围外的素材');
  bool(raw, 'blocked'); bool(raw, 'requiresReview');
  if (raw.scenePolicy !== 'input_supplied_scene_ids' || raw.trackingPerformed !== false) invalid('插值结果不能冒充场景识别或目标跟踪');
  return { ...pick(raw, ['intervalId', 'leftKeyframeId', 'rightKeyframeId', 'leftFrameId', 'rightFrameId', 'blocked', 'requiresReview',
    'scenePolicy', 'trackingPerformed', 'candidateCount', 'protectedFrameCount']), startTime: rational(raw.startTime), endTime: rational(raw.endTime),
    thresholds: parameters(raw.thresholds, true), ...issues(raw.reviewIssues, index, env),
    metrics: pick(object(raw.metrics), ['durationSeconds', 'centerDistancePixels', 'centerSpeedPixelsPerSecond', 'maxKeypointDistancePixels', 'maxKeypointSpeedPixelsPerSecond', 'scaleFactor']) };
}
function generation(value: unknown, sourceTrack: Row, sourceTimeline: Row) {
  const raw = object(value, '轨迹生成任务'); id(raw.id);
  if (raw.trackId !== sourceTrack.id || raw.timelineId !== sourceTimeline.id) invalid('生成任务不属于请求的轨迹或时间轴');
  if (!generationStatuses.includes(raw.status as string) || !['affected', 'all'].includes(raw.scope as string)
    || raw.candidateOnly !== true || raw.humanConfirmed !== false || raw.requestsUsed !== 0) invalid('生成任务缺少实际候选或请求使用标记');
  version(raw.trackVersion); version(raw.timelineVersion); count(raw.sequence, '事件位置', Number.MAX_SAFE_INTEGER);
  if (bool(raw, 'canCancel') && !['queued', 'running', 'cancelling'].includes(raw.status as string)) invalid('已结束任务不能标记为可取消');
  const progress = object(raw.progress);
  if (typeof progress.phase !== 'string' || progress.phase.length > 160) invalid('生成任务进度阶段无效');
  for (const key of ['completed', 'total', 'applied', 'protected', 'conflicts', 'failed']) count(progress[key], '生成进度');
  if ((progress.completed as number) > (progress.total as number)) invalid('生成任务进度超过总量');
  parameters(raw.parameters, true); involvedTracks(raw);
  if (raw.originalGenerationId != null) id(raw.originalGenerationId, '原生成任务');
  return raw;
}
function involvedTracks(raw: Row) {
  if (raw.involvedTrackIds == null) return [];
  const values = ids(raw.involvedTrackIds, '参与轨迹', maximumFrames);
  if (!values.length || values.length !== (raw.involvedTrackIds as unknown[]).length) invalid('生成任务参与轨迹身份不完整或重复');
  return values;
}
function generationSummary(raw: Row) {
  const involved = involvedTracks(raw);
  return { ...pick(raw, ['id', 'trackId', 'timelineId', 'trackVersion', 'timelineVersion', 'status', 'sequence', 'createdAt', 'updatedAt', 'canCancel',
    'scope', 'candidateOnly', 'humanConfirmed', 'requestsUsed', 'originalGenerationId']), parameters: parameters(raw.parameters, true),
    ...(raw.involvedTrackIds == null ? {} : { involvedTrackCount: involved.length, involvedTrackSample: involved.slice(0, 20), involvedTracksTruncated: involved.length > 20 }),
    progress: pick(object(raw.progress), ['phase', 'completed', 'total', 'applied', 'protected', 'conflicts', 'failed']),
    ...(raw.summary == null ? {} : { summary: pick(object(raw.summary), ['applied', 'protected', 'blocked', 'unchanged', 'conflicts', 'failed', 'removed', 'requiresReview', 'reviewCount']) }),
    ...(raw.error == null ? {} : { error: pick(object(raw.error), ['code']) }) };
}
async function getGeneration(env: ToolEnvironment, generationId: string) {
  const raw = object(await request(env, 'track.generation.get', { generationId }));
  if (raw.id !== generationId) invalid('生成任务响应标识不一致');
  const source = await getTrack(env, id(raw.trackId));
  return { ...source, generation: generation(raw, source.track, source.timeline) };
}
function previewArgs(args: Row) {
  const selectedScope = args.scope ?? 'affected';
  if (!['affected', 'all'].includes(selectedScope as string)) throw new AgentError('INVALID_ARGUMENT', '生成范围必须为 affected 或 all');
  return { trackId: id(args.trackId), baseVersion: version(args.baseVersion), timelineVersion: version(args.timelineVersion),
    parameters: parameters(args.parameters), scope: selectedScope };
}
function checkVersions(source: { track: Row; timeline: Row }, args: Row) {
  if (source.track.version !== args.baseVersion || source.timeline.version !== args.timelineVersion) conflict();
  if (source.track.status !== 'active') throw new AgentError('TRACK_NOT_ACTIVE', '当前轨迹已归档或被替代，不能生成候选');
}
function planHash(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new AgentError('TRACK_PREVIEW_REQUIRED', '请先预览，并携带预览返回的完整计划标识');
  return value;
}
async function preview(env: ToolEnvironment, args: Row, index: FrameIndex) {
  const raw = object(await request(env, 'track.generate.preview', args)); bool(raw, 'canGenerate'); planHash(raw.planHash);
  const total = count(raw.frameCount); count(raw.affectedCount); count(raw.protectedCount);
  if (total !== index.frames.size || (raw.affectedCount as number) > total || (raw.protectedCount as number) > total) invalid('预览数量与固定时间轴不一致');
  if (!Array.isArray(raw.intervals) || raw.intervals.length > 500 || !Array.isArray(raw.issues) || raw.issues.length > 100) invalid('预览区间或问题数量超出范围');
  const intervalsTotal = count(raw.intervalsTotal, '预览区间总数'), issueCount = count(raw.issueCount, '预览问题总数', Number.MAX_SAFE_INTEGER);
  if (intervalsTotal < raw.intervals.length || issueCount < raw.issues.length
    || bool(raw, 'intervalsTruncated') !== (intervalsTotal > raw.intervals.length)) invalid('预览总数或截断标记不一致');
  const intervals = raw.intervals.map(value => interval(object(value), index, env)); unique(intervals, 'intervalId');
  return { canGenerate: raw.canGenerate as boolean, planHash: raw.planHash as string,
    ...pick(raw, ['frameCount', 'affectedCount', 'protectedCount']), parameters: parameters(raw.parameters, true),
    ...issues(raw.issues, index, env), issueCount, issuesTruncated: issueCount > Math.min(20, raw.issues.length),
    intervalsTotal, intervals: intervals.slice(0, 20), intervalsTruncated: intervalsTotal > Math.min(20, intervals.length) };
}

export const TRACK_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'list_video_timelines', description: '分页读取当前项目已有视频时间轴；不创建时间轴或扩大素材范围。', parameters: schema(listPages), mutation: false,
    async execute(args, env) {
      fields(args, ['offset', 'limit']); const { offset, limit } = page(args, 100);
      const result = checkedPage(await request(env, 'track.timeline.list', { projectId: projectId(env), offset, limit }), offset, limit);
      const items = result.items.map(value => timeline(value, env)); unique(items, 'id');
      return { ...pagination(result.total, offset, limit, items.length), items: items.map(timelineSummary) };
    } },
  { name: 'get_video_timeline', description: '读取同项目时间轴并分页查看帧、实际 PTS、场景和人工保护状态；不返回图像、文件路径或标注几何。',
    parameters: schema({ timelineId: identifier, trackId: nullableId, ...pages }), mutation: false,
    async execute(args, env) {
      fields(args, ['timelineId', 'trackId', 'offset', 'limit']); const source = await getTimeline(env, id(args.timelineId));
      const sourceTrack = args.trackId == null ? undefined : (await getTrack(env, id(args.trackId))).track;
      if (sourceTrack) track(sourceTrack, source);
      const { offset, limit } = page(args), result = checkedPage(await request(env, 'track.timeline.frames', { timelineId: source.id,
        ...(sourceTrack ? { trackId: sourceTrack.id } : {}), offset, limit }), offset, limit);
      if (result.total !== source.frameCount) invalid('时间轴帧总数不一致'); unique(result.items, 'frameId'); unique(result.items, 'assetId');
      const selected = scope(env), items = result.items.map(value => frameSummary(frame(value, source), env, selected, sourceTrack));
      sameTimeline(source, await getTimeline(env, source.id as string));
      return { timeline: timelineSummary(source), frames: { ...pagination(result.total, offset, limit, items.length), items } };
    } },
  { name: 'list_video_tracks', description: '分页读取同项目时间轴的对象轨迹、固定版本和待重算数量；includeArchived 可查看被替代或删除的历史轨迹。',
    parameters: schema({ timelineId: identifier, includeArchived: { type: ['boolean', 'null'] }, ...listPages }), mutation: false,
    async execute(args, env) {
      fields(args, ['timelineId', 'includeArchived', 'offset', 'limit']);
      if (args.includeArchived != null && typeof args.includeArchived !== 'boolean') throw new AgentError('INVALID_ARGUMENT', '历史轨迹开关必须为布尔值');
      const source = await getTimeline(env, id(args.timelineId)), { offset, limit } = page(args, 100), includeArchived = args.includeArchived ?? false;
      const result = checkedPage(await request(env, 'track.list', { timelineId: source.id, includeArchived, offset, limit }), offset, limit);
      const items = result.items.map(value => track(value, source)); unique(items, 'id');
      if (!includeArchived && items.some(value => value.status !== 'active')) invalid('轨迹列表包含未请求的历史轨迹');
      return { timeline: timelineSummary(source), ...pagination(result.total, offset, limit, items.length), items: items.map(trackSummary) };
    } },
  { name: 'get_video_track', description: '读取轨迹当前版本和分页关键帧身份、状态、PTS；aroundFrameId 可读取实际前后关键帧，不生成或编辑几何。',
    parameters: schema({ trackId: identifier, aroundFrameId: nullableId, ...pages }), mutation: false,
    async execute(args, env) {
      fields(args, ['trackId', 'aroundFrameId', 'offset', 'limit']); const source = await getTrack(env, id(args.trackId));
      const index = await allFrames(env, source.timeline), { offset, limit } = page(args);
      const aroundFrameId = args.aroundFrameId == null ? undefined : id(args.aroundFrameId);
      if (aroundFrameId) member(index, aroundFrameId, env);
      const result = checkedPage(await request(env, 'track.keyframe.list', { trackId: source.track.id, ...(aroundFrameId ? { aroundFrameId } : {}), offset, limit }), offset, limit);
      if (result.total !== source.track.keyframeCount) conflict(); unique(result.items, 'keyframeId'); unique(result.items, 'frameId');
      if (aroundFrameId && (result.raw.previous === undefined || result.raw.next === undefined)) invalid('关键帧响应缺少前后导航结果');
      const items = result.items.map(value => keyframe(value, source.track, index, env));
      const neighbors: Row = {};
      for (const key of ['previous', 'next']) if (result.raw[key] !== undefined) {
        const raw = result.raw[key]; neighbors[key] = raw == null ? null : keyframe(object(raw), source.track, index, env);
        if (raw != null && aroundFrameId) {
          const position = index.positions.get(object(raw).frameId as string)!, center = index.positions.get(aroundFrameId)!;
          if (key === 'previous' ? position >= center : position <= center) invalid('前后关键帧方向不一致');
        }
      }
      const latest = await getTrack(env, source.track.id as string);
      if (latest.track.version !== source.track.version) conflict(); sameTimeline(source.timeline, latest.timeline);
      return { track: trackSummary(source.track), timeline: timelineSummary(source.timeline), keyframes: { ...pagination(result.total, offset, limit, items.length), items, ...neighbors } };
    } },
  { name: 'list_track_generations', description: '分页读取轨迹生成历史的真实进度和状态。requestsUsed 仅指插值任务，Agent 对话预算独立；生成候选不等于人工确认。',
    parameters: schema({ trackId: identifier, ...listPages }), mutation: false,
    async execute(args, env) {
      fields(args, ['trackId', 'offset', 'limit']); const source = await getTrack(env, id(args.trackId)), { offset, limit } = page(args, 100);
      const result = checkedPage(await request(env, 'track.generation.list', { trackId: source.track.id, offset, limit }), offset, limit);
      const items: Row[] = [], verified = new Map<string, Row>([[source.track.id as string, source.track]]);
      for (const raw of result.items) {
        const mainId = id(raw.trackId, '生成任务主轨迹');
        if (mainId !== source.track.id && !involvedTracks(raw).includes(source.track.id as string)) invalid('生成任务未关联请求的轨迹');
        if (!verified.has(mainId)) {
          const main = await getTrack(env, mainId); track(main.track, source.timeline); verified.set(mainId, main.track);
        }
        items.push(generation(raw, verified.get(mainId)!, source.timeline));
      }
      unique(items, 'id');
      return { track: trackSummary(source.track), ...pagination(result.total, offset, limit, items.length), items: items.map(generationSummary) };
    } },
  { name: 'get_track_generation', description: '读取生成任务实际状态，并按 frames/intervals/skipped 分页读取结果；保留 protected、blocked 和需要复核标记，不返回候选几何。',
    parameters: schema({ generationId: identifier, section: { type: ['string', 'null'], enum: [...sections, null] }, ...pages }), mutation: false,
    async execute(args, env) {
      fields(args, ['generationId', 'section', 'offset', 'limit']); const section = (args.section ?? 'frames') as TrackGenerationSection;
      if (!sections.includes(section)) throw new AgentError('INVALID_ARGUMENT', '生成结果分类不受支持');
      const source = await getGeneration(env, id(args.generationId)), index = await allFrames(env, source.timeline), { offset, limit } = page(args);
      const result = checkedPage(await request(env, 'track.generation.results', { generationId: source.generation.id, section, offset, limit }), offset, limit);
      if (result.raw.generationId !== source.generation.id || result.raw.section !== section || result.raw.offset !== offset || result.raw.limit !== limit) invalid('生成结果身份或分页不一致');
      unique(result.items, section === 'intervals' ? 'intervalId' : 'frameId');
      const items = result.items.map(raw => {
        if (section === 'intervals') return interval(raw, index, env);
        const actual = member(index, raw.frameId, env, section === 'frames' ? id(raw.assetId) : undefined);
        if (section === 'skipped') {
          if (!annotationStates.includes(raw.annotationState as string)) invalid('跳过帧标注状态无效');
          count(raw.annotationVersion, '标注版本', Number.MAX_SAFE_INTEGER);
          return { ...pick(raw, ['frameId', 'reason', 'annotationState', 'annotationVersion']), assetId: actual.assetId };
        }
        if (!['applied', 'protected', 'blocked', 'unchanged', 'conflict', 'removed'].includes(raw.status as string)) invalid('生成帧结果状态无效');
        bool(raw, 'requiresReview');
        return { ...pick(raw, ['frameId', 'assetId', 'status', 'contributionId', 'candidateVersion', 'requiresReview']), ...issues(raw.reasons, index, env) };
      });
      return { generation: generationSummary(source.generation), results: { generationId: source.generation.id, section,
        ...pagination(result.total, offset, limit, items.length), items } };
    } },
  { name: 'preview_track_generation', description: '只读预览已有轨迹的插值计划，默认 affected。返回 planHash 和两版本供生成复核；异常区间仍需人工检查，不创建候选。',
    parameters: schema(generationArgs), mutation: false,
    async execute(args, env) {
      fields(args, Object.keys(generationArgs)); const payload = previewArgs(args), source = await getTrack(env, payload.trackId);
      checkVersions(source, payload); const index = await allFrames(env, source.timeline, true);
      const result = await preview(env, payload, index), latest = await getTrack(env, payload.trackId);
      checkVersions(latest, payload); sameTimeline(source.timeline, latest.timeline);
      return { trackId: source.track.id, timelineId: source.timeline.id, baseVersion: source.track.version, timelineVersion: source.timeline.version, scope: payload.scope, ...result };
    } },
  { name: 'generate_track_candidates', description: '凭预览 planHash 和 track/timeline 两版本提交候选生成。默认 affected，提交前检查完整时间轴素材范围和最新计划。返回实际后台状态，候选未人工确认；不消耗标注 API 请求，对话预算独立。',
    parameters: schema({ ...generationArgs, expectedPlanHash: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-fA-F0-9]{64}$' } }), mutation: true,
    async execute(args, env) {
      fields(args, [...Object.keys(generationArgs), 'expectedPlanHash']); const payload = previewArgs(args), expectedPlanHash = planHash(args.expectedPlanHash);
      const source = await getTrack(env, payload.trackId); checkVersions(source, payload);
      const index = await allFrames(env, source.timeline, true), latest = await getTrack(env, payload.trackId);
      checkVersions(latest, payload); sameTimeline(source.timeline, latest.timeline);
      const plan = await preview(env, payload, index);
      if (plan.planHash !== expectedPlanHash) conflict();
      if (!plan.canGenerate) throw new AgentError('TRACK_GENERATION_BLOCKED', '当前轨迹计划不能生成，请先处理预览中的阻断项');
      const result = generation(await request(env, 'track.generate', { ...payload, expectedPlanHash }), source.track, source.timeline);
      if (result.trackVersion !== payload.baseVersion || result.timelineVersion !== payload.timelineVersion || result.scope !== payload.scope) invalid('提交返回的固定版本或范围不一致');
      return { submitted: true, generation: generationSummary(result) };
    } },
  { name: 'cancel_track_generation', description: '取消当前项目中实际可取消的轨迹生成任务。不可取消时返回当前状态；cancelling 表示仍在停止，不宣称候选已回滚或任务已结束。',
    parameters: schema({ generationId: identifier }), mutation: true,
    async execute(args, env) {
      fields(args, ['generationId']); const source = await getGeneration(env, id(args.generationId));
      if (!source.generation.canCancel) return { submitted: false, generation: generationSummary(source.generation) };
      if (scope(env)) await allFrames(env, source.timeline, true);
      const result = generation(await request(env, 'track.generation.cancel', { generationId: source.generation.id }), source.track, source.timeline);
      if (result.id !== source.generation.id || result.trackVersion !== source.generation.trackVersion || result.timelineVersion !== source.generation.timelineVersion) invalid('取消返回了其他生成任务或固定版本');
      return { submitted: true, generation: generationSummary(result) };
    } },
];
