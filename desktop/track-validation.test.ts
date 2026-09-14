import test from 'node:test';
import assert from 'node:assert/strict';
import type { TrackCommandMap } from '../shared/tracks';
import { assertAgentCommand, validateCommand } from './validation';
import { SseDecoder } from './sse';

const write = { trackId: 'track', baseVersion: 1, timelineVersion: 1 };
const valid: { [C in keyof TrackCommandMap]: TrackCommandMap[C]['request'] } = {
  'track.timeline.create': { projectId: 'project', mediaJobId: 'media', name: '行人片段' },
  'track.timeline.list': { projectId: 'project', limit: 100 },
  'track.timeline.get': { timelineId: 'timeline' },
  'track.timeline.frames': { timelineId: 'timeline', trackId: 'track', offset: 0, limit: 500 },
  'track.timeline.update': { timelineId: 'timeline', baseVersion: 1, scenes: [{ startFrameId: 'frame1', endFrameId: 'frame2', sceneId: null }] },
  'track.create': { timelineId: 'timeline', timelineVersion: 1, classId: 'person' },
  'track.list': { timelineId: 'timeline', includeArchived: false, limit: 100 },
  'track.get': { trackId: 'track', version: 1 },
  'track.update': { trackId: 'track', baseVersion: 1, name: '主行人' },
  'track.delete': write,
  'track.keyframe.list': { trackId: 'track', aroundFrameId: 'frame1', limit: 500 },
  'track.keyframe.save': { ...write, frameId: 'frame1', state: 'located', baseAnnotationVersion: 0, baseDraftSavedAt: '2026-09-10T00:00:00.123456700Z',
    annotation: { id: 'object', classId: 'person', type: 'detect', bbox: { x: 1, y: 2, width: 3, height: 4 } } },
  'track.keyframe.delete': { ...write, keyframeId: 'keyframe' },
  'track.split': { ...write, splitFrameId: 'frame2', leftName: '进入', rightName: '离开' },
  'track.merge': { leftTrackId: 'left', leftVersion: 1, rightTrackId: 'right', rightVersion: 2, timelineVersion: 1, confirmSameObject: true },
  'track.generate.preview': { ...write, scope: 'affected', parameters: { maxGapSeconds: 2, maxScaleFactor: 1 } },
  'track.generate': { ...write, expectedPlanHash: 'a'.repeat(64) },
  'track.generation.get': { generationId: 'generation' },
  'track.generation.list': { trackId: 'track', limit: 100 },
  'track.generation.results': { generationId: 'generation', section: 'skipped', limit: 500 },
  'track.generation.cancel': { generationId: 'generation' },
  'track.generation.retry': { generationId: 'generation' },
  'track.local.sequence': { timelineId: 'timeline', timelineVersion: 1, modelId: 'model', modelVersion: 1, device: 'cpu', timeoutMs: 120000, classMap: { '0': 'person' }, detector: 'detect', scope: 'affected' },
  'track.local.sequence.get': { candidateId: 'candidate' },
  'track.local.sequence.list': { timelineId: 'timeline', limit: 100 },
  'track.local.sequence.confirm': { candidateId: 'candidate', timelineId: 'timeline', timelineVersion: 1, confirm: true },
  'track.local.sequence.promote': { candidateId: 'candidate', timelineId: 'timeline', timelineVersion: 1, confirm: true },
};

test('轨迹命令闭合到 27 项公共契约，仅开放指定 Agent 命令并拒绝文件路径', () => {
  assert.equal(Object.keys(valid).length, 27);
  const agentAllowed = new Set<string>(['track.timeline.list', 'track.timeline.get', 'track.timeline.frames', 'track.list', 'track.get', 'track.keyframe.list',
    'track.generation.list', 'track.generation.get', 'track.generation.results', 'track.generate.preview', 'track.generate', 'track.generation.cancel',
    'track.local.sequence.get', 'track.local.sequence.list'] satisfies Array<keyof TrackCommandMap>);
  for (const [command, payload] of Object.entries(valid)) {
    assert.doesNotThrow(() => validateCommand(command, payload), command);
    assert.throws(() => validateCommand(command, { ...payload, sourcePath: 'C:\\outside.mp4' }), command);
    if (agentAllowed.has(command)) assert.doesNotThrow(() => assertAgentCommand(command, payload), command);
    else assert.throws(() => assertAgentCommand(command, payload), command);
  }
  assert.throws(() => validateCommand('track.timeline.create', { projectId: 'project', sourceVideoId: 'video', sourcePath: 'C:\\outside.mp4' }));
  assert.throws(() => validateCommand('track.generate', { ...write, parameters: { modelPath: 'C:\\model.pt' } }));
  assert.throws(() => validateCommand('track.generate', { ...write, humanConfirmed: true }));
  assert.throws(() => validateCommand('track.local.sequence', { ...valid['track.local.sequence'], detector: 'segment' }));
  assert.throws(() => validateCommand('track.local.sequence', { ...valid['track.local.sequence'], modelPath: 'C:\\model.pt' }));
  assert.throws(() => validateCommand('track.local.sequence.confirm', { ...valid['track.local.sequence.confirm'], confirm: false }));
  assert.throws(() => validateCommand('track.private.resolve', { trackId: 'track' }));
});

test('关键帧、版本和阈值保留精度与状态边界', () => {
  const key = valid['track.keyframe.save'];
  assert.equal(validateCommand('track.keyframe.save', key).payload.baseDraftSavedAt, key.baseDraftSavedAt);
  assert.doesNotThrow(() => validateCommand('track.keyframe.save', { ...key, state: 'unlocatable', annotation: null, baseDraftSavedAt: null }));
  for (const change of [{ state: 'unlocatable' }, { annotation: null }, { annotation: undefined }, { state: 'hidden' }, { baseAnnotationVersion: -1 }, { baseDraftSavedAt: '' }, { baseDraftSavedAt: 1780000000 }]) {
    assert.throws(() => validateCommand('track.keyframe.save', { ...key, ...change }));
  }
  assert.throws(() => validateCommand('track.keyframe.save', { ...key, annotation: { ...key.annotation, type: 'segment' } }));
  for (const version of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateCommand('track.delete', { ...write, baseVersion: version }));
  for (const version of [0, 2147483648, Number.MAX_SAFE_INTEGER]) assert.doesNotThrow(() => validateCommand('track.delete', { ...write, baseVersion: version }));
  assert.doesNotThrow(() => validateCommand('track.timeline.update', { timelineId: 'timeline', baseVersion: 1, scenes: [{ startFrameId: 'frame1', endFrameId: 'frame2', sceneId: '场景甲' }] }));
  for (const name of [' ', '名'.repeat(201)]) assert.throws(() => validateCommand('track.update', { trackId: 'track', baseVersion: 1, name }));
  assert.throws(() => validateCommand('track.keyframe.save', { ...key, baseDraftSavedAt: 'a'.repeat(101) }));
  for (const parameters of [{ maxGapSeconds: 0 }, { maxCenterSpeedPixelsPerSecond: Infinity }, { maxKeypointSpeedPixelsPerSecond: NaN }, { maxScaleFactor: .99 }, { maxGapSeconds: 1e12 + 1 }]) {
    assert.throws(() => validateCommand('track.generate.preview', { ...write, parameters }));
  }
  for (const expectedPlanHash of ['', 'g'.repeat(64), 'a'.repeat(65)]) assert.throws(() => validateCommand('track.generate', { ...write, expectedPlanHash }));
  for (const command of ['track.timeline.list', 'track.list', 'track.generation.list'] as const) assert.throws(() => validateCommand(command, { ...valid[command], limit: 101 }));
  for (const command of ['track.local.sequence.list'] as const) assert.throws(() => validateCommand(command, { ...valid[command], limit: 101 }));
  for (const command of ['track.timeline.frames', 'track.keyframe.list', 'track.generation.results'] as const) assert.throws(() => validateCommand(command, { ...valid[command], limit: 501 }));
  assert.throws(() => validateCommand('track.merge', { ...valid['track.merge'], rightTrackId: 'left' }));
  assert.throws(() => validateCommand('track.timeline.update', { ...valid['track.timeline.update'], scenes: Array(10001).fill({ startFrameId: 'a', endFrameId: 'b', sceneId: null }) }));
});

test('时间轴支持围绕关键帧定位，拒绝同时指定偏移', () => {
  const payload = { timelineId: 'timeline', trackId: 'track', aroundFrameId: 'frame2', limit: 100 };
  assert.equal(validateCommand('track.timeline.frames', payload).payload.aroundFrameId, 'frame2');
  assert.throws(() => validateCommand('track.timeline.frames', { ...payload, offset: 0 }), /格式不正确/);
});

test('轨迹事件经 SSE 分片解析仍完整保留三种身份与精确 PTS 字符串', () => {
  const event = { sequence: 17, type: 'track.generation.progress', timestamp: '2026-09-10T00:00:00Z', timelineId: 'timeline', trackId: 'track', generationId: 'generation',
    payload: { frameId: 'frame', sourcePts: '9007199254740993123', candidateOnly: true, humanConfirmed: false } };
  const parser = new SseDecoder(), wire = `id: 17\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
  assert.deepEqual(parser.push(wire.slice(0, 65)), []); assert.deepEqual(parser.push(wire.slice(65)), [event]);
});
