import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TRACK_TOOL_DEFINITIONS } from '../track-tools.ts';
import type { ToolEnvironment } from '../tools.ts';
import type { AgentContext, EngineClient } from '../types.ts';

type Row = Record<string, unknown>;
const tool = (name: string) => TRACK_TOOL_DEFINITIONS.find(value => value.name === name)!;
const thresholds = { maxGapSeconds: 2, maxCenterSpeedPixelsPerSecond: 500, maxKeypointSpeedPixelsPerSecond: 500, maxScaleFactor: 2 };
const expectedPlanHash = 'a'.repeat(64);
const generateArgs = { trackId: 'track', baseVersion: 3, timelineVersion: 2, expectedPlanHash };
function timeline(): Row {
  return { id: 'timeline', projectId: 'project', mediaJobId: 'video-job', sourceVideoId: 'video', name: '视频时间轴', version: 2,
    taskType: 'detect', templateHash: 'private-hash', template: { prompt: '内部原文' }, frameCount: 3, width: 100, height: 80,
    createdAt: '2026-09-10T10:00:00Z', updatedAt: '2026-09-10T10:00:01Z', sequence: 2, path: 'D:/private/video' };
}
function track(): Row {
  return { id: 'track', timelineId: 'timeline', sourceVideoId: 'video', objectId: 'object', classId: '0', name: '车辆', version: 3,
    status: 'active', templateHash: 'private-hash', keyframeCount: 2, needsRecompute: true, pendingFrameCount: 1,
    createdAt: '2026-09-10T10:00:00Z', updatedAt: '2026-09-10T10:00:01Z', sequence: 3 };
}
function frame(index: number): Row {
  return { frameId: `frame-${index}`, assetId: `asset-${index}`, sourceFrameId: `source-frame-${index}`, sourcePresentationIndex: index,
    sourcePts: String(-90071992547409910n + BigInt(index)), originPts: '-90071992547409910', relativePts: String(index),
    timeBase: { numerator: 1, denominator: 30 }, timeSeconds: index / 30, rangeIndex: 0, sceneId: 'scene', contentHash: 'private-hash',
    width: 100, height: 80, inputVersion: 1, annotationVersion: 2, annotationState: index === 0 ? 'confirmed' : 'candidate',
    draftSavedAt: null, protected: index === 0, path: 'D:/private/frame.png', raw: '内部原文' };
}
function keyframe(index: number): Row {
  const source = frame(index);
  return { keyframeId: `key-${index}`, frameId: source.frameId, objectId: 'object', assetId: source.assetId, state: 'located',
    sourcePts: source.sourcePts, timeSeconds: source.timeSeconds, annotation: { type: 'detect', classId: '0', x: 1, raw: '内部原文' } };
}
function interval(): Row {
  return { intervalId: 'interval', leftKeyframeId: 'key-0', rightKeyframeId: 'key-2', leftFrameId: 'frame-0', rightFrameId: 'frame-2',
    leftKeyframeHash: 'private-hash', rightKeyframeHash: 'private-hash', startTime: { numerator: '0', denominator: '1' },
    endTime: { numerator: '1', denominator: '15' }, blocked: false, requiresReview: true,
    reviewIssues: [{ code: 'rapid_center_motion', severity: 'warning', metricValue: 700, threshold: 500, path: 'D:/private/raw', message: '内部原文' }],
    metrics: { centerSpeedPixelsPerSecond: 700, raw: '内部原文' }, thresholds, scenePolicy: 'input_supplied_scene_ids', trackingPerformed: false,
    candidateCount: 1, protectedFrameCount: 1 };
}
function generation(): Row {
  return { id: 'generation', trackId: 'track', timelineId: 'timeline', trackVersion: 3, timelineVersion: 2, status: 'running', sequence: 4,
    createdAt: '2026-09-10T10:00:00Z', updatedAt: '2026-09-10T10:00:01Z', canCancel: true, parameters: thresholds, scope: 'affected',
    progress: { phase: 'generating', completed: 1, total: 3, applied: 0, protected: 1, conflicts: 0, failed: 0, raw: '内部原文' },
    summary: { protected: 1, blocked: 1, requiresReview: true, raw: '内部原文', frames: ['内部原文'] },
    error: { code: 'previous_issue', message: 'D:/private/error 内部原文' }, candidateOnly: true, humanConfirmed: false, requestsUsed: 0 };
}
function fixture(context: AgentContext = {}) {
  const calls: Array<{ command: string; payload: Row }> = [], abort = new AbortController();
  const state = { timeline: timeline(), track: track(), generation: generation(), frames: [frame(0), frame(1), frame(2)], keys: [keyframe(0), keyframe(2)],
    rows: [{ frameId: 'frame-1', assetId: 'asset-1', status: 'blocked', requiresReview: true, annotations: [{ raw: '内部原文' }],
      reasons: [{ code: 'scene_boundary', severity: 'error', frameId: 'frame-1', message: '内部原文', path: 'D:/private/reason' }] }] as Row[],
    timelines: undefined as Row[] | undefined, tracks: undefined as Row[] | undefined, generations: undefined as Row[] | undefined,
    mainTrack: undefined as Row | undefined, mainTimeline: undefined as Row | undefined,
    previous: keyframe(0) as Row | null, next: keyframe(2) as Row | null, fail: '', wrongPage: false, emptyOffset: -1, duplicateSecondPage: false,
    preview: { canGenerate: true, issues: [], issueCount: 0, planHash: expectedPlanHash, frameCount: 3, affectedCount: 1, protectedCount: 1,
      intervals: [interval()], intervalsTotal: 1, intervalsTruncated: false, parameters: thresholds } as Row,
    before: undefined as ((command: string, payload: Row) => void) | undefined, afterSubmitAbort: false };
  function paged(rows: Row[], payload: Row) {
    const offset = payload.offset as number, limit = payload.limit as number;
    return { total: rows.length, items: rows.slice(offset, offset + limit) };
  }
  const engine: EngineClient = { async request<T>(command: string, payload: Row = {}) {
    calls.push({ command, payload: structuredClone(payload) }); state.before?.(command, payload);
    if (state.fail === command) throw Object.assign(new Error('命令未实现'), { code: 'unknown_command' });
    let result: unknown;
    switch (command) {
      case 'track.timeline.list': result = paged(state.timelines ?? [state.timeline], payload); break;
      case 'track.timeline.get': result = state.mainTimeline?.id === payload.timelineId ? state.mainTimeline : state.timeline; break;
      case 'track.timeline.frames': {
        const rows = state.duplicateSecondPage && (payload.offset as number) >= 500 ? [state.frames[0]] : state.frames.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number));
        result = { total: state.frames.length, items: state.emptyOffset === payload.offset ? [] : rows }; break;
      }
      case 'track.list': result = paged(state.tracks ?? [state.track], payload); break;
      case 'track.get': result = state.mainTrack?.id === payload.trackId ? state.mainTrack : state.track; break;
      case 'track.keyframe.list': result = { ...paged(state.keys, payload), previous: state.previous, next: state.next }; break;
      case 'track.generation.list': result = paged(state.generations ?? [state.generation], payload); break;
      case 'track.generation.get': result = state.generation; break;
      case 'track.generation.results': result = { generationId: state.wrongPage ? 'other' : payload.generationId, section: payload.section,
        offset: payload.offset, limit: payload.limit, ...paged(state.rows, payload) }; break;
      case 'track.generate.preview': result = state.preview; break;
      case 'track.generate': result = { ...state.generation, status: 'queued', parameters: { ...thresholds, ...payload.parameters as Row }, scope: payload.scope,
        progress: { phase: 'queued', completed: 0, total: state.frames.length, applied: 0, protected: 0, conflicts: 0, failed: 0 } };
        if (state.afterSubmitAbort) abort.abort(); break;
      case 'track.generation.cancel': result = { ...state.generation, status: 'cancelling', canCancel: false }; if (state.afterSubmitAbort) abort.abort(); break;
      default: throw new Error(`非授权命令：${command}`);
    }
    return structuredClone(result) as T;
  } };
  const environment: ToolEnvironment = { engine, projectId: 'project', context, signal: abort.signal, openAsset() {} };
  return { state, calls, abort, environment };
}
function noPrivate(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const marker of ['private-hash', 'D:/private', '内部原文', 'annotation"', 'annotations"', 'template"']) assert.equal(encoded.includes(marker), false, marker);
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(value => ['track.generate', 'track.generation.cancel'].includes(value.command));

test('九项 native schema 严格，只有生成与取消开放写入且没有几何或路径参数', () => {
  assert.equal(TRACK_TOOL_DEFINITIONS.length, 9);
  assert.deepEqual(TRACK_TOOL_DEFINITIONS.filter(value => value.mutation).map(value => value.name), ['generate_track_candidates', 'cancel_track_generation']);
  function strict(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const raw = value as Row, types = Array.isArray(raw.type) ? raw.type : [raw.type];
    if (types.includes('object')) { assert.equal(raw.additionalProperties, false); assert.deepEqual(raw.required, Object.keys(raw.properties as Row)); }
    Object.values(raw).forEach(value => Array.isArray(value) ? value.forEach(strict) : strict(value));
  }
  for (const value of TRACK_TOOL_DEFINITIONS) { strict(value.parameters); assert.doesNotMatch(JSON.stringify(value.parameters), /annotation|imagePath|sourcePath|keyframes|geometry/); }
});

test('时间轴和轨迹列表真实分页，严格项目与归属，摘要不包含模板或路径', async () => {
  const f = fixture(); f.state.timelines = Array.from({ length: 101 }, (_, i) => ({ ...timeline(), id: `timeline-${i}` }));
  const first = await tool('list_video_timelines').execute({}, f.environment) as Row;
  assert.equal(first.nextOffset, 100); assert.deepEqual(f.calls[0].payload, { projectId: 'project', offset: 0, limit: 100 });
  const last = await tool('list_video_timelines').execute({ offset: 100 }, f.environment) as Row;
  assert.equal(last.nextOffset, null); assert.equal((last.items as Row[])[0].id, 'timeline-100');
  const tracks = await tool('list_video_tracks').execute({ timelineId: 'timeline' }, f.environment) as Row; noPrivate([first, last, tracks]);
  f.state.track.timelineId = 'outside'; await assert.rejects(tool('list_video_tracks').execute({ timelineId: 'timeline' }, f.environment), /不属于/);
  f.state.track.timelineId = 'timeline'; f.state.timeline.projectId = 'outside';
  await assert.rejects(tool('get_video_track').execute({ trackId: 'track' }, f.environment), { code: 'PROJECT_SCOPE' });
  f.state.timeline.projectId = 'project'; f.state.timelines[1].projectId = 'outside';
  await assert.rejects(tool('list_video_timelines').execute({}, f.environment), { code: 'PROJECT_SCOPE' });
});

test('分页帧保留大 PTS、人工保护和真实身份，并逐帧检查所选素材', async () => {
  const f = fixture({ assetIds: ['asset-0'] });
  const first = await tool('get_video_timeline').execute({ timelineId: 'timeline', limit: 1 }, f.environment) as Row;
  const page = first.frames as Row, row = (page.items as Row[])[0];
  assert.equal(page.nextOffset, 1); assert.equal(row.sourcePts, '-90071992547409910'); assert.equal(row.protected, true); assert.equal(row.annotationState, 'confirmed'); noPrivate(first);
  await assert.rejects(tool('get_video_timeline').execute({ timelineId: 'timeline', offset: 1, limit: 1 }, f.environment), { code: 'ASSET_SCOPE' });
  f.state.frames[0].sourcePts = 1; await assert.rejects(tool('get_video_timeline').execute({ timelineId: 'timeline', limit: 1 }, f.environment), /PTS/);
  f.state.frames[0] = frame(0); f.state.frames[1] = frame(0);
  await assert.rejects(tool('get_video_timeline').execute({ timelineId: 'timeline' }, f.environment), /重复身份/);
});

test('关键帧分页与前后导航不返回几何，检查对象、素材、时间和邻居范围', async () => {
  const f = fixture({ assetIds: ['asset-0', 'asset-1', 'asset-2'] });
  const result = await tool('get_video_track').execute({ trackId: 'track', aroundFrameId: 'frame-1', limit: 1 }, f.environment) as Row;
  const keys = result.keyframes as Row; assert.equal(keys.nextOffset, 1); assert.equal((keys.previous as Row).keyframeId, 'key-0'); assert.equal((keys.next as Row).keyframeId, 'key-2'); noPrivate(result);
  f.state.next = { ...keyframe(2), objectId: 'outside' }; await assert.rejects(tool('get_video_track').execute({ trackId: 'track' }, f.environment), /对象/);
  f.state.next = { ...keyframe(2), assetId: 'outside' }; await assert.rejects(tool('get_video_track').execute({ trackId: 'track' }, f.environment), /不属于/);
  f.state.next = keyframe(0); await assert.rejects(tool('get_video_track').execute({ trackId: 'track', aroundFrameId: 'frame-1' }, f.environment), /方向/);
  f.state.next = keyframe(2); f.environment.context.assetIds = ['asset-0', 'asset-1'];
  await assert.rejects(tool('get_video_track').execute({ trackId: 'track', aroundFrameId: 'frame-1', limit: 1 }, f.environment), { code: 'ASSET_SCOPE' });
});

test('生成历史保留实际进度和未人工确认，逐项验证轨迹与结果身份', async () => {
  const f = fixture({ assetIds: ['asset-1'] });
  const history = await tool('list_track_generations').execute({ trackId: 'track' }, f.environment) as Row;
  const item = (history.items as Row[])[0]; assert.equal(item.status, 'running'); assert.equal(item.requestsUsed, 0); assert.equal(item.humanConfirmed, false);
  assert.equal((item.progress as Row).protected, 1);
  const detail = await tool('get_track_generation').execute({ generationId: 'generation' }, f.environment) as Row;
  const row = ((detail.results as Row).items as Row[])[0]; assert.equal(row.status, 'blocked'); assert.equal(row.requiresReview, true); assert.equal((row.issues as Row[])[0].code, 'scene_boundary'); noPrivate([history, detail]);
  f.state.wrongPage = true; await assert.rejects(tool('get_track_generation').execute({ generationId: 'generation' }, f.environment), /身份或分页/);
  f.state.wrongPage = false; f.state.rows[0].assetId = 'asset-0'; await assert.rejects(tool('get_track_generation').execute({ generationId: 'generation' }, f.environment), /不属于/);
  f.state.generation.timelineId = 'outside'; await assert.rejects(tool('list_track_generations').execute({ trackId: 'track' }, f.environment), /不属于/);
  f.state.generation.timelineId = 'timeline'; f.state.generation.humanConfirmed = true;
  await assert.rejects(tool('get_track_generation').execute({ generationId: 'generation' }, f.environment), /候选/);
  f.state.generation.humanConfirmed = false; f.state.mainTrack = { ...track(), id: 'main-track' };
  f.state.generations = [{ ...generation(), trackId: 'main-track', involvedTrackIds: ['main-track', 'track'], originalGenerationId: 'original-generation' }];
  const involved = await tool('list_track_generations').execute({ trackId: 'track' }, f.environment) as Row;
  assert.equal((involved.items as Row[])[0].trackId, 'main-track'); assert.equal((involved.items as Row[])[0].involvedTrackCount, 2); noPrivate(involved);
  f.state.generations[0].involvedTrackIds = ['track'];
  await tool('list_track_generations').execute({ trackId: 'track' }, f.environment);
  f.state.mainTimeline = { ...timeline(), id: 'outside' }; f.state.mainTrack.timelineId = 'outside';
  await assert.rejects(tool('list_track_generations').execute({ trackId: 'track' }, f.environment), /不属于/);
  f.state.mainTrack.timelineId = 'timeline'; f.state.generations[0].involvedTrackIds = ['main-track'];
  await assert.rejects(tool('list_track_generations').execute({ trackId: 'track' }, f.environment), /未关联/);
});

test('intervals/skipped 分页核帧归属，区间内部范围不能被两端掩盖', async () => {
  const f = fixture(); f.state.rows = [interval()];
  const result = await tool('get_track_generation').execute({ generationId: 'generation', section: 'intervals', limit: 500 }, f.environment) as Row;
  const row = ((result.results as Row).items as Row[])[0]; assert.equal(row.requiresReview, true); assert.equal(row.trackingPerformed, false); assert.deepEqual(row.endTime, { numerator: '1', denominator: '15' }); noPrivate(result);
  f.environment.context.assetIds = ['asset-0', 'asset-2'];
  await assert.rejects(tool('get_track_generation').execute({ generationId: 'generation', section: 'intervals' }, f.environment), { code: 'ASSET_SCOPE' });
  f.environment.context.assetIds = ['asset-0']; f.state.rows = [{ frameId: 'frame-0', reason: 'manual_protected', message: 'D:/private/source', annotationState: 'confirmed', annotationVersion: 2 }];
  const skipped = await tool('get_track_generation').execute({ generationId: 'generation', section: 'skipped' }, f.environment) as Row;
  assert.equal(((skipped.results as Row).items as Row[])[0].assetId, 'asset-0'); noPrivate(skipped);
  f.state.rows[0].frameId = 'outside'; await assert.rejects(tool('get_track_generation').execute({ generationId: 'generation', section: 'skipped' }, f.environment), /不属于/);
});

test('只读预览携带计划和两版本，生成返回真实 queued 且不创建人工确认或预算请求', async () => {
  const f = fixture({ maxRequests: null });
  const preview = await tool('preview_track_generation').execute({ trackId: 'track', baseVersion: 3, timelineVersion: 2 }, f.environment) as Row;
  assert.equal(preview.planHash, expectedPlanHash); assert.equal(preview.baseVersion, 3); assert.equal(preview.timelineVersion, 2); assert.equal(preview.scope, 'affected'); assert.equal(writes(f).length, 0); noPrivate(preview);
  f.state.frames = Array.from({ length: 701 }, (_, i) => frame(i)); f.state.timeline.frameCount = 701; f.state.track.keyframeCount = 701;
  f.state.preview.frameCount = 701; f.state.preview.intervalsTotal = 700; f.state.preview.intervalsTruncated = true;
  f.state.preview.intervals = Array.from({ length: 500 }, (_, i) => ({ ...interval(), intervalId: `interval-${i}`, leftKeyframeId: `key-${i}`,
    rightKeyframeId: `key-${i + 1}`, leftFrameId: `frame-${i}`, rightFrameId: `frame-${i + 1}` }));
  f.state.preview.issues = Array.from({ length: 100 }, () => ({ code: 'scene_unchecked', severity: 'warning' })); f.state.preview.issueCount = 130;
  const truncated = await tool('preview_track_generation').execute({ trackId: 'track', baseVersion: 3, timelineVersion: 2 }, f.environment) as Row;
  assert.equal(truncated.intervalsTotal, 700); assert.equal(truncated.intervalsTruncated, true); assert.equal((truncated.intervals as Row[]).length, 20);
  assert.equal(truncated.issueCount, 130); assert.equal(truncated.issuesTruncated, true); assert.equal((truncated.issues as Row[]).length, 20);
  f.state.afterSubmitAbort = true;
  const result = await tool('generate_track_candidates').execute(generateArgs, f.environment) as Row;
  assert.equal(result.submitted, true); const created = result.generation as Row;
  assert.equal(created.status, 'queued'); assert.equal(created.candidateOnly, true); assert.equal(created.humanConfirmed, false); assert.equal((created.progress as Row).completed, 0);
  assert.deepEqual(writes(f), [{ command: 'track.generate', payload: { ...generateArgs, parameters: {}, scope: 'affected' } }]);
  assert.equal(f.calls.some(call => /budget|provider|annotation.save|keyframe.save|timeline.create/.test(call.command)), false); noPrivate(result);
});

test('生成前完整遍历超过一页的时间轴，范围外尾帧与空选择都阻止提交', async () => {
  const f = fixture({ assetIds: Array.from({ length: 500 }, (_, i) => `asset-${i}`) });
  f.state.frames = Array.from({ length: 501 }, (_, i) => frame(i)); f.state.timeline.frameCount = 501;
  await assert.rejects(tool('generate_track_candidates').execute(generateArgs, f.environment), { code: 'ASSET_SCOPE' });
  assert.deepEqual(f.calls.filter(call => call.command === 'track.timeline.frames').map(call => call.payload.offset), [0, 500]); assert.equal(writes(f).length, 0);
  f.environment.context.assetIds!.push('asset-500'); f.state.preview.frameCount = 501;
  const submitted = await tool('generate_track_candidates').execute(generateArgs, f.environment) as Row; assert.equal(submitted.submitted, true);
  const empty = fixture({ assetIds: [] }); await assert.rejects(tool('generate_track_candidates').execute(generateArgs, empty.environment), { code: 'ASSET_SCOPE' }); assert.equal(writes(empty).length, 0);
});

test('完整范围扫描拒绝截断、重复页、超限和读取时版本变化', async () => {
  for (const failure of ['empty', 'duplicate', 'changed', 'oversize']) {
    const f = fixture(); f.state.frames = Array.from({ length: 501 }, (_, i) => frame(i)); f.state.timeline.frameCount = 501;
    if (failure === 'empty') f.state.emptyOffset = 500;
    if (failure === 'duplicate') f.state.duplicateSecondPage = true;
    if (failure === 'oversize') f.state.timeline.frameCount = 10001;
    if (failure === 'changed') f.state.before = command => { if (command === 'track.timeline.frames') f.state.timeline.version = 4; };
    await assert.rejects(tool('generate_track_candidates').execute(generateArgs, f.environment)); assert.equal(writes(f).length, 0, failure);
  }
});

test('缺预览、旧 planHash、轨迹/时间轴版本冲突或阻断不能提交', async () => {
  for (const args of [{ ...generateArgs, expectedPlanHash: undefined }, { ...generateArgs, expectedPlanHash: 'b'.repeat(64) },
    { ...generateArgs, baseVersion: 2 }, { ...generateArgs, timelineVersion: 1 }]) {
    const f = fixture(); await assert.rejects(tool('generate_track_candidates').execute(args, f.environment)); assert.equal(writes(f).length, 0);
  }
  const changed = fixture(); let trackReads = 0;
  changed.state.before = command => { if (command === 'track.get' && ++trackReads === 2) changed.state.track.version = 4; };
  await assert.rejects(tool('generate_track_candidates').execute(generateArgs, changed.environment), { code: 'TRACK_VERSION_CONFLICT' }); assert.equal(writes(changed).length, 0);
  const blocked = fixture(); blocked.state.preview.canGenerate = false;
  await assert.rejects(tool('generate_track_candidates').execute(generateArgs, blocked.environment), { code: 'TRACK_GENERATION_BLOCKED' }); assert.equal(writes(blocked).length, 0);
});

test('实际取消保留 cancelling，不可取消只返回当前状态，不把停止聊天当取消已提交任务', async () => {
  const f = fixture(); f.state.afterSubmitAbort = true;
  const result = await tool('cancel_track_generation').execute({ generationId: 'generation' }, f.environment) as Row;
  assert.equal(result.submitted, true); assert.equal((result.generation as Row).status, 'cancelling'); assert.equal((result.generation as Row).canCancel, false); noPrivate(result);
  const completed = fixture(); completed.state.generation.status = 'completed'; completed.state.generation.canCancel = false;
  const unchanged = await tool('cancel_track_generation').execute({ generationId: 'generation' }, completed.environment) as Row;
  assert.equal(unchanged.submitted, false); assert.equal((unchanged.generation as Row).status, 'completed'); assert.equal(writes(completed).length, 0);
  const scoped = fixture({ assetIds: ['asset-1'] }); await assert.rejects(tool('cancel_track_generation').execute({ generationId: 'generation' }, scoped.environment), { code: 'ASSET_SCOPE' }); assert.equal(writes(scoped).length, 0);
});

test('旧 Engine 能力缺失明确 needs_input，读取或提交中断不伪造成功', async () => {
  for (const command of ['track.timeline.get', 'track.generate.preview', 'track.generate']) {
    const f = fixture(); f.state.fail = command;
    await assert.rejects(tool('generate_track_candidates').execute(generateArgs, f.environment), { code: 'TRACK_CAPABILITY_REQUIRED' });
  }
  const f = fixture(); f.state.before = command => { if (command === 'track.generate.preview') f.abort.abort(); };
  await assert.rejects(tool('generate_track_candidates').execute(generateArgs, f.environment), { code: 'AGENT_CANCELLED' }); assert.equal(writes(f).length, 0);
  const cross = fixture(); cross.state.timeline.projectId = 'other';
  await assert.rejects(tool('cancel_track_generation').execute({ generationId: 'generation' }, cross.environment), { code: 'PROJECT_SCOPE' }); assert.equal(writes(cross).length, 0);
});

test('有限数值、布尔、枚举、分页及未知字段边界不降级或隐式扩大范围', async () => {
  const f = fixture();
  for (const args of [{ ...generateArgs, force: true }, { ...generateArgs, scope: 'everything' }, { ...generateArgs, baseVersion: 1.5 },
    { ...generateArgs, timelineVersion: Number.MAX_SAFE_INTEGER + 1 }, ...[{ maxGapSeconds: 0 }, { maxGapSeconds: '2' },
      { maxCenterSpeedPixelsPerSecond: Infinity }, { maxScaleFactor: 0.9 }, { maxScaleFactor: 1e12 + 1 }, { path: 'D:/private' }].map(parameters => ({ ...generateArgs, parameters }))])
    await assert.rejects(tool('generate_track_candidates').execute(args, f.environment));
  for (const name of ['list_video_timelines', 'list_video_tracks', 'list_track_generations'])
    await assert.rejects(tool(name).execute({ ...(name === 'list_video_tracks' ? { timelineId: 'timeline' } : name === 'list_track_generations' ? { trackId: 'track' } : {}), limit: 101 }, f.environment));
  await assert.rejects(tool('get_video_timeline').execute({ timelineId: 'timeline', limit: 501 }, f.environment));
  await assert.rejects(tool('list_video_tracks').execute({ timelineId: 'timeline', includeArchived: 'true' }, f.environment));
  await assert.rejects(tool('get_track_generation').execute({ generationId: 'generation', section: 'raw' }, f.environment));
  assert.equal(writes(f).length, 0);
});
