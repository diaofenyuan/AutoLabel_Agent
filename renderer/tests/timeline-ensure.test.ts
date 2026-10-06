import assert from 'node:assert/strict';
import test from 'node:test';
import type { TrackTimeline, TrackTimelineEnsureResult } from '../../shared/tracks';
import { ensuredTimelineId, ensureNotice } from '../src/timelineEnsure';

function timeline(id: string, mediaJobId: string): TrackTimeline {
  return { id, projectId: 'project', mediaJobId, sourceVideoId: 'video', name: '视频轨迹时间轴', version: 1,
    taskType: 'detect', templateHash: 'a'.repeat(64), frameCount: 3, width: 96, height: 72,
    createdAt: '', updatedAt: '', sequence: 1 };
}

function result(overrides: Partial<TrackTimelineEnsureResult> = {}): TrackTimelineEnsureResult {
  return { projectId: 'project', taskType: 'detect', supported: true, created: [], existing: [], skipped: [], truncated: false, ...overrides };
}

test('为抽帧任务取时间轴标识：本轮新建优先，其次已存在，取不到为空串', () => {
  const both = result({ created: [timeline('new', 'job')], existing: [timeline('old', 'job')] });
  assert.equal(ensuredTimelineId(both, 'job'), 'new', '新建与已存在同时命中时以新建为准');
  assert.equal(ensuredTimelineId(result({ existing: [timeline('old', 'job')] }), 'job'), 'old', '只有已存在时回落到它');
  assert.equal(ensuredTimelineId(both, 'other'), '', '没有对应任务时返回空串，界面据此不展示入口');
});

test('补建提示只在有内容时才产出：说清新建数量、失败原因与截断', () => {
  assert.equal(ensureNotice(result()), '', '无缺口、无失败、无截断时不打扰用户');
  assert.equal(ensureNotice(result({ created: [timeline('a', 'job1'), timeline('b', 'job2')] })), '已为 2 个已入库抽帧任务补建视频时间轴');
  assert.equal(ensureNotice(result({ created: [timeline('a', 'job1')], existing: [timeline('b', 'job2')] })), '已为 1 个已入库抽帧任务补建视频时间轴', '已存在的任务不重复计数');
});

test('补建失败与截断如实上报，给出原因而不是静默', () => {
  assert.equal(ensureNotice(result({ skipped: [{ mediaJobId: 'job', reason: 'track_task_type_unsupported', message: '当前项目为「segment」任务，不支持视频轨迹时间轴。' }] })),
    '1 个已入库抽帧任务无法建立时间轴：当前项目为「segment」任务，不支持视频轨迹时间轴。');
  const skipped = ensureNotice(result({ skipped: [{ mediaJobId: 'a', reason: 'x', message: '原因甲' }, { mediaJobId: 'b', reason: 'y', message: '原因乙' }] }));
  assert.match(skipped, /2 个已入库抽帧任务无法建立时间轴/, '多条失败给出总数');
  assert.match(skipped, /原因甲/, '沿用首条原因作为代表，避免一次刷屏');
  assert.equal(ensureNotice(result({ truncated: true })), '超出单轮上限的缺口会在下一轮继续补建');
});