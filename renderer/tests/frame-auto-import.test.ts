import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaJob } from '../../shared/media';
import { AUTO_IMPORT_MAX_ATTEMPTS, autoImportExhausted, importableVideoJobs, registerAutoImportFailure } from '../src/frameAutoImport';

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

test('瞬时导入失败在达到上限前仍会重试，不拉黑也不静默', () => {
  const attempts = new Map<string, number>();
  for (let i = 1; i < AUTO_IMPORT_MAX_ATTEMPTS; i++) {
    assert.equal(registerAutoImportFailure(attempts, 'job-1'), false, `第 ${i} 次失败不该判定为需人工处理`);
    assert.equal(autoImportExhausted(attempts, 'job-1'), false);
  }
});

test('连续失败达到上限后判定为需人工处理，不再自动重试', () => {
  const attempts = new Map<string, number>();
  let exhausted = false;
  for (let i = 0; i < AUTO_IMPORT_MAX_ATTEMPTS; i++) exhausted = registerAutoImportFailure(attempts, 'job-1');
  assert.equal(exhausted, true, `连续失败 ${AUTO_IMPORT_MAX_ATTEMPTS} 次才判定为需人工处理`);
  assert.equal(autoImportExhausted(attempts, 'job-1'), true);
  assert.equal(autoImportExhausted(attempts, 'job-2'), false, '失败计数按条目隔离，不牵连其他任务');
});

test('成功一次即清零，后续失败从零重新计数', () => {
  const attempts = new Map<string, number>();
  registerAutoImportFailure(attempts, 'job-1');
  attempts.delete('job-1');
  assert.equal(autoImportExhausted(attempts, 'job-1'), false);
  assert.equal(registerAutoImportFailure(attempts, 'job-1'), false, '成功后的新失败应按第一次计');
});
