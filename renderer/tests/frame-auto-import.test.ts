import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaJob } from '../../shared/media';
import { importableVideoJobs } from '../src/frameAutoImport';

function videoJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: 'job-1', projectId: 'project', kind: 'video_extract', status: 'completed', stage: 'ready',
    sequence: 1, createdAt: '', updatedAt: '', canCancel: false, canRetry: false,
    artifactCommitted: true, assetsCommitted: false, canImport: true,
    progress: { phase: 'ready', completed: 1, total: 1 },
    parameters: { mode: 'scene' },
    ...overrides,
  } as MediaJob;
}

test('完成的抽帧任务且产物就绪未入库时判定为可自动导入', () => {
  const jobs = importableVideoJobs([videoJob()]);
  assert.equal(jobs.length, 1);
});

test('已入库、未完成、产物未封存、不可导入或筛选任务都不自动导入', () => {
  const jobs = importableVideoJobs([
    videoJob({ id: 'imported', assetsCommitted: true, canImport: false }),
    videoJob({ id: 'running', status: 'running', stage: 'extracting', canImport: false }),
    videoJob({ id: 'failed', status: 'failed', artifactCommitted: false, canImport: false }),
    videoJob({ id: 'no-artifact', artifactCommitted: false, canImport: false }),
    videoJob({ id: 'screening', kind: 'image_screening', canImport: false, parameters: {} }),
  ]);
  assert.deepEqual(jobs.map(job => job.id), []);
});

test('失败后重试完成的任务重新变为可导入', () => {
  const jobs = importableVideoJobs([videoJob({ id: 'retry', originalJobId: 'job-1' })]);
  assert.deepEqual(jobs.map(job => job.id), ['retry']);
});
