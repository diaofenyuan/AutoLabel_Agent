import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertAgentCommand, validateCommand } from './validation';
import { PathGrants, authorizeCommandPaths, assetIdFromUrl, mediaTargetFromUrl, isTrustedUrl, normalizeMedia, redact } from './security';
import { SseDecoder } from './sse';
import { DIRECTORY_SCAN_MAX_DEPTH, DIRECTORY_SCAN_MAX_FILES, IMAGE_EXTENSIONS, isImagePath, isVideoPath } from '../shared/mediaFormats';
import { providerCapabilities, requiredProviderCapabilities } from '../shared/protocol';
import { DialogFixtures } from './dialog-fixtures';

test('IPC 拒绝内部命令、未知字段与无效标注数值', () => {
  assert.throws(() => validateCommand('engine.shutdown'), /未开放/);
  assert.throws(() => validateCommand('system.resume'), /未开放/);
  assert.throws(() => validateCommand('project.list', { command: 'run.cancel' }), /格式不正确/);
  assert.throws(() => validateCommand('annotation.save', { assetId: 'a', baseVersion: 0, annotations: [{ id: 'x', classId: 'c', type: 'detect', bbox: { x: NaN, y: 1, width: 2, height: 3 } }] }), /格式不正确/);
  assert.throws(() => validateCommand('provider.save', { name: '接口', baseUrl: 'https://user:password@example.com/v1', protocol: 'responses' }), /格式不正确/);
  assert.doesNotThrow(() => validateCommand('provider.delete', { providerId: 'provider-1' }));
  assert.throws(() => validateCommand('provider.delete', { providerId: 'provider-1', key: 'never-accepted' }), /格式不正确/);
});
test('接口能力名以共享常量为准，界面能点到的每一项都必须被校验接受', () => {
  // 曾出现校验枚举写作 multi-image、界面与引擎用 multiImage：校验静默拒绝后，
  // 「多图输入」的测试按钮只会报「参数格式不正确」，看起来像接口不支持。
  for (const capability of providerCapabilities) {
    assert.equal(validateCommand('provider.test', { providerId: 'provider-1', model: 'fixture', capability }).payload.capability, capability);
  }
  for (const capability of ['multi-image', 'vision', 'structured-output', 'tool-calling', ''])
    assert.throws(() => validateCommand('provider.test', { providerId: 'provider-1', model: 'fixture', capability }), /格式不正确/);
  for (const capability of requiredProviderCapabilities) assert.ok((providerCapabilities as readonly string[]).includes(capability));
});
test('Agent 原生工具消息与有单位配置通过合法协议', () => {
  const result = validateCommand('chat.send', { providerId: 'p', model: 'model', sessionId: 's', maxRequests: 10,
    messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_assets', arguments: '{}' } }] }] });
  assert.equal(result.command, 'chat.send');
  const provider = { name: '接口', baseUrl: 'https://example.com/v1', protocol: 'responses', timeoutMs: 120000, requestsPerMinute: 60, maxRetries: 2, maxImages: 64, quotaGroupId: 'shared-quota' };
  assert.equal(validateCommand('provider.save', provider).payload.maxImages, 64);
  assert.throws(() => validateCommand('provider.save', { ...provider, maxImages: 65 }), /格式不正确/);
});
test('导出格式标识接受内置前缀，导出预检不因默认格式被拦下', () => {
  // 导出对话框在挂载时就会回填 builtin:yolo。若 formatId 只允许 [A-Za-z0-9_-]，
  // 导出预检与导出提交都会在参数校验阶段失败，用户看到的是「参数格式不正确」而不是真实的导出检查结果。
  const fields = { projectId: 'p', taskType: 'detect' as const };
  assert.doesNotThrow(() => validateCommand('export.preflight', { ...fields, formatId: 'builtin:yolo', formatVersion: 1 }));
  assert.doesNotThrow(() => validateCommand('export.create', { ...fields, formatId: 'builtin:yolo', formatVersion: 1 }));
  assert.doesNotThrow(() => validateCommand('export.format.get', { formatId: 'builtin:coco' }));
  assert.doesNotThrow(() => validateCommand('export.format.delete', { formatId: 'builtin:csv', baseVersion: 1 }));
  // 用户保存的模板使用引擎生成的普通标识，同样必须通过。
  assert.doesNotThrow(() => validateCommand('export.preflight', { ...fields, formatId: 'format-abc_123' }));
  // 前缀之外仍限定安全字符集：内置前缀不能被用来夹带路径或地址。
  assert.throws(() => validateCommand('export.preflight', { ...fields, formatId: 'builtin:../etc' }), /格式不正确/);
  assert.throws(() => validateCommand('export.preflight', { ...fields, formatId: 'http://example.com/x' }), /格式不正确/);
});
test('4C 人工真值需要显式来源和基线，Agent 只开放查询与既有运行比较', () => {
  assert.doesNotThrow(() => validateCommand('evaluationSet.create', { projectId: 'p', name: '人工评测集', assetIds: ['a', 'b'] }));
  assert.throws(() => validateCommand('evaluationSet.create', { projectId: 'p', name: '人工评测集', assetIds: ['a', 'a'] }), /格式不正确/);
  assert.throws(() => validateCommand('evaluationSet.create', { projectId: 'p', name: '人工评测集', assetIds: [] }), /格式不正确/);
  const truth = { setId: 's', assetId: 'a', annotations: [], baseTruthVersion: 0, source: 'manual' };
  assert.doesNotThrow(() => validateCommand('evaluationSet.saveTruth', truth));
  for (const change of [{ source: 'confirmed' }, { source: 'model' }, { baseTruthVersion: undefined }, { annotations: undefined }, { confirm: true }]) {
    assert.throws(() => validateCommand('evaluationSet.saveTruth', { ...truth, ...change }), /格式不正确/);
  }
  for (const command of ['evaluationSet.list', 'evaluationSet.get', 'evaluation.list', 'evaluation.get', 'evaluation.results', 'evaluation.preflight', 'evaluation.create', 'review.list']) {
    assert.doesNotThrow(() => assertAgentCommand(command));
  }
  for (const command of ['evaluationSet.create', 'evaluationSet.saveTruth', 'evaluationSet.publish', 'evaluationSet.getTruth', 'review.resolve', 'review.build', 'review.sample', 'annotation.save', 'system.prepareUpdate']) {
    assert.throws(() => assertAgentCommand(command), /Agent 工具范围/);
  }
  assert.throws(() => assertAgentCommand('evaluationSet.get', { setId: 's', versionId: 'v' }), /真值清单/);
  assert.doesNotThrow(() => validateCommand('evaluationSet.get', { setId: 's', versionId: 'v' }));
});
test('文件路径权限仅来自用户选择，目录连接不能越界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-grant-'));
  try {
    const selected = path.join(root, 'selected'); const outside = path.join(root, 'outside');
    await mkdir(selected); await mkdir(outside); await writeFile(path.join(outside, 'secret.png'), 'secret');
    await writeFile(path.join(selected, 'image.png'), 'image');
    const grants = new PathGrants(); await grants.add(selected, 'directory');
    assert.equal(await grants.require(selected, ['directory']), selected);
    await assert.rejects(grants.require(path.join(selected, 'image.png'), ['images']));
    await assert.rejects(grants.require(outside, ['directory'], false));
    await symlink(outside, path.join(selected, 'linked'), 'junction');
    await assert.rejects(grants.require(path.join(selected, 'linked/secret.png'), ['directory'], false));
    assert.equal(await grants.require(path.join(selected, 'image.png'), ['directory'], false), path.join(selected, 'image.png'));
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-grant-'));
    await rm(root, { recursive: true, force: true });
  }
});
test('素材协议拒绝路径、查询参数与外部来源', () => {
  assert.equal(assetIdFromUrl('autolabel-media://asset/asset-123'), 'asset-123');
  for (const url of ['autolabel-media://asset/a/b', 'autolabel-media://asset/a?path=x', 'autolabel-media://elsewhere/a', 'autolabel-media://asset/%2e%2e%5csecret']) assert.throws(() => assetIdFromUrl(url));
  assert.equal(isTrustedUrl('https://example.com'), false);
  assert.equal(isTrustedUrl('http://127.0.0.1:5173.evil.test', 'http://127.0.0.1:5173'), false);
  assert.equal(isTrustedUrl('autolabel-app://app/index.html'), true);
  assert.deepEqual(normalizeMedia({ id: 'asset-1', mediaUrl: 'http://127.0.0.1:1/media/asset-1' }), { id: 'asset-1', mediaUrl: 'autolabel-media://asset/asset-1' });
});
test('资源图片绑定具体版本，拒绝路径注入和内部图片命令', () => {
  const url = 'autolabel-media://resource/ref-1/2147483647';
  assert.deepEqual(mediaTargetFromUrl(url), { kind: 'resource', resourceId: 'ref-1', version: 2147483647 });
  for (const invalid of ['autolabel-media://resource/ref-1', url + '?path=secret', url + '\n', url + '/extra',
    'autolabel-media://resource/ref-1/2147483648', 'autolabel-media://resource/ref-1/01', 'autolabel-media://resource/ref-1/-1',
    'autolabel-media://resource/%2e%2e/1', 'autolabel-media://user@resource/ref-1/1']) assert.throws(() => mediaTargetFromUrl(invalid));
  assert.deepEqual(normalizeMedia({ kind: 'reference', id: 'ref-1', version: 0 }),
    { kind: 'reference', id: 'ref-1', version: 0, mediaUrl: 'autolabel-media://resource/ref-1/0' });
  assert.deepEqual(normalizeMedia({ id: 'asset-1', mediaUrl: url + '?path=other' }), { id: 'asset-1' });
  assert.throws(() => validateCommand('resource.image', { resourceId: 'ref-1', version: 1 }), /未开放/);
});
test('流程严格限定执行范围、节点参数与人工确认权限', () => {
  const step = { id: 'api.v1', kind: 'api', enabled: true, parameters: { providerId: 'p', model: 'model', prompt: '仅标注目标', maxRetries: 0 } };
  const request = { projectId: 'p', definition: { version: 1, name: '执行流程', steps: [step] }, input: { source: 'project', selection: 'explicit', assetIds: ['a'] }, maxRequests: 2 };
  assert.doesNotThrow(() => validateCommand('flow.create', request));
  const incomplete = { ...request, maxRequests: undefined, definition: { ...request.definition, steps: [
    { ...step, parameters: {} }, { id: 'export', kind: 'export', enabled: true, parameters: {} },
  ] } };
  assert.doesNotThrow(() => validateCommand('flow.preflight', incomplete));
  assert.throws(() => validateCommand('flow.create', incomplete));
  assert.throws(() => validateCommand('flow.preflight', { ...incomplete, definition: { ...request.definition, steps: [{ ...step, parameters: { prompt: 123 } }] } }));
  assert.doesNotThrow(() => validateCommand('flow.preflight', { ...request, input: { source: 'artifact', artifactId: 'artifact-1' }, execution: { mode: 'single', stepId: 'api.v1' } }));
  for (const change of [{ maxRequests: undefined }, { input: { source: 'project', selection: 'explicit', assetIds: [] } },
    { input: { source: 'project', selection: 'all', assetIds: ['a'] } }, { execution: { mode: 'all', stepId: 'api.v1' } },
    { definition: { ...request.definition, steps: [step, step] } },
    { definition: { ...request.definition, steps: [{ ...step, parameters: { ...step.parameters, command: 'shell' } }] } },
    { definition: { ...request.definition, steps: [{ id: 'local', kind: 'local', enabled: true, parameters: {} }] } }]) {
    assert.throws(() => validateCommand('flow.create', { ...request, ...change }), /格式不正确/);
  }
  assert.doesNotThrow(() => validateCommand('flow.resume', { flowRunId: 'f', acknowledgeReviewStepId: 'review.1' }));
  assert.throws(() => assertAgentCommand('flow.resume', { flowRunId: 'f', acknowledgeReviewStepId: 'review.1' }), /人工检查/);
  assert.throws(() => assertAgentCommand('flow.retry', { flowRunId: 'f', retryUnknown: true }), /未知请求/);
  assert.throws(() => assertAgentCommand('flow.create', { definition: { steps: [{ kind: 'import', parameters: { paths: [] } }] } }), /导入路径/);
  for (const command of ['flow.capabilities', 'flow.preflight', 'flow.create', 'flow.get', 'flow.list', 'flow.artifact', 'flow.pause', 'flow.resume', 'flow.cancel', 'flow.retry', 'flow.rerun']) assert.doesNotThrow(() => assertAgentCommand(command, {}));
  assert.doesNotThrow(() => validateCommand('event.list', { flowRunId: 'f', after: 1 }));
  assert.throws(() => validateCommand('flow.list', { limit: 101 }));
});
test('复用策略只允许运行与 API 节点声明，保留缺省和 null 并拒绝伪造来源', () => {
  const run = { projectId: 'p', providerId: 'provider', model: 'model', prompt: '标注目标' };
  const policy = { reuseEnabled: false, forceRerun: true, reuseMaxAgeSeconds: null };
  assert.equal(Object.hasOwn(validateCommand('run.create', run).payload, 'reuseEnabled'), false);
  assert.deepEqual(validateCommand('run.create', { ...run, ...policy }).payload, { ...run, ...policy });
  const flow = (parameters: Record<string, unknown>) => ({ projectId: 'p', maxRequests: 1, input: { source: 'project', selection: 'explicit', assetIds: ['a'] },
    definition: { version: 1, name: '复用策略', steps: [{ id: 'api', kind: 'api', enabled: true, parameters }] } });
  const parameters = { providerId: 'provider', model: 'model', prompt: '标注目标', ...policy };
  assert.doesNotThrow(() => validateCommand('flow.create', flow(parameters)));
  const rerun = (parameters: Record<string, unknown>) => ({ flowRunId: 'f', fromStepId: 'api', maxRequests: 1, definition: flow(parameters).definition });
  assert.deepEqual(validateCommand('flow.rerun', rerun(parameters)).payload, rerun(parameters));
  assert.doesNotThrow(() => validateCommand('flow.preflight', flow({ reuseEnabled: true, reuseMaxAgeSeconds: 3600 })));
  for (const change of [{ reuseEnabled: 'true' }, { forceRerun: 1 }, { reuseMaxAgeSeconds: 0 }, { reuseMaxAgeSeconds: -1 },
    { reuseMaxAgeSeconds: 1.5 }, { reuseMaxAgeSeconds: Number.MAX_SAFE_INTEGER + 1 }, { reused: true }, { reusedFrom: { sourceRunId: 'old' } }, { reuseFingerprint: 'forged' }]) {
    assert.throws(() => validateCommand('run.create', { ...run, ...change }));
    assert.throws(() => validateCommand('flow.create', flow({ ...parameters, ...change })));
    assert.throws(() => validateCommand('flow.rerun', rerun({ ...parameters, ...change })));
  }
  assert.throws(() => validateCommand('evaluation.rerun.create', { setVersionId: 'v', budgetScopeId: 'b', maxRequests: 1,
    schemes: [{ providerId: 'p', model: 'model', prompt: '真实重跑', reuseEnabled: true }] }));
});
test('本地推理只接受固定模型参数，执行路径和授权不能由普通设置或 Agent 注入', () => {
  const parameters = { modelId: 'm', modelVersion: 1, device: '0', classMap: { '0': 'vehicle', '1': null }, timeoutMs: 600000 };
  const request = { projectId: 'p', assetIds: ['a'], ...parameters };
  assert.doesNotThrow(() => validateCommand('local.run.create', request));
  const reusePolicy = { reuseEnabled: false, forceRerun: true, reuseMaxAgeSeconds: null };
  assert.deepEqual(validateCommand('local.run.create', { ...request, ...reusePolicy }).payload, { ...request, ...reusePolicy });
  assert.equal(Object.hasOwn(validateCommand('local.run.create', request).payload, 'reuseEnabled'), false);
  assert.doesNotThrow(() => validateCommand('local.runtime.configure', { pythonPath: null }));
  assert.doesNotThrow(() => validateCommand('local.model.load', { modelId: 'm', device: 'cpu' }));
  assert.doesNotThrow(() => validateCommand('local.runtime.get', {}));
  assert.doesNotThrow(() => validateCommand('local.model.get', { modelId: 'm', modelVersion: 1 }));
  assert.doesNotThrow(() => assertAgentCommand('local.runtime.get', {}));
  assert.doesNotThrow(() => assertAgentCommand('local.model.get', { modelId: 'm' }));
  assert.throws(() => validateCommand('local.runtime.get', { probe: true }));
  assert.throws(() => validateCommand('local.model.get', { modelId: 'm', modelVersion: 0 }));
  for (const change of [{ modelVersion: 0 }, { device: '00' }, { device: 'cuda:0' }, { confidence: NaN }, { iou: 1.1 },
    { imageSize: 31 }, { imageSize: 32.5 }, { maxDetections: 10001 }, { timeoutMs: 999 }, { modelPath: 'C:\\model.pt' }, { workerPath: 'C:\\worker.py' }, { inputId: 'forged' },
    { reuseEnabled: 'true' }, { forceRerun: 1 }, { reuseMaxAgeSeconds: 0 }, { reuseMaxAgeSeconds: 0.5 }, { reuseMaxAgeSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { inputReusedFrom: { source: 'local', sourceRunId: 'forged' } }]) {
    assert.throws(() => validateCommand('local.run.create', { ...request, ...change }));
  }
  const flow = { projectId: 'p', input: { source: 'project', selection: 'all' }, definition: { version: 1, name: '本地推理', steps: [{ id: 'local', kind: 'local', enabled: true, parameters }] } };
  assert.doesNotThrow(() => validateCommand('flow.create', flow));
  assert.doesNotThrow(() => validateCommand('flow.create', { ...flow, definition: { ...flow.definition, steps: [{ ...flow.definition.steps[0], parameters: { ...parameters, ...reusePolicy } }] } }));
  assert.doesNotThrow(() => validateCommand('flow.preflight', { ...flow, definition: { ...flow.definition, steps: [{ ...flow.definition.steps[0], parameters: { reuseEnabled: true, reuseMaxAgeSeconds: 3600 } }] } }));
  assert.doesNotThrow(() => validateCommand('flow.preflight', { ...flow, definition: { ...flow.definition, steps: [{ id: 'local', kind: 'local', enabled: true, parameters: {} }] } }));
  for (const command of ['flow.input.image', 'local.model.resolve', 'local.model.authorize']) assert.throws(() => validateCommand(command, {}));
  for (const command of ['local.runtime.configure', 'local.runtime.probe', 'local.model.register', 'local.model.authorize', 'local.model.resolve']) assert.throws(() => assertAgentCommand(command, {}));
  for (const key of ['workerPath', 'scriptPath', 'localModelGrants', 'localModelAuthorizations', 'pythonPath']) {
    if (key !== 'pythonPath') assert.throws(() => validateCommand('local.runtime.configure', { pythonPath: null, [key]: 'forged' }));
    assert.throws(() => validateCommand('settings.save', { settings: { nested: { [key]: 'forged' } } }));
  }
});
test('图像处理只接受裁剪缩放切片参数，拒绝伪造视图、路径与越界几何', () => {
  const operations = [{ kind: 'crop', x: 0, y: 0, width: 1280, height: 720 }, { kind: 'resize', width: 640, height: 640, fit: 'contain' },
    { kind: 'tile', width: 320, height: 320, overlapX: 32, overlapY: 32 }];
  const flow = (parameters: Record<string, unknown>) => ({ projectId: 'p', input: { source: 'project', selection: 'all' },
    definition: { version: 1, name: '图像处理', steps: [{ id: 'transform.1', kind: 'transform', enabled: true, parameters }] } });
  assert.doesNotThrow(() => validateCommand('flow.create', flow({ operations, background: '#00aAFF' })));
  assert.doesNotThrow(() => validateCommand('flow.preflight', flow({})));
  for (const parameters of [{ operations, imagePath: 'C:\\private.png' }, { operations, views: [] }, { operations, planHash: 'forged' },
    { operations, background: 'transparent' }, { operations: Array(31).fill(operations[0]) }, { operations: [operations[2], operations[2]] },
    { operations: [{ ...operations[0], x: 0.5 }] }, { operations: [{ ...operations[0], x: 20000 }] },
    { operations: [{ ...operations[1], width: 20000, height: 20000 }] }, { operations: [{ ...operations[1], fit: 'cover' }] },
    { operations: [{ ...operations[2], overlapX: 320 }] }, { operations: [{ kind: 'rotate', degrees: 90 }] }]) {
    assert.throws(() => validateCommand('flow.create', flow(parameters)));
    assert.throws(() => validateCommand('flow.preflight', flow(parameters)));
  }
});
test('流程嵌套路径逐项授权，历史定义与禁用步骤不扩大权限', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-flow-paths-'));
  try {
    const image = path.join(root, 'selected.png'); const privateImage = path.join(root, 'private.png'); const output = path.join(root, 'output');
    await writeFile(image, 'fixture'); await writeFile(privateImage, 'private'); await mkdir(output);
    const grants = new PathGrants(); await grants.add(image, 'images'); await grants.add(output, 'directory');
    const definition = { version: 1, name: '嵌套路径', steps: [
      { id: 'in', kind: 'import', enabled: true, parameters: { paths: [image] } },
      { id: 'out', kind: 'export', enabled: true, parameters: { outputDir: output } },
    ] };
    await authorizeCommandPaths('flow.create', { definition: structuredClone(definition) }, grants);
    const forbidden = structuredClone(definition); forbidden.steps[0].parameters.paths = [privateImage]; forbidden.steps[0].enabled = false;
    await assert.rejects(authorizeCommandPaths('flow.rerun', { definition: forbidden }, grants), /尚未通过/);
    await assert.rejects(authorizeCommandPaths('flow.resume', { definition: structuredClone(definition) }, new PathGrants()), /尚未通过/);
    const outside = structuredClone(definition); outside.steps[1].parameters.outputDir = root;
    await assert.rejects(authorizeCommandPaths('flow.preflight', { definition: outside }, grants), /尚未通过/);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-flow-paths-'));
    await rm(root, { recursive: true, force: true });
  }
});
test('资源写入与显式应用字段严格校验，Agent 资源命令保持关闭', () => {
  assert.doesNotThrow(() => validateCommand('resource.save', { kind: 'prompt', name: '提示词', content: '标注目标', baseVersion: 0, category: '检测', note: '人工整理' }));
  assert.doesNotThrow(() => validateCommand('resource.list', { kind: 'evaluation_comparison', query: '检测', category: '', offset: 0, limit: 500 }));
  assert.doesNotThrow(() => validateCommand('resource.reference', { assetId: 'a', assetVersion: 0, name: '人工参考' }));
  assert.doesNotThrow(() => validateCommand('resource.apply', { projectId: 'p', resourceId: 'r', version: 1, fields: ['prompt', 'classes'] }));
  for (const fields of [[], ['prompt', 'prompt'], ['taskType'], ['path']]) {
    assert.throws(() => validateCommand('resource.apply', { projectId: 'p', resourceId: 'r', fields }), /格式不正确/);
  }
  for (const kind of ['reference', 'evaluation_comparison', 'resource_version']) assert.throws(() => validateCommand('resource.save', { kind, name: '不能伪造', content: {} }), /格式不正确/);
  assert.throws(() => validateCommand('resource.reference', { assetId: 'a', assetVersion: 0, name: '参考', path: 'C:\\private.png' }), /格式不正确/);
  assert.throws(() => validateCommand('resource.get', { resourceId: 'r', version: -1 }), /格式不正确/);
  for (const command of ['resource.save', 'resource.list', 'resource.get', 'resource.apply', 'resource.reference', 'resource.image']) assert.throws(() => assertAgentCommand(command), /Agent 工具范围/);
});
test('Agent 显式参考与执行配置保留原值，任务和重跑共享参考总量边界', () => {
  const referenceResources = [{ resourceId: 'reference-1', version: 0, classMap: { car: 'vehicle' } }];
  const context = { concurrency: 32, maxRequests: null, referenceAssetIds: ['asset-1'], referenceResources };
  const chat = { sessionId: 's', providerId: 'p', model: 'm', messages: [{ role: 'user', content: '开始' }], context };
  assert.deepEqual(validateCommand('agent.chat', chat).payload.context, context);
  for (const change of [{ concurrency: 33 }, { maxRequests: 0 }, { referenceResources: [...referenceResources, ...referenceResources] },
    { referenceResources: [{ resourceId: 'r', version: 2147483648 }] }, { referenceResources: [{ resourceId: 'r', classMap: { car: '../private' } }] }]) {
    assert.throws(() => validateCommand('agent.chat', { ...chat, context: { ...context, ...change } }), /格式不正确/);
  }
  const refs63 = Array.from({ length: 63 }, (_, i) => `ref-${i}`);
  const run = { projectId: 'p', providerId: 'p', model: 'm', prompt: '仅标注', referenceResources, referenceAssetIds: refs63.slice(1) };
  assert.doesNotThrow(() => validateCommand('run.create', run));
  assert.throws(() => validateCommand('run.create', { ...run, referenceAssetIds: refs63 }), /格式不正确/);
  const { projectId, ...scheme } = run;
  assert.doesNotThrow(() => validateCommand('evaluation.rerun.create', { setVersionId: 'v', budgetScopeId: 's', maxRequests: 1, schemes: [scheme] }));
  assert.throws(() => validateCommand('evaluation.rerun.create', { setVersionId: 'v', budgetScopeId: 's', maxRequests: 1, schemes: [{ ...scheme, referenceAssetIds: refs63 }] }), /格式不正确/);
});
test('4C 冻结图片保留发布版本，只允许固定鉴权媒体路由', () => {
  const url = 'autolabel-media://evaluation/version-1/asset-1';
  assert.deepEqual(mediaTargetFromUrl(url), { kind: 'evaluation', setVersionId: 'version-1', assetId: 'asset-1' });
  for (const suffix of ['?path=private', '#other', '/extra', '\n', '/%2e%2e/asset-2']) assert.throws(() => mediaTargetFromUrl(url + suffix));
  for (const invalid of ['autolabel-media://evaluation/v/../v/a', 'autolabel-media://user@evaluation/v/a', 'autolabel-media://evaluation:80/v/a', 'autolabel-media://evaluation/v/%2fprivate', 'https://evaluation/v/a']) {
    assert.throws(() => mediaTargetFromUrl(invalid));
  }
  const result = normalizeMedia({ id: 'result-1', assetId: 'asset-1', mediaUrl: url, thumbnailUrl: '/evaluation-media/version-1/asset-1' });
  assert.deepEqual(result, { id: 'result-1', assetId: 'asset-1', mediaUrl: url, thumbnailUrl: url });
  assert.deepEqual(normalizeMedia({ id: 'asset-1', mediaUrl: url + '?path=other' }), { id: 'asset-1' });
});
test('4C 比较仅接受既有唯一运行，分页和人工复核参数严格校验', () => {
  const payload = { setVersionId: 'v', schemes: [{ runId: 'r1' }, { runId: 'r2', name: '第二方案' }], match: { iouThreshold: 0.5, poseNormalization: 'image_diagonal' } };
  assert.doesNotThrow(() => validateCommand('evaluation.create', payload));
  for (const change of [{ schemes: [] }, { schemes: [{ runId: 'r1' }, { runId: 'r1' }] }, { providerId: 'p' }, { match: { iouThreshold: 1.1 } }, { match: { poseNormalization: 'object_diagonal' } }]) {
    assert.throws(() => validateCommand('evaluation.create', { ...payload, ...change }), /格式不正确/);
  }
  assert.doesNotThrow(() => validateCommand('evaluation.results', { evaluationId: 'e', schemeId: 'r1', offset: 0, limit: 500 }));
  for (const change of [{ offset: -1 }, { limit: 501 }, { limit: 0 }, { schemeId: '../r' }]) {
    assert.throws(() => validateCommand('evaluation.results', { evaluationId: 'e', ...change }), /格式不正确/);
  }
  assert.doesNotThrow(() => validateCommand('review.resolve', { itemId: 'i', baseCandidateVersion: null, action: 'checked' }));
  assert.doesNotThrow(() => validateCommand('review.resolve', { itemId: 'i', baseCandidateVersion: 0, action: 'checked' }));
  assert.throws(() => validateCommand('review.resolve', { itemId: 'i', action: 'checked' }), /格式不正确/);
  assert.throws(() => validateCommand('review.resolve', { itemId: 'i', baseCandidateVersion: 1, action: 'saveTruth' }), /格式不正确/);
  assert.doesNotThrow(() => validateCommand('review.list', { projectId: 'p', status: 'pending', offset: 2147483647, limit: 1 }));
  assert.throws(() => validateCommand('review.list', { projectId: 'p', status: 'confirmed' }), /格式不正确/);
  assert.doesNotThrow(() => validateCommand('review.build', { runId: 'r', rules: { minMatchedIoU: 0, maxNormalizedPointError: 1 } }));
  for (const input of [{}, { runId: 'r', evaluationId: 'e' }, { runId: 'r', rules: { maxNormalizedPointError: Infinity } }]) {
    assert.throws(() => validateCommand('review.build', input), /格式不正确/);
  }
  assert.doesNotThrow(() => validateCommand('review.sample', { projectId: 'p', assetIds: ['a'], seed: '独立抽查', count: 1 }));
  for (const change of [{ count: 2 }, { seed: 1 }, { seed: '' }, { assetIds: ['a', 'a'] }]) {
    assert.throws(() => validateCommand('review.sample', { projectId: 'p', assetIds: ['a'], seed: 's', count: 1, ...change }), /格式不正确/);
  }
});
test('重新评测与预算查询只接收固定标识，Agent 不能改价或改预算', () => {
  assert.doesNotThrow(() => validateCommand('evaluation.rerun.get', { comparisonId: 'comparison-1' }));
  assert.doesNotThrow(() => validateCommand('evaluation.rerun.finish', { comparisonId: 'comparison-1' }));
  assert.doesNotThrow(() => validateCommand('budget.get', { budgetScopeId: 'session-1' }));
  assert.throws(() => validateCommand('evaluation.rerun.finish', { comparisonId: 'comparison-1', maxRequests: 100 }), /格式不正确/);
  assert.throws(() => validateCommand('budget.get', { budgetScopeId: '../private' }), /格式不正确/);
  for (const source of ['execution', 'truth_comparison', 'random']) assert.doesNotThrow(() => validateCommand('review.list', { projectId: 'p', source }));
  assert.throws(() => validateCommand('review.list', { projectId: 'p', source: 'model_confidence' }), /格式不正确/);
  for (const command of ['evaluation.rerun.preflight', 'evaluation.rerun.create', 'evaluation.rerun.get', 'evaluation.rerun.finish', 'budget.estimate', 'budget.get']) assert.doesNotThrow(() => assertAgentCommand(command));
  for (const command of ['provider.save', 'provider.delete', 'provider.pricing', 'budget.update']) assert.throws(() => assertAgentCommand(command), /Agent 工具范围/);
});
test('价格与预算估算保留显式假设，拒绝伪造费用结果和越界金额', () => {
  const provider = { name: '人工配置价格', baseUrl: 'https://example.invalid/v1', protocol: 'responses',
    pricing: { model: 'model', currency: 'USD', inputPerMillion: 0, outputPerMillion: 2 } };
  assert.doesNotThrow(() => validateCommand('provider.save', provider));
  assert.doesNotThrow(() => validateCommand('provider.save', { ...provider, pricing: null }));
  for (const change of [{ currency: 'usd' }, { inputPerMillion: -1 }, { inputPerMillion: Infinity }, { outputPerMillion: 1e9 + 1 }, { totalCost: 0 }, { model: '' }]) {
    assert.throws(() => validateCommand('provider.save', { ...provider, pricing: { ...provider.pricing, ...change } }), /格式不正确/);
  }
  assert.doesNotThrow(() => validateCommand('budget.update', { budgetScopeId: 's', maxRequests: Number.MAX_SAFE_INTEGER, costLimit: { currency: 'CNY', amount: 0.01 } }));
  assert.doesNotThrow(() => validateCommand('budget.update', { budgetScopeId: 's', costLimit: null }));
  for (const amount of [0, -1, NaN, Infinity, 1e12 + 1]) assert.throws(() => validateCommand('budget.update', { budgetScopeId: 's', costLimit: { currency: 'USD', amount } }), /格式不正确/);
  assert.throws(() => validateCommand('budget.update', { budgetScopeId: 's', maxRequests: Number.MAX_SAFE_INTEGER + 1 }), /格式不正确/);
  assert.throws(() => validateCommand('budget.update', { budgetScopeId: 's', costLimit: { currency: 'USD', amount: 1, hardLimit: true } }), /格式不正确/);
  const estimate = { providerId: 'p', model: 'model', requests: 2, inputTokensPerRequest: 100, outputTokensPerRequest: 20 };
  assert.equal(Object.hasOwn(validateCommand('budget.estimate', estimate).payload, 'cachedInputTokensPerRequest'), false);
  assert.doesNotThrow(() => validateCommand('budget.estimate', { ...estimate, cachedInputTokensPerRequest: 100 }));
  for (const change of [{ requests: 0 }, { requests: 1000001 }, { inputTokensPerRequest: 1000000001 }, { outputTokensPerRequest: 0.5 }, { cachedInputTokensPerRequest: 101 }, { inputTokensPerRequest: undefined }, { cost: 0 }, { hardLimit: true }]) {
    assert.throws(() => validateCommand('budget.estimate', { ...estimate, ...change }), /格式不正确/);
  }
});
test('重新评测要求明确请求上限，允许重复实验且参考素材严格去重', () => {
  const scheme = { providerId: 'p', model: 'model', prompt: '仅返回标注', referenceAssetIds: ['ref1'], concurrency: 1, maxRetries: 0 };
  const rerun = { setVersionId: 'v', budgetScopeId: 's', maxRequests: 10, schemes: [scheme, { ...scheme }] };
  const parsed = validateCommand('evaluation.rerun.create', rerun).payload;
  assert.equal((parsed.schemes as unknown[]).length, 2);
  assert.doesNotThrow(() => validateCommand('evaluation.rerun.preflight', rerun));
  for (const change of [{ maxRequests: undefined }, { maxRequests: 0 }, { maxRequests: 1000001 }, { schemes: [] }, { schemes: Array(9).fill(scheme) }, { costLimit: { currency: 'USD', amount: 10 } }, { hardLimit: true }]) {
    assert.throws(() => validateCommand('evaluation.rerun.create', { ...rerun, ...change }), /格式不正确/);
  }
  for (const change of [{ prompt: '  ' }, { maxRetries: 7 }, { concurrency: 33 }, { maxRequests: 0 }, { referenceAssetIds: ['ref1', 'ref1'] }, { referenceAssetIds: Array.from({ length: 64 }, (_, i) => `ref${i}`) }, { runId: 'prior-run' }, { pricing: { currency: 'USD' } }]) {
    assert.throws(() => validateCommand('evaluation.rerun.create', { ...rerun, schemes: [{ ...scheme, ...change }] }), /格式不正确/);
  }
});
test('手工链路只接受已选择的标签、重定位目录和精确输出文件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-manual-grant-'));
  try {
    const labels = path.join(root, '人工标签'); const outside = path.join(root, '未选择');
    await mkdir(labels); await mkdir(outside);
    const labelPath = path.join(labels, '图片 一.txt'); await writeFile(labelPath, '0 0.5 0.5 0.2 0.2');
    const unselectedLabel = path.join(labels, '图片 二.txt'); await writeFile(unselectedLabel, '');
    const grants = new PathGrants(); await grants.add(labelPath, 'labels');
    const run = async (command: string, input: Record<string, unknown>) => {
      const { payload } = validateCommand(command, input); await authorizeCommandPaths(command, payload, grants); return payload;
    };
    const input = { projectId: 'p', labelSpace: 'baseline', classMap: { '0': 'car' }, items: [{ assetId: 'a', labelPath }] };
    await run('annotation.importYolo', input);
    await assert.rejects(run('annotation.importYolo', { ...input, items: [{ assetId: 'a', labelPath: unselectedLabel }] }), /尚未通过/);
    await assert.rejects(run('asset.relocate', { projectId: 'p', directory: labels }), /尚未通过/);
    await grants.add(labels, 'directory');
    await run('asset.relocate', { projectId: 'p', directory: labels });
    await run('annotation.importYolo', { projectId: 'p', labelSpace: 'source', classMap: { '0': 'car' }, labelsDir: labels });
    await run('export.reproduce', { exportId: 'export1', outputDir: labels });
    await assert.rejects(run('export.reproduce', { exportId: 'export1', outputDir: outside }), /尚未通过/);
    const outputPath = path.join(labels, '效果图.png');
    await assert.rejects(run('annotation.render', { assetId: 'a', outputPath }), /保存对话框/);
    await grants.addOutput(outputPath);
    await run('annotation.render', { assetId: 'a', outputPath, format: 'png' });
    await assert.rejects(run('annotation.render', { assetId: 'a', outputPath, format: 'jpeg' }), /扩展名/);
    await assert.rejects(run('annotation.render', { assetId: 'a', outputPath: path.join(labels, '另一个.png') }), /保存对话框/);
    await writeFile(outputPath, 'rendered');
    assert.equal(await grants.require(outputPath, ['output'], false), outputPath);
    const freshSession = new PathGrants();
    await assert.rejects(authorizeCommandPaths('export.reproduce', { outputDir: labels }, freshSession), /尚未通过/);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-manual-grant-'));
    await rm(root, { recursive: true, force: true });
  }
});
test('开发对话框只消费隔离目录内真实文件，目录连接不能越界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-dialog-'));
  try {
    const fixtures = path.join(root, 'fixtures'); const outside = path.join(root, 'outside');
    await mkdir(fixtures); await mkdir(outside); const filename = path.join(fixtures, '标签.txt'); await writeFile(filename, '');
    const queuePath = path.join(root, 'dialog-fixtures.json'); const dialog = new DialogFixtures(root);
    await writeFile(queuePath, JSON.stringify([{ kind: 'labels', paths: [filename] }, { kind: 'save', path: path.join(fixtures, '效果图.png') }]));
    assert.deepEqual(await dialog.take('labels'), [filename]);
    assert.deepEqual(await dialog.take('save'), [path.join(fixtures, '效果图.png')]);
    await assert.rejects(dialog.take('labels'), /队列/);
    await symlink(outside, path.join(fixtures, 'linked'), 'junction');
    await writeFile(queuePath, JSON.stringify([{ kind: 'directory', paths: [path.join(fixtures, 'linked')] }]));
    await assert.rejects(dialog.take('directory'), /隔离目录之外/);
    await writeFile(queuePath, JSON.stringify([{ kind: 'save', path: path.join(fixtures, 'linked', 'should-not-write.png') }]));
    await assert.rejects(dialog.take('save'), /隔离目录之外/);
    const redirectedProfile = path.join(root, 'redirected-profile'); await mkdir(redirectedProfile);
    await symlink(outside, path.join(redirectedProfile, 'fixtures'), 'junction');
    await writeFile(path.join(redirectedProfile, 'dialog-fixtures.json'), JSON.stringify([{ kind: 'directory', paths: [outside] }]));
    await assert.rejects(new DialogFixtures(redirectedProfile).take('directory'), /不能重定向/);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-dialog-'));
    await rm(root, { recursive: true, force: true });
  }
});
test('SSE 支持跨字块、心跳和 CRLF，拒绝错位序号', () => {
  const parser = new SseDecoder();
  const event = { sequence: 9, type: 'asset.saved', timestamp: '2026-09-10T00:00:00Z', payload: {} };
  assert.deepEqual(parser.push(': heartbeat\n\nid: 9\r\ndata: ' + JSON.stringify(event).slice(0, 23)), []);
  assert.deepEqual(parser.push(JSON.stringify(event).slice(23) + '\r\n\r\n'), [event]);
  assert.throws(() => parser.push(`id: 8\ndata: ${JSON.stringify(event)}\n\n`), /INVALID_SSE/);
});
test('诊断不保留令牌、认证头、URL 与个人绝对路径', () => {
  const result = redact('Bearer abc123 token=topsecret https://example.com/path?key=hidden C:\\Users\\private\\file.txt', ['topsecret']);
  for (const secret of ['abc123', 'topsecret', 'example.com', 'private']) assert.equal(result.includes(secret), false);
});

test('训练只放开触发与查询，数据快照必须来自已生成的数据集版本', () => {
  const parameters = { epochs: 10, device: 'gpu-auto', batch: 'auto' };
  assert.doesNotThrow(() => validateCommand('training.job.create', { datasetId: 'd', parameters, confirm: true }));
  assert.throws(() => validateCommand('training.job.create', { datasetId: 'd', parameters }), /格式不正确/);
  assert.throws(() => validateCommand('training.job.create', { datasetId: 'd', confirm: true, datasetDir: 'C:\\private' }), /格式不正确/);
  assert.doesNotThrow(() => validateCommand('training.dataset.create', { projectId: 'p', source: 'version', versionId: 'v' }));
  for (const command of ['dataset.version.list', 'dataset.version.get', 'training.dataset.list', 'training.dataset.get', 'training.job.preflight',
    'training.job.create', 'training.job.list', 'training.job.get', 'training.job.metrics', 'training.job.cancel']) {
    assert.doesNotThrow(() => assertAgentCommand(command, {}), command);
  }
  assert.doesNotThrow(() => assertAgentCommand('training.dataset.create', { source: 'version', versionId: 'v' }));
  for (const source of ['upload', 'export']) assert.throws(() => assertAgentCommand('training.dataset.create', { source, versionId: 'v' }), /数据集版本/);
  // 建类别走窄口径命令：只允许新增类别名，整个 project.update（含 settings 模板与规则）仍不开放。
  assert.doesNotThrow(() => assertAgentCommand('project.classes.add', { projectId: 'p', names: ['箱子'] }));
  assert.throws(() => assertAgentCommand('project.update', { projectId: 'p', name: '改名' }), /Agent 工具范围/);
  assert.throws(() => validateCommand('project.classes.add', { projectId: 'p', names: ['箱子'], settings: {} }), /格式不正确/);
  assert.throws(() => validateCommand('project.classes.add', { projectId: 'p', names: [] }), /格式不正确/);
  // 预检是只读的：助手要能自己回答「素材为什么进不了数据集版本」（含视频帧硬规则），否则只能猜。
  assert.doesNotThrow(() => assertAgentCommand('dataset.version.preflight', { projectId: 'p', annotationScope: 'labeled' }));
  for (const command of ['dataset.version.create', 'dataset.version.cancel', 'dataset.version.delete', 'dataset.version.items',
    'training.job.retry', 'training.job.delete', 'training.job.registerModel', 'training.job.log', 'training.root.save']) {
    assert.throws(() => assertAgentCommand(command, {}), /Agent 工具范围/, command);
  }
});

test('媒体抽帧和筛选严格校验范围，不接受私有路径与多种抽帧模式混用', () => {
  const input = { projectId: 'project', sourcePath: 'C:\\chosen.mp4', parameters: { mode: 'interval', intervalSeconds: 1, ranges: [{ start: 0, end: 3 }] } };
  assert.doesNotThrow(() => validateCommand('media.video.create', input));
  for (const change of [{ intervalSeconds: 0 }, { everyNFrames: 2 }, { sourcePath: 'C:\\hidden.mp4' }, { ranges: [{ start: 1, end: 1 }] },
    { ranges: [{ start: 0, end: 3 }, { start: 2, end: 4 }] }, { ranges: [{ start: 0, end: Infinity }] }, { maxFrames: 10001 }, { maxOutputBytes: Number.MAX_SAFE_INTEGER + 1 },
    { outputSize: { width: 20000, height: 20000 } }, { timeoutMs: 86400001 }]) assert.throws(() => validateCommand('media.video.create', { ...input, parameters: { ...input.parameters, ...change } }));
  assert.throws(() => validateCommand('media.screening.create', { projectId: 'project', assetIds: ['asset', 'asset'], parameters: {} }));
  assert.throws(() => validateCommand('media.screening.create', { projectId: 'project', parameters: { blurEnabled: true } }));
  assert.doesNotThrow(() => validateCommand('media.screening.create', { projectId: 'project', parameters: { blurEnabled: true, blurThreshold: 0, maxComparisons: 0, maxPairs: 0 } }));
  assert.doesNotThrow(() => validateCommand('media.video.frames', { jobId: 'job', limit: 500 }));
  assert.throws(() => validateCommand('media.video.frames', { jobId: 'job', limit: 501 }));
  assert.doesNotThrow(() => validateCommand('media.job.list', { limit: 100 }));
  assert.throws(() => validateCommand('media.job.list', { limit: 101 }));
  assert.throws(() => validateCommand('media.job.resolve', { jobId: 'job' }));
  for (const field of ['ffmpegPath', 'ffprobePath', 'mediaFfmpegPath', 'mediaFfprobePath']) assert.throws(() => validateCommand('settings.save', { settings: { desktop: { nested: { [field]: 'C:\\tool.exe' } } } }));
  assert.throws(() => assertAgentCommand('media.runtime.configure', { ffmpegPath: null, ffprobePath: null }));
  // media.video.create 开放给 Agent 的前提是 PathGrants 只放行用户已授权（kind=video）的路径；
  // 授权本身仍只能由文件选择器或拖拽产生，见下方「视频探测和创建只能读取原生视频选择授权」用例。
  assert.doesNotThrow(() => assertAgentCommand('media.video.create', input));
  for (const command of ['media.job.get', 'media.job.list', 'media.video.frames', 'media.screening.result', 'media.screening.create']) assert.doesNotThrow(() => assertAgentCommand(command));
  const definition = { version: 1, name: '媒体导入', steps: [{ id: 'import.1', kind: 'import', enabled: true, parameters: { mediaJobId: 'job' } }] };
  const flow = { projectId: 'project', definition, input: { source: 'project', selection: 'all' } };
  assert.doesNotThrow(() => validateCommand('flow.create', flow));
  assert.throws(() => validateCommand('flow.create', { ...flow, definition: { ...definition, steps: [{ ...definition.steps[0], parameters: { mediaJobId: 'job', paths: ['C:\\hidden.png'] } }] } }));
  const filterFlow = (excludeAssetIds: string[]) => ({ ...flow, definition: { ...definition, steps: [{ id: 'filter.1', kind: 'filter', enabled: true,
    parameters: { screening: { blurEnabled: true, blurThreshold: 100000, maxComparisons: 0 }, excludeAssetIds } }] } });
  assert.doesNotThrow(() => validateCommand('flow.preflight', filterFlow(['video_frame_asset_1'])));
  assert.doesNotThrow(() => validateCommand('flow.create', filterFlow([])));
  assert.throws(() => validateCommand('flow.create', filterFlow(['asset', 'asset'])));
  assert.throws(() => validateCommand('flow.create', filterFlow(Array.from({ length: 10001 }, (_, i) => `asset${i}`))));
  const event = { sequence: 7, type: 'media.job.progress', timestamp: '2026-09-10T00:00:00Z', mediaJobId: 'job', payload: { completedFrames: 2 } };
  assert.deepEqual(new SseDecoder().push(`id: 7\ndata: ${JSON.stringify(event)}\n\n`), [event]);
});

test('视频探测和创建只能读取原生视频选择授权，目录授权不扩大到视频', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-video-grant-'));
  try {
    const selected = path.join(root, 'selected.mp4'); await writeFile(selected, '视频夹具');
    const grants = new PathGrants(); await grants.add(root, 'directory'); await grants.add(selected, 'images');
    await assert.rejects(authorizeCommandPaths('media.video.inspect', { sourcePath: selected }, grants), /尚未通过/);
    await assert.rejects(authorizeCommandPaths('media.video.create', { sourcePath: selected }, grants), /尚未通过/);
    await grants.add(selected, 'video');
    await authorizeCommandPaths('media.video.inspect', { sourcePath: selected }, grants);
    await authorizeCommandPaths('media.video.create', { sourcePath: selected }, grants);
  } finally { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-video-grant-')); await rm(root, { recursive: true, force: true }); }
});

test('素材扩展名白名单以引擎实际能力为下限，三处共用一份常量', async () => {
  // 选择器 filters、拖入白名单、目录扫描若各写一份，就会出现「同一类素材走不同入口可用格式不同」；
  // 更隐蔽的是目录导入：引擎只收 jpg/jpeg/png，按拖入白名单放开会静默少收素材。
  assert.deepEqual([...IMAGE_EXTENSIONS], ['jpg', 'jpeg', 'png']);
  assert.equal(isImagePath('D:/随便/图.PNG'), true);
  assert.equal(isImagePath('D:/随便/图.webp'), false);
  assert.equal(isVideoPath('D:/随便/片.M4V'), true);
  assert.equal(isVideoPath('D:/随便/片.txt'), false);
  // 引擎的目录扫描正则必须与这份常量一致；改了引擎就要同步改常量，反之亦然。
  const engine = await readFile(path.resolve('engine/src/main/java/cn/autolabel/engine/Projects.java'), 'utf8');
  const walk = /Files\.walk\(path,(\d+)\)/.exec(engine);
  assert.ok(walk, '引擎目录扫描实现应保持可识别，便于这份一致性断言');
  assert.equal(Number(walk![1]), DIRECTORY_SCAN_MAX_DEPTH, '目录递归层数应与引擎一致');
  assert.match(engine, /matches\("\.\*\\\\\.\(jpe\?g\|png\)\$"\)/, '引擎目录扫描的扩展名应与 IMAGE_EXTENSIONS 一致');
  assert.match(engine, /limit\(10001-files\.size\(\)\)/, '单次导入上限应与 DIRECTORY_SCAN_MAX_FILES 一致');
});
