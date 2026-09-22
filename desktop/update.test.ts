import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateManager, assertUpdateIdle, compareVersions, validateUpdateUrl, type UpdateManifest } from './updater';
import { verifyUpdatePackage } from './update-package';
import { DesktopError, validateCommand } from './validation';
import { PathGrants, mediaTargetFromUrl } from './security';
import { EngineManager } from './engine';

const sample = Buffer.from('MZ-local-update-test-content');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
// 真实安装包文件名带版本号，随 package.json 推导；同时用其产品版本校验更新清单。
const appVersion = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version as string;
const setupPackage = path.resolve(`build/release/AutoLabel-Setup-${appVersion}-x64.exe`);
async function fixture(options: { packageFile?: string; slow?: boolean; corrupt?: boolean; malformed?: boolean; version?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-update-'));
  let digest = hash(sample), size = sample.length;
  if (options.packageFile) {
    size = (await stat(options.packageFile)).size; const hasher = createHash('sha256');
    for await (const chunk of createReadStream(options.packageFile)) hasher.update(chunk);
    digest = hasher.digest('hex');
  }
  let manifest: UpdateManifest;
  const server: Server = createServer((req, res) => {
    if (req.url === '/manifest') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(options.malformed ? { ...manifest, appId: 'other.application' } : manifest)); return;
    }
    if (req.url === '/bad-redirect') { res.writeHead(302, { Location: 'file:///C:/Windows/win.ini' }); res.end(); return; }
    if (req.url === '/error') { res.writeHead(500); res.end(); return; }
    if (req.url !== '/package') { res.writeHead(404); res.end(); return; }
    if (options.slow) {
      res.setHeader('Content-Length', 65536); res.write('MZ');
      const timer = setTimeout(() => res.end(Buffer.alloc(65534)), 5000); res.on('close', () => clearTimeout(timer)); return;
    }
    if (options.packageFile) { res.setHeader('Content-Length', size); createReadStream(options.packageFile).pipe(res); return; }
    res.end(options.corrupt ? Buffer.from('X'.repeat(sample.length)) : sample);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  manifest = { schemaVersion: 1, appId: 'com.autolabel.assistant', platform: 'win32', arch: 'x64', version: options.version ?? '0.1.0', releaseNotes: '本地测试清单，不代表发布了新版本',
    downloadUrl: `${origin}/package`, sha256: digest, size: options.slow ? 65536 : size };
  return { directory, origin, manifest,
    create: (extra: Partial<ConstructorParameters<typeof UpdateManager>[0]> = {}) => {
      const updater = new UpdateManager({ directory, currentVersion: '0.0.9', allowLoopbackHttp: true,
        verifyPackage: async () => undefined, prepareInstall: async () => undefined,
        launchInstaller: async () => { throw new Error('测试禁止执行安装包'); }, ...extra });
      updater.configure(`${origin}/manifest`); return updater;
    },
    close: async () => {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-update-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('更新版本比较与生产 URL 边界', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.9') > 0);
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0);
  assert.throws(() => compareVersions('1.0.0-01', '1.0.0'));
  assert.throws(() => validateUpdateUrl('http://127.0.0.1:1234/manifest'));
  assert.throws(() => validateUpdateUrl('http://localhost:1234/manifest', true));
  assert.throws(() => validateUpdateUrl('http://example.com/manifest', true));
  assert.throws(() => validateUpdateUrl('https://user:secret@example.com/manifest'));
  assert.equal(validateUpdateUrl('http://127.0.0.1:1234/manifest', true).hostname, '127.0.0.1');
  assert.throws(() => validateCommand('update.install', { path: 'C:\\other.exe' }));
});
test('安装前阻断本地或媒体配置不确定状态', () => {
  const base = { installing: false, agentActive: 0, credentialSaves: 0, localBusy: false, localUncertain: false, mediaBusy: false, mediaUncertain: false, storageBusy: false };
  assert.doesNotThrow(() => assertUpdateIdle(base));
  for (const field of ['localUncertain', 'mediaUncertain'] as const) {
    assert.throws(() => assertUpdateIdle({ ...base, [field]: true }), (error: unknown) => error instanceof DesktopError && error.code === 'UPDATE_TASKS_ACTIVE');
  }
});
test('清单错误、HTTP故障、未发布清单与降级重定向均不产生可用更新', async () => {
  const f = await fixture({ malformed: true });
  try {
    const updater = f.create(); assert.equal((await updater.check()).error?.code, 'UPDATE_MANIFEST_INVALID');
    // 404 = 清单尚未发布（官方默认源在首个发布之前的常态）：如实「已是最新」，不冒充故障。
    updater.configure(`${f.origin}/missing`); const missing = await updater.check();
    assert.equal(missing.state, 'up-to-date'); assert.equal(missing.error?.code, undefined);
    // 5xx 才是服务器故障：明确报 UPDATE_HTTP_ERROR。
    updater.configure(`${f.origin}/error`); assert.equal((await updater.check()).error?.code, 'UPDATE_HTTP_ERROR');
    updater.configure(`${f.origin}/bad-redirect`); assert.equal((await updater.check()).error?.code, 'UPDATE_URL_INVALID');
    updater.configure(''); assert.equal((await updater.check()).state, 'unconfigured');
  } finally { await f.close(); }
});
test('相同或旧版本不允许下载，损坏安装包不进入ready', async () => {
  const f = await fixture({ corrupt: true });
  try {
    const same = f.create({ currentVersion: '0.1.0' }); assert.equal((await same.check()).state, 'up-to-date');
    await assert.rejects(same.download(), /新版本/);
    const updater = f.create(); assert.equal((await updater.check()).state, 'available');
    assert.equal((await updater.download()).error?.code, 'UPDATE_CHECKSUM_MISMATCH');
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});
test('取消流式下载清理临时文件，不把已收字节当作完整更新', async () => {
  const f = await fixture({ slow: true });
  try {
    const updater = f.create(); await updater.check(); const downloading = updater.download();
    const deadline = Date.now() + 3000;
    while (updater.status().downloadedBytes === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(updater.status().downloadedBytes, 2); updater.cancel();
    assert.equal((await downloading).state, 'cancelled'); assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});
test('原子ready可恢复，活动任务拒绝安装，文件被改写后重新校验失败', async () => {
  const f = await fixture(); let launched = false;
  try {
    const updater = f.create({ prepareInstall: async () => { throw new DesktopError('UPDATE_TASKS_ACTIVE', '有活动任务'); }, launchInstaller: async () => { launched = true; } });
    await updater.check(); assert.equal((await updater.download()).state, 'ready');
    const blocked = await updater.install(); assert.equal(blocked.state, 'ready'); assert.equal(blocked.error?.code, 'UPDATE_TASKS_ACTIVE'); assert.equal(launched, false);
    const restored = f.create(); await restored.restore(); assert.equal(restored.status().state, 'ready');
    const packageName = (await readdir(f.directory)).find(value => value.endsWith('.exe'))!;
    await writeFile(path.join(f.directory, packageName), 'tampered');
    assert.equal((await updater.install()).error?.code, 'UPDATE_CHECKSUM_MISMATCH'); assert.equal(launched, false);
  } finally { await f.close(); }
});
test('保存对话框可授权不存在的精确文件，不能改写相邻文件名', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-update-'));
  try {
    const grants = new PathGrants(); const expected = path.join(directory, '人工效果图.png');
    assert.equal(await grants.addOutput(expected), expected); assert.equal(await grants.requireOutput(expected), expected);
    await assert.rejects(grants.requireOutput(path.join(directory, 'other.png')), /授权/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-update-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('安装分派只取得内部已验证文件；测试记录分派而不执行程序', async () => {
  const f = await fixture(); let dispatched = '';
  try {
    const updater = f.create({ launchInstaller: async filename => { dispatched = filename; } });
    await updater.check(); await updater.download();
    assert.equal((await updater.install()).state, 'installing');
    assert.equal(dispatched, path.join(f.directory, `AutoLabel-0.1.0-${f.manifest.sha256}.exe`));
  } finally { await f.close(); }
});
test('真实本项目NSIS包经本地HTTP下载，核对SHA256和PE产品版本；不执行安装', async () => {
  const packageFile = setupPackage;
  // 清单版本必须与包内 PE 产品版本一致，故显式传入当前版本而非夹具默认值。
  const f = await fixture({ packageFile, version: appVersion });
  try {
    const updater = f.create({ verifyPackage: verifyUpdatePackage });
    assert.equal((await updater.check()).state, 'available');
    const result = await updater.download();
    assert.equal(result.state, 'ready', JSON.stringify(result));
    assert.equal(result.downloadedBytes, (await stat(packageFile)).size);
    const receipt = JSON.parse(await readFile(path.join(f.directory, 'ready.json'), 'utf8'));
    assert.equal(receipt.manifest.version, appVersion);
    await assert.rejects(verifyUpdatePackage(packageFile, { ...f.manifest, version: '0.0.1' }), /版本/);
  } finally { await f.close(); }
});
test('Java 维护握手通过桌面代理原子锁写入口并可解除', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-update-'));
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: directory, credentials: async () => [] });
  try {
    assert.equal((await engine.start()).state, 'ready');
    const prepared = await engine.request('system.prepareUpdate') as { ready: boolean; locked: boolean };
    assert.equal(prepared.ready, true); assert.equal(prepared.locked, true);
    await assert.rejects(engine.request('project.create', { name: '不应创建', taskType: 'detect' }), (error: unknown) => error instanceof DesktopError && error.code === 'engine_update_locked');
    assert.deepEqual(await engine.request('project.list'), []);
    await engine.request('system.cancelUpdate');
    const status = await engine.request('system.canUpdate') as { locked: boolean }; assert.equal(status.locked, false);
  } finally {
    await engine.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-update-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('4C 桌面读取冻结 PNG，维护锁覆盖全部新增写入而允许读取', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-evaluation-'));
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: directory, credentials: async () => [] });
  const request = async (command: string, input: Record<string, unknown>) => {
    const checked = validateCommand(command, input); return engine.request(checked.command, checked.payload) as Promise<any>;
  };
  try {
    assert.equal((await engine.start()).state, 'ready');
    const project = await request('project.example', {});
    const { items } = await request('asset.list', { projectId: project.id, limit: 1 }); const assetId = items[0].id;
    const set = await request('evaluationSet.create', { projectId: project.id, name: '桌面独立真值验收', assetIds: [assetId] });
    const truth = await request('evaluationSet.saveTruth', { setId: set.id, assetId, annotations: [], baseTruthVersion: 0, source: 'manual' });
    const published = await request('evaluationSet.publish', { setId: set.id, baseSetRevision: truth.setRevision });
    const media = await engine.media(mediaTargetFromUrl(`autolabel-media://evaluation/${published.id}/${assetId}`), new AbortController().signal);
    assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await media.arrayBuffer()); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(hash(bytes), items[0].contentHash);
    const prepared = await engine.request('system.prepareUpdate') as { ready: boolean; locked: boolean };
    assert.equal(prepared.ready, true); assert.equal(prepared.locked, true);
    const writes: [string, Record<string, unknown>][] = [
      ['evaluationSet.create', { projectId: project.id, name: '不应创建', assetIds: [assetId] }],
      ['evaluationSet.saveTruth', { setId: set.id, assetId, annotations: [], baseTruthVersion: 1, source: 'manual' }],
      ['evaluationSet.publish', { setId: set.id, baseSetRevision: truth.setRevision }],
      ['evaluation.create', { setVersionId: published.id, schemes: [{ runId: 'nonexistent' }] }],
      ['review.build', { evaluationId: 'nonexistent' }],
      ['review.resolve', { itemId: 'nonexistent', baseCandidateVersion: null, action: 'checked' }],
      ['review.sample', { projectId: project.id, assetIds: [assetId], seed: 'desktop', count: 1 }],
    ];
    for (const [command, input] of writes) await assert.rejects(request(command, input), (error: unknown) => error instanceof DesktopError && error.code === 'engine_update_locked', command);
    assert.equal((await request('evaluationSet.list', { projectId: project.id })).length, 1);
    assert.equal((await request('evaluationSet.getTruth', { setId: set.id, assetId })).truthVersion, 1);
    assert.deepEqual(await request('evaluation.list', { projectId: project.id }), []);
    assert.equal((await request('review.list', { projectId: project.id, limit: 1 })).total, 0);
    await engine.request('system.cancelUpdate');
    const sample = await request('review.sample', { projectId: project.id, assetIds: [assetId], seed: 'desktop', count: 1 });
    assert.equal(sample.count, 1);
  } finally {
    await engine.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-evaluation-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('资源库通过真实桌面代理固定人工版本和 PNG，维护锁覆盖写入', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-resource-'));
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: directory, credentials: async () => [] });
  const request = async (command: string, input: Record<string, unknown>) => {
    const checked = validateCommand(command, input); return engine.request(checked.command, checked.payload) as Promise<any>;
  };
  try {
    assert.equal((await engine.start()).state, 'ready');
    const project = await request('project.example', {});
    const { items } = await request('asset.list', { projectId: project.id, limit: 1 });
    let asset = await request('asset.get', { assetId: items[0].id });
    asset = await request('annotation.save', { assetId: asset.id, annotations: asset.annotations, baseVersion: asset.version, confirm: true });
    const reference = await request('resource.reference', { assetId: asset.id, assetVersion: asset.version, name: '固定人工参考', note: '初始人工版本' });
    assert.equal(reference.kind, 'reference'); assert.equal(reference.version, 1);
    assert.equal(reference.mediaUrl, `autolabel-media://resource/${reference.id}/1`);
    const target = mediaTargetFromUrl(reference.mediaUrl);
    const media = await engine.media(target, new AbortController().signal);
    assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await media.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(hash(bytes), reference.content.contentHash);
    const revised = await request('resource.reference', { id: reference.id, baseVersion: 1, assetId: asset.id, assetVersion: asset.version, name: '第二版人工参考', note: '修订说明' });
    assert.equal(revised.version, 2);
    const frozen = await request('resource.get', { resourceId: reference.id, version: 1 });
    assert.equal(frozen.note, '初始人工版本'); assert.equal(frozen.mediaUrl, reference.mediaUrl);
    const prompt = await request('resource.save', { kind: 'prompt', name: '资源提示词', content: '仅标注明确可见目标' });
    const applied = await request('resource.apply', { projectId: project.id, resourceId: prompt.id, version: prompt.version, fields: ['prompt'] });
    assert.equal(applied.project.settings.prompt, '仅标注明确可见目标'); assert.deepEqual(applied.project.classes, project.classes);
    await assert.rejects(request('resource.save', { id: prompt.id, baseVersion: 0, kind: 'prompt', name: '陈旧编辑', content: '不能覆盖' }), (error: unknown) => error instanceof DesktopError && error.code === 'resource_version_conflict');
    // 伪造内部返回仍不能把其他版本或受管目录之外的文件交给界面。
    const internalImage = await engine.request('resource.image', { resourceId: reference.id, version: 1 }) as Record<string, unknown>;
    const originalRequest = engine.request.bind(engine);
    try {
      engine.request = async () => ({ ...internalImage, resourceVersion: 2 });
      await assert.rejects(engine.media(target, new AbortController().signal), /版本与请求不一致/);
      engine.request = async () => ({ ...internalImage, path: process.execPath });
      await assert.rejects(engine.media(target, new AbortController().signal), /不在受管资源目录/);
    } finally { engine.request = originalRequest; }
    assert.equal((await engine.request('system.prepareUpdate') as { locked: boolean }).locked, true);
    const writes: [string, Record<string, unknown>][] = [
      ['resource.save', { kind: 'prompt', name: '不应保存', content: '暂停写入' }],
      ['resource.apply', { projectId: project.id, resourceId: prompt.id, fields: ['prompt'] }],
      ['resource.reference', { assetId: asset.id, assetVersion: asset.version, name: '不应保存' }],
    ];
    for (const [command, input] of writes) await assert.rejects(request(command, input), (error: unknown) => error instanceof DesktopError && error.code === 'engine_update_locked', command);
    assert.equal((await request('resource.list', { kind: 'reference', query: '第二版', limit: 1 })).length, 1);
    assert.equal((await request('resource.get', { resourceId: reference.id, version: 1 })).version, 1);
    const lockedMedia = await engine.media(target, new AbortController().signal);
    assert.equal(hash(Buffer.from(await lockedMedia.arrayBuffer())), reference.content.contentHash);
    await engine.request('system.cancelUpdate');
  } finally {
    await engine.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-resource-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('费用与重新评测通过真实桌面代理，维护锁覆盖新写入并保留结果口径', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autolabel-rerun-'));
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: directory, credentials: async () => [] });
  let calls = 0; let fixtureError: unknown; let releaseReply!: () => void;
  const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls++; const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(body.model, 'local-rerun');
      assert.ok(body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url')));
      const target = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
        .filter((part: any) => part.type === 'text').map((part: any) => { try { return JSON.parse(part.text); } catch { return null; } })
        .find((part: any) => part?.role === 'target');
      assert.equal(typeof target?.assetId, 'string');
      await replyGate;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'local-reply', choices: [{ message: { role: 'assistant', content: JSON.stringify({ assetId: target.assetId, annotations: [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 20 } } }));
    } catch (error) { fixtureError = error; res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"local fixture failed"}}'); }
  });
  const request = async (command: string, input: Record<string, unknown>) => {
    const checked = validateCommand(command, input); return engine.request(checked.command, checked.payload) as Promise<any>;
  };
  const waitFor = async (check: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('本地重新评测未在预期时间完成');
  };
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    assert.equal((await engine.start()).state, 'ready');
    const project = await request('project.example', {}); const { items } = await request('asset.list', { projectId: project.id, limit: 1 });
    const assetId = items[0].id; const set = await request('evaluationSet.create', { projectId: project.id, name: '本地重新评测验收', assetIds: [assetId] });
    const truth = await request('evaluationSet.saveTruth', { setId: set.id, assetId, annotations: [], baseTruthVersion: 0, source: 'manual' });
    const published = await request('evaluationSet.publish', { setId: set.id, baseSetRevision: truth.setRevision });
    const providerInput = { name: '本地受控协议', baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'chat-completions', model: 'local-rerun',
      pricing: { model: 'local-rerun', currency: 'USD', inputPerMillion: 10, cachedInputPerMillion: 5, outputPerMillion: 20 } };
    const provider = await request('provider.save', providerInput); await engine.setCredential(provider.id, 'local-fixture-key');
    const estimateInput = { providerId: provider.id, model: 'local-rerun', requests: 1, inputTokensPerRequest: 100, outputTokensPerRequest: 20 };
    const unknown = await request('budget.estimate', estimateInput);
    assert.equal(unknown.estimatedCost, null); assert.equal(unknown.assumptions.cachedInputTokensPerRequest, null); assert.equal(unknown.hardLimit, false);
    const estimate = await request('budget.estimate', { ...estimateInput, cachedInputTokensPerRequest: 20 });
    assert.equal(estimate.source, 'explicit_token_assumptions'); assert.equal(estimate.estimatedCost, 0.0013); assert.equal(calls, 0);
    await request('budget.update', { budgetScopeId: 'desktop-rerun', maxRequests: 1, costLimit: { currency: 'USD', amount: 1 } });
    const input = { setVersionId: published.id, budgetScopeId: 'desktop-rerun', maxRequests: 1,
      schemes: [{ providerId: provider.id, model: 'local-rerun', prompt: '只返回合法 annotations 数组', concurrency: 1, maxRetries: 0 }] };
    assert.equal((await request('evaluation.rerun.preflight', input)).canStart, true); assert.equal(calls, 0);
    const comparison = await request('evaluation.rerun.create', input);
    await waitFor(() => calls > 0);
    // 固定本地响应时机，验证真实请求进行中不能取得安装维护锁。
    const busy = await engine.request('system.prepareUpdate') as { ready: boolean; locked: boolean };
    assert.equal(busy.ready, false); assert.equal(busy.locked, false); releaseReply();
    await waitFor(async () => (await request('evaluation.rerun.get', { comparisonId: comparison.id })).canFinish);
    assert.equal(fixtureError, undefined);
    const evaluation = await request('evaluation.rerun.finish', { comparisonId: comparison.id });
    assert.equal(evaluation.source, 'fresh_run_snapshot'); assert.equal(evaluation.comparisonId, comparison.id);
    assert.equal((await request('evaluation.rerun.finish', { comparisonId: comparison.id })).id, evaluation.id);
    const result = await request('evaluation.results', { evaluationId: evaluation.id, limit: 1 });
    assert.equal(result.total, 1); assert.equal(result.items[0].status, 'scorable', JSON.stringify(result.items[0]));
    const budget = await request('budget.get', { budgetScopeId: 'desktop-rerun' });
    assert.equal(budget.requestsUsed, 1); assert.equal(budget.cost.knownCost, 0.0013); assert.equal(budget.cost.unknownCalls, 0);
    assert.equal(budget.cost.hardLimit, false); assert.equal(budget.cost.providerBilledAmount, null);
    await waitFor(async () => (await engine.request('system.prepareUpdate') as { ready: boolean }).ready);
    for (const [command, payload] of [
      ['provider.save', { ...providerInput, id: provider.id, pricing: null }],
      ['budget.update', { budgetScopeId: 'desktop-rerun', maxRequests: 2, costLimit: null }],
      ['evaluation.rerun.create', input], ['evaluation.rerun.finish', { comparisonId: comparison.id }],
    ] as [string, Record<string, unknown>][]) {
      await assert.rejects(request(command, payload), (error: unknown) => error instanceof DesktopError && error.code === 'engine_update_locked', command);
    }
    assert.equal((await request('budget.estimate', { ...estimateInput, cachedInputTokensPerRequest: 20 })).estimatedCost, 0.0013);
    assert.equal((await request('evaluation.rerun.get', { comparisonId: comparison.id })).status, 'completed');
    assert.equal((await request('evaluation.rerun.preflight', input)).canStart, false);
    await engine.request('system.cancelUpdate');
    assert.equal((await request('budget.update', { budgetScopeId: 'desktop-rerun', maxRequests: 2, costLimit: null })).maxRequests, 2);
    assert.equal(calls, 1);
  } finally {
    releaseReply(); await engine.stop();
    if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-rerun-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('中文空格路径中的安装包身份可通过stdin正确验证', async () => {
  // 清单版本需与真实包的产品版本一致，否则身份校验会先因版本不符而拒绝。
  const f = await fixture({ version: appVersion });
  try {
    const filename = path.join(f.directory, '自动标注 更新安装包.exe');
    await copyFile(setupPackage, filename);
    await verifyUpdatePackage(filename, f.manifest);
  } finally { await f.close(); }
});
