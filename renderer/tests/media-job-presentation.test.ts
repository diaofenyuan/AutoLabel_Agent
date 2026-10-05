import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaJob } from '../../shared/media';
import { assetImportTally, mediaJobName, mediaJobRowNote, mediaJobStageText } from '../src/mediaJobPresentation';

function job(value: Record<string, unknown>): MediaJob {
  return { id: 'job-1', projectId: 'project', status: 'completed', stage: 'done', sequence: 1, createdAt: '', updatedAt: '',
    canCancel: false, canRetry: false, artifactCommitted: false, assetsCommitted: false, canImport: false,
    progress: { phase: 'done', completed: 1, total: 1 }, ...value } as unknown as MediaJob;
}
const importJob = (value: Record<string, unknown> = {}) => job({ kind: 'asset_import', parameters: { mode: 'copy', total: 1001 }, ...value });
const videoJob = (value: Record<string, unknown> = {}) => job({ kind: 'video_extract', stage: 'ready', parameters: { mode: 'fps', targetFps: 1, ranges: [] }, ...value });

test('三种媒体任务各有自己的名称，批量导入不再冒充筛选分析', () => {
  assert.equal(mediaJobName(videoJob({ sourceName: '视频.mp4' })), '视频.mp4');
  assert.equal(mediaJobName(videoJob()), '视频抽帧');
  assert.equal(mediaJobName(importJob()), '批量导入素材');
  assert.equal(mediaJobName(job({ kind: 'image_screening', parameters: {} })), '素材筛选分析');
});

test('列表副标题：抽帧讲导入状态，批量导入讲真实结果，筛选不加戏', () => {
  assert.equal(mediaJobRowNote(videoJob({ canImport: true })), '待导入');
  assert.equal(mediaJobRowNote(videoJob({ canImport: true, status: 'interrupted' })), '导入中断，待续传');
  assert.equal(mediaJobRowNote(videoJob({ assetsCommitted: true })), '已入库');
  assert.equal(mediaJobRowNote(videoJob({ stage: 'extracting', status: 'running' })), '尚未入库');
  assert.equal(mediaJobRowNote(importJob({ summary: { imported: 1000, skipped: 0, errorsTotal: 0, total: 1001 } })), '已导入 1000 张');
  assert.equal(mediaJobRowNote(job({ kind: 'image_screening', parameters: {} })), '');
});

test('批量导入结果优先取引擎摘要，在途退回进度，零值不啰嗦', () => {
  assert.equal(assetImportTally(importJob({ summary: { imported: 1000, skipped: 3, errorsTotal: 1, total: 1004 } })),
    '已导入 1000 张 · 已在项目 3 张 · 失败 1 张');
  assert.equal(assetImportTally(importJob({ status: 'running', stage: 'importing', progress: { phase: 'importing', completed: 200, total: 1001, skipped: 2, errors: 1 } })),
    '已处理 200/1001 · 跳过 2 · 失败 1');
  assert.equal(assetImportTally(importJob({ status: 'queued', stage: 'queued', progress: { phase: 'queued', completed: 0, total: null } })), '正在准备导入');
  // 中断的批量导入已入库的部分保留，必须如实说明，不能让用户以为全白导了。
  const partial = assetImportTally(importJob({ status: 'interrupted', summary: { imported: 400, skipped: 0, errorsTotal: 2, total: 1001, partial: true } }));
  assert.equal(partial, '已导入 400 张 · 失败 2 张 · 中断前已入库的部分保留');
  assert.equal(assetImportTally(videoJob()), null);
});

test('批量导入的终态不再拼「正在导入素材」，其余类型维持阶段 · 状态', () => {
  // 引擎重启把在途导入中断成 interrupted，stage 会停在 importing：终态必须以状态为准。
  assert.equal(mediaJobStageText(importJob({ status: 'interrupted', stage: 'importing' })), '执行中断');
  assert.equal(mediaJobStageText(importJob({ status: 'completed', stage: 'done' })), '已完成');
  assert.equal(mediaJobStageText(importJob({ status: 'running', stage: 'importing' })), '正在导入素材 · 处理中');
  assert.equal(mediaJobStageText(videoJob({ status: 'completed' })), '抽帧就绪，待导入 · 已完成');
  assert.equal(mediaJobStageText(job({ kind: 'image_screening', status: 'completed', stage: 'done', parameters: {} })), '处理结束 · 已完成');
});