import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AgentController } from '../agent/orchestrator.ts';
import { AgentError } from '../agent/validation.ts';
import { findTool } from '../agent/tools.ts';
import type { EngineClient } from '../agent/types.ts';
import type { Evaluation, QualityMetrics } from '../shared/quality.ts';
import type { FlowArtifact, FlowDefinition, FlowRun, FlowRerunResult } from '../shared/flow.ts';
import type { InputResult, LoadedLocalModel, LocalModel, LocalRuntimeState } from '../shared/inference.ts';
import { validateMediaFlow } from './validate-media-flow.mts';

const root = path.resolve(import.meta.dirname, '..');
const localMode = process.argv.includes('--local-flow');
const mediaMode = process.argv.includes('--media-flow');
assert.ok(!(localMode && mediaMode), '本地专项与视频专项分别运行，避免重复模型计算');
if (localMode || mediaMode) {
  for (const name of ['AUTOLABEL_ENGINE_JAR', 'AUTOLABEL_PYTHON_PATH', 'AUTOLABEL_INFERENCE_DIR'])
    assert.ok(process.env[name] && path.isAbsolute(process.env[name]!), `模型专项需要显式绝对路径 ${name}`);
}
if (mediaMode) for (const name of ['AUTOLABEL_FFMPEG_PATH', 'AUTOLABEL_FFPROBE_PATH', 'AUTOLABEL_VIDEO_SOURCE'])
  assert.ok(process.env[name] && path.isAbsolute(process.env[name]!), `--media-flow 需要显式绝对路径 ${name}`);
const dataDir = path.join(root, '.qa', `agent-integration-${Date.now()}`);
await mkdir(dataDir, { recursive: true });
let requests = 0;
let annotationRequests = 0;
let truthLeaked = false;
let qualityComparison: Record<string, unknown> | undefined;
let freshComparison: Record<string, unknown> | undefined;
let flowRequest: Record<string, unknown> | undefined;
let annotationPolicy: Record<string, unknown> | undefined;
const receivedReferences: Array<{ assetId: string; annotations: Array<{ classId: string; bbox: { x: number } }> }> = [];
const provider = createServer(async (incoming, outgoing) => {
  let raw = '';
  for await (const part of incoming) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  truthLeaked ||= raw.includes('fixture-truth-');
  requests++;
  const tools = body.tools ?? [];
  const names = tools.map((tool: { function: { name: string } }) => tool.function.name);
  let message: Record<string, unknown>;
  if (names.includes('report_status')) {
    message = { role: 'assistant', content: '', tool_calls: [{ id: 'proof-1', type: 'function',
      function: { name: 'report_status', arguments: '{"status":"ok"}' } }] };
  } else if (names.includes('run_annotation')) {
    if (body.messages.some((item: { role: string }) => item.role === 'tool')) message = { role: 'assistant', content: flowRequest
      ? '流程已提交，请查询实际步骤状态；等待人工检查时需要用户放行。' : freshComparison
      ? '固定图片的两个方案已提交，请查询实际状态后再生成指标。' : qualityComparison
      ? '已有结果评测已生成，未重新标注图片，请检查实际指标。'
      : '标注任务已经提交，请在任务中心查看实际进度。' };
    else if (flowRequest) message = { role: 'assistant', content: '', tool_calls: [{ id: 'flow-1', type: 'function',
      function: { name: 'start_flow', arguments: JSON.stringify(flowRequest) } }] };
    else if (freshComparison) message = { role: 'assistant', content: '', tool_calls: [{ id: 'fresh-1', type: 'function',
      function: { name: 'run_evaluation', arguments: JSON.stringify(freshComparison) } }] };
    else if (qualityComparison) message = { role: 'assistant', content: '', tool_calls: [{ id: 'quality-1', type: 'function',
      function: { name: 'compare_results', arguments: JSON.stringify(qualityComparison) } }] };
    else message = { role: 'assistant', content: '', tool_calls: [{ id: 'action-1', type: 'function',
      function: { name: 'run_annotation', arguments: JSON.stringify({ assetIds: null, prompt: null, concurrency: 2, ...annotationPolicy }) } }] };
  } else if ((body.messages ?? []).some((item: { content: unknown }) => Array.isArray(item.content)
    && item.content.some((part: { text?: string }) => part.text === 'Return exactly a JSON object with ok=true.'))) {
    message = { role: 'assistant', content: '{"ok":true}' };
  } else if ((body.messages ?? []).some((item: { content: unknown }) => Array.isArray(item.content)
    && item.content.some((part: { text?: string }) => part.text === 'Reply OK. If images are attached, state their count.'))) {
    const count = body.messages.flatMap((item: { content: unknown }) => Array.isArray(item.content) ? item.content : [])
      .filter((part: { type: string }) => part.type === 'image_url').length;
    message = { role: 'assistant', content: `OK. ${count} image(s).` };
  } else {
    annotationRequests++;
    const parts = (body.messages ?? []).flatMap((item: { content: unknown }) => Array.isArray(item.content) ? item.content : []);
    let target: { assetId?: string } | undefined;
    let classId = 'vehicle';
    for (const part of parts) {
      if (part.type !== 'text') continue;
      try {
        const value = JSON.parse(part.text);
        if (value.role === 'target') target = value;
        const classes = value.template?.classes ?? value.classes;
        if (Array.isArray(classes) && classes[0]?.id) classId = classes[0].id;
        if (value.role === 'reference') receivedReferences.push(value);
      } catch { /* 非 JSON 提示词不是素材身份。 */ }
    }
    message = { role: 'assistant', content: JSON.stringify({ assetId: target?.assetId, annotations: [{ id: 'local-protocol-candidate', classId,
      type: 'detect', bbox: { x: 221, y: 483, width: 537, height: 350 } }] }) };
  }
  outgoing.writeHead(200, { 'Content-Type': 'application/json' });
  outgoing.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, prompt_tokens_details: { cached_tokens: 2 } } }));
});
const javaHome = (await readFile(path.join(root, 'engine/build/runtime-path.txt'), 'utf8')).trim();
const token = randomUUID() + randomUUID();
const runtimeJar = path.join(dataDir, 'engine.jar');
await copyFile(process.env.AUTOLABEL_ENGINE_JAR ?? path.join(root, 'engine/build/autolabel-engine.jar'), runtimeJar);
let localStartup: Record<string, unknown> = {};
let localModelPath: string | undefined;
if (localMode || mediaMode) {
  const python = process.env.AUTOLABEL_PYTHON_PATH;
  assert.ok(python && path.isAbsolute(python), '--local-flow 需要显式 AUTOLABEL_PYTHON_PATH');
  localModelPath = path.resolve(process.env.AUTOLABEL_LOCAL_MODEL ?? path.join(root, '.qa/models/yolo11n.pt'));
  const worker = path.join(dataDir, 'worker.py');
  await copyFile(path.join(process.env.AUTOLABEL_INFERENCE_DIR!, 'worker.py'), worker);
  const modelHash = createHash('sha256').update(await readFile(localModelPath)).digest('hex');
  // 夹具直接启动私有引擎；真实桌面另行验证用户文件选择与作用域授权。
  localStartup = { localPythonPath: python, localWorkerPath: worker, localModelAuthorizations: [{ path: localModelPath, modelHash }] };
}
if (mediaMode) Object.assign(localStartup, {
  mediaFfmpegPath: process.env.AUTOLABEL_FFMPEG_PATH, mediaFfprobePath: process.env.AUTOLABEL_FFPROBE_PATH,
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerAddress = provider.address() as { port: number };
const engine = spawn(path.join(javaHome, 'bin/java.exe'), ['-jar', runtimeJar],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
engine.stderr.resume();
const output = createInterface({ input: engine.stdout });
const ready = new Promise<{ port: number }>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('引擎启动超时')), 15000);
  output.once('line', line => { clearTimeout(timeout); resolve(JSON.parse(line)); });
  engine.once('exit', code => { clearTimeout(timeout); reject(new Error(`引擎提前退出：${code}`)); });
});
engine.stdin.write(JSON.stringify({ token, dataDir, protocolVersion: 1, ...localStartup }) + '\n');
let command: EngineClient['request'];
try {
  const address = await ready;
  command = async <T>(name: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/command`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: name, payload }), signal: AbortSignal.timeout(name === 'local.model.load' ? 180000 : ['local.runtime.probe', 'media.video.inspect'].includes(name) ? 75000 : 15000),
    });
    const result = await response.json() as { ok: boolean; data: T; error: { code: string; message: string } };
    if (!result.ok) throw new AgentError(result.error.code, result.error.message);
    return result.data;
  };
  const p = await command<{ id: string }>('project.example');
  const assetList = await command<{ items: Array<{ id: string; version: number }> }>('asset.list', { projectId: p.id });
  const modelProvider = await command<{ id: string }>('provider.save', { name: '隔离协议验证',
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, protocol: 'chat-completions', timeoutMs: 5000, maxRetries: 0,
    pricing: { model: 'protocol-test', currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 } });
  await command('credential.set', { providerId: modelProvider.id, key: 'local-protocol-fixture',
    ...(process.argv.includes('--reuse') ? { credentialBindingVersion: randomUUID() } : {}) });
  const capability = await command<{ status: string }>('provider.test', { providerId: modelProvider.id, model: 'protocol-test', capability: 'tools' });
  assert.equal(capability.status, 'verified');
  const controller = new AgentController({ request: command });
  const result = await controller.run({ sessionId: randomUUID(), projectId: p.id, providerId: modelProvider.id, model: 'protocol-test',
    messages: [{ role: 'user', content: '按已经设置的规则标注所选素材' }],
    context: { annotationProviderId: modelProvider.id, annotationModel: 'protocol-test', assetIds: [assetList.items[0].id], prompt: '标注车辆', maxRequests: 8 } });
  assert.equal(result.status, 'completed');
  const submitted = result.actions.find(action => action.name === 'run_annotation');
  assert.equal(submitted?.status, 'completed');
  const runId = (submitted!.result as { id: string }).id;
  let run: { status: string; statistics: { succeeded: number }; budget?: { requestsUsed: number; budgetScopeId: string } };
  const deadline = Date.now() + 10000;
  do {
    run = await command('run.get', { runId });
    if (run.statistics.succeeded === 1) break;
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (Date.now() < deadline);
  assert.equal(run.statistics.succeeded, 1, 'Agent 创建的任务没有通过 Java 队列完成');
  const after = await command<{ version: number; status: string }>('asset.get', { assetId: assetList.items[0].id });
  assert.equal(after.version, assetList.items[0].version, '新候选覆盖了人工示例正式版本');
  assert.ok(run.budget, '任务应返回真实共享预算');
  assert.equal(run.budget.budgetScopeId, result.budgetScopeId);
  assert.equal(run.budget.requestsUsed, 3, '两次 Agent 对话和一次标注应纳入同一预算');
  let quality: Record<string, unknown> | undefined;
  let references: Record<string, unknown> | undefined;
  let flow: Record<string, unknown> | undefined;
  let reuse: Record<string, unknown> | undefined;
  let localFlow: Record<string, unknown> | undefined;
  let mediaFlow: Record<string, unknown> | undefined;
  if (process.argv.includes('--quality') || process.argv.includes('--rerun')) {
    const assetId = assetList.items[0].id;
    const set = await command<{ id: string }>('evaluationSet.create', { projectId: p.id, name: '隔离协议真值验证集', assetIds: [assetId] });
    // 测试显式提供独立已知答案，不通过 confirmed 状态或模型候选自动生成真值。
    const truth = await command<{ setRevision: number }>('evaluationSet.saveTruth', {
      setId: set.id, assetId, baseTruthVersion: 0, source: 'manual', note: '本地协议测试夹具，不作为真实模型质量结果',
      annotations: [
        { id: 'fixture-truth-left', classId: 'vehicle', type: 'detect', bbox: { x: 221, y: 483, width: 537, height: 350 } },
        { id: 'fixture-truth-right', classId: 'vehicle', type: 'detect', bbox: { x: 771, y: 512, width: 314, height: 202 } },
      ],
    });
    const published = await command<{ id: string }>('evaluationSet.publish', { setId: set.id, baseSetRevision: truth.setRevision });
    qualityComparison = { setId: set.id, setVersionId: published.id, schemes: [{ runId, name: '既有协议候选' }], iouThreshold: 0.5 };
    const beforeQuality = requests;
    const compared = await controller.run({ sessionId: randomUUID(), projectId: p.id, providerId: modelProvider.id, model: 'protocol-test',
      messages: [{ role: 'user', content: '使用已经发布的独立真值评测已有运行，不再标注图片' }],
      context: { assetIds: [assetId], maxRequests: 4 } });
    assert.equal(compared.status, 'completed');
    const action = compared.actions.find(item => item.name === 'compare_results');
    assert.equal(action?.status, 'completed');
    const created = action!.result as { created: boolean; evaluation: Evaluation };
    assert.equal(created.created, true);
    const metrics: QualityMetrics = created.evaluation.schemes[0].metrics;
    assert.equal(metrics.scorableTruthObjects, 2); assert.equal(metrics.scorablePredictedObjects, 1);
    assert.equal(metrics.matchedObjects, 1); assert.equal(metrics.missedObjects, 1);
    assert.equal(metrics.extraObjects, 0); assert.equal(metrics.meanMatchedIoU, 1);
    assert.equal(metrics.missedRate, 0.5);
    assert.equal(requests - beforeQuality, 2, '既有结果评测只能增加两轮 Agent 对话，不能重跑标注');
    assert.ok(!JSON.stringify(compared.messages).includes('fixture-truth-left'), '独立真值答案进入了模型上下文');
    await command('review.build', { evaluationId: created.evaluation.id });
    const review = await findTool('list_review_items').execute({ offset: null, status: 'pending' }, {
      projectId: p.id, context: {}, engine: { request: command }, openAsset() {},
    }) as { total: number; items: Array<{ reason: string }> };
    assert.equal(review.total, 1); assert.equal(review.items[0].reason, 'missed_object');
    quality = { evaluationId: created.evaluation.id, source: created.evaluation.source,
      matchedObjects: metrics.matchedObjects, missedObjects: metrics.missedObjects, missedRate: metrics.missedRate,
      modelAnnotationRerun: false, truthExcludedFromModelContext: true, reviewIssues: review.total };
    if (process.argv.includes('--rerun')) {
      const annotationBefore = annotationRequests;
      const totalBefore = requests;
      freshComparison = { setId: set.id, setVersionId: published.id, iouThreshold: 0.5, schemes: ['方案一', '独立重复方案'].map(name => ({
        name, providerId: null, model: null, prompt: '标注车辆', referenceAssetIds: null, concurrency: 1,
      })) };
      const rerunContext = { assetIds: [assetId], annotationProviderId: modelProvider.id, annotationModel: 'protocol-test', maxRequests: 8 };
      const rerun = await controller.run({ sessionId: randomUUID(), projectId: p.id, providerId: modelProvider.id, model: 'protocol-test',
        messages: [{ role: 'user', content: '使用已选固定版本真实重跑两个独立方案，保留正式人工版本。' }], context: rerunContext });
      const submittedRerun = rerun.actions.find(item => item.name === 'run_evaluation');
      assert.equal(submittedRerun?.status, 'completed');
      const comparison = (submittedRerun!.result as { created: boolean; comparison: { id: string } }).comparison;
      const env = { projectId: p.id, budgetScopeId: rerun.budgetScopeId, context: rerunContext,
        engine: { request: command }, openAsset() {} };
      let inspected: { canFinish: boolean; schemes: Array<{ statistics: { succeeded: number } }> };
      const until = Date.now() + 12000;
      do {
        inspected = await findTool('inspect_comparison').execute({ comparisonId: comparison.id }, env) as typeof inspected;
        if (inspected.canFinish) break;
        await new Promise(resolve => setTimeout(resolve, 80));
      } while (Date.now() < until);
      assert.equal(inspected.canFinish, true); assert.equal(inspected.schemes.length, 2);
      assert.ok(inspected.schemes.every(scheme => scheme.statistics.succeeded === 1));
      const finished = await findTool('finish_comparison').execute({ comparisonId: comparison.id }, env) as { finished: boolean; evaluation: Evaluation };
      assert.equal(finished.finished, true); assert.equal(finished.evaluation.source, 'fresh_run_snapshot');
      assert.ok(finished.evaluation.schemes.every(scheme => scheme.metrics.matchedObjects === 1 && scheme.metrics.missedObjects === 1));
      const again = await findTool('finish_comparison').execute({ comparisonId: comparison.id }, env) as typeof finished;
      assert.equal(again.evaluation.id, finished.evaluation.id);
      assert.equal(annotationRequests - annotationBefore, 2, '两个重跑方案必须实际发送两张图片请求');
      assert.equal(requests - totalBefore, 4, '重跑与两轮Agent对话必须纳入同一预算');
      const budget = await findTool('inspect_budget').execute({}, env) as { requestsUsed: number; cost: { knownCost: number; unknownCalls: number; hardLimit: boolean } };
      assert.equal(budget.requestsUsed, 4); assert.equal(budget.cost.hardLimit, false); assert.equal(budget.cost.unknownCalls, 0);
      assert.ok(Math.abs(budget.cost.knownCost - 0.000232) < 1e-12, '隔离协议夹具单价与缓存用量计价不一致');
      const estimateArgs = { requests: 2, inputTokensPerRequest: 100, outputTokensPerRequest: 50, cachedInputTokensPerRequest: null };
      const unknown = await findTool('estimate_cost').execute(estimateArgs, env) as { estimatedCost: number | null };
      assert.equal(unknown.estimatedCost, null, '未提供缓存假设不能编造精确费用');
      const estimate = await findTool('estimate_cost').execute({ ...estimateArgs, cachedInputTokensPerRequest: 20 }, env) as { estimatedCost: number };
      assert.ok(Math.abs(estimate.estimatedCost - 0.00076) < 1e-12);
      const protectedAsset = await command<{ version: number }>('asset.get', { assetId });
      assert.equal(protectedAsset.version, assetList.items[0].version);
      assert.equal(truthLeaked, false, '独立真值进入了真实HTTP模型请求');
      quality.rerun = { source: finished.evaluation.source, schemes: 2, annotationRequests: 2, sharedRequests: budget.requestsUsed,
        fixturePriceKnownCost: budget.cost.knownCost, hardCostLimit: false, missingCacheEstimateUnknown: true,
        repeatedFinishStable: true, formalVersionProtected: true, truthExcludedFromHttp: true };
    }
  }
  if (process.argv.includes('--references')) {
    qualityComparison = undefined; freshComparison = undefined;
    const original = await command<{ id: string; version: number; annotations: Array<{ bbox: { x: number } }> }>('asset.get', { assetId: assetList.items[0].id });
    const saved = await command<{ id: string; version: number; content: { template: { classes: Array<{ id: string; name: string; color: string }> } } }>('resource.reference', {
      assetId: original.id, assetVersion: original.version, name: '跨项目人工参考', note: '本地协议测试的明确人工参考说明',
    });
    const classes = saved.content.template.classes.map(item => ({ ...item, id: `target-${item.id}` }));
    const classMap = Object.fromEntries(saved.content.template.classes.map((item, index) => [item.id, classes[index].id]));
    const targetProject = await command<{ id: string }>('project.create', { name: '跨项目参考目标', taskType: 'detect', classes,
      settings: { annotationProviderId: modelProvider.id, annotationModel: 'protocol-test', prompt: '使用明确的人工参考标注车辆' } });
    const imported = await command<{ assetIds: string[]; imported: number }>('asset.import', {
      projectId: targetProject.id, paths: [path.join(root, '.qa/models/bus.jpg')], mode: 'copy',
    });
    assert.equal(imported.imported, 1);
    const modified = structuredClone(original.annotations); modified[0].bbox.x += 10;
    const editedSource = await command<{ version: number }>('annotation.save', { assetId: original.id, baseVersion: original.version, annotations: modified });
    const priorAnnotations = annotationRequests;
    const response = await controller.run({ sessionId: randomUUID(), projectId: targetProject.id, providerId: modelProvider.id, model: 'protocol-test',
      messages: [{ role: 'user', content: '按项目配置标注当前目标，使用已经选择的共享参考。' }],
      context: { assetIds: imported.assetIds, maxRequests: 8, referenceResources: [{ resourceId: saved.id, version: saved.version, classMap }] } });
    const action = response.actions.find(item => item.name === 'run_annotation');
    assert.equal(action?.status, 'completed', JSON.stringify(action?.result));
    const nextRunId = (action!.result as { id: string }).id;
    let nextRun: { statistics: { succeeded: number }; snapshot: { references: Array<{ resourceId: string; resourceVersion: number }> }; budget: { requestsUsed: number } };
    const until = Date.now() + 12000;
    do {
      nextRun = await command('run.get', { runId: nextRunId });
      if (nextRun.statistics.succeeded === 1) break;
      await new Promise(resolve => setTimeout(resolve, 80));
    } while (Date.now() < until);
    assert.equal(nextRun.statistics.succeeded, 1);
    assert.equal(nextRun.budget.requestsUsed, 3);
    assert.equal(annotationRequests - priorAnnotations, 1);
    assert.equal(nextRun.snapshot.references[0].resourceId, saved.id);
    assert.equal(nextRun.snapshot.references[0].resourceVersion, saved.version);
    assert.equal(receivedReferences.at(-1)?.annotations[0].bbox.x, original.annotations[0].bbox.x, '源素材后续修改污染了已发布人工参考');
    assert.equal(receivedReferences.at(-1)?.annotations[0].classId, classes[0].id, '跨项目明确类别映射未进入请求');
    assert.ok(editedSource.version > original.version);
    assert.equal((await command<{ version: number }>('asset.get', { assetId: original.id })).version, editedSource.version);
    references = { crossProject: true, mappedClasses: true, sourceEditDidNotChangeSnapshot: true,
      resourceVersion: saved.version, annotationRequests: 1, sharedRequests: nextRun.budget.requestsUsed };
  }
  if (process.argv.includes('--flow')) {
    qualityComparison = undefined; freshComparison = undefined;
    for (const capability of ['image', 'structured']) {
      const tested = await command<{ status: string }>('provider.test', { providerId: modelProvider.id, model: 'protocol-test', capability });
      assert.equal(tested.status, 'verified', `流程接口未通过 ${capability} 能力测试`);
    }
    const assetId = assetList.items[0].id;
    const original = await command<{ version: number; annotations: Array<{ bbox: { x: number } }> }>('asset.get', { assetId });
    const definition: FlowDefinition = { version: 1, name: '助手五步实际执行', steps: [
      { id: 'import', kind: 'import', enabled: true, parameters: {} },
      { id: 'filter', kind: 'filter', enabled: true, parameters: { minWidth: 1, deduplicate: true } },
      { id: 'api', kind: 'api', enabled: true, parameters: { providerId: null, model: null, prompt: '标注车辆', concurrency: 1, maxRetries: 0, maxRequests: 3 } },
      { id: 'review', kind: 'review', enabled: true, parameters: { buildIssues: true, waitForHuman: true, randomSample: { count: 1, seed: 'fixed-flow-check' } } },
      { id: 'export', kind: 'export', enabled: true, parameters: { trainRatio: 0.8, onlyConfirmed: false, annotationSelection: 'protected' } },
    ] };
    flowRequest = { definition, input: { source: 'project', selection: 'all' }, execution: null, failurePolicy: 'continue' };
    const context = { assetIds: [assetId], annotationProviderId: modelProvider.id, annotationModel: 'protocol-test',
      prompt: '标注车辆', maxRequests: 8, exportDir: path.join(dataDir, '流程导出') };
    const beforeAnnotations = annotationRequests, beforeRequests = requests;
    const answer = await controller.run({ sessionId: randomUUID(), projectId: p.id, providerId: modelProvider.id, model: 'protocol-test',
      messages: [{ role: 'user', content: '对选中的素材执行筛选、标注、人工检查后导出的五步流程。' }], context });
    assert.equal(answer.status, 'completed');
    const submitted = answer.actions.find(action => action.name === 'start_flow');
    assert.equal(submitted?.status, 'completed', JSON.stringify(submitted?.result));
    const created = submitted!.result as { started: boolean; run: FlowRun };
    assert.equal(created.started, true);
    const env = { engine: { request: command }, projectId: p.id, context, budgetScopeId: answer.budgetScopeId, openAsset() {} };
    const waitFlow = async (flowRunId: string, status: string) => {
      const until = Date.now() + 20000;
      let current: FlowRun;
      do {
        current = await command<FlowRun>('flow.get', { flowRunId });
        if (current.status === status) return current;
        if (['failed', 'cancelled'].includes(current.status)) break;
        await new Promise(resolve => setTimeout(resolve, 80));
      } while (Date.now() < until);
      assert.equal(current!.status, status, JSON.stringify(current!.steps));
      return current!;
    };
    const paused = await waitFlow(created.run.id, 'needs_attention');
    assert.equal(paused.steps.find(step => step.stepId === 'api')?.statistics.succeeded, 1);
    assert.equal(paused.steps.find(step => step.stepId === 'export')?.status, 'pending');
    assert.equal(annotationRequests - beforeAnnotations, 1);
    assert.equal(requests - beforeRequests, 3);
    assert.equal(paused.budget?.budgetScopeId, answer.budgetScopeId);
    assert.equal(paused.budget?.requestsUsed, 3, '流程 API 和两次助手对话应共用请求预算');
    const apiStep = paused.steps.find(step => step.stepId === 'api')!;
    const artifact = await findTool('inspect_flow_artifact').execute({ artifactId: apiStep.outputArtifactId, offset: 0, limit: 100 }, env) as FlowArtifact;
    assert.equal(artifact.total, 1); assert.equal(artifact.items[0].assetId, assetId);
    assert.ok(artifact.items[0].candidateVersion! > original.version);
    assert.equal((await command<{ version: number }>('asset.get', { assetId })).version, original.version, 'API 候选覆盖了人工正式版本');
    await assert.rejects(findTool('control_flow').execute({ flowRunId: paused.id, action: 'resume' }, env),
      (error: unknown) => error instanceof AgentError && error.code === 'FLOW_HUMAN_REVIEW_REQUIRED');
    // 用显式人工动作模拟工作台保存和复核放行，助手本身不能越过这一步。
    const changed = structuredClone(original.annotations); changed[0].bbox.x += 7;
    const edited = await command<{ version: number }>('annotation.save', { assetId, baseVersion: original.version, annotations: changed });
    await command('flow.resume', { flowRunId: paused.id, acknowledgeReviewStepId: 'review' });
    const completed = await waitFlow(paused.id, 'completed');
    const exportArtifact = await command<FlowArtifact>('flow.artifact', { artifactId: completed.steps.find(step => step.stepId === 'export')!.outputArtifactId });
    const exports = await command<Array<{ id: string; path: string }>>('export.list', { projectId: p.id });
    const exported = exports.find(item => item.id === exportArtifact.exportId)!;
    assert.ok(exported, '导出产物必须关联真实导出记录');
    const manifest = JSON.parse(await readFile(path.join(exported.path, 'manifest.json'), 'utf8'));
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0].version, original.version, '流程导出错误读取了后续正式版本');
    assert.deepEqual(manifest.assets[0].annotations, original.annotations);
    assert.equal((await command<{ version: number }>('asset.get', { assetId })).version, edited.version);
    const beforeRerun = requests;
    const rerun = await findTool('rerun_flow').execute({ flowRunId: paused.id, fromStepId: 'export' }, env) as FlowRerunResult;
    assert.notEqual(rerun.run.id, paused.id); assert.deepEqual(rerun.invalidatedStepIds, ['export']);
    const rerunDone = await waitFlow(rerun.run.id, 'completed');
    assert.equal(requests, beforeRerun, '仅重跑导出不能再次请求标注');
    assert.equal(rerunDone.steps.find(step => step.stepId === 'api')?.outputArtifactId, apiStep.outputArtifactId);
    const events = await command<Array<{ sequence: number; flowRunId?: string; stepId?: string; runId?: string }>>('event.list', { flowRunId: paused.id, after: 0, limit: 2000 });
    assert.ok(events.length > 0 && events.every(event => event.flowRunId === paused.id));
    assert.equal(new Set(events.map(event => event.sequence)).size, events.length);
    assert.ok(events.some(event => event.stepId === 'api' && event.runId === apiStep.childRunId), '单图 API 事件缺少父流程与步骤关联');
    flow = { flowRunId: paused.id, status: completed.status, steps: completed.steps.map(step => ({ id: step.stepId, status: step.status })),
      sharedRequests: paused.budget!.requestsUsed, annotationRequests: 1, fixedInputAssets: artifact.total,
      manualGateRespected: true, fixedExportVersion: original.version, currentManualVersion: edited.version,
      exportOnlyRerun: rerun.run.id, rerunAddedRequests: 0, correlatedEvents: events.length };
  }
  if (process.argv.includes('--reuse')) {
    flowRequest = undefined; freshComparison = undefined; qualityComparison = undefined;
    const assetId = assetList.items[0].id;
    const baseline = await command<{ version: number; status: string }>('asset.get', { assetId });
    let sourceRunId = runId;
    const checks: Array<Record<string, unknown>> = [];
    for (const forced of [false, true, false]) {
      const before = annotationRequests;
      annotationPolicy = { reuseEnabled: true, forceRerun: forced, reuseMaxAgeSeconds: null };
      const response = await controller.run({ sessionId: randomUUID(), projectId: p.id, providerId: modelProvider.id, model: 'protocol-test',
        messages: [{ role: 'user', content: forced ? '对当前选中素材强制重新调用标注。' : '使用相同配置标注，允许复用历史候选。' }],
        context: { annotationProviderId: modelProvider.id, annotationModel: 'protocol-test', assetIds: [assetId], prompt: '标注车辆', maxRequests: 8 } });
      assert.equal(response.status, 'completed');
      const action = response.actions.find(item => item.name === 'run_annotation');
      assert.equal(action?.status, 'completed', JSON.stringify(action?.result));
      const id = (action!.result as { id: string }).id;
      type ReuseRun = { status: string; requestsUsed: number; statistics: { succeeded: number; reused: number };
        budget: { requestsUsed: number }; samples: Array<{ reused?: boolean; attemptCount: number;
          reusedFrom?: { sourceRunId: string; sourceAttemptId: string; sourceCandidateVersion: number } }> };
      let completed: ReuseRun | undefined;
      const until = Date.now() + 12000;
      do {
        completed = await command<ReuseRun>('run.get', { runId: id });
        if (completed.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 80));
      } while (Date.now() < until);
      assert.equal(completed!.status, 'completed');
      assert.equal(completed!.statistics.succeeded, 1);
      assert.equal(completed!.statistics.reused, forced ? 0 : 1);
      assert.equal(completed!.requestsUsed, forced ? 1 : 0);
      assert.equal(completed!.budget.requestsUsed, forced ? 3 : 2, '复用只能免标注请求，Agent 两次聊天仍须计数');
      assert.equal(annotationRequests - before, forced ? 1 : 0);
      const sample = completed!.samples[0];
      if (!forced) {
        assert.equal(sample.reused, true);
        assert.equal(sample.reusedFrom!.sourceRunId, sourceRunId, '强制新调用应成为后续可复用来源');
        assert.ok(sample.reusedFrom!.sourceAttemptId);
        const events = await command<Array<{ type: string; attemptId?: string }>>('event.list', { runId: id, after: 0, limit: 2000 });
        assert.equal(events.some(event => event.type === 'sample.sending'), false);
        assert.equal(events.some(event => event.type === 'sample.succeeded' && event.attemptId), false);
      } else sourceRunId = id;
      const preserved = await command<{ version: number; status: string }>('asset.get', { assetId });
      assert.deepEqual({ version: preserved.version, status: preserved.status }, { version: baseline.version, status: baseline.status });
      checks.push({ runId: id, forceRerun: forced, succeeded: 1, reused: completed!.statistics.reused,
        annotationRequests: annotationRequests - before, sharedRequests: completed!.budget.requestsUsed,
        ...(sample.reusedFrom ? { sourceRunId: sample.reusedFrom.sourceRunId, sourceCandidateVersion: sample.reusedFrom.sourceCandidateVersion } : {}) });
    }
    reuse = { checks, formalVersionProtected: true, reusedCallsDoNotCreateAttempts: true, forcedResultReusable: true };
  }
  if (localMode) {
    qualityComparison = undefined; freshComparison = undefined;
    const runtime = await command<LocalRuntimeState>('local.runtime.probe');
    assert.equal(runtime.available, true);
    const registered = await command<LocalModel>('local.model.register', { name: '隔离 CPU Detect 模型', taskType: 'detect', modelPath: localModelPath });
    const loaded = await command<LoadedLocalModel>('local.model.load', { modelId: registered.id, modelVersion: registered.version, device: 'cpu', timeoutMs: 120000 });
    assert.equal(loaded.model.version, registered.version);
    assert.ok(loaded.classes.length > 0);
    const assetId = assetList.items[0].id;
    const original = await command<{ width: number; height: number; version: number; status: string }>('asset.get', { assetId });
    const classes = loaded.classes.map(value => ({ modelClassId: value.id, projectClassId: ['car', 'bus', 'truck'].includes(value.name) ? 'vehicle' : null }));
    // 高阈值检查两片无目标的真实输入/聚合链路；模型质量与非空 Pose 另由 UI 夹具验证。
    flowRequest = { definition: { version: 1, name: '助手切片与本地输入聚合', steps: [
      { id: 'transform', kind: 'transform', enabled: true, parameters: { operations: [
        { kind: 'tile', width: Math.ceil(original.width / 2), height: original.height, overlapX: 0, overlapY: 0 },
      ], background: '#FFFFFF' } },
      { id: 'local', kind: 'local', enabled: true, parameters: { modelId: registered.id, modelVersion: registered.version,
        device: 'cpu', classMap: classes, confidence: 1, iou: 0.7, imageSize: 640, maxDetections: 300, timeoutMs: 120000 } },
    ] }, input: { source: 'project', selection: 'explicit', assetIds: [assetId] }, execution: null, failurePolicy: 'continue' };
    const checks: Array<Record<string, unknown>> = [];
    let sourceResults = new Map<string, { resultId: string; inputId: string; runId: string }>();
    for (const [round, forced] of [false, false, true, false].entries()) {
    const shouldReuse = round === 1 || round === 3;
    Object.assign((flowRequest.definition as FlowDefinition).steps[1].parameters,
      { reuseEnabled: true, forceRerun: forced, reuseMaxAgeSeconds: null });
    const beforeRequests = requests, beforeAnnotations = annotationRequests;
    const context = { assetIds: [assetId], maxRequests: 4 };
    const answer = await controller.run({ sessionId: randomUUID(), projectId: p.id, providerId: modelProvider.id, model: 'protocol-test',
      messages: [{ role: 'user', content: '按给定完整类别映射，将选中图像切成两片并用已加载的 CPU 模型预标注，保留人工版本。' }], context });
    assert.equal(answer.status, 'completed');
    const action = answer.actions.find(value => value.name === 'start_flow');
    assert.equal(action?.status, 'completed', JSON.stringify(action?.result));
    const started = action!.result as { started: boolean; run: FlowRun };
    assert.equal(started.started, true);
    let completed: FlowRun | undefined;
    const until = Date.now() + 180000;
    do {
      completed = await command<FlowRun>('flow.get', { flowRunId: started.run.id });
      if (['completed', 'completed_with_errors', 'failed', 'cancelled', 'needs_attention'].includes(completed.status)) break;
      await new Promise(resolve => setTimeout(resolve, 120));
    } while (Date.now() < until);
    assert.equal(completed!.status, 'completed', JSON.stringify(completed!.steps));
    const localStep = completed!.steps.find(value => value.stepId === 'local')!;
    assert.deepEqual(localStep.local, { modelId: registered.id, modelVersion: registered.version, device: 'cpu' });
    const child = await command<{ id: string; kind: string; modelVersion: number; requestsUsed: number; statistics: Record<string, number>;
      samples: Array<{ inputId: string; resultId: string; attemptCount: number }> }>('run.get', { runId: localStep.childRunId });
    assert.equal(child.kind, 'local'); assert.equal(child.modelVersion, registered.version);
    assert.equal(child.requestsUsed, 0); assert.equal(child.samples.length, 2);
    assert.equal(child.statistics.baselineTotal, 1); assert.equal(child.statistics.baselineCompleted, 1);
    assert.equal(child.statistics.inputTotal, 2); assert.equal(child.statistics.inputCompleted, 2);
    assert.equal(child.statistics.reused, shouldReuse ? 2 : 0);
    assert.equal(new Set(child.samples.map(value => value.inputId)).size, 2);
    assert.ok(child.samples.every(value => value.inputId !== assetId && value.attemptCount === 0 && value.resultId));
    const inputResults: Array<Record<string, unknown>> = [];
    const currentResults = new Map<string, { resultId: string; inputId: string; runId: string }>();
    for (const sample of child.samples) {
      const saved = await command<InputResult>('run.result.get', { resultId: sample.resultId });
      assert.equal(saved.inputId, sample.inputId); assert.equal(saved.assetId, assetId); assert.equal(saved.runId, child.id);
      assert.equal(saved.source, shouldReuse ? 'reuse' : 'local'); assert.equal(saved.status, 'succeeded'); assert.deepEqual(saved.annotations, []);
      assert.equal(saved.requiresGeometryReview, false); assert.deepEqual(saved.mappedResult?.annotations, []);
      const viewId = String(saved.mappedResult?.viewId);
      assert.match(viewId, /^view-\d+$/);
      if (shouldReuse) {
        const origin = saved.provenance.reusedFrom;
        assert.equal(origin?.source, 'local');
        assert.equal(origin?.sourceResultId, sourceResults.get(viewId)?.resultId);
        assert.equal(origin?.sourceRunId, sourceResults.get(viewId)?.runId);
        assert.equal(origin?.sourceInputId, sourceResults.get(viewId)?.inputId);
        assert.notEqual(origin?.sourceInputId, saved.inputId, '新流程输入身份独立，不能借用旧产物 ID');
        assert.equal(origin?.sourceModelVersion, registered.version);
      }
      currentResults.set(viewId, { resultId: saved.id, inputId: saved.inputId, runId: child.id });
      const image = await command<{ path: string; inputId: string; contentHash: string; width: number; height: number }>('flow.input.image', { inputId: sample.inputId });
      assert.equal(image.inputId, sample.inputId);
      assert.equal(createHash('sha256').update(await readFile(image.path)).digest('hex'), image.contentHash);
      assert.equal(image.width, Math.ceil(original.width / 2)); assert.equal(image.height, original.height);
      inputResults.push({ inputId: saved.inputId, resultId: saved.id, status: saved.status, objects: 0, provenance: saved.provenance });
    }
    assert.equal(currentResults.size, 2);
    if (!shouldReuse) sourceResults = currentResults;
    const budget = await findTool('inspect_budget').execute({}, { engine: { request: command }, projectId: p.id,
      context, budgetScopeId: answer.budgetScopeId, openAsset() {} }) as { requestsUsed: number };
    assert.equal(budget.requestsUsed, 2); assert.equal(requests - beforeRequests, 2);
    assert.equal(annotationRequests, beforeAnnotations, '本地推理不得产生标注 API 请求');
    const current = await command<{ version: number; status: string }>('asset.get', { assetId });
    assert.deepEqual({ version: current.version, status: current.status }, { version: original.version, status: original.status });
    checks.push({ flowRunId: completed!.id, childRunId: child.id, forceRerun: forced,
      statistics: child.statistics, inputResults, annotationRequests: 0, sharedRequests: budget.requestsUsed });
    }
    localFlow = { modelId: registered.id, modelVersion: registered.version, checks,
      formalVersionProtected: true, independentInputIdentities: true, forcedResultReusable: true };
  }
  if (mediaMode) mediaFlow = await validateMediaFlow({ command, controller, providerId: modelProvider.id,
    dataDir, modelPath: localModelPath!, videoPath: process.env.AUTOLABEL_VIDEO_SOURCE!,
    setFlowRequest(value) { flowRequest = value; }, counts: () => ({ requests, annotationRequests }),
  });
  const verification = { mode: mediaMode ? 'real-video-model-and-loopback-protocol' : localMode ? 'local-model-and-loopback-protocol' : 'local-protocol-only', agentStatus: result.status, javaRunStatus: run.status,
    sampleSucceeded: run.statistics.succeeded, providerAttempts: requests, budget: run.budget,
    manualVersionProtected: true, ...(quality ? { quality } : {}), ...(references ? { references } : {}), ...(flow ? { flow } : {}), ...(reuse ? { reuse } : {}), ...(localFlow ? { localFlow } : {}), ...(mediaFlow ? { mediaFlow } : {}), dataDir };
  await writeFile(path.join(dataDir, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify({ passed: true, mode: verification.mode, report: path.join(dataDir, 'verification.json') }));
} finally {
  if (command!) await command('engine.shutdown').catch(() => {});
  engine.stdin.end();
  await new Promise<void>(resolve => {
    if (engine.exitCode !== null) return resolve();
    const timer = setTimeout(() => { engine.kill(); resolve(); }, 8000);
    engine.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  provider.close();
}
