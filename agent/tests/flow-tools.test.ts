import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FLOW_TOOL_DEFINITIONS } from '../flow-tools.ts';
import type { ToolEnvironment } from '../tools.ts';
import type { AgentContext, EngineClient } from '../types.ts';

type RecordValue = Record<string, unknown>;
const tool = (name: string) => FLOW_TOOL_DEFINITIONS.find(value => value.name === name)!;
const step = (kind: string, parameters: RecordValue = {}, id = kind) => ({ id, kind, enabled: true, parameters });
const definition = (...steps: ReturnType<typeof step>[]) => ({ version: 1, name: '当前素材处理', steps });
const start = (steps = [step('review')], input: RecordValue = { source: 'project', selection: 'all' }) => ({
  definition: definition(...steps), input, execution: null, failurePolicy: null,
});
const api = () => step('api', { providerId: null, model: null, prompt: null, concurrency: null, maxRetries: null, maxRequests: null });
const item = (assetId: string, index: number): RecordValue => ({ id: `item-${index}`, assetId, name: `${assetId}.png`,
  selectedVersion: 1, outcome: 'included', inputPath: 'D:/private/input.png', annotations: [{ classId: 'secret-label' }] });

function fixture(context: AgentContext = {}) {
  const calls: Array<{ command: string; payload: RecordValue }> = [];
  const state = {
    canStart: true, failCommand: '', abortAfterPreflight: false,
    projectId: 'project', artifactProjectId: 'project', listProjectId: 'project', pageMode: '',
    projectSettings: { annotationProviderId: 'configured', annotationModel: 'vision', prompt: '项目规则', concurrency: 2 } as RecordValue,
    issues: [{ code: 'invalid_input', message: '预检未通过', severity: 'error' }] as RecordValue[],
    artifactStatistics: undefined as RecordValue | undefined,
    availableSteps: ['import', 'filter', 'transform', 'local', 'api', 'review', 'export'],
    localModel: { id: 'local-model', version: 9, kind: 'local_model', name: '检测模型', taskType: 'detect', format: 'onnx', path: 'D:/private/model.onnx' } as RecordValue,
    modelVersionMismatch: false,
    mediaUnavailable: false, invalidateVideoAfterPreflight: false,
    mediaJob: { id: 'video-job', projectId: 'project', kind: 'video_extract', status: 'completed', stage: 'ready', sequence: 4,
      artifactCommitted: true, assetsCommitted: false, canImport: true, canRetry: false, canCancel: false, sourceVideoId: 'source-video' } as RecordValue,
    videoFrames: [0, 1].map(index => ({ frameId: `frame-${index}`, sourceVideoId: 'source-video', sourcePresentationIndex: index,
      sourcePts: String(index), originPts: '0', relativePts: String(index), timeSeconds: index / 30, timeBase: { numerator: 1, denominator: 30 } } as RecordValue)),
    filterItems: undefined as RecordValue[] | undefined,
    localRuntime: { configured: true, workerAvailable: true, available: true, devices: [], slots: [{ device: 'cpu', busy: false,
      modelId: 'local-model', modelVersion: 9, classes: [{ id: '0', name: '汽车' }, { id: '1', name: '忽略' }] }] } as RecordValue,
    run: { id: 'flow', projectId: 'project', name: '已保存流程', revision: 1, status: 'paused', inputArtifactId: 'artifact',
      definition: definition(step('review')), steps: [{ stepId: 'review', kind: 'review', status: 'paused', enabled: true }],
      statistics: { inputAssets: 2, requestsUsed: 0, internalPath: 'D:/private/statistics' },
      budget: { budgetScopeId: 'existing-scope', maxRequests: 4, requestsUsed: 1, remaining: 3, secret: 'hidden' },
      internalPath: 'D:/private/flow' } as RecordValue,
    items: [item('a', 0), item('b', 1)],
    assets: new Map<string, RecordValue>([
      ['a', { id: 'a', projectId: 'project', status: 'unlabeled', source: 'none' }],
      ['b', { id: 'b', projectId: 'project', status: 'confirmed', source: 'manual' }],
      ['reference', { id: 'reference', projectId: 'project', status: 'modified', source: 'manual' }],
      ['other', { id: 'other', projectId: 'other-project', status: 'unlabeled', source: 'none' }],
    ]),
    rerunSameId: false,
  };
  const abort = new AbortController();
  const engine: EngineClient = { async request<T>(command: string, payload: RecordValue = {}) {
    calls.push({ command, payload: structuredClone(payload) });
    if (command === state.failCommand) throw new Error('引擎操作失败');
    if (command === 'project.open') return { id: state.projectId, settings: state.projectSettings, taskType: 'detect', classes: [{ id: 'target', name: '目标' }] } as T;
    if (command === 'local.model.get') return { ...state.localModel, version: state.modelVersionMismatch ? 10 : payload.modelVersion ?? state.localModel.version } as T;
    if (command === 'local.runtime.get') return structuredClone(state.localRuntime) as T;
    if (command === 'media.job.get') {
      if (state.mediaUnavailable) throw Object.assign(new Error('unknown_command'), { code: 'unknown_command' });
      return structuredClone(state.mediaJob) as T;
    }
    if (command === 'media.video.frames') return { total: state.videoFrames.length, items: state.videoFrames.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)) } as T;
    if (command === 'flow.capabilities') return { availableSteps: state.availableSteps } as T;
    if (command === 'provider.list') return [{ id: 'configured', model: 'vision', capabilities: { 'tested-vision': {} } }, { id: 'second', model: 'second-model' }] as T;
    if (command === 'asset.get') return (state.assets.get(payload.assetId as string) ?? { id: payload.assetId, projectId: 'project', status: 'unlabeled' }) as T;
    if (command === 'flow.preflight') {
      if (state.abortAfterPreflight) abort.abort();
      if (state.invalidateVideoAfterPreflight) state.mediaJob.artifactCommitted = false;
      return { projectId: state.projectId, canStart: state.canStart, issues: state.canStart ? [] : state.issues,
        steps: [], inputCount: 2, availableSteps: state.availableSteps, internalPath: 'D:/private/preflight', definition: payload.definition } as T;
    }
    if (command === 'flow.create') return { ...state.run, id: 'created', status: 'queued', definition: payload.definition } as T;
    if (command === 'flow.get') return structuredClone(state.run) as T;
    if (command === 'flow.list') return { total: 1, items: [{ ...state.run, projectId: state.listProjectId }] } as T;
    if (command === 'flow.artifact') {
      const offset = payload.offset as number, limit = payload.limit as number;
      const items = payload.artifactId === 'filter-input' && state.filterItems ? state.filterItems : state.items;
      const source = state.pageMode === 'duplicate' && offset ? items.slice(0, 1)
        : state.pageMode === 'empty' && offset ? [] : items.slice(offset, offset + limit);
      return { id: payload.artifactId, flowRunId: 'flow', projectId: state.artifactProjectId,
        total: items.length, kind: 'annotations', items: source, statistics: state.artifactStatistics, inputPath: 'D:/private/artifact' } as T;
    }
    if (command === 'flow.rerun') return { run: { ...state.run, id: state.rerunSameId ? 'flow' : 'revision-2', revision: 2, status: 'queued' }, invalidatedStepIds: ['review'] } as T;
    if (['flow.pause', 'flow.resume', 'flow.cancel', 'flow.retry'].includes(command)) {
      state.run.status = command === 'flow.cancel' ? 'cancelling' : command === 'flow.pause' ? 'pausing' : 'running';
      return structuredClone(state.run) as T;
    }
    throw new Error(`未定义夹具命令 ${command}`);
  } };
  const environment: ToolEnvironment = { engine, projectId: 'project', context, budgetScopeId: 'session-budget', signal: abort.signal, openAsset() {} };
  const mutations = () => calls.filter(call => ['flow.create', 'flow.pause', 'flow.resume', 'flow.cancel', 'flow.retry', 'flow.rerun'].includes(call.command));
  return { calls, state, environment, mutations };
}

test('流程提交必须实际预检，失败和取消不伪造完成', async () => {
  const f = fixture();
  f.state.canStart = false;
  const blocked = await tool('start_flow').execute(start(), f.environment) as RecordValue;
  assert.equal(blocked.started, false); assert.equal(f.mutations().length, 0);
  assert.equal(JSON.stringify(blocked).includes('D:/private'), false);
  f.state.canStart = true;
  const submitted = await tool('start_flow').execute(start(), f.environment) as RecordValue;
  assert.equal(submitted.started, true); assert.equal((submitted.run as RecordValue).status, 'queued');
  assert.deepEqual(f.calls.slice(-2).map(call => call.command), ['flow.preflight', 'flow.create']);
  f.state.failCommand = 'flow.create';
  await assert.rejects(tool('start_flow').execute(start(), f.environment), /引擎操作失败/);
  const aborted = fixture(); aborted.state.abortAfterPreflight = true;
  await assert.rejects(tool('start_flow').execute(start(), aborted.environment), /对话已停止/);
  assert.equal(aborted.mutations().length, 0);
});

test('all 和 unlabeled 尊重 context 上限，显式跨范围和跨项目在提交前拒绝', async () => {
  const f = fixture({ assetIds: ['a', 'b'] });
  await tool('preflight_flow').execute(start(), f.environment);
  assert.deepEqual(f.calls.at(-1)?.payload.input, { source: 'project', selection: 'explicit', assetIds: ['a', 'b'] });
  await tool('preflight_flow').execute(start(undefined, { source: 'project', selection: 'unlabeled' }), f.environment);
  assert.deepEqual(f.calls.at(-1)?.payload.input, { source: 'project', selection: 'explicit', assetIds: ['a'] });
  await assert.rejects(tool('start_flow').execute(start(undefined, { source: 'project', selection: 'explicit', assetIds: ['reference'] }), f.environment), /超出助手/);
  const cross = fixture();
  await assert.rejects(tool('start_flow').execute(start(undefined, { source: 'project', selection: 'explicit', assetIds: ['other'] }), cross.environment), /不属于当前项目/);
  await assert.rejects(tool('start_flow').execute(start(), fixture({ assetIds: [] }).environment), /不能为空/);
  assert.equal(f.mutations().length + cross.mutations().length, 0);
});

test('artifact 有界分页全量核范围，第二页越界、重复或缺项都不能放行', async () => {
  const selected = Array.from({ length: 501 }, (_, index) => `asset-${index}`);
  const f = fixture({ assetIds: selected });
  f.state.items = selected.map(item);
  const args = start(undefined, { source: 'artifact', artifactId: 'artifact' });
  await tool('preflight_flow').execute(args, f.environment);
  assert.deepEqual(f.calls.filter(call => call.command === 'flow.artifact').map(call => call.payload.offset), [0, 500]);
  f.state.items[500] = item('outside', 500);
  await assert.rejects(tool('start_flow').execute(args, f.environment), /选择范围外/);
  f.state.items = selected.map(item); f.state.pageMode = 'duplicate';
  await assert.rejects(tool('start_flow').execute(args, f.environment), /分页重复/);
  f.state.pageMode = 'empty';
  await assert.rejects(tool('start_flow').execute(args, f.environment), /分页不完整/);
  f.state.pageMode = ''; f.state.artifactProjectId = 'other-project';
  await assert.rejects(tool('start_flow').execute(args, f.environment), /不属于当前项目/);
  assert.equal(f.mutations().length, 0);
});

test('步骤 schema 封闭路径、参考和任意参数，导出仅使用 context 目录', async () => {
  const f = fixture({ exportDir: 'D:/chosen/export' });
  for (const injected of [step('import', { paths: ['D:/private/import.png'] }), step('export', { outputDir: 'D:/private/export' }),
    step('api', { referenceResources: [{ resourceId: 'forged' }] }), step('filter', { arbitrary: true })]) {
    await assert.rejects(tool('start_flow').execute(start([injected]), f.environment), /不支持的参数/);
  }
  await tool('preflight_flow').execute(start([step('export', { onlyConfirmed: true, annotationSelection: 'protected', trainRatio: 0.8 })]), f.environment);
  const sent = f.calls.at(-1)?.payload.definition as { steps: Array<{ parameters: RecordValue }> };
  assert.equal(sent.steps[0].parameters.outputDir, 'D:/chosen/export');
  assert.equal(f.mutations().length, 0);
  const encoded = JSON.stringify(tool('start_flow').parameters);
  assert.equal(encoded.includes('outputDir'), false); assert.equal(encoded.includes('referenceResources'), false);
  assert.equal(encoded.includes('anyOf'), true);
});

test('API 继承实际配置与固定人工参考，共享预算必填且不能猜模型', async () => {
  const selectedReference = { resourceId: 'library', version: 2, classMap: { old: 'target' } };
  const f = fixture({ assetIds: ['a'], maxRequests: 5, referenceAssetIds: ['reference'], referenceResources: [selectedReference] });
  await tool('preflight_flow').execute(start([api()]), f.environment);
  const payload = f.calls.at(-1)!.payload;
  const parameters = ((payload.definition as RecordValue).steps as Array<{ parameters: RecordValue }>)[0].parameters;
  assert.equal(payload.budgetScopeId, 'session-budget'); assert.equal(payload.maxRequests, 5);
  assert.equal(parameters.providerId, 'configured'); assert.equal(parameters.model, 'vision'); assert.equal(parameters.concurrency, 2);
  assert.deepEqual(parameters.referenceAssetIds, ['reference']); assert.deepEqual(parameters.referenceResources, [selectedReference]);
  await assert.rejects(tool('start_flow').execute(start([api()]), fixture({ maxRequests: null }).environment), /共享请求上限/);
  await assert.rejects(tool('start_flow').execute(start([step('api', { model: 'invented' })]), f.environment), /不能猜测模型/);
  const overlap = fixture({ assetIds: ['reference'], maxRequests: 2, referenceAssetIds: ['reference'] });
  await assert.rejects(tool('start_flow').execute(start([api()]), overlap.environment), /同时作为流程输入/);
  const unfixed = fixture({ maxRequests: 2, referenceResources: [{ resourceId: 'library' }] });
  await assert.rejects(tool('start_flow').execute(start([api()]), unfixed.environment), /固定版本/);
});

test('参数数量、尺寸、单步前驱边界在模型调用之前校验', async () => {
  const f = fixture();
  for (const invalid of [step('filter', { minWidth: 100, maxWidth: 50 }), step('filter', { assetIds: ['a', 'a'] }),
    step('review', { randomSample: { count: 1001, seed: '固定种子' } }), step('review', { waitForHuman: 'true' })]) {
    await assert.rejects(tool('preflight_flow').execute(start([invalid]), f.environment));
  }
  await assert.rejects(tool('preflight_flow').execute({ ...start([step('import'), step('review')]), execution: { mode: 'single', stepId: 'review' } }, f.environment), /非首步骤/);
  await tool('preflight_flow').execute({ ...start([step('import'), step('review')], { source: 'artifact', artifactId: 'artifact' }), execution: { mode: 'single', stepId: 'review' } }, f.environment);
  await assert.rejects(tool('preflight_flow').execute(start([step('review', {}, 'same'), step('review', {}, 'same')]), f.environment), /标识不能重复/);
  assert.equal(f.mutations().length, 0);
});

test('状态与产物返回白名单，列表和控制严格核项目归属', async () => {
  const f = fixture();
  const run = await tool('inspect_flow').execute({ flowRunId: 'flow' }, f.environment) as RecordValue;
  assert.equal(run.definition, undefined); assert.equal(run.internalPath, undefined);
  assert.deepEqual(run.budget, { budgetScopeId: 'existing-scope', maxRequests: 4, requestsUsed: 1, remaining: 3 });
  (f.state.run.budget as RecordValue).cost = { currency: null, knownCost: 0, knownCalls: 0, unknownCalls: 2, inFlightCalls: 1,
    limit: null, control: 'observed_cost_stop', hardLimit: false, internalPath: 'D:/private/cost' };
  const withCost = await tool('inspect_flow').execute({ flowRunId: 'flow' }, f.environment) as RecordValue;
  assert.deepEqual((withCost.budget as RecordValue).cost, { currency: null, knownCost: 0, knownCalls: 0, unknownCalls: 2, inFlightCalls: 1,
    limit: null, control: 'observed_cost_stop', hardLimit: false });
  const artifact = await tool('inspect_flow_artifact').execute({ artifactId: 'artifact', offset: 0, limit: 1 }, f.environment);
  assert.equal(JSON.stringify(artifact).includes('D:/private'), false); assert.equal(JSON.stringify(artifact).includes('secret-label'), false);
  f.state.listProjectId = 'other-project';
  await assert.rejects(tool('list_flows').execute({ offset: null, limit: null }, f.environment), /不属于当前项目/);
  f.state.run.projectId = 'other-project';
  await assert.rejects(tool('control_flow').execute({ flowRunId: 'flow', action: 'cancel' }, f.environment), /不属于当前项目/);
  assert.equal(f.mutations().length, 0);
});

test('人工检查与 unknown 重试不可越权，重复控制读真实状态且不重复提交', async () => {
  const f = fixture();
  const resume = { flowRunId: 'flow', action: 'resume' };
  await assert.rejects(tool('control_flow').execute({ ...resume, acknowledgeReviewStepId: 'review' }, f.environment), /不支持的参数/);
  await assert.rejects(tool('retry_flow').execute({ flowRunId: 'flow', stepId: null, assetIds: null, retryUnknown: true }, f.environment), /不支持的参数/);
  f.state.run.status = 'needs_attention';
  f.state.run.steps = [{ stepId: 'review', kind: 'review', status: 'needs_attention', enabled: true }];
  await assert.rejects(tool('control_flow').execute(resume, f.environment), /等待人工检查/);
  await assert.rejects(tool('retry_flow').execute({ flowRunId: 'flow', stepId: null, assetIds: null }, f.environment), /等待人工检查/);
  f.state.run.definition = definition(step('review', { waitForHuman: true }), step('filter'));
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'filter' }, f.environment), /越过尚未完成的人工检查/);
  f.state.run.steps = []; f.state.run.status = 'paused';
  const paused = await tool('control_flow').execute({ flowRunId: 'flow', action: 'pause' }, f.environment) as RecordValue;
  assert.equal(paused.unchanged, true);
  await tool('control_flow').execute(resume, f.environment);
  const repeated = await tool('control_flow').execute(resume, f.environment) as RecordValue;
  assert.equal(repeated.unchanged, true); assert.equal(f.mutations().length, 1);
  f.state.run.status = 'failed';
  await tool('retry_flow').execute({ flowRunId: 'flow', stepId: null, assetIds: ['a'] }, f.environment);
  assert.deepEqual(f.calls.at(-1)?.payload, { flowRunId: 'flow', retryUnknown: false, assetIds: ['a'] });
});

test('历史文件路径不能借继续或重跑取得授权，取消仍可停止任务', async () => {
  const f = fixture({ exportDir: 'D:/chosen/export' });
  f.state.run.definition = definition(step('import', { paths: ['D:/historical/import.png'] }), step('review'));
  await assert.rejects(tool('control_flow').execute({ flowRunId: 'flow', action: 'resume' }, f.environment), /流程编辑器/);
  await assert.rejects(tool('retry_flow').execute({ flowRunId: 'flow', stepId: null, assetIds: null }, f.environment), /流程编辑器/);
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'review' }, f.environment), /流程编辑器/);
  await tool('control_flow').execute({ flowRunId: 'flow', action: 'cancel' }, f.environment);
  f.state.run.status = 'paused'; f.state.run.definition = definition(step('export', { outputDir: 'D:/historical/export' }));
  await assert.rejects(tool('control_flow').execute({ flowRunId: 'flow', action: 'resume' }, f.environment), /选择此流程的导出目录/);
  const before = structuredClone(f.state.run.definition);
  const result = await tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'export' }, f.environment) as RecordValue;
  const sent = f.calls.at(-1)!.payload.definition as { steps: Array<{ parameters: RecordValue }> };
  assert.equal(sent.steps[0].parameters.outputDir, 'D:/chosen/export');
  assert.deepEqual(f.state.run.definition, before); assert.equal((result.run as RecordValue).id, 'revision-2');
  f.state.rerunSameId = true;
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'export' }, f.environment), /独立的新修订/);
});

test('历史参考与操作素材不能越过当前 context，失败不返回成功', async () => {
  const f = fixture({ assetIds: ['a'], maxRequests: 3 });
  await assert.rejects(tool('control_flow').execute({ flowRunId: 'flow', action: 'cancel' }, f.environment), /选择范围外/);
  f.state.items = [item('a', 0)];
  f.state.run.definition = definition(step('api', { providerId: 'configured', model: 'vision', prompt: '历史规则', referenceResources: [{ resourceId: 'old', version: 1 }] }));
  await assert.rejects(tool('retry_flow').execute({ flowRunId: 'flow', stepId: null, assetIds: null }, f.environment), /未选择的参考版本/);
  f.state.run.definition = definition(step('review'));
  f.state.failCommand = 'flow.retry';
  await assert.rejects(tool('retry_flow').execute({ flowRunId: 'flow', stepId: null, assetIds: ['a'] }, f.environment), /引擎操作失败/);
});

test('缺配置预检保留逐节点问题，start 也先取得真实问题再阻断', async () => {
  const f = fixture(); f.state.projectSettings = {}; f.state.canStart = false;
  f.state.issues = [
    { stepId: 'api', code: 'flow_model_required', message: '请选择标注接口和模型', severity: 'error' },
    { stepId: 'api', code: 'flow_prompt_required', message: '请填写提示词', severity: 'error' },
    { stepId: 'api', code: 'flow_budget_required', message: '请填写请求上限', severity: 'error' },
    { stepId: 'export', code: 'flow_output_required', message: '请选择导出目录', severity: 'error' },
  ];
  const args = start([api(), step('export')]);
  const checked = await tool('preflight_flow').execute(args, f.environment) as RecordValue;
  assert.deepEqual(checked.issues, f.state.issues);
  const payload = f.calls.at(-1)!.payload;
  const steps = (payload.definition as RecordValue).steps as Array<{ parameters: RecordValue }>;
  assert.deepEqual(steps[0].parameters, { concurrency: 1, maxRetries: 0 });
  assert.deepEqual(steps[1].parameters, {}); assert.equal(payload.maxRequests, undefined);
  const submitted = await tool('start_flow').execute(args, f.environment) as RecordValue;
  assert.equal(submitted.started, false); assert.deepEqual((submitted.preflight as RecordValue).issues, f.state.issues);
  f.state.projectSettings = { annotationProviderId: 'configured' };
  await tool('preflight_flow').execute(args, f.environment);
  const partial = (((f.calls.at(-1)!.payload.definition as RecordValue).steps as Array<{ parameters: RecordValue }>)[0]).parameters;
  assert.equal(partial.providerId, 'configured'); assert.equal(partial.model, undefined); assert.equal(partial.prompt, undefined);
  assert.equal(f.mutations().length, 0);
});

test('disabled 和 single 未执行节点不索取当前配置，但显式非法字段仍拒绝', async () => {
  const f = fixture(); f.state.projectSettings = {};
  const disabled = start([{ ...api(), enabled: false }, step('review'), { ...step('export'), enabled: false }]);
  await tool('start_flow').execute(disabled, f.environment);
  const single = { ...start([api(), step('review'), step('export')], { source: 'artifact', artifactId: 'artifact' }), execution: { mode: 'single', stepId: 'review' } };
  await tool('start_flow').execute(single, f.environment);
  assert.equal(f.calls.some(call => ['project.open', 'provider.list'].includes(call.command)), false);
  const payload = f.calls.at(-1)!.payload;
  const steps = (payload.definition as RecordValue).steps as Array<{ parameters: RecordValue }>;
  assert.deepEqual(steps[0].parameters, {}); assert.deepEqual(steps[2].parameters, {});
  assert.equal(payload.maxRequests, undefined); assert.equal(f.mutations().length, 2);
  await assert.rejects(tool('preflight_flow').execute(start([{ ...step('api', { concurrency: 33 }), enabled: false }, step('review')]), f.environment), /步骤并发/);
  await assert.rejects(tool('preflight_flow').execute({ ...single, definition: definition(api(), step('review'), step('export', { outputDir: 'D:/injected' })) }, f.environment), /不支持的参数/);
  await assert.rejects(tool('preflight_flow').execute(start([{ ...step('api', { prompt: ' ' }), enabled: false }, step('review')]), f.environment), /提示词不能为空/);
});

test('预检误报可启动仍不能绕过实际执行节点的预算配置和目录闸门', async () => {
  const withoutBudget = fixture();
  await assert.rejects(tool('start_flow').execute(start([api()]), withoutBudget.environment), /共享请求上限/);
  const withoutConfiguration = fixture({ maxRequests: 3 }); withoutConfiguration.state.projectSettings = {};
  await assert.rejects(tool('start_flow').execute(start([api()]), withoutConfiguration.environment), /标注接口不能为空/);
  const withoutDirectory = fixture();
  await assert.rejects(tool('start_flow').execute(start([step('export')]), withoutDirectory.environment), /用户选择的导出目录不能为空/);
  for (const f of [withoutBudget, withoutConfiguration, withoutDirectory]) {
    assert.equal(f.calls.some(call => call.command === 'flow.preflight'), true);
    assert.equal(f.mutations().length, 0);
  }
  const invalidBudget = fixture({ maxRequests: 0 });
  await assert.rejects(tool('preflight_flow').execute(start([api()]), invalidBudget.environment), /请求上限/);
  assert.equal(invalidBudget.calls.some(call => call.command === 'flow.preflight'), false);
});

test('流程 API 复用策略保留显式值和空 TTL，拒绝无效秒数及伪造开关', async () => {
  const f = fixture({ maxRequests: 3 });
  for (const ttl of [null, 1, Number.MAX_SAFE_INTEGER]) {
    await tool('preflight_flow').execute(start([step('api', { reuseEnabled: false, forceRerun: true, reuseMaxAgeSeconds: ttl })]), f.environment);
    const parameters = ((f.calls.at(-1)!.payload.definition as RecordValue).steps as Array<{ parameters: RecordValue }>)[0].parameters;
    assert.equal(parameters.reuseEnabled, false); assert.equal(parameters.forceRerun, true); assert.equal(parameters.reuseMaxAgeSeconds, ttl);
    assert.equal(f.calls.at(-1)!.payload.maxRequests, 3);
  }
  for (const parameters of [{ reuseEnabled: 'true' }, { forceRerun: 1 }, { reuseMaxAgeSeconds: 0 }, { reuseMaxAgeSeconds: -1 },
    { reuseMaxAgeSeconds: 1.1 }, { reuseMaxAgeSeconds: '30' }, { reuseMaxAgeSeconds: Number.MAX_SAFE_INTEGER + 1 }, { force: true }]) {
    await assert.rejects(tool('preflight_flow').execute(start([{ ...step('api', parameters), enabled: false }, step('review')]), f.environment));
  }
  f.state.run.definition = definition(step('api', { providerId: 'configured', model: 'vision', prompt: '历史规则', reuseEnabled: true, forceRerun: false, reuseMaxAgeSeconds: null }));
  await tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'api' }, f.environment);
  const sent = f.calls.at(-1)!.payload;
  assert.deepEqual(sent.definition, f.state.run.definition);
  assert.equal(sent.budgetScopeId, 'session-budget'); assert.equal(sent.maxRequests, 3);
  const oldParameters = ((f.state.run.definition as RecordValue).steps as Array<{ parameters: RecordValue }>)[0].parameters;
  oldParameters.forceRerun = 'true';
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'api' }, f.environment), /必须是布尔值/);
});

test('复用来源只返回受限标识与模型版本，不改变成功计数或伪造请求与人工确认', async () => {
  const f = fixture();
  const provenance = { sourceRunId: 'old-run', sourceSampleId: 'old-sample', sourceAssetId: 'a', sourceCandidateVersion: 2,
    sourceAttemptId: 'old-attempt', sourceCompletedAt: '2026-09-10T10:00:00Z', sourceModel: 'vision',
    sourceModelVersion: { model: 'vision', model_version: { internalPath: 'D:/private/raw' }, system_fingerprint: 'version-1', response: '完整模型响应' },
    reuseFingerprint: 'internal-cache-key', inputPath: 'D:/private/source', response: '完整模型响应' };
  f.state.items = [{ ...item('a', 0), candidateVersion: 4, reused: true, reusedFrom: provenance }];
  f.state.artifactStatistics = { total: 1, succeeded: 1, reused: 1, failed: 0 };
  f.state.run.statistics = { inputAssets: 1, outputAssets: 1, requestsUsed: 0, reused: 1 };
  const result = await tool('inspect_flow_artifact').execute({ artifactId: 'artifact', offset: 0, limit: 100 }, f.environment) as RecordValue;
  const entry = (result.items as RecordValue[])[0];
  assert.equal(entry.reused, true); assert.equal(entry.candidateVersion, 4); assert.equal(entry.status, undefined);
  assert.deepEqual(entry.reusedFrom, { sourceRunId: 'old-run', sourceSampleId: 'old-sample', sourceAssetId: 'a', sourceCandidateVersion: 2,
    sourceAttemptId: 'old-attempt', sourceCompletedAt: '2026-09-10T10:00:00Z', sourceModel: 'vision', sourceModelVersion: { model: 'vision', system_fingerprint: 'version-1' } });
  assert.deepEqual(result.statistics, f.state.artifactStatistics);
  assert.equal(JSON.stringify(result).includes('D:/private'), false); assert.equal(JSON.stringify(result).includes('完整模型响应'), false);
  const run = await tool('inspect_flow').execute({ flowRunId: 'flow' }, f.environment) as RecordValue;
  assert.deepEqual(run.statistics, f.state.run.statistics); assert.equal(f.mutations().length, 0);
});

test('输入结果复用摘要分别保留真实 API 与本地来源，不披露缓存或伪造候选来源', async () => {
  const f = fixture();
  const origin = { sourceResultId: 'old-result', sourceRunId: 'old-run', sourceSampleId: 'old-sample', sourceInputId: 'old-input',
    sourceAssetId: 'a', sourceCompletedAt: '2026-09-10T10:00:00Z', sourceModel: '实际模型', reuseFingerprint: 'private-full-fingerprint',
    sourceModelHash: 'private-model-hash', sourceWorkerHash: 'private-worker-hash', sourceCandidateVersion: 99,
    inputPath: 'D:/private/source', rawResult: { response: '完整模型响应' } };
  f.state.items = [{ ...item('a', 0), resultId: 'new-result', reused: true, requiresGeometryReview: true,
    inputReusedFrom: { ...origin, source: 'api', sourceAttemptId: 'actual-attempt', sourceModelId: 'not-local',
      sourceModelVersion: { model: 'vision', model_version: 'revision-2', system_fingerprint: 'provider-version', raw: '完整模型响应', path: 'D:/private/model' } } }];
  const apiResult = await tool('inspect_flow_artifact').execute({ artifactId: 'artifact' }, f.environment) as RecordValue;
  const apiItem = (apiResult.items as RecordValue[])[0], expected = {
    sourceResultId: 'old-result', sourceRunId: 'old-run', sourceSampleId: 'old-sample', sourceInputId: 'old-input',
    sourceAssetId: 'a', sourceCompletedAt: '2026-09-10T10:00:00Z', sourceModel: '实际模型',
  };
  assert.deepEqual(apiItem.inputReusedFrom, { ...expected, source: 'api', sourceAttemptId: 'actual-attempt',
    sourceModelVersion: { model: 'vision', model_version: 'revision-2', system_fingerprint: 'provider-version' } });
  assert.equal(apiItem.reusedFrom, undefined); assert.equal(apiItem.candidateVersion, undefined);
  assert.equal(apiItem.resultId, 'new-result'); assert.equal(apiItem.requiresGeometryReview, true);
  const serialized: unknown[] = [apiResult];
  for (const backend of [undefined, null, { kind: 'pytorch', device: 'cuda:0', providers: null },
    { kind: 'onnxruntime', device: null, providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'] }]) {
    f.state.items = [{ ...item('a', 0), reused: true, inputReusedFrom: { ...origin, source: 'local', sourceModelId: 'local-model',
      sourceModelVersion: 9, sourceAttemptId: 'not-an-api-call', sourceRequestedDevice: '0',
      ...(backend === undefined ? {} : { sourceObservedBackend: backend && { ...backend, path: 'D:/private/backend', raw: '完整模型响应' } }) } }];
    const localResult = await tool('inspect_flow_artifact').execute({ artifactId: 'artifact' }, f.environment) as RecordValue;
    const localItem = (localResult.items as RecordValue[])[0]; serialized.push(localResult);
    assert.deepEqual(localItem.inputReusedFrom, { ...expected, source: 'local', sourceModelId: 'local-model', sourceModelVersion: 9,
      sourceRequestedDevice: '0', ...(backend === undefined ? {} : { sourceObservedBackend: backend }) });
    assert.equal(localItem.reusedFrom, undefined); assert.equal(localItem.status, undefined);
  }
  for (const forbidden of ['private-', 'D:/private', '完整模型响应', 'sourceCandidateVersion', 'not-an-api-call', 'not-local'])
    assert.equal(JSON.stringify(serialized).includes(forbidden), false);
  f.state.items = [{ ...item('a', 0), inputReusedFrom: { ...origin, source: 'api' } }];
  const notReused = await tool('inspect_flow_artifact').execute({ artifactId: 'artifact' }, f.environment) as RecordValue;
  assert.equal((notReused.items as RecordValue[])[0].inputReusedFrom, undefined);
  f.state.items = [{ ...item('a', 0), reused: true, inputReusedFrom: { ...origin, source: 'reuse' } }];
  await assert.rejects(tool('inspect_flow_artifact').execute({ artifactId: 'artifact' }, f.environment), /复用来源类型不受支持/);
  assert.equal(f.mutations().length, 0);
});

test('图像处理覆盖裁剪缩放与切片，有限尺寸和重叠边界不能注入路径', async () => {
  const f = fixture();
  const operations = [{ kind: 'crop', x: 10, y: 20, width: 200, height: 100 }, { kind: 'resize', width: 400, height: 200, fit: 'contain' },
    { kind: 'tile', width: 100, height: 100, overlapX: 20, overlapY: 0 }];
  await tool('start_flow').execute(start([step('transform', { operations, background: '#AABBCC' })]), f.environment);
  const sent = f.calls.at(-1)!.payload;
  assert.deepEqual(((sent.definition as RecordValue).steps as RecordValue[])[0].parameters, { operations, background: '#AABBCC' });
  assert.equal(sent.maxRequests, undefined); assert.equal(sent.budgetScopeId, undefined);
  for (const parameters of [
    { operations: Array.from({ length: 31 }, () => operations[0]) }, { operations: [operations[2], operations[2]] },
    { operations: [{ ...operations[2], overlapX: 100 }] }, { operations: [{ ...operations[2], overlapY: -1 }] },
    { operations: [{ ...operations[0], x: NaN }] }, { operations: [{ ...operations[0], y: 0.5 }] },
    { operations: [{ kind: 'resize', width: 20001, height: 1 }] }, { operations: [{ kind: 'resize', width: 10000, height: 4001 }] },
    { operations: [{ ...operations[1], fit: 'cover' }] }, { operations: [{ ...operations[0], inputPath: 'D:/private/input' }] },
    { operations: [], background: 'url(file:///D:/private)' },
  ]) await assert.rejects(tool('preflight_flow').execute(start([step('transform', parameters)]), f.environment));
  const oldEngine = fixture(); oldEngine.state.availableSteps = ['import', 'filter', 'api', 'review', 'export'];
  await assert.rejects(tool('start_flow').execute(start([step('transform', { operations })]), oldEngine.environment), /当前引擎尚不支持/);
  assert.equal(oldEngine.mutations().length, 0);
});

const local = (parameters: RecordValue = {}) => step('local', { modelId: 'local-model', classMap: [
  { modelClassId: '0', projectClassId: 'target' }, { modelClassId: '1', projectClassId: null },
], ...parameters });

test('本地复用三字段严格传输，强制计算不索取 API 预算', async () => {
  const f = fixture({ maxRequests: null });
  for (const ttl of [null, 1, Number.MAX_SAFE_INTEGER]) {
    await tool('start_flow').execute(start([local({ reuseEnabled: false, forceRerun: true, reuseMaxAgeSeconds: ttl })]), f.environment);
    const payload = f.calls.at(-1)!.payload, parameters = ((payload.definition as RecordValue).steps as RecordValue[])[0].parameters as RecordValue;
    assert.equal(parameters.reuseEnabled, false); assert.equal(parameters.forceRerun, true); assert.equal(parameters.reuseMaxAgeSeconds, ttl);
    assert.equal(payload.maxRequests, undefined); assert.equal(payload.budgetScopeId, undefined);
  }
  const mutationCount = f.mutations().length;
  for (const parameters of [{ reuseEnabled: 'true' }, { reuseEnabled: 0 }, { forceRerun: 1 }, { forceRerun: 'false' },
    { reuseMaxAgeSeconds: 0 }, { reuseMaxAgeSeconds: -1 }, { reuseMaxAgeSeconds: 0.5 }, { reuseMaxAgeSeconds: '1' },
    { reuseMaxAgeSeconds: NaN }, { reuseMaxAgeSeconds: Infinity }, { reuseMaxAgeSeconds: Number.MAX_SAFE_INTEGER + 1 }, { force: true }]) {
    await assert.rejects(tool('preflight_flow').execute(start([{ ...step('local', parameters), enabled: false }, step('review')]), f.environment));
  }
  assert.equal(f.mutations().length, mutationCount);
  assert.equal(f.calls.some(call => call.command === 'provider.list'), false);
  const schema = tool('start_flow').parameters as RecordValue;
  const definitionSchema = (schema.properties as RecordValue).definition as RecordValue;
  const stepsSchema = (definitionSchema.properties as RecordValue).steps as RecordValue;
  const branches = (stepsSchema.items as RecordValue).anyOf as RecordValue[];
  const branch = branches.find(value => (((value.properties as RecordValue).kind as RecordValue).enum as string[]).includes('local'))!;
  const parametersSchema = (branch.properties as RecordValue).parameters as RecordValue;
  for (const field of ['reuseEnabled', 'forceRerun', 'reuseMaxAgeSeconds']) {
    assert.equal((parametersSchema.required as string[]).includes(field), true);
    assert.ok((parametersSchema.properties as RecordValue)[field]);
  }
});

test('历史本地复用策略逐值保留且不补缺省策略，非法历史值拒绝', async () => {
  const f = fixture();
  for (const policy of [{}, { reuseEnabled: false, forceRerun: true, reuseMaxAgeSeconds: null },
    { reuseEnabled: true, forceRerun: false, reuseMaxAgeSeconds: 120 }]) {
    f.state.run.definition = definition(step('local', { modelId: 'local-model', modelVersion: 3, classMap: { '0': 'target', '1': null }, ...policy }));
    const before = structuredClone(f.state.run.definition);
    await tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'local' }, f.environment);
    assert.deepEqual(f.state.run.definition, before); assert.deepEqual(f.calls.at(-1)!.payload.definition, before);
    assert.equal(f.calls.at(-1)!.payload.maxRequests, undefined); assert.equal(f.calls.at(-1)!.payload.budgetScopeId, undefined);
  }
  for (const policy of [{ reuseEnabled: 'true' }, { forceRerun: 'false' }, { reuseMaxAgeSeconds: 0 }, { reuseMaxAgeSeconds: Number.MAX_SAFE_INTEGER + 1 }]) {
    f.state.run.definition = definition(step('local', { modelId: 'local-model', modelVersion: 3, classMap: { '0': 'target', '1': null }, ...policy }));
    await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'local' }, f.environment));
  }
});

test('本地模型只使用实际登记版本和完整类别映射，不要求 API 标注预算', async () => {
  const f = fixture();
  f.state.localRuntime.available = false;
  await tool('start_flow').execute(start([local({ device: 'cpu', confidence: 0, iou: 1, imageSize: 32, maxDetections: 10000, timeoutMs: 600000 })]), f.environment);
  const payload = f.calls.at(-1)!.payload, parameters = ((payload.definition as RecordValue).steps as RecordValue[])[0].parameters as RecordValue;
  assert.equal(parameters.modelVersion, 9); assert.deepEqual(parameters.classMap, { '0': 'target', '1': null });
  assert.equal(payload.maxRequests, undefined); assert.equal(payload.budgetScopeId, undefined);
  assert.equal(f.calls.some(call => ['local.model.list', 'local.model.resolve', 'local.model.load', 'local.model.authorize', 'local.runtime.probe'].includes(call.command)), false);
  for (const parameters of [{ device: '01' }, { device: '1000' }, { device: 'cuda:0' }, { modelVersion: 0 }, { confidence: NaN }, { iou: 1.01 },
    { imageSize: 31 }, { imageSize: 4097 }, { maxDetections: 10001 }, { timeoutMs: 999 }, { timeoutMs: 600001 },
    { modelPath: 'D:/private/forged.pt' }, { configure: true }, { classMap: { '0': 'target' } },
    { classMap: [{ modelClassId: '0', projectClassId: 'target' }, { modelClassId: '0', projectClassId: null }] },
    { classMap: [{ modelClassId: '0', projectClassId: 'target' }] }, { classMap: [{ modelClassId: '0', projectClassId: 'outside' }] },
    { classMap: [{ modelClassId: '00', projectClassId: null }] }, { classMap: [{ modelClassId: '0' }] }]) {
    await assert.rejects(tool('preflight_flow').execute(start([local(parameters)]), f.environment));
  }
  f.state.localModel.taskType = 'pose';
  await assert.rejects(tool('preflight_flow').execute(start([local()]), f.environment), /任务类型与当前项目/);
  assert.equal(f.mutations().length, 1);
});

test('本地缺项由实际预检说明，误报可启动不能绕过未加载或缺失映射', async () => {
  const f = fixture(); f.state.canStart = false; f.state.issues = [{ stepId: 'local', code: 'local_model_required', message: '请选择模型', severity: 'error' }];
  const result = await tool('start_flow').execute(start([step('local', { modelId: null, classMap: null })]), f.environment) as RecordValue;
  assert.equal(result.started, false); assert.deepEqual((result.preflight as RecordValue).issues, f.state.issues);
  f.state.localRuntime.slots = [];
  await tool('preflight_flow').execute(start([local()]), f.environment);
  f.state.canStart = true;
  await assert.rejects(tool('start_flow').execute(start([local()]), f.environment), /软件 AI 配置里加载/);
  await assert.rejects(tool('start_flow').execute(start([local({ classMap: null })]), f.environment), /完整类别映射/);
  assert.equal(f.mutations().length, 0);
  const inactive = fixture();
  await tool('start_flow').execute(start([{ ...step('local'), enabled: false }, step('review')]), inactive.environment);
  assert.equal(inactive.calls.some(call => call.command.startsWith('local.')), false);
});

test('历史本地模型固定版本不替换活动头，运行快照补齐版本并拒绝冲突或缺失', async () => {
  const f = fixture();
  f.state.run.definition = definition(step('local', { modelId: 'local-model', modelVersion: 3, classMap: { '0': 'target', '1': null } }));
  await tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'local' }, f.environment);
  assert.deepEqual(f.calls.at(-1)!.payload.definition, f.state.run.definition);
  assert.equal(f.calls.filter(call => call.command === 'local.model.get').at(-1)!.payload.modelVersion, 3);
  assert.equal(f.calls.at(-1)!.payload.maxRequests, undefined);
  const parameters = ((f.state.run.definition as RecordValue).steps as RecordValue[])[0].parameters as RecordValue;
  delete parameters.modelVersion;
  f.state.run.steps = [{ stepId: 'local', kind: 'local', local: { modelId: 'local-model', modelVersion: 3, device: 'cpu' } }];
  await tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'local' }, f.environment);
  const fixed = (((f.calls.at(-1)!.payload.definition as RecordValue).steps as RecordValue[])[0].parameters as RecordValue);
  assert.equal(fixed.modelVersion, 3); assert.equal(fixed.device, 'cpu'); assert.equal(parameters.modelVersion, undefined);
  parameters.modelVersion = 4;
  await assert.rejects(tool('control_flow').execute({ flowRunId: 'flow', action: 'resume' }, f.environment), /固定选择不一致/);
  delete parameters.modelVersion; f.state.run.steps = [];
  await assert.rejects(tool('retry_flow').execute({ flowRunId: 'flow' }, f.environment), /缺少固定本地模型版本/);
  parameters.modelVersion = 3; f.state.modelVersionMismatch = true;
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'local' }, f.environment), /选定版本不一致/);
  assert.equal(f.calls.some(call => call.command === 'local.model.resolve'), false);
});

test('视图摘要保留输入身份与几何复核门槛，不展开变换路径或完整模型结果', async () => {
  const f = fixture({ assetIds: ['a'] });
  f.state.items = [0, 1].map(index => ({ ...item('a', index), inputId: `input-${index}`, viewId: `view-${index}`, planHash: 'fixed-plan', resultId: `result-${index}`,
    requiresGeometryReview: true, rawResult: { private: '原始模型输出' }, inputSnapshot: { inputId: `input-${index}`, kind: 'view', assetId: 'a', width: 100, height: 100,
      viewId: `view-${index}`, planHash: 'fixed-plan', inputPath: 'D:/private/view', inputTransform: { secret: '原始模型输出' } } }));
  f.state.run.statistics = { inputAssets: 1, inputViews: 2, requestsUsed: 0 };
  f.state.run.steps = [{ stepId: 'local', kind: 'local', local: { modelId: 'local-model', modelVersion: 3, device: 'cpu', path: 'D:/private/model' } }];
  const result = await tool('inspect_flow_artifact').execute({ artifactId: 'artifact' }, f.environment) as RecordValue;
  const entries = result.items as RecordValue[];
  assert.equal(entries.length, 2); assert.deepEqual(entries.map(entry => entry.inputId), ['input-0', 'input-1']);
  assert.equal(entries.every(entry => entry.requiresGeometryReview === true), true);
  const run = await tool('inspect_flow').execute({ flowRunId: 'flow' }, f.environment) as RecordValue;
  assert.deepEqual(run.statistics, f.state.run.statistics);
  assert.deepEqual((run.steps as RecordValue[])[0].local, { modelId: 'local-model', modelVersion: 3, device: 'cpu' });
  assert.equal(JSON.stringify([run, result]).includes('D:/private'), false); assert.equal(JSON.stringify(result).includes('原始模型输出'), false);
});

test('视频产物导入真实核验项目与完成标记，预检后再次核验且不索取 API 预算', async () => {
  const f = fixture();
  await tool('start_flow').execute(start([step('import', { mediaJobId: 'video-job' })]), f.environment);
  const sent = f.calls.at(-1)!.payload;
  assert.deepEqual(((sent.definition as RecordValue).steps as RecordValue[])[0].parameters, { mediaJobId: 'video-job' });
  assert.equal(sent.maxRequests, undefined); assert.equal(sent.budgetScopeId, undefined); assert.equal(f.state.mediaJob.assetsCommitted, false);
  assert.deepEqual(f.calls.filter(call => ['media.job.get', 'flow.preflight', 'flow.create'].includes(call.command)).map(call => call.command),
    ['media.job.get', 'flow.preflight', 'media.job.get', 'flow.create']);
  for (const change of [{ status: 'running' }, { status: 'cancelled' }, { artifactCommitted: false }, { kind: 'image_screening' }, { projectId: 'outside' }, { id: 'wrong' }]) {
    const test = fixture(); Object.assign(test.state.mediaJob, change);
    await assert.rejects(tool('preflight_flow').execute(start([step('import', { mediaJobId: 'video-job' })]), test.environment));
    assert.equal(test.mutations().length, 0);
  }
  const changed = fixture(); changed.state.invalidateVideoAfterPreflight = true;
  await assert.rejects(tool('start_flow').execute(start([step('import', { mediaJobId: 'video-job' })]), changed.environment), { code: 'MEDIA_ARTIFACT_REQUIRED' });
  assert.equal(changed.mutations().length, 0);
  const unavailable = fixture(); unavailable.state.mediaUnavailable = true;
  await assert.rejects(tool('preflight_flow').execute(start([step('import', { mediaJobId: 'video-job' })]), unavailable.environment), { code: 'MEDIA_CAPABILITY_REQUIRED' });
  assert.equal(unavailable.calls.some(call => call.command === 'flow.preflight'), false);
  await assert.rejects(tool('preflight_flow').execute(start([step('import', { mediaJobId: 'video-job', paths: [] })]), f.environment), /不支持的参数/);
});

test('视频导入不突破明确素材范围，历史 mediaJobId 原样保存且与路径互斥', async () => {
  const f = fixture({ assetIds: ['a', 'b'] });
  await assert.rejects(tool('start_flow').execute(start([step('import', { mediaJobId: 'video-job' })]), f.environment), /尚未入库|范围/);
  f.state.videoFrames.forEach((frame, index) => frame.assetId = ['a', 'b'][index]); f.state.mediaJob.assetsCommitted = true;
  await tool('start_flow').execute(start([step('import', { mediaJobId: 'video-job' })]), f.environment);
  await assert.rejects(tool('preflight_flow').execute(start([step('import', { mediaJobId: 'video-job' })], { source: 'project', selection: 'explicit', assetIds: ['a'] }), f.environment), /当前范围外|范围/);
  f.state.run.definition = definition(step('import', { mediaJobId: 'video-job' })); const before = structuredClone(f.state.run.definition);
  await tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'import' }, f.environment);
  assert.deepEqual(f.calls.at(-1)!.payload.definition, before); assert.deepEqual(f.state.run.definition, before);
  ((f.state.run.definition as RecordValue).steps as RecordValue[])[0].parameters = { mediaJobId: 'video-job', paths: [] };
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'import' }, f.environment), /不能同时/);
  f.state.run.definition = definition(step('import', { paths: ['D:/private/inject.png'] }));
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'import' }, f.environment), /文件导入/);
  assert.equal(f.calls.some(call => /media\.(video\.(create|import)|runtime)/.test(call.command)), false);
});

test('流程筛选严格校验参数和明确排除范围，不从近重复或模糊建议合成排除', async () => {
  const f = fixture({ assetIds: ['a', 'b'], maxRequests: null });
  const screening = { nearEnabled: true, blurEnabled: true, blurThreshold: 0, nearMaxDistance: 64, aspectRatioTolerance: 1, maxComparisons: 0, maxPairs: 0 };
  await tool('start_flow').execute(start([step('filter', { screening })]), f.environment);
  let payload = f.calls.at(-1)!.payload, parameters = ((payload.definition as RecordValue).steps as RecordValue[])[0].parameters as RecordValue;
  assert.equal(parameters.excludeAssetIds, undefined); assert.deepEqual(parameters, { screening }); assert.equal(payload.maxRequests, undefined);
  await tool('preflight_flow').execute(start([step('filter', { screening, excludeAssetIds: ['b'] })]), f.environment);
  payload = f.calls.at(-1)!.payload; parameters = ((payload.definition as RecordValue).steps as RecordValue[])[0].parameters as RecordValue;
  assert.deepEqual(parameters.excludeAssetIds, ['b']); assert.equal(f.state.assets.get('b')!.status, 'confirmed');
  for (const parameters of [{ screening: { nearEnabled: 'true' } }, { screening: { maxComparisons: 2000001 } }, { screening: { maxPairs: -1 } },
    { screening: { blurEnabled: true } }, { screening: { blurThreshold: Infinity } }, { screening: { arbitrary: true } }, { excludeAssetIds: ['a', 'a'] },
    { excludeAssetIds: ['outside'] }, { excludeAssetIds: [] }]) await assert.rejects(tool('preflight_flow').execute(start([step('filter', parameters)]), f.environment));
  await assert.rejects(tool('preflight_flow').execute(start([step('filter', { excludeAssetIds: ['b'] })], { source: 'project', selection: 'explicit', assetIds: ['a'] }), f.environment), /流程输入/);
  assert.equal(f.calls.some(call => call.command === 'media.screening.create'), false);
});

test('历史筛选按该节点冻结输入核范围，保留原参数与人工建议，摘要仅白名单来源', async () => {
  const f = fixture();
  f.state.items = [item('a', 0)]; f.state.filterItems = [item('a', 0), item('b', 1)];
  f.state.run.steps = [{ stepId: 'filter', kind: 'filter', inputArtifactId: 'filter-input' }];
  f.state.run.definition = definition(step('filter', { screening: { nearEnabled: false, blurEnabled: null, maxPairs: 0 }, excludeAssetIds: ['b'] }));
  const original = structuredClone(f.state.run.definition);
  await tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'filter' }, f.environment);
  assert.deepEqual(f.calls.at(-1)!.payload.definition, original); assert.deepEqual(f.state.run.definition, original);
  assert.equal(f.calls.at(-1)!.payload.maxRequests, undefined);
  ((f.state.run.definition as RecordValue).steps as RecordValue[])[0].parameters = { excludeAssetIds: ['outside'] };
  await assert.rejects(tool('rerun_flow').execute({ flowRunId: 'flow', fromStepId: 'filter' }, f.environment), /流程输入/);
  f.state.items = [{ ...item('b', 0), outcome: 'included', screeningRecommendation: 'keep_protected',
    screeningReasons: [{ code: 'blur_candidate', score: 2, threshold: 10, requiresReview: true, raw: '内部筛选原文', path: 'D:/private/result' }],
    metadata: { sourceVideoId: 'source-video', sourcePts: '90071992547409911', timeSeconds: 2, privatePath: 'D:/private/source', frames: ['内部筛选原文'] } }];
  const artifact = await tool('inspect_flow_artifact').execute({ artifactId: 'artifact' }, f.environment) as RecordValue;
  const row = (artifact.items as RecordValue[])[0]; assert.equal(row.screeningRecommendation, 'keep_protected'); assert.equal(row.outcome, 'included');
  assert.deepEqual(row.metadata, { sourceVideoId: 'source-video', sourcePts: '90071992547409911', timeSeconds: 2 });
  assert.deepEqual(row.screeningReasons, [{ code: 'blur_candidate', score: 2, threshold: 10, requiresReview: true }]);
  assert.equal(JSON.stringify(artifact).includes('D:/private'), false); assert.equal(JSON.stringify(artifact).includes('内部筛选原文'), false);
});
