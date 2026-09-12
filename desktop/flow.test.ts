import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineManager } from './engine';
import { CredentialVault } from './vault';
import { PathGrants, authorizeCommandPaths } from './security';
import { assertAgentCommand, validateCommand } from './validation';
import type { EngineEvent } from '../shared/protocol';
import type { FlowArtifact, FlowCapabilities, FlowDefinition, FlowPreflight, FlowRun } from '../shared/flow';

test('真实流程通过桌面严格代理，人工检查暂停后授权继续并产出导出与事件', { skip: process.env.AUTOLABEL_FLOW_INTEGRATION !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-flow-desktop-'));
  const outputDir = path.join(root, 'selected-output'); await mkdir(outputDir);
  const grants = new PathGrants(); await grants.add(outputDir, 'directory');
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: path.join(root, 'data'), credentials: async () => [] });
  const events: EngineEvent[] = []; engine.on('event', event => events.push(event));
  const request = async <T>(command: string, input: Record<string, unknown> = {}): Promise<T> => {
    const checked = validateCommand(command, input);
    if (['flow.resume', 'flow.retry', 'flow.rerun'].includes(command) && !checked.payload.definition) {
      const run = await engine.request('flow.get', { flowRunId: input.flowRunId }) as FlowRun;
      await authorizeCommandPaths(command, { ...checked.payload, definition: run.definition }, grants);
    }
    await authorizeCommandPaths(command, checked.payload, grants);
    return await engine.request(checked.command, checked.payload) as T;
  };
  const waitFor = async (flowRunId: string, predicate: (run: FlowRun) => boolean): Promise<FlowRun> => {
    const deadline = Date.now() + 10000; let run: FlowRun;
    do {
      run = await request<FlowRun>('flow.get', { flowRunId }); if (predicate(run)) return run;
      if (run.status === 'failed') throw new Error(JSON.stringify(run.steps));
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`流程状态未收敛：${JSON.stringify(run!)}`);
  };
  try {
    assert.equal((await engine.start()).state, 'ready');
    const capabilities = await request<FlowCapabilities>('flow.capabilities');
    for (const kind of ['filter', 'review', 'export'] as const) assert.ok(capabilities.availableSteps.includes(kind));
    const project = await request<any>('project.example');
    const assets = await request<any>('asset.list', { projectId: project.id, limit: 1 });
    const source = await request<any>('asset.get', { assetId: assets.items[0].id });
    await request('annotation.save', { assetId: source.id, annotations: source.annotations, baseVersion: source.version, confirm: true });
    const definition: FlowDefinition = { version: 1, name: '桌面路径与人工检查', steps: [
      { id: 'filter.1', kind: 'filter', enabled: true, parameters: { assetIds: [source.id], minWidth: 1, deduplicate: true } },
      { id: 'review.1', kind: 'review', enabled: true, parameters: { buildIssues: false, waitForHuman: true } },
      { id: 'export.1', kind: 'export', enabled: true, parameters: { outputDir, trainRatio: 0.8, onlyConfirmed: true, annotationSelection: 'protected' } },
    ] };
    const input = { projectId: project.id, definition, input: { source: 'project', selection: 'explicit', assetIds: [source.id] } };
    const preflight = await request<FlowPreflight>('flow.preflight', input);
    assert.equal(preflight.canStart, true); assert.equal(preflight.inputCount, 1);
    const created = await request<FlowRun>('flow.create', input);
    const paused = await waitFor(created.id, run => ['paused', 'needs_attention'].includes(run.status) && run.steps.some(step => step.stepId === 'review.1' && ['paused', 'needs_attention'].includes(step.status)));
    assert.equal(paused.steps.find(step => step.stepId === 'export.1')?.outputArtifactId, undefined);
    await assert.rejects(authorizeCommandPaths('flow.resume', { definition: paused.definition }, new PathGrants()));
    assert.throws(() => assertAgentCommand('flow.resume', { flowRunId: created.id, acknowledgeReviewStepId: 'review.1' }));
    await request('flow.resume', { flowRunId: created.id, acknowledgeReviewStepId: 'review.1' });
    const finished = await waitFor(created.id, run => ['completed', 'completed_with_errors'].includes(run.status));
    assert.equal(finished.status, 'completed'); assert.equal(finished.statistics.requestsUsed, 0);
    const artifactId = finished.steps.find(step => step.stepId === 'export.1')?.outputArtifactId;
    assert.ok(artifactId);
    const artifact = await request<FlowArtifact>('flow.artifact', { artifactId, offset: 0, limit: 1 });
    assert.equal(artifact.kind, 'export'); assert.ok(artifact.exportId);
    assert.equal(Object.hasOwn(artifact, 'path'), false);
    const history = await request<unknown>('event.list', { flowRunId: created.id, after: 0 });
    assert.ok(history);
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.flowRunId === created.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(events.some(event => event.flowRunId === created.id));
  } finally {
    await engine.stop();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-flow-desktop-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('真实复用经桌面严格代理与持久凭据恢复，命中零请求且强制重跑生成新尝试', { skip: process.env.AUTOLABEL_REUSE_INTEGRATION !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-reuse-desktop-'));
  let requests = 0; let source: any;
  const server = createServer((incoming, response) => {
    incoming.resume(); incoming.on('end', () => {
      requests++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: 'fixture', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ assetId: source.id, annotations: source.annotations }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  // 夹具只验证绑定的持久化与注入；操作系统加密由独立 Electron 冒烟覆盖。
  const protection = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
  const vault = new CredentialVault(path.join(root, 'vault.json'), protection);
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: path.join(root, 'data'), credentials: () => vault.all() });
  const request = async (command: string, input: Record<string, unknown> = {}): Promise<any> => {
    const checked = validateCommand(command, input); return engine.request(checked.command, checked.payload);
  };
  const finished = async (input: Record<string, unknown>): Promise<any> => {
    let run = await request('run.create', input); const deadline = Date.now() + 10000;
    do {
      run = await request('run.get', { runId: run.id });
      if (run.status === 'completed') return run;
      assert.ok(!['failed', 'completed_with_errors', 'paused', 'cancelled'].includes(run.status), JSON.stringify(run));
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`复用运行未收敛：${JSON.stringify(run)}`);
  };
  try {
    assert.equal((await engine.start()).state, 'ready');
    const project = await request('project.example');
    const assets = await request('asset.list', { projectId: project.id, limit: 1 });
    source = await request('asset.get', { assetId: assets.items[0].id });
    const provider = await request('provider.save', { name: '桌面复用夹具', baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'chat-completions' });
    const saved = await vault.set(provider.id, 'reuse-desktop-fixture');
    await engine.setCredential(provider.id, 'reuse-desktop-fixture', saved.credentialBindingVersion);
    const input = { projectId: project.id, providerId: provider.id, model: 'fixture', prompt: '返回基准图标注', assetIds: [source.id],
      concurrency: 1, maxRequests: 1, budgetScopeId: 'desktop-reuse', reuseEnabled: true, reuseMaxAgeSeconds: null };
    const first = await finished(input);
    assert.equal(requests, 1); assert.equal(first.requestsUsed, 1);
    const firstAttempts = await request('run.attempts', { runId: first.id }); assert.equal(firstAttempts.length, 1);
    await engine.stop(); assert.equal((await engine.start()).state, 'ready');
    assert.equal((await vault.all())[0].credentialBindingVersion, saved.credentialBindingVersion);
    const reused = await finished(input);
    assert.equal(requests, 1); assert.equal(reused.requestsUsed, 0); assert.equal(reused.budget.requestsUsed, 1);
    assert.equal(reused.statistics.succeeded, 1); assert.equal(reused.statistics.reused, 1);
    assert.deepEqual(await request('run.attempts', { runId: reused.id }), []);
    const sample = reused.samples[0]; assert.equal(sample.reused, true); assert.equal(sample.attemptCount, 0);
    assert.equal(sample.reusedFrom.sourceRunId, first.id); assert.equal(sample.reusedFrom.sourceAttemptId, firstAttempts[0].id);
    const history = await request('annotation.history', { assetId: source.id });
    const candidate = history.find((entry: any) => entry.version === sample.candidateVersion);
    assert.equal(candidate.status, 'candidate'); assert.equal(candidate.reused, true);
    assert.deepEqual(candidate.reusedFrom, sample.reusedFrom); assert.equal(Object.hasOwn(candidate, 'attemptId'), false);
    const forced = await finished({ ...input, budgetScopeId: 'desktop-force', forceRerun: true, reuseMaxAgeSeconds: 3600 });
    assert.equal(requests, 2); assert.equal(forced.requestsUsed, 1); assert.equal(forced.statistics.reused, 0);
    assert.equal((await request('run.attempts', { runId: forced.id })).length, 1);
    assert.equal(Object.hasOwn(forced.samples[0], 'reusedFrom'), false);
  } finally {
    await engine.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-reuse-desktop-'));
    await rm(root, { recursive: true, force: true });
  }
});
