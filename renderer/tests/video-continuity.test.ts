import assert from 'node:assert/strict';
import test from 'node:test';
import type { Asset } from '../../shared/protocol';
import { inspectVideoContinuity } from '../src/videoContinuity';

function asset(id: string, timeSeconds: number, bbox?: { x: number; y: number; width: number; height: number }, resultState: Asset['resultState'] = bbox ? 'candidate' : 'empty'): Asset {
  return {
    id, projectId: 'project', name: `${id}.jpg`, width: 1000, height: 1000, contentHash: id,
    status: 'candidate', resultState,
    annotations: bbox ? [{ id: `annotation-${id}`, classId: 'figurine', type: 'detect', bbox }] : [],
    version: 1, source: 'api', metadata: { groupId: 'source-video', timeSeconds, frameId: id },
  };
}

test('相邻视频候选稳定时不增加连续性提示', () => {
  const issues = inspectVideoContinuity([
    asset('frame-2', 1, { x: 210, y: 200, width: 100, height: 120 }),
    asset('frame-1', 0, { x: 200, y: 200, width: 100, height: 120 }),
  ]);
  assert.deepEqual(issues, []);
});

test('标出中心跳变、框尺度骤变和贴边候选', () => {
  const issues = inspectVideoContinuity([
    asset('frame-1', 0, { x: 400, y: 400, width: 100, height: 100 }),
    asset('frame-2', 1, { x: 940, y: 450, width: 50, height: 40 }),
  ]);
  assert.deepEqual(new Set(issues.map(issue => issue.code)), new Set(['center_jump', 'box_scale', 'near_edge']));
});

test('中心位移按目标框尺寸归一化，避免手持镜头的小幅移动触发提示', () => {
  const issues = inspectVideoContinuity([
    asset('frame-1', 0, { x: 200, y: 200, width: 100, height: 120 }),
    asset('frame-2', 1, { x: 280, y: 200, width: 100, height: 120 }),
  ]);
  assert.deepEqual(issues, []);
});

test('中心跨越约一个目标框对角线时提示复核', () => {
  const issues = inspectVideoContinuity([
    asset('frame-1', 0, { x: 200, y: 200, width: 100, height: 120 }),
    asset('frame-2', 1, { x: 370, y: 200, width: 100, height: 120 }),
  ]);
  assert.deepEqual(issues.map(issue => issue.code), ['center_jump']);
});

test('前后帧都有同类候选时提示中间空帧复核', () => {
  const issues = inspectVideoContinuity([
    asset('frame-3', 2, { x: 220, y: 200, width: 100, height: 120 }),
    asset('frame-2', 1),
    asset('frame-1', 0, { x: 200, y: 200, width: 100, height: 120 }),
  ]);
  assert.deepEqual(issues.map(issue => issue.code), ['candidate_gap']);
  assert.equal(issues[0].assetId, 'frame-2');
});

test('框面积相近但宽高比例突变时单独提示', () => {
  const issues = inspectVideoContinuity([
    asset('frame-1', 0, { x: 440, y: 475, width: 120, height: 50 }),
    asset('frame-2', 1, { x: 475, y: 440, width: 50, height: 120 }),
  ]);
  assert.deepEqual(issues.map(issue => issue.code), ['aspect_change']);
});
