import assert from 'node:assert/strict';
import test from 'node:test';
import type { VideoInspection } from '../../shared/media';
import { VIDEO_DOWNSAMPLE_LONG_EDGE, VIDEO_DOWNSAMPLE_THRESHOLD, VIDEO_MAX_FRAMES, VIDEO_MAX_RANGE_SECONDS } from '../../shared/media';
import { batchExtractionPlan, batchFailures, batchOutcome, remainingBatchItems, retryWhileMediaBusy } from '../src/videoBatchPlan';

function inspection(overrides: Partial<VideoInspection> = {}): VideoInspection {
  return {
    sourceName: 'clip.avi', sourceVideoId: 'video-1', sourceHash: 'a'.repeat(64), streamIndex: 0,
    width: 1920, height: 1080, durationSeconds: 60, reportedFrameRate: '30/1', reportedFrameCount: 1800,
    timeBase: { numerator: 1, denominator: 90000 }, sampleAspectRatioAssumed: false, geometryNotice: null,
    ...overrides,
  };
}

test('默认参数：固定每秒一帧、整段时长、PNG，不超阈值不缩放', () => {
  const plan = batchExtractionPlan(inspection({ width: 1280, height: 720 }));
  assert.ok(!('error' in plan));
  assert.deepEqual(plan.parameters, {
    ranges: [{ start: 0, end: 60 }], streamIndex: 0, format: 'png',
    mode: 'interval', intervalSeconds: 1,
  });
  assert.equal(plan.note, undefined);
});

test('超高清视频按单个面板同一规则默认降采样', () => {
  const plan = batchExtractionPlan(inspection({ width: 3840, height: 2160 }));
  assert.ok(!('error' in plan));
  const scale = VIDEO_DOWNSAMPLE_LONG_EDGE / 3840;
  assert.deepEqual(plan.parameters.outputSize, { width: Math.round(3840 * scale), height: Math.round(2160 * scale), fit: 'contain' });
  assert.match(plan.note ?? '', new RegExp(`长边 ${VIDEO_DOWNSAMPLE_LONG_EDGE}`));
});

test('分辨率没超阈值时不缩放', () => {
  const plan = batchExtractionPlan(inspection({ width: VIDEO_DOWNSAMPLE_THRESHOLD, height: 1080 }));
  assert.ok(!('error' in plan) && plan.parameters.outputSize === undefined);
});

test('时长未知时拒绝按默认参数抽帧，提示走单个面板', () => {
  const plan = batchExtractionPlan(inspection({ durationSeconds: null }));
  assert.ok('error' in plan);
  assert.match(plan.error, /时长未知/);
});

test('超长视频退到按间隔采样并留出帧数余量', () => {
  const duration = VIDEO_MAX_FRAMES * 2; // 场景候选 20000 个，超上限
  const plan = batchExtractionPlan(inspection({ durationSeconds: duration }));
  assert.ok(!('error' in plan));
  assert.equal(plan.parameters.mode, 'interval');
  if (plan.parameters.mode === 'interval') {
    assert.equal(plan.parameters.intervalSeconds, Math.ceil(duration / (VIDEO_MAX_FRAMES - 1)));
    assert.ok(plan.parameters.intervalSeconds * VIDEO_MAX_FRAMES >= duration, '按上限帧数折算要能覆盖整段时长');
  }
  assert.match(plan.note ?? '', /每 \d+ 秒一帧/);
});

test('默认每秒一帧超出上限时自动放宽间隔', () => {
  const plan = batchExtractionPlan(inspection({ durationSeconds: VIDEO_MAX_FRAMES + 1 }));
  assert.ok(!('error' in plan) && plan.parameters.mode === 'interval');
  if (plan.parameters.mode === 'interval') assert.equal(plan.parameters.intervalSeconds, 2);
});

test('超过引擎时间段上限时提前阻止批量提交', () => {
  const duration = VIDEO_MAX_RANGE_SECONDS + 2;
  const plan = batchExtractionPlan(inspection({ durationSeconds: duration }));
  assert.ok('error' in plan);
  if ('error' in plan) assert.match(plan.error, /超过引擎允许的单段范围/);
});

test('批量自定义按源帧间隔传递参数', () => {
  const plan = batchExtractionPlan(inspection(), { density: 'custom', customMode: 'every_n', customValue: 30 });
  assert.ok(!('error' in plan));
  assert.equal(plan.parameters.mode, 'every_n');
  if (plan.parameters.mode === 'every_n') assert.equal(plan.parameters.everyNFrames, 30);
});

test('批量自定义按秒间隔与目标帧率传递参数', () => {
  const interval = batchExtractionPlan(inspection(), { density: 'custom', customMode: 'interval', customValue: 2.5 });
  const fps = batchExtractionPlan(inspection(), { density: 'custom', customMode: 'fps', customValue: 5 });
  assert.ok(!('error' in interval) && interval.parameters.mode === 'interval');
  assert.ok(!('error' in fps) && fps.parameters.mode === 'fps');
  if (interval.parameters.mode === 'interval') assert.equal(interval.parameters.intervalSeconds, 2.5);
  if (fps.parameters.mode === 'fps') assert.equal(fps.parameters.targetFps, 5);
});

test('批量自定义抽样超过单视频帧数上限时返回明确错误', () => {
  const plan = batchExtractionPlan(inspection({ durationSeconds: VIDEO_MAX_FRAMES + 1 }), {
    density: 'custom', customMode: 'interval', customValue: 1,
  });
  assert.ok('error' in plan);
  if ('error' in plan) assert.match(plan.error, /超过.*10000.*帧/);
});

test('批量探测遇到媒体任务占用后等待并自动重试', async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await retryWhileMediaBusy(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('媒体资源正在使用'), { code: 'media_busy' });
    return inspection();
  }, { shouldStop: () => false, wait: async ms => { waits.push(ms); } });
  assert.deepEqual(result, inspection());
  assert.equal(calls, 2);
  assert.deepEqual(waits, [750]);
});

test('批量探测的真实错误直接返回，不进入媒体占用重试', async () => {
  let calls = 0;
  const decodeError = Object.assign(new Error('视频解码失败'), { code: 'video_decode_failed' });
  await assert.rejects(retryWhileMediaBusy(async () => {
    calls++;
    throw decodeError;
  }, { shouldStop: () => false, wait: async () => {} }), error => error === decodeError);
  assert.equal(calls, 1);
});

test('用户停止时结束媒体占用等待，不再发起探测', async () => {
  let stopped = false;
  let calls = 0;
  const result = await retryWhileMediaBusy(async () => {
    calls++;
    throw Object.assign(new Error('媒体资源正在使用'), { code: 'media_busy' });
  }, { shouldStop: () => stopped, wait: async () => { stopped = true; } });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test('再次开始时跳过已排队的视频，失败与待处理的仍会重试', () => {
  const items = [
    { path: 'C:/clips/a.mp4', state: { kind: 'queued' } },
    { path: 'C:/clips/b.mp4', state: { kind: 'failed' } },
    { path: 'C:/clips/c.mp4', state: { kind: 'pending' } },
  ];
  assert.deepEqual(remainingBatchItems(items).map(item => item.path), ['C:/clips/b.mp4', 'C:/clips/c.mp4']);
  // 全部排完队后没有可发起的条目：面板只剩「关闭」，不会再建第二个任务。
  assert.deepEqual(remainingBatchItems(items.map(item => ({ ...item, state: { kind: 'queued' } }))), []);
});

test('批量条目按排队/失败/待处理统计，失败明细与未完成清单可带出面板续跑', () => {
  const items = [
    { path: 'C:/clips/a.mp4', name: 'a.mp4', state: { kind: 'queued' } },
    { path: 'C:/clips/b.mp4', name: 'b.mp4', state: { kind: 'failed', error: '视频时长未知，无法按默认参数抽帧。' } },
    { path: 'C:/clips/c.mp4', name: 'c.mp4', state: { kind: 'failed' } },
    { path: 'C:/clips/d.mp4', name: 'd.mp4', state: { kind: 'pending' } },
    { path: 'C:/clips/e.mp4', name: 'e.mp4', state: { kind: 'working', label: '正在检查…' } },
  ];
  assert.deepEqual(batchOutcome(items), { queued: 1, failed: 2, pending: 2 });
  assert.deepEqual(batchFailures(items), [
    { path: 'C:/clips/b.mp4', name: 'b.mp4', error: '视频时长未知，无法按默认参数抽帧。' },
    // 接口没给原因时如实说未知：既要能提示，也不能编造一条原因。
    { path: 'C:/clips/c.mp4', name: 'c.mp4', error: '未返回失败原因' },
  ]);
  // 未完成清单 = 失败 + 待处理 + 处理中，正是调用方重开面板时该带上的那批文件。
  assert.deepEqual(remainingBatchItems(items).map(item => item.path), ['C:/clips/b.mp4', 'C:/clips/c.mp4', 'C:/clips/d.mp4', 'C:/clips/e.mp4']);
  assert.deepEqual(batchOutcome([]), { queued: 0, failed: 0, pending: 0 });
  assert.deepEqual(batchFailures([]), []);
});
