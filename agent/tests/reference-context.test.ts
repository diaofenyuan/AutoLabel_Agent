import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AgentController } from '../orchestrator.ts';
import { findTool } from '../tools.ts';
import type { AgentContext, EngineClient } from '../types.ts';

const project = { id: 'project', classes: [{ id: 'object' }], assetCount: 2,
  settings: { annotationProviderId: 'configured', annotationModel: 'vision', prompt: '项目规则', concurrency: 2, maxRequests: 20 } };
const args = { assetIds: ['target'], prompt: null, concurrency: null };
function fixture(context: AgentContext = {}, settings: Record<string, unknown> = project.settings) {
  const submissions: Record<string, unknown>[] = [];
  const state = { reference: { id: 'reference', projectId: 'project', status: 'modified', source: 'manual' } };
  const engine: EngineClient = { async request<T>(command: string, payload: Record<string, unknown> = {}) {
    if (command === 'project.open') return { ...project, settings } as T;
    if (command === 'asset.get') return (payload.assetId === 'reference' ? state.reference : { id: payload.assetId, projectId: 'project' }) as T;
    if (command === 'run.create') { submissions.push(payload); return { id: 'created' } as T; }
    throw new Error(command);
  } };
  return { submissions, state, environment: { engine, projectId: 'project', context, openAsset() {} } };
}

test('助手使用项目角色模型和并发，显式无上限不会退回项目额度', async () => {
  const inherited = fixture();
  await findTool('run_annotation').execute(args, inherited.environment);
  assert.equal(inherited.submissions[0].providerId, 'configured');
  assert.equal(inherited.submissions[0].model, 'vision');
  assert.equal(inherited.submissions[0].concurrency, 2);
  assert.equal(inherited.submissions[0].maxRequests, 20);
  const cleared = fixture({ maxRequests: null, concurrency: 1 });
  await findTool('run_annotation').execute(args, cleared.environment);
  assert.equal(cleared.submissions[0].maxRequests, undefined);
  assert.equal(cleared.submissions[0].concurrency, 1);
  const changed = fixture({ annotationProviderId: 'another' });
  await assert.rejects(findTool('run_annotation').execute(args, changed.environment), /当前接口选择模型/);
  assert.equal(changed.submissions.length, 0);
});

test('助手标注沿用项目区域并发送缩小副本，坏区域在提交前拒绝', async () => {
  const region = { left: 0.08, top: 0.12, right: 0.92, bottom: 0.88 };
  const f = fixture({}, { ...project.settings, annotationRegion: region });
  await findTool('run_annotation').execute(args, f.environment);
  assert.deepEqual(f.submissions[0].payload, { maxEdge: 1920, quality: 92, region });

  const invalid = fixture({}, { ...project.settings, annotationRegion: { left: 0.5, top: 0.1, right: 0.51, bottom: 0.9 } });
  await assert.rejects(findTool('run_annotation').execute(args, invalid.environment), /区域无效或过小/);
  assert.equal(invalid.submissions.length, 0);
});

test('明确人工参考可送入任务，跨项目、候选及目标重叠均在提交前阻断', async () => {
  const f = fixture({ referenceAssetIds: ['reference'] });
  await findTool('run_annotation').execute(args, f.environment);
  assert.deepEqual(f.submissions[0].referenceAssetIds, ['reference']);
  f.state.reference.source = 'api';
  await assert.rejects(findTool('run_annotation').execute(args, f.environment), /人工修改或确认/);
  f.state.reference.source = 'manual'; f.state.reference.projectId = 'other';
  await assert.rejects(findTool('run_annotation').execute(args, f.environment), /不属于当前项目/);
  f.state.reference.projectId = 'project';
  await assert.rejects(findTool('run_annotation').execute({ ...args, assetIds: ['reference'] }, f.environment), /同时作为/);
  await assert.rejects(findTool('run_annotation').execute({ ...args, assetIds: null }, f.environment), /明确选择待标注图片/);
  assert.equal(f.submissions.length, 1);
});

test('助手上下文接受显式空预算，拒绝重复参考和超限并发', async () => {
  let requests = 0;
  const agent = new AgentController({ async request<T>(command: string, payload: Record<string, unknown> = {}) {
    requests++;
    if (command === 'provider.capabilities') return { tools: 'unverified' } as T;
    assert.equal(payload.maxRequests, undefined);
    return { content: '配置已读取' } as T;
  } });
  const input = { sessionId: 'session', providerId: 'configured', model: 'chat', messages: [{ role: 'user' as const, content: '查看配置' }] };
  const result = await agent.run({ ...input, context: { maxRequests: null, concurrency: 1, referenceAssetIds: [] } });
  assert.equal(result.status, 'completed');
  await assert.rejects(agent.run({ ...input, context: { referenceAssetIds: ['reference', 'reference'] } }), /人工参考不能重复/);
  await assert.rejects(agent.run({ ...input, context: { concurrency: 33 } }), /并发数/);
  assert.equal(requests, 2);
});

test('共享参考仅传递用户选定的固定版本和映射，重复资源拒绝', async () => {
  const selection = { resourceId: 'reference-resource', version: 2, classMap: { source: 'object' } };
  const f = fixture({ referenceResources: [selection] });
  await findTool('run_annotation').execute(args, f.environment);
  assert.deepEqual(f.submissions[0].referenceResources, [selection]);
  const agent = new AgentController({ async request<T>() { throw new Error('不应发送请求'); } });
  await assert.rejects(agent.run({ sessionId: 'session', providerId: 'configured', model: 'chat',
    messages: [{ role: 'user', content: '开始标注' }], context: { referenceResources: [selection, selection] } }), /不能重复选择/);
  await assert.rejects(agent.run({ sessionId: 'session', providerId: 'configured', model: 'chat',
    messages: [{ role: 'user', content: '开始标注' }], context: { referenceResources: [{ ...selection, version: -1 }] } }), /参考版本/);
});

test('单次标注明确传递复用策略，非法值不能进入队列', async () => {
  const f = fixture();
  await findTool('run_annotation').execute({ ...args, reuseEnabled: false, forceRerun: true, reuseMaxAgeSeconds: null }, f.environment);
  assert.equal(f.submissions[0].reuseEnabled, false);
  assert.equal(f.submissions[0].forceRerun, true);
  assert.equal(f.submissions[0].reuseMaxAgeSeconds, null);
  await findTool('run_annotation').execute({ ...args, reuseEnabled: true, forceRerun: false, reuseMaxAgeSeconds: 3600 }, f.environment);
  assert.equal(f.submissions[1].reuseMaxAgeSeconds, 3600);
  for (const policy of [{ reuseEnabled: 'false' }, { forceRerun: 1 }, { reuseMaxAgeSeconds: 0 },
    { reuseMaxAgeSeconds: 1.5 }, { reuseMaxAgeSeconds: Number.MAX_SAFE_INTEGER + 1 }])
    await assert.rejects(findTool('run_annotation').execute({ ...args, ...policy }, f.environment), /必须为布尔值|复用最长时间/);
  assert.equal(f.submissions.length, 2);
});
