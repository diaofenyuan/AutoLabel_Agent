import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MEDIA_TOOL_DEFINITIONS } from '../media-tools.ts';
import type { ToolEnvironment } from '../tools.ts';
import type { AgentContext, EngineClient } from '../types.ts';

type RecordValue = Record<string, unknown>;
const tool = (name: string) => MEDIA_TOOL_DEFINITIONS.find(value => value.name === name)!;
function video(id = 'video-job'): RecordValue {
  return { id, projectId: 'project', kind: 'video_extract', status: 'completed', stage: 'ready', sequence: 3,
    createdAt: '2026-09-10T10:00:00Z', updatedAt: '2026-09-10T10:00:01Z', canCancel: false, canRetry: false,
    artifactCommitted: true, assetsCommitted: false, canImport: true, sourceVideoId: 'source-video', sourceName: '视频.mp4',
    progress: { phase: 'ready', completed: 2, total: 2, outputBytes: 123, path: 'D:/private/progress' },
    parameters: { mode: 'fps', targetFps: 2, ranges: [{ start: 0, end: 1, raw: '内部原文' }], maxFrames: 10000, sourcePath: 'D:/private/source.mp4' },
    summary: { frameCount: 2, importedAssets: 0, manifestPath: 'D:/private/frames.jsonl', frames: ['内部原文'] },
    error: { code: 'previous_issue', message: 'D:/private/source.mp4: 内部原文' }, sourcePath: 'D:/private/source.mp4' };
}
function frame(index: number): RecordValue {
  return { frameId: `frame-${String(index).padStart(8, '0')}`, sourceVideoId: 'source-video', sourcePts: String(-90071992547409910n + BigInt(index)),
    originPts: '-90071992547409910', relativePts: String(index), sourcePresentationIndex: index, timeBase: { numerator: 1, denominator: 30 },
    timeSeconds: index / 30, width: 100, height: 80, bytes: 60, contentHash: 'same-static-image', sourceHash: 'private-hash',
    rangeIndex: 0, bucketIndex: index, selectionVersion: 'bucket-v1', imagePath: 'D:/private/frame.png', raw: '内部原文' };
}
function summary(): RecordValue {
  return { status: 'incomplete', inputCount: 3, distinctContentCount: 3, identityMerge: false, changesApplied: false,
    nearCheck: { status: 'incomplete', scope: 'distinct_content_groups', totalContentPairs: 3, comparedContentPairs: 1,
      hammingComparisons: 1, aspectIncompatibleContentPairs: 0, unexaminedContentPairs: 2, unexaminedIdentityPairUpperBound: 2,
      stopReason: 'comparison_budget', reportedPairs: 1, path: 'D:/private/cache' },
    partitionCheck: { status: 'incomplete', unassignedInputs: 2 }, unexaminedBlurAssetIds: ['a'], raw: '内部原文' };
}
function screened(assetId: string): RecordValue {
  return { assetId, protected: false, recommendation: 'review_suggested', input: { assetId, sourceVideoId: 'source-video',
    sourcePts: '90071992547409911', timeSeconds: 0.5, inputPath: 'D:/private/source', metadata: { groupId: 'group', path: 'D:/private/source' } },
    feature: { featureVersion: 'feature-v1', analysisWidth: 256, analysisHeight: 128, laplacianVariance: 2, contentHash: 'private-hash', dHash64: 'private-fingerprint' },
    reasons: [{ code: 'blur_candidate', score: 2, threshold: 10, analysisWidth: 256, analysisHeight: 128, requiresReview: true, path: 'D:/private/reason' }] };
}
function fixture(context: AgentContext = {}) {
  const calls: Array<{ command: string; payload: RecordValue }> = [], abort = new AbortController();
  const state = { jobs: [video()], frames: [frame(0), frame(1)], rows: [screened('a')], summary: summary(),
    failure: '', wrongPage: false, pageEmpty: false, assetProject: 'project', abortAfterAsset: false,
    screening: { ...video('screening-job'), kind: 'image_screening', stage: 'done', canImport: false, parameters: { blurEnabled: true, blurThreshold: 10 } } as RecordValue };
  const engine: EngineClient = { async request<T>(command: string, payload: RecordValue = {}) {
    calls.push({ command, payload: structuredClone(payload) });
    if (state.failure === command) throw Object.assign(new Error('内部命令缺失'), { code: 'unknown_command' });
    if (command === 'media.job.list') return { total: state.jobs.length, items: state.jobs.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)) } as T;
    if (command === 'media.job.get') return structuredClone(payload.jobId === 'screening-job' ? state.screening : state.jobs[0]) as T;
    if (command === 'media.video.frames') return { total: state.frames.length, items: state.pageEmpty ? [] : state.frames.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)) } as T;
    if (command === 'media.screening.result') return { jobId: state.wrongPage ? 'other-job' : payload.jobId, section: payload.section, offset: payload.offset,
      limit: payload.limit, total: state.rows.length, items: state.rows.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)),
      parameters: state.screening.parameters, summary: state.summary } as T;
    if (command === 'asset.get') { if (state.abortAfterAsset) abort.abort(); return { id: payload.assetId, projectId: state.assetProject } as T; }
    if (command === 'media.screening.create') return { ...state.screening, status: 'queued', stage: 'queued', artifactCommitted: false,
      canCancel: true, parameters: payload.parameters, progress: { phase: 'queued', completed: 0, total: null } } as T;
    // 抽帧创建返回与真实引擎同形状的 job 摘要，并回显提交的参数以便核对纯函数式的参数构建。
    if (command === 'media.video.create') return { ...state.jobs[0], projectId: payload.projectId, status: 'queued', stage: 'queued',
      artifactCommitted: false, assetsCommitted: false, canCancel: true, canImport: false, parameters: payload.parameters,
      progress: { phase: 'queued', completed: 0, total: null } } as T;
    throw new Error(`非授权命令：${command}`);
  } };
  const environment: ToolEnvironment = { engine, context, projectId: 'project', signal: abort.signal, openAsset() {} };
  return { state, calls, abort, environment };
}
function noPrivate(value: unknown) {
  const encoded = JSON.stringify(value); for (const marker of ['D:/private', '内部原文', 'private-hash', 'private-fingerprint']) assert.equal(encoded.includes(marker), false);
}

test('媒体列表真实分页和产物/入库标记分离，路径与错误原文不进入摘要', async () => {
  const f = fixture(); f.state.jobs = Array.from({ length: 101 }, (_, i) => video(`job-${i}`));
  const first = await tool('list_media_jobs').execute({}, f.environment) as RecordValue;
  assert.deepEqual(f.calls[0].payload, { projectId: 'project', offset: 0, limit: 100 }); assert.equal(first.nextOffset, 100);
  const entry = (first.items as RecordValue[])[0]; assert.equal(entry.status, 'completed'); assert.equal(entry.stage, 'ready');
  assert.equal(entry.artifactCommitted, true); assert.equal(entry.assetsCommitted, false); assert.deepEqual(entry.error, { code: 'previous_issue' });
  const last = await tool('list_media_jobs').execute({ offset: 100 }, f.environment) as RecordValue;
  assert.equal((last.items as RecordValue[])[0].id, 'job-100'); assert.equal(last.nextOffset, null); noPrivate([first, last]);
  for (const args of [{ limit: 101 }, { offset: -1 }, { offset: 0.5 }, { kind: 'video' }, { projectId: 'outside' }, { sourcePath: 'D:/private/video' }])
    await assert.rejects(tool('list_media_jobs').execute(args, f.environment));
  f.state.jobs[1] = f.state.jobs[0]; await assert.rejects(tool('list_media_jobs').execute({}, f.environment), /分页重复/);
});

test('媒体任务核项目和真实身份，旧引擎或取消明确失败，不回退为成功', async () => {
  const f = fixture();
  f.state.jobs[0].projectId = 'outside'; await assert.rejects(tool('get_media_job').execute({ jobId: 'video-job' }, f.environment), /不属于当前项目/);
  f.state.jobs[0].projectId = 'project'; await assert.rejects(tool('get_media_job').execute({ jobId: 'wrong' }, f.environment), /标识不一致/);
  f.state.failure = 'media.job.get'; await assert.rejects(tool('get_media_job').execute({ jobId: 'video-job' }, f.environment), { code: 'MEDIA_CAPABILITY_REQUIRED' });
  f.state.failure = ''; f.abort.abort(); await assert.rejects(tool('get_media_job').execute({ jobId: 'video-job' }, f.environment), { code: 'AGENT_CANCELLED' });
  assert.equal(f.calls.some(call => /configure|resolve|authorize|probe|create/.test(call.command)), false);
});

test('视频帧保留有符号大 PTS 和相同画面的不同时间身份，未入库帧无素材身份', async () => {
  const f = fixture();
  const result = await tool('get_video_frames').execute({ jobId: 'video-job', limit: 1 }, f.environment) as RecordValue;
  const row = (result.items as RecordValue[])[0]; assert.equal(row.sourcePts, '-90071992547409910'); assert.equal(row.assetId, undefined); assert.equal(result.nextOffset, 1);
  const next = await tool('get_video_frames').execute({ jobId: 'video-job', offset: 1, limit: 500 }, f.environment) as RecordValue;
  assert.notEqual((next.items as RecordValue[])[0].frameId, row.frameId); assert.notEqual((next.items as RecordValue[])[0].sourcePts, row.sourcePts); noPrivate([result, next]);
  f.state.jobs[0].artifactCommitted = false; await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment), { code: 'MEDIA_ARTIFACT_REQUIRED' });
  f.state.jobs[0].artifactCommitted = true; f.state.jobs[0].status = 'cancelled'; await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment));
  f.state.jobs[0].status = 'completed'; f.state.frames[0].sourcePts = 1; await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment), /PTS/);
});

test('视频分页拒绝重复/空洞/错源，限定素材范围不能读取未入库或范围外帧', async () => {
  const f = fixture({ assetIds: ['a'] });
  await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment), /尚未入库|超出/);
  f.state.frames = [{ ...frame(0), assetId: 'a' }]; await tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment);
  f.state.frames.push({ ...frame(1), assetId: 'b' }); await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment), /超出/);
  f.state.frames = [{ ...frame(0), assetId: 'a' }, { ...frame(0), assetId: 'a' }]; await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment), /分页重复/);
  f.state.frames = [{ ...frame(0), assetId: 'a', sourceVideoId: 'other' }]; await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment), /来源/);
  f.state.pageEmpty = true; await assert.rejects(tool('get_video_frames').execute({ jobId: 'video-job' }, f.environment), /分页响应/);
});

test('筛选建议保留实际覆盖和分析尺寸，近重复仅候选，组成员输出有界', async () => {
  const f = fixture();
  const result = await tool('get_screening_result').execute({ jobId: 'screening-job' }, f.environment) as RecordValue;
  assert.equal((result.summary as RecordValue).status, 'incomplete'); assert.equal(((result.summary as RecordValue).nearCheck as RecordValue).unexaminedContentPairs, 2);
  assert.equal((result.summary as RecordValue).unexaminedBlurCount, 1); assert.equal((result.summary as RecordValue).unexaminedBlurAssetIds, undefined);
  assert.equal(((result.items as RecordValue[])[0].feature as RecordValue).analysisWidth, 256); noPrivate(result);
  f.state.rows = [{ leftAssetId: 'a', rightAssetId: 'b', distance: 0, threshold: 6, action: 'candidate_only', requiresReview: true,
    crossPartition: true, inputPath: 'D:/private/image', raw: '内部原文' }];
  const near = await tool('get_screening_result').execute({ jobId: 'screening-job', section: 'nearPairs' }, f.environment) as RecordValue;
  assert.equal((near.items as RecordValue[])[0].action, 'candidate_only'); assert.equal((near.items as RecordValue[])[0].recommendation, undefined);
  f.state.rows[0].action = 'exclude'; await assert.rejects(tool('get_screening_result').execute({ jobId: 'screening-job', section: 'nearPairs' }, f.environment), /待复核候选/);
  f.state.rows = [{ representativeAssetId: 'asset-0', members: Array.from({ length: 10000 }, (_, i) => `asset-${i}`), partitions: ['train', 'val'], crossPartition: true }];
  const group = await tool('get_screening_result').execute({ jobId: 'screening-job', section: 'exactGroups' }, f.environment) as RecordValue;
  const row = (group.items as RecordValue[])[0]; assert.equal(row.memberCount, 10000); assert.equal((row.memberSample as unknown[]).length, 20); assert.equal(row.members, undefined); assert.equal(row.membersTruncated, true);
  noPrivate([near, group]); assert.equal(f.calls.some(call => /create|save|delete|import/.test(call.command)), false);
});

test('筛选读取拒绝串页、错误项目、范围外成员及不完整结果', async () => {
  const f = fixture({ assetIds: ['a'] }); f.state.wrongPage = true;
  await assert.rejects(tool('get_screening_result').execute({ jobId: 'screening-job' }, f.environment), /身份或分页/);
  f.state.wrongPage = false; f.state.rows = [screened('outside')]; await assert.rejects(tool('get_screening_result').execute({ jobId: 'screening-job' }, f.environment), /选择范围外/);
  f.state.rows = [screened('a'), screened('a')]; await assert.rejects(tool('get_screening_result').execute({ jobId: 'screening-job' }, f.environment), /重复项/);
  f.state.screening.artifactCommitted = false; await assert.rejects(tool('get_screening_result').execute({ jobId: 'screening-job' }, f.environment), { code: 'MEDIA_ARTIFACT_REQUIRED' });
  f.state.screening.artifactCommitted = true; f.state.failure = 'media.screening.result';
  await assert.rejects(tool('get_screening_result').execute({ jobId: 'screening-job' }, f.environment), { code: 'MEDIA_CAPABILITY_REQUIRED' });
});

test('筛选预览实际排后台任务，明确范围且不需要 API 预算或自动排除', async () => {
  const f = fixture({ assetIds: ['a', 'b'], maxRequests: null });
  const parameters = { deduplicate: true, nearEnabled: true, blurEnabled: true, blurThreshold: 0,
    nearMaxDistance: 64, aspectRatioTolerance: 1, maxComparisons: 0, maxPairs: 0 };
  const result = await tool('preview_image_screening').execute({ assetIds: ['a', 'b'], parameters }, f.environment) as RecordValue;
  assert.equal(result.submitted, true); assert.equal((result.job as RecordValue).status, 'queued'); assert.equal((result.job as RecordValue).artifactCommitted, false); assert.equal(result.items, undefined);
  assert.deepEqual(f.calls.at(-1), { command: 'media.screening.create', payload: { projectId: 'project', assetIds: ['a', 'b'], parameters } });
  assert.equal(f.calls.some(call => /provider|run.create|annotation|delete|import/.test(call.command)), false); noPrivate(result);
  for (const args of [{ assetIds: [], parameters: {} }, { assetIds: ['a', 'a'], parameters: {} }, { assetIds: ['outside'], parameters: {} },
    { assetIds: ['a'], parameters: {}, sourcePath: 'D:/private/source' }]) await assert.rejects(tool('preview_image_screening').execute(args, f.environment));
  f.state.assetProject = 'outside'; await assert.rejects(tool('preview_image_screening').execute({ assetIds: ['a'], parameters: {} }, f.environment), /不属于当前项目/);
  f.state.assetProject = 'project'; f.state.abortAfterAsset = true;
  await assert.rejects(tool('preview_image_screening').execute({ assetIds: ['a'], parameters: {} }, f.environment), { code: 'AGENT_CANCELLED' });
  assert.equal(f.calls.filter(call => call.command === 'media.screening.create').length, 1);
});

test('筛选阈值和 native 工具 schema 严格，不开放配置路径或隐式执行工具', async () => {
  const f = fixture();
  for (const parameters of [{ deduplicate: 'true' }, { nearEnabled: 1 }, { blurEnabled: true }, { nearMaxDistance: 65 }, { nearMaxDistance: 0.1 },
    { aspectRatioTolerance: -0.1 }, { aspectRatioTolerance: Infinity }, { blurThreshold: NaN }, { maxPairs: 20001 },
    { maxComparisons: 2000001 }, { maxComparisons: '1' }, { excludeAssetIds: ['a'] }, { inputPath: 'D:/private/input' }])
    await assert.rejects(tool('preview_image_screening').execute({ assetIds: ['a'], parameters }, f.environment));
  function strict(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const raw = value as RecordValue;
    if (raw.type === 'object') { assert.equal(raw.additionalProperties, false); assert.deepEqual(raw.required, Object.keys(raw.properties as RecordValue)); }
    for (const child of Object.values(raw)) if (Array.isArray(child)) child.forEach(strict); else strict(child);
  }
  MEDIA_TOOL_DEFINITIONS.forEach(value => strict(value.parameters));
  // create_video_job 是写操作但只消费用户已授权路径：授权本身仍由桌面文件选择器产生，
  // 因此它出现在写入工具集合中是预期的，判定依据见 desktop/security.test.ts 的授权用例。
  assert.deepEqual(MEDIA_TOOL_DEFINITIONS.filter(value => value.mutation).map(value => value.name), ['create_video_job', 'preview_image_screening']);
  assert.equal(f.calls.length, 0);
});

test('抽帧任务只提交已授权路径与单一模式，参数范围在提交前校验', async () => {
  const f = fixture();
  // 三种模式各自只带上自己的参数，不把无关字段混进 payload。
  for (const [args, expected] of [[{ sourcePath: 'C:\\chosen.mp4', mode: 'interval', intervalSeconds: 1.5 }, { mode: 'interval', intervalSeconds: 1.5 }],
    [{ sourcePath: 'C:\\chosen.mp4', mode: 'every_n', everyNFrames: 30 }, { mode: 'every_n', everyNFrames: 30 }],
    [{ sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 2 }, { mode: 'fps', targetFps: 2 }]] as const) {
    f.calls.length = 0;
    const created = await tool('create_video_job').execute(args, f.environment) as RecordValue;
    assert.equal(created.submitted, true);
    assert.equal(f.calls[0].command, 'media.video.create');
    assert.deepEqual(f.calls[0].payload, { projectId: 'project', sourcePath: args.sourcePath, parameters: expected });
  }
  // 时间段必须有序、不重叠，且与其余输出选项一起透传。
  f.calls.length = 0;
  await tool('create_video_job').execute({ sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1,
    ranges: [{ start: 0, end: 2 }, { start: 2, end: 4 }], format: 'jpg', jpegQuality: 3, maxFrames: 50 }, f.environment);
  assert.deepEqual(f.calls[0].payload.parameters, { mode: 'fps', targetFps: 1, ranges: [{ start: 0, end: 2 }, { start: 2, end: 4 }],
    format: 'jpg', jpegQuality: 3, maxFrames: 50 });
  for (const args of [{ sourcePath: 'C:\\chosen.mp4', mode: 'interval' }, { sourcePath: 'C:\\chosen.mp4', mode: 'mix', intervalSeconds: 1 },
    { sourcePath: 'C:\\chosen.mp4', mode: 'every_n', everyNFrames: 0 }, { sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: Number.POSITIVE_INFINITY },
    { sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1, ranges: [{ start: 2, end: 1 }] },
    { sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1, ranges: [{ start: 0, end: 3 }, { start: 2, end: 4 }] },
    { sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1, format: 'webp' },
    { sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1, maxFrames: 0 },
    { sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1, jpegQuality: 1 },
    { sourcePath: '', mode: 'fps', targetFps: 1 }, { sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1, outputPath: 'C:\\out' }])
    await assert.rejects(tool('create_video_job').execute(args, f.environment), /整数|不支持的参数|INVALID_ARGUMENT|超出允许范围|不能为空|时间段|抽帧模式|输出格式/, JSON.stringify(args));
  // 引擎返回非抽帧任务时必须失败，不能把筛选任务当抽帧成功上报。
  f.state.jobs[0].kind = 'image_screening';
  await assert.rejects(tool('create_video_job').execute({ sourcePath: 'C:\\chosen.mp4', mode: 'fps', targetFps: 1 }, f.environment), /没有返回视频抽帧任务/);
});
