import assert from 'node:assert/strict';
import test from 'node:test';
import type { VideoInspection } from '../../shared/media';
import { VIDEO_DOWNSAMPLE_LONG_EDGE, VIDEO_DOWNSAMPLE_THRESHOLD, VIDEO_MAX_FRAMES, VIDEO_SCENE_MIN_INTERVAL_SECONDS, VIDEO_SCENE_THRESHOLD } from '../../shared/media';
import { batchExtractionPlan } from '../src/videoBatchPlan';

function inspection(overrides: Partial<VideoInspection> = {}): VideoInspection {
  return {
    sourceName: 'clip.avi', sourceVideoId: 'video-1', sourceHash: 'a'.repeat(64), streamIndex: 0,
    width: 1920, height: 1080, durationSeconds: 60, reportedFrameRate: '30/1', reportedFrameCount: 1800,
    timeBase: { numerator: 1, denominator: 90000 }, sampleAspectRatioAssumed: false, geometryNotice: null,
    ...overrides,
  };
}

test('默认参数：场景变化采样、整段时长、PNG，不超阈值不缩放', () => {
  const plan = batchExtractionPlan(inspection({ width: 1280, height: 720 }));
  assert.ok(!('error' in plan));
  assert.deepEqual(plan.parameters, {
    ranges: [{ start: 0, end: 60 }], streamIndex: 0, format: 'png',
    mode: 'scene', sceneThreshold: VIDEO_SCENE_THRESHOLD, minIntervalSeconds: VIDEO_SCENE_MIN_INTERVAL_SECONDS,
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

test('时长正好在上限内时仍用场景模式', () => {
  const plan = batchExtractionPlan(inspection({ durationSeconds: VIDEO_MAX_FRAMES * VIDEO_SCENE_MIN_INTERVAL_SECONDS }));
  assert.ok(!('error' in plan) && plan.parameters.mode === 'scene');
});
