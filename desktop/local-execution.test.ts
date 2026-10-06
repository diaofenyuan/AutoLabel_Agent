import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { DesktopPreferences } from './storage';
import { LocalExecutionSettings } from './local-execution';
import { EngineManager, waitForEngineExit } from './engine';
import { mediaTargetFromUrl, normalizeMedia, PathGrants, publicInputResult } from './security';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-local-desktop-'));
  const preferences = new DesktopPreferences(path.join(root, 'preferences.json')); await preferences.load();
  const grants = new PathGrants(); const local = new LocalExecutionSettings(preferences, grants);
  const calls: unknown[] = []; const engine = { request: async (command: string, payload?: Record<string, unknown>) => { calls.push({ command, payload }); return { configured: payload?.pythonPath !== null }; }, log: () => undefined };
  return { root, preferences, grants, local, calls, engine, close: async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'autolabel-local-desktop-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

test('Python 配置只接受解释器精确授权，持久化失败回退且失效路径不阻断普通启动', async () => {
  const f = await fixture();
  try {
    const python = path.join(f.root, 'python.exe'); await writeFile(python, 'fixture');
    await f.grants.add(f.root, 'directory'); await f.grants.add(python, 'model');
    await assert.rejects(f.local.configure(f.engine, python, () => undefined)); assert.equal(f.calls.length, 0);
    await f.grants.add(python, 'python'); await f.local.configure(f.engine, python, () => undefined);
    assert.equal(await new LocalExecutionSettings(f.preferences, new PathGrants()).pythonPath(), python);
    assert.equal(f.local.busy, false);
    await mkdir(f.preferences.filename + '.tmp');
    await assert.rejects(f.local.configure(f.engine, null, () => undefined), /未能保存/);
    assert.deepEqual(f.calls.slice(-2), [{ command: 'local.runtime.configure', payload: { pythonPath: null } }, { command: 'local.runtime.configure', payload: { pythonPath: python } }]);
    assert.equal(f.preferences.value.localPythonPath, python); assert.equal(f.local.uncertain, false);
    await rm(python); assert.equal(await f.local.pythonPath(), undefined);
  } finally { await f.close(); }
});

test('真实 Java 正常退出和强制终止均清理阻塞 Python，新作用域不能恢复模型执行授权', { skip: process.env.AUTOLABEL_LOCAL_PROCESS_INTEGRATION !== '1', timeout: 90000 }, async t => {
  const python = process.env.AUTOLABEL_PYTHON_PATH;
  const inference = process.env.AUTOLABEL_INFERENCE_DIR;
  assert.ok(python && path.isAbsolute(python), '必须明确指定已验证的 Python');
  assert.ok(inference && process.env.AUTOLABEL_ENGINE_JAR && process.env.AUTOLABEL_JAVA_HOME, '必须指定冻结 worker、JAR 和 Java 运行时');
  const pythonExecutable = (await realpath(python)).toLowerCase();
  const childProcesses = async (parentPid: number): Promise<Array<{ pid: number; started: string; name: string; executable: string }>> => {
    assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0);
    const command = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o'); name = $_.Name; executable = $_.ExecutablePath } } | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' });
    if (!stdout.trim()) return []; const parsed = JSON.parse(stdout); return Array.isArray(parsed) ? parsed : [parsed];
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  for (const mode of ['graceful', 'forced'] as const) {
    const f = await fixture(); let javaPid = 0; let pythonProcess: { pid: number; started: string } | undefined;
    let scope = 'selected-scope';
    const engine = new EngineManager({ packaged: false, root: f.root, resources: '', dataDir: path.join(f.root, 'data'), credentials: async () => [],
      localPythonPath: () => f.local.pythonPath(), localModelAuthorizations: () => f.local.modelAuthorizations(scope) });
    try {
      const workerDir = path.join(f.root, 'inference'); await mkdir(workerDir);
      await copyFile(path.join(inference, 'worker.py'), path.join(workerDir, 'worker.py'));
      process.env.AUTOLABEL_INFERENCE_DIR = workerDir;
      // 保留真实 worker 与父进程监控，只用同目录测试模块把预测停在可观测的阻塞点。
      await writeFile(path.join(workerDir, 'torch.py'), "__version__ = 'blocked-fixture'\nclass cuda:\n    @staticmethod\n    def is_available(): return False\n");
      await writeFile(path.join(workerDir, 'ultralytics.py'), "import json, os, time\nfrom pathlib import Path\n__version__ = 'blocked-fixture'\nclass YOLO:\n    def __init__(self, model_path, task):\n        self.task = task\n        self.names = {0: 'fixture'}\n    def predict(self, **kwargs):\n        Path(__file__).with_name('blocked.json').write_text(json.dumps({'pid': os.getpid(), 'parentPid': os.getppid()}), encoding='utf-8')\n        time.sleep(300)\n        return []\n");
      assert.equal((await engine.start()).state, 'ready');
      javaPid = (engine as any).child.pid;
      assert.equal((await engine.request('diagnostics.get') as any).databaseVersion, 4);
      const unconfigured = await engine.request('local.runtime.get') as any;
      assert.equal(unconfigured.configured, false);
      const initialChildren = await childProcesses(javaPid);
      t.diagnostic(`${mode} 未配置 Python 时的 Java 子进程：${initialChildren.map(child => child.name).join(', ') || '无'}`);
      assert.equal(initialChildren.filter(child => child.executable?.toLowerCase() === pythonExecutable).length, 0);
      const project = await engine.request('project.example') as any;
      const assets = await engine.request('asset.list', { projectId: project.id, limit: 1 }) as any;
      await f.grants.add(python, 'python'); await f.local.configure(engine, python, () => undefined);
      const modelPath = path.join(f.root, 'blocked-model.pt'); await writeFile(modelPath, 'isolated-blocking-model');
      const model = await engine.request('local.model.register', { name: '阻塞清理夹具', taskType: 'detect', modelPath }) as any;
      await assert.rejects(engine.request('local.model.load', { modelId: model.id, modelVersion: model.version, device: 'cpu' }));
      await f.grants.add(modelPath, 'model'); await f.local.authorizeSelectedModel(scope, modelPath, () => undefined, engine);
      const loaded = await engine.request('local.model.load', { modelId: model.id, modelVersion: model.version, device: 'cpu' }) as any;
      assert.equal(loaded.loaded, true);
      await engine.request('local.run.create', { projectId: project.id, assetIds: [assets.items[0].id], modelId: model.id, modelVersion: model.version,
        device: 'cpu', classMap: { '0': project.classes[0].id }, timeoutMs: 600000 });
      let blocked: { pid: number; parentPid: number } | undefined;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !blocked) {
        try { blocked = JSON.parse(await readFile(path.join(workerDir, 'blocked.json'), 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      assert.ok(blocked, '真实 worker 必须已进入预测阻塞点'); assert.equal(blocked.parentPid, javaPid);
      pythonProcess = (await childProcesses(javaPid)).find(child => child.pid === blocked.pid); assert.ok(pythonProcess);
      const started = Date.now();
      if (mode === 'graceful') await engine.stop();
      else {
        const ownedJava = (engine as any).child; assert.equal(ownedJava.pid, javaPid); assert.equal(ownedJava.kill(), true);
        await waitForEngineExit(ownedJava, 6000);
      }
      while (alive(pythonProcess.pid) && Date.now() - started < 6000) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(alive(pythonProcess.pid), false, `${mode} 退出后不能留下阻塞 Python`);
      t.diagnostic(`${mode} 阻塞 Python 已退出，耗时 ${Date.now() - started} ms`);
      if (mode === 'graceful') {
        scope = 'external-restore'; assert.equal((await engine.start()).state, 'ready');
        javaPid = (engine as any).child.pid;
        await assert.rejects(engine.request('local.model.load', { modelId: model.id, modelVersion: model.version, device: 'cpu' }));
        assert.equal((await childProcesses(javaPid)).filter(child => child.executable?.toLowerCase() === pythonExecutable).length, 0, '新作用域的历史模型不能启动 Python');
      }
    } finally {
      await engine.stop();
      if (pythonProcess && alive(pythonProcess.pid)) {
        const capturedPython = pythonProcess;
        const owned = (await childProcesses(javaPid)).find(child => child.pid === capturedPython.pid && child.started === capturedPython.started);
        if (owned) process.kill(owned.pid);
      }
      await f.close();
      process.env.AUTOLABEL_INFERENCE_DIR = inference;
    }
  }
});

test('模型执行授权按作用域和摘要持久化，外部恢复与改写文件不能继承授权', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.root, '模型.pt'); await writeFile(model, 'model-original');
    await assert.rejects(f.local.authorizeSelectedModel('current', model, () => undefined));
    await f.grants.add(model, 'model'); await f.local.authorizeSelectedModel('current', model, () => undefined, f.engine);
    const modelHash = createHash('sha256').update('model-original').digest('hex');
    assert.deepEqual(f.calls, [{ command: 'local.model.authorize', payload: { path: model, modelHash } }]);
    const reloadedPreferences = new DesktopPreferences(f.preferences.filename); await reloadedPreferences.load();
    const restarted = new LocalExecutionSettings(reloadedPreferences, new PathGrants());
    assert.equal(await restarted.requireModel('current', model, modelHash), model);
    assert.deepEqual(await restarted.modelAuthorizations('current'), [{ path: model, modelHash }]);
    assert.deepEqual(await restarted.modelAuthorizations('external-restore'), []);
    await assert.rejects(restarted.requireModel('external-restore', model, modelHash), /重新选择/);
    await writeFile(model, 'changed');
    await assert.rejects(restarted.requireModel('current', model, createHash('sha256').update('changed').digest('hex')), /重新选择/);
  } finally { await f.close(); }
});

test('授权键保留真实路径：重启后完整回读，大小写不同的文件互不继承授权', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const upper = path.join(f.root, 'Model.pt'), lower = path.join(f.root, 'model.pt');
    await writeFile(upper, 'upper-model'); await writeFile(lower, 'lower-model');
    await f.grants.add(upper, 'model'); await f.grants.add(lower, 'model');
    const upperHash = createHash('sha256').update('upper-model').digest('hex');
    const lowerHash = createHash('sha256').update('lower-model').digest('hex');
    await f.local.authorizeSelectedModel('current', upper, () => undefined, f.engine);
    assert.deepEqual(f.calls, [{ command: 'local.model.authorize', payload: { path: upper, modelHash: upperHash } }]);
    // 落盘键必须是真实路径本身，不能被折叠成另一个路径。
    const saved = f.preferences.value.localModelGrants as Record<string, Record<string, string>>;
    assert.deepEqual(Object.keys(saved.current), [upper]);
    const reloaded = new DesktopPreferences(f.preferences.filename); await reloaded.load();
    const restarted = new LocalExecutionSettings(reloaded, new PathGrants());
    assert.equal(await restarted.requireModel('current', upper, upperHash), upper);
    // 仅大小写不同的另一个文件不得借用这条授权。
    await assert.rejects(restarted.requireModel('current', lower, lowerHash), /重新选择/);
    await assert.rejects(restarted.requireModel('current', lower, upperHash), /重新选择/);
    assert.deepEqual(await restarted.modelAuthorizations('current'), [{ path: upper, modelHash: upperHash }]);
  } finally { await f.close(); }
});

test('模型授权键保存真实路径身份：重建后仍能按真实路径回传引擎', async () => {
  const f = await fixture();
  try {
    const selected = path.join(f.root, 'Case.pt'); await writeFile(selected, 'weights');
    const real = await realpath(selected);
    await f.grants.add(selected, 'model');
    await f.local.authorizeSelectedModel('current', selected, () => undefined, f.engine);
    // 键是路径身份（Windows 归一为小写），不是「无条件小写」臆造出的字符串：
    // 后者在大小写敏感卷上取不到文件，重启后授权会被静默丢弃。
    const scopes = f.preferences.value.localModelGrants as Record<string, Record<string, string>>;
    assert.deepEqual(Object.keys(scopes.current), [process.platform === 'win32' ? real.toLowerCase() : real]);
    const reloaded = new DesktopPreferences(f.preferences.filename); await reloaded.load();
    const restarted = new LocalExecutionSettings(reloaded, new PathGrants());
    const modelHash = createHash('sha256').update('weights').digest('hex');
    assert.deepEqual(await restarted.modelAuthorizations('current'), [{ path: real, modelHash }]);
  } finally { await f.close(); }
});

test('大小写敏感卷上仅大小写不同的两个模型文件互不授权', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const lower = path.join(f.root, 'model.pt'), upper = path.join(f.root, 'MODEL.pt');
    await writeFile(lower, 'lower'); await writeFile(upper, 'upper');
    // 文件授权按真实身份判定：对 lower 的授权不能顺带放行另一个真实文件 upper。
    await f.grants.add(lower, 'model');
    await assert.rejects(f.grants.require(upper, ['model']), /尚未通过/);
    await f.local.authorizeSelectedModel('current', lower, () => undefined);
    const lowerHash = createHash('sha256').update('lower').digest('hex');
    const restarted = new LocalExecutionSettings(f.preferences, new PathGrants());
    assert.deepEqual(await restarted.modelAuthorizations('current'), [{ path: lower, modelHash: lowerHash }]);
    await assert.rejects(restarted.requireModel('current', upper, createHash('sha256').update('upper').digest('hex')), /重新选择/);
  } finally { await f.close(); }
});

test('模型库授权只接受库内文件，目录前缀与库外路径都不能放行', async () => {
  const f = await fixture();
  try {
    const library = path.join(f.root, 'library'); await mkdir(library, { recursive: true });
    const sibling = path.join(f.root, 'library2'); await mkdir(sibling);
    const inside = path.join(library, 'yolo11n.pt'); await writeFile(inside, 'library-model');
    const outside = path.join(f.root, 'outside.pt'); await writeFile(outside, 'outside-model');
    const sneaky = path.join(sibling, 'sneaky.pt'); await writeFile(sneaky, 'sneaky-model');
    const roots = [await realpath(library)];
    const modelHash = createHash('sha256').update('library-model').digest('hex');
    // 库外文件与「同前缀的相邻目录」都不算库内；guard 通过也不能绕过。
    await assert.rejects(f.local.trustModel('current', outside, roots, () => undefined, f.engine), /模型库/);
    await assert.rejects(f.local.trustModel('current', sneaky, roots, () => undefined), /模型库/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await f.local.trustModel('current', inside, roots, () => undefined, f.engine), { path: inside, modelHash });
    assert.deepEqual(f.calls, [{ command: 'local.model.authorize', payload: { path: inside, modelHash } }]);
    const reloaded = new DesktopPreferences(f.preferences.filename); await reloaded.load();
    const restarted = new LocalExecutionSettings(reloaded, new PathGrants());
    assert.deepEqual(await restarted.modelAuthorizations('current'), [{ path: inside, modelHash }]);
    assert.equal(await restarted.requireModel('current', inside, modelHash), inside);
    assert.deepEqual(await restarted.modelAuthorizations('external-restore'), []);
  } finally { await f.close(); }
});

test('大小写敏感平台上授权路径区分大小写，与引擎 pathKey 同口径', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const upper = path.join(f.root, 'Model.pt'); const lower = path.join(f.root, 'model.pt');
    await writeFile(upper, 'same-bytes'); await writeFile(lower, 'same-bytes');
    await f.grants.add(upper, 'model');
    await f.local.authorizeSelectedModel('current', upper, () => undefined);
    const modelHash = createHash('sha256').update('same-bytes').digest('hex');
    const reloaded = new DesktopPreferences(f.preferences.filename); await reloaded.load();
    const restarted = new LocalExecutionSettings(reloaded, new PathGrants());
    assert.equal(await restarted.requireModel('current', upper, modelHash), upper);
    await assert.rejects(restarted.requireModel('current', lower, modelHash), /重新选择/);
    assert.deepEqual(await restarted.modelAuthorizations('current'), [{ path: upper, modelHash }]);
  } finally { await f.close(); }
});

test('损坏或旧版的模型授权配置按空处理，重新授权后写回干净结构', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.root, 'damaged.pt'); await writeFile(model, 'model-bytes');
    // 手工构造损坏与旧结构：作用域值不是对象、条目摘要非法、键不是绝对路径。
    await f.preferences.update({ localModelGrants: { current: 'junk', legacy: ['x'], other: { [model]: 'not-a-hash', 'relative.pt': 'a'.repeat(64) } } });
    const preferences = new DesktopPreferences(f.preferences.filename); await preferences.load();
    const local = new LocalExecutionSettings(preferences, f.grants);
    for (const scope of ['current', 'legacy', 'other']) assert.deepEqual(await local.modelAuthorizations(scope), []);
    await assert.rejects(local.requireModel('current', model, 'a'.repeat(64)), /重新选择/);
    await f.grants.add(model, 'model');
    const modelHash = createHash('sha256').update('model-bytes').digest('hex');
    assert.equal(await local.authorizeSelectedModel('current', model, () => undefined), model);
    assert.deepEqual(Object.keys(preferences.value.localModelGrants as Record<string, unknown>).sort(), ['current']);
    assert.deepEqual(await local.modelAuthorizations('current'), [{ path: model, modelHash }]);
  } finally { await f.close(); }
});

test('并发授权经串行化后不丢条目，也不残留忙碌状态', async () => {
  const f = await fixture();
  try {
    const models = await Promise.all([1, 2, 3, 4, 5].map(async index => {
      const file = path.join(f.root, `model-${index}.pt`); await writeFile(file, `weights-${index}`); await f.grants.add(file, 'model'); return file;
    }));
    await Promise.all(models.map(file => f.local.authorizeSelectedModel('current', file, () => undefined, f.engine)));
    const scopes = f.preferences.value.localModelGrants as Record<string, Record<string, string>>;
    assert.deepEqual(Object.keys(scopes.current).sort(), [...models].sort());
    assert.equal(f.calls.length, models.length);
    assert.equal(f.local.busy, false);
  } finally { await f.close(); }
});

test('固定输入媒体只读取受管 PNG，拒绝错绑、查询、外部文件和目录连接', async () => {
  const f = await fixture();
  try {
    const data = path.join(f.root, 'data'); const views = path.join(data, 'flow-inputs'); const outside = path.join(f.root, 'outside');
    await mkdir(views, { recursive: true }); await mkdir(outside);
    const png = path.join(views, 'input.png'); const hidden = path.join(outside, 'hidden.png');
    await writeFile(png, 'png-fixture'); await writeFile(hidden, 'private');
    const engine = new EngineManager({ packaged: false, root: f.root, resources: '', dataDir: data, credentials: async () => [] });
    (engine as any).port = 1;
    let descriptor = { inputId: 'input-1', assetId: 'asset-1', path: png, contentHash: 'a'.repeat(64), width: 1, height: 1, mimeType: 'image/png' };
    engine.request = async (command, payload) => { assert.equal(command, 'flow.input.image'); assert.deepEqual(payload, { inputId: 'input-1' }); return descriptor; };
    const target = mediaTargetFromUrl('autolabel-media://input/input-1');
    assert.equal(await (await engine.media(target, new AbortController().signal)).text(), 'png-fixture');
    descriptor = { ...descriptor, path: hidden }; await assert.rejects(engine.media(target, new AbortController().signal));
    await symlink(outside, path.join(views, 'linked'), 'junction');
    descriptor = { ...descriptor, path: path.join(views, 'linked', 'hidden.png') }; await assert.rejects(engine.media(target, new AbortController().signal));
    descriptor = { ...descriptor, path: png, inputId: 'wrong' }; await assert.rejects(engine.media(target, new AbortController().signal));
    for (const suffix of ['?path=private', '#view', '/other', '\n']) assert.throws(() => mediaTargetFromUrl('autolabel-media://input/input-1' + suffix));
    assert.deepEqual(normalizeMedia({ assetId: 'asset-1', mediaUrl: '/flow-input-media/input-1' }), { assetId: 'asset-1', mediaUrl: 'autolabel-media://input/input-1' });
    assert.deepEqual(normalizeMedia({ assetId: 'asset-1', mediaUrl: 'autolabel-media://input/input-1?path=other' }), { assetId: 'asset-1' });
    assert.deepEqual(publicInputResult({ inputId: 'input-1', provenance: { modelHash: 'h', modelPath: hidden }, rawResult: { points: [{ x: 1, y: 2 }], workerPath: hidden } }),
      { inputId: 'input-1', provenance: { modelHash: 'h' }, rawResult: { points: [{ x: 1, y: 2 }] } });
  } finally { await f.close(); }
});
