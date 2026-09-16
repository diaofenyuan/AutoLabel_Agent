import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TRAINING_TOOL_DEFINITIONS } from '../training-tools.ts';
import type { ToolEnvironment } from '../tools.ts';
import type { EngineClient } from '../types.ts';

type RecordValue = Record<string, unknown>;
const tool = (name: string) => TRAINING_TOOL_DEFINITIONS.find(tool => tool.name === name)!;
const version = { id: 'version-1', projectId: 'project-1', number: 3, name: '第三版', status: 'ready', sourceKind: 'project',
  taskType: 'detect', createdAt: '2026-09-16T00:00:00Z', contentHash: 'hash', manifestHash: 'manifest',
  recipe: { private: '完整配方' }, summary: { images: 12, objects: 30, bytes: 1024, groups: 4 },
  split: { seed: '固定种子', train: 8, val: 2, test: 2 }, files: [{ image: 'D:/private/image.png' }] };
const dataset = { id: 'dataset-1', projectId: 'project-1', origin: 'export', taskType: 'detect', status: 'ready',
  createdAt: '2026-09-16T00:00:00Z', snapshotHash: 'snapshot-hash', bytes: 2048, classes: [{ id: 'item', name: '物品' }], keypointNames: [],
  snapshotDir: 'D:/private/dataset', files: [{ image: 'D:/private/dataset/image.png' }],
  inspection: { issues: [{ severity: 'warning', code: 'empty_labels', message: '有 1 张空标签', file: 'D:/private/image.txt' }],
    summary: { images: 12, objects: 30, emptyLabels: 1, bytes: 2048, classes: 1, keypoints: 0, splits: { train: 8, val: 2, test: 2 }, classCounts: [30], errors: 0, warnings: 1, usable: true } } };
const job = { id: 'job-1', datasetId: 'dataset-1', projectId: 'project-1', taskType: 'detect', status: 'running', stage: 'running',
  device: '0', createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:01:00Z', epochs: 10, completedEpochs: 3, progress: 0.3, progressKnown: true,
  lastMetrics: { boxLoss: 1.5, mAP50: 0.4, private: 9 }, bestMetrics: { mAP50: 0.42 }, bestEpoch: 3,
  artifacts: [{ kind: 'weights', name: 'weights/best.pt', size: 10, hash: 'artifact-hash', path: 'D:/private/best.pt' }],
  artifactsDir: 'D:/private/jobs/job-1', parameters: { epochs: 10 }, print: 'D:/private/log.txt' };
function fixture() {
  const calls: Array<{ command: string; payload: RecordValue }> = [];
  const state = { jobs: [job], datasets: [dataset], versions: [version] };
  const abort = new AbortController();
  const engine: EngineClient = { async request<T>(command: string, payload: RecordValue = {}) {
    calls.push({ command, payload });
    if (command === 'dataset.version.list') return { items: state.versions.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)), total: state.versions.length, offset: payload.offset, limit: payload.limit } as T;
    if (command === 'dataset.version.preflight') return { projectId: 'project-1', taskType: 'detect', annotationScope: payload.annotationScope ?? 'labeled',
      assets: 0, excluded: 7, groups: 0, excludedTotal: 9, blocking: 1, canBuild: false,
      excludedByReason: { form_video_frame: 7, annotation_scope_excluded: 2 },
      inspection: { issues: [{ severity: 'error', code: 'export_empty', message: '没有可导出的素材。', assetId: 'D:/private/asset.png' }] },
      private: 'D:/private/preflight' } as T;
    if (command === 'training.dataset.list') return { items: state.datasets.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)), total: state.datasets.length, offset: payload.offset, limit: payload.limit } as T;
    if (command === 'training.dataset.get') return structuredClone(state.datasets.find(item => item.id === payload.datasetId) ?? {}) as T;
    if (command === 'training.dataset.create') return structuredClone(state.datasets[0]) as T;
    if (command === 'training.job.preflight') return { ok: true, issues: [], estimates: { images: 12, objects: 30, epochs: 10, estimatedPeakBytes: 4096 },
      resolvedParameters: { actualDevice: '0', requestedDevice: 'gpu-auto', snapshotHash: 'snapshot-hash', classNames: ['物品'], path: 'D:/private' } } as T;
    if (command === 'training.job.create') return structuredClone(state.jobs[0]) as T;
    if (command === 'training.job.get') return structuredClone(state.jobs.find(item => item.id === payload.jobId) ?? {}) as T;
    if (command === 'training.job.list') return { items: state.jobs.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)), total: state.jobs.length, offset: payload.offset, limit: payload.limit, concurrency: 1 } as T;
    if (command === 'training.job.metrics') return { items: [{ jobId: 'job-1', epoch: 1, epochs: 10, metrics: { mAP50: 0.1, private: 1 }, elapsedMs: 100, at: '2026-09-16T00:00:30Z' }], total: 1, offset: payload.offset, limit: payload.limit } as T;
    if (command === 'training.job.cancel') return { ...structuredClone(state.jobs[0]), cancelRequested: true } as T;
    if (command === 'local.model.get') return { id: 'model-1', version: 2, kind: 'local_model', taskType: 'detect', format: 'pt', name: '基础权重', modelPath: 'D:/private/model.pt' } as T;
    throw new Error('禁止调用有副作用的训练命令');
  } };
  const environment: ToolEnvironment = { engine, projectId: 'project-1', context: {}, openAsset() {}, signal: abort.signal };
  return { calls, state, abort, environment };
}

test('训练来源只读取当前项目的数据集版本与快照，不返回清单与任何路径', async () => {
  const f = fixture();
  const versions = await tool('list_dataset_versions').execute({}, f.environment) as RecordValue;
  const datasets = await tool('list_training_datasets').execute({}, f.environment) as RecordValue;
  assert.deepEqual(f.calls.map(call => call.payload.projectId), ['project-1', 'project-1']);
  assert.equal((versions.items as RecordValue[])[0].number, 3);
  assert.deepEqual((versions.items as RecordValue[])[0].split, { seed: '固定种子', train: 8, val: 2, test: 2 });
  assert.deepEqual((datasets.items as RecordValue[])[0].summary, { images: 12, objects: 30, emptyLabels: 1, bytes: 2048, classes: 1, keypoints: 0, splits: { train: 8, val: 2, test: 2 }, classCounts: [30], errors: 0, warnings: 1, usable: true });
  assert.equal((datasets.items as RecordValue[])[0].snapshotHash, 'snapshot-hash');
  const text = JSON.stringify([versions, datasets]);
  for (const secret of ['D:/private', '完整配方', 'snapshotDir', 'recipe']) assert.equal(text.includes(secret), false, secret);
  f.state.versions[0] = { ...version, projectId: 'other-project' };
  await assert.rejects(tool('list_dataset_versions').execute({}, f.environment), /不属于当前项目/);
  await assert.rejects(tool('list_training_datasets').execute({ limit: 101 }, f.environment), /不支持的参数|每页数量/);
});

test('数据集预检只读，原因与问题都以中文返回，不带原始码与本地路径', async () => {
  const f = fixture();
  const report = await tool('dataset_preflight').execute({ annotationScope: 'all' }, f.environment) as RecordValue;
  assert.deepEqual(f.calls.at(-1), { command: 'dataset.version.preflight', payload: { projectId: 'project-1', annotationScope: 'all' } });
  assert.equal(report.canBuild, false); assert.equal(report.blocking, 1); assert.equal(report.excluded, 7);
  const text = JSON.stringify(report);
  // 原因码与问题码都必须已经在工具侧翻成中文，否则助手会把它们原样复述给用户。
  assert.equal(/form_video_frame|annotation_scope_excluded|export_empty/.test(text), false, text);
  assert.ok(text.includes('视频抽帧素材'), text);
  assert.ok(text.includes('尚未生成正式标注'), text);
  assert.ok(text.includes('没有可导出的素材。'), text);
  assert.equal(text.includes('D:/private'), false);
  await tool('dataset_preflight').execute({ annotationScope: null }, f.environment);
  assert.deepEqual(f.calls.at(-1)!.payload, { projectId: 'project-1', annotationScope: 'labeled' });
  await assert.rejects(tool('dataset_preflight').execute({ annotationScope: 'everything' }, f.environment), /标注范围/);
  await assert.rejects(tool('dataset_preflight').execute({ annotationScope: 'all', projectId: 'other' }, f.environment), /不支持的参数/);
});

test('训练快照只能由已生成版本建立，提交前先预检且不猜测参数', async () => {
  const f = fixture();
  const created = await tool('create_training_dataset').execute({ versionId: 'version-1', name: '检测数据' }, f.environment) as RecordValue;
  assert.deepEqual(f.calls.at(-1), { command: 'training.dataset.create', payload: { projectId: 'project-1', source: 'version', versionId: 'version-1', name: '检测数据' } });
  assert.equal(created.id, 'dataset-1');
  for (const args of [{ versionId: 'version-1', source: 'upload', trainDir: 'D:/private' }, { versionId: 'version-1', files: [] },
    { versionId: 'version-1', path: 'D:/private' }])
    await assert.rejects(tool('create_training_dataset').execute(args, f.environment), /不支持的参数/);
  const preflight = await tool('preflight_training').execute({ datasetId: 'dataset-1', parameters: { epochs: 10, batch: 'auto' } }, f.environment) as RecordValue;
  assert.deepEqual(f.calls.at(-1), { command: 'training.job.preflight', payload: { datasetId: 'dataset-1', parameters: { epochs: 10, batch: 'auto' } } });
  assert.equal(preflight.ok, true);
  assert.equal(JSON.stringify(preflight).includes('D:/private'), false);
  for (const parameters of [{ epochs: 0 }, { epochs: 10001 }, { imgsz: 33 }, { device: 'cuda:0' }, { optimizer: 'Lion' },
    { momentum: 1.1 }, { learningRate: 2 }, { cosLr: 'true' }, { modelPath: 'D:/private/model.pt' }, { seed: 2147483648 }])
    await assert.rejects(tool('preflight_training').execute({ datasetId: 'dataset-1', parameters }, f.environment));
});

test('训练任务提交、查询与取消按真实状态返回，不把提交当作完成', async () => {
  const f = fixture();
  const started = await tool('start_training').execute({ datasetId: 'dataset-1', parameters: { epochs: 10 } }, f.environment) as RecordValue;
  assert.deepEqual(f.calls.at(-1), { command: 'training.job.create', payload: { datasetId: 'dataset-1', parameters: { epochs: 10 }, confirm: true } });
  assert.equal(started.started, true); assert.equal((started.job as RecordValue).status, 'running');
  assert.equal((started.job as RecordValue).progressKnown, true);
  assert.deepEqual((started.job as RecordValue).artifacts, [{ kind: 'weights', name: 'weights/best.pt', size: 10, hash: 'artifact-hash' }]);
  const detailed = await tool('inspect_training_job').execute({ jobId: 'job-1', metricLimit: 10 }, f.environment) as RecordValue;
  assert.deepEqual((detailed.job as RecordValue).bestMetrics, { mAP50: 0.42 });
  assert.deepEqual(((detailed.metrics as RecordValue).items as RecordValue[])[0], { epoch: 1, epochs: 10, metrics: { mAP50: 0.1 }, elapsedMs: 100, at: '2026-09-16T00:00:30Z' });
  const jobs = await tool('list_training_jobs').execute({ status: 'running' }, f.environment) as RecordValue;
  assert.equal(f.calls.at(-1)!.payload.status, 'running'); assert.equal((jobs.items as RecordValue[]).length, 1);
  const cancelled = await tool('cancel_training_job').execute({ jobId: 'job-1' }, f.environment) as RecordValue;
  assert.equal(cancelled.unchanged, false); assert.deepEqual(f.calls.at(-1), { command: 'training.job.cancel', payload: { jobId: 'job-1' } });
  assert.equal(JSON.stringify([started, detailed, jobs, cancelled]).includes('D:/private'), false);
  f.state.jobs[0] = { ...job, status: 'succeeded', projectId: 'other-project' };
  await assert.rejects(tool('inspect_training_job').execute({ jobId: 'job-1' }, f.environment), /不属于当前项目/);
  f.abort.abort();
  await assert.rejects(tool('inspect_training_job').execute({ jobId: 'job-1' }, f.environment), /对话已停止/);
  assert.equal(TRAINING_TOOL_DEFINITIONS.filter(tool => tool.mutation).map(tool => tool.name).sort()
    .join(','), 'cancel_training_job,create_training_dataset,start_training');
});

test('基础权重必须来自已登记模型并固定真实版本', async () => {
  const f = fixture();
  const parameters = { baseModel: { modelId: 'model-1' }, device: 'cpu' };
  await tool('preflight_training').execute({ datasetId: 'dataset-1', parameters }, f.environment);
  assert.deepEqual(f.calls.at(-1)!.payload, { datasetId: 'dataset-1', parameters: { baseModel: { modelId: 'model-1', modelVersion: 2 }, device: 'cpu' } });
  for (const change of [{ baseModel: { modelId: 'model-1', modelVersion: 0 } }, { baseModel: { modelId: 'model-1', modelPath: 'D:/private/model.pt' } },
    { baseModel: 'model-1' }, { baseModel: { modelId: '../../private' } }])
    await assert.rejects(tool('preflight_training').execute({ datasetId: 'dataset-1', parameters: { ...parameters, ...change } }, f.environment));
});
