import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { EngineManager } from './engine';
import { MediaExecutionSettings } from './media-execution';
import { DesktopPreferences } from './storage';
import { PathGrants } from './security';

test('媒体工具仅使用固定目录或专用授权，关闭配置能持久且不会搜索其他位置', async () => {
  const root = await mkdtemp(path.resolve('.qa/media-tools-unit-'));
  try {
    const bundled = path.join(root, 'bundled'); await mkdir(bundled);
    const ffmpegPath = path.join(bundled, 'ffmpeg.exe'), ffprobePath = path.join(bundled, 'ffprobe.exe');
    await writeFile(ffmpegPath, '固定工具夹具'); await writeFile(ffprobePath, '固定工具夹具');
    const preferences = new DesktopPreferences(path.join(root, 'prefs.json')), grants = new PathGrants();
    const settings = new MediaExecutionSettings(preferences, grants, bundled);
    assert.deepEqual(await settings.paths(), { ffmpegPath, ffprobePath });
    const calls: unknown[] = []; const engine = { request: async (command: string, input: unknown) => { calls.push({ command, input }); return { configured: true }; }, log() {} };
    await grants.add(ffmpegPath, 'python'); await grants.add(ffprobePath, 'directory');
    await assert.rejects(settings.configure(engine, { ffmpegPath, ffprobePath }, () => {}), /尚未通过/); assert.equal(calls.length, 0);
    await grants.add(ffmpegPath, 'ffmpeg'); await grants.add(ffprobePath, 'ffprobe');
    await settings.configure(engine, { ffmpegPath, ffprobePath }, () => {});
    assert.equal(JSON.parse(await readFile(preferences.filename, 'utf8')).mediaFfmpegPath, ffmpegPath);
    await settings.configure(engine, { ffmpegPath: null, ffprobePath: null }, () => {});
    const restarted = new DesktopPreferences(preferences.filename); await restarted.load();
    assert.deepEqual(await new MediaExecutionSettings(restarted, new PathGrants(), bundled).paths(), {});
    preferences.value.mediaFfmpegPath = path.join(root, 'missing.exe'); preferences.value.mediaFfprobePath = null;
    assert.deepEqual(await settings.paths(), {}); assert.equal(settings.busy, false);
  } finally { assert.ok(root.startsWith(path.resolve('.qa') + path.sep + 'media-tools-unit-')); await rm(root, { recursive: true, force: true }); }
});

test('媒体配置保存失败会回退；回退失败封锁后续执行直到重连', async () => {
  const root = await mkdtemp(path.resolve('.qa/media-tools-rollback-'));
  try {
    const preferences = new DesktopPreferences(path.join(root, 'prefs.json'));
    const settings = new MediaExecutionSettings(preferences, new PathGrants(), root);
    preferences.update = async () => { throw new Error('磁盘写入失败'); };
    const calls: unknown[] = []; let failRollback = false;
    const engine = { request: async (_command: string, input: unknown) => { calls.push(input); if (failRollback && calls.length % 2 === 0) throw new Error('断连'); return {}; }, log() {} };
    await assert.rejects(settings.configure(engine, { ffmpegPath: null, ffprobePath: null }, () => {}), /未能保存/);
    assert.deepEqual(calls, [{ ffmpegPath: null, ffprobePath: null }, { ffmpegPath: null, ffprobePath: null }]); assert.equal(settings.uncertain, false);
    failRollback = true;
    await assert.rejects(settings.configure(engine, { ffmpegPath: null, ffprobePath: null }, () => {}), /未能保存/);
    assert.equal(settings.uncertain, true); assert.equal(settings.busy, false);
  } finally { assert.ok(root.startsWith(path.resolve('.qa') + path.sep + 'media-tools-rollback-')); await rm(root, { recursive: true, force: true }); }
});

test('真实媒体进程取消、维护屏障和桌面正常退出', { skip: process.env.AUTOLABEL_MEDIA_PROCESS_INTEGRATION !== '1', timeout: 90000 }, async t => {
  assert.ok(process.env.AUTOLABEL_ENGINE_JAR, '须显式指定本次 7B 候选引擎');
  assert.ok(process.env.AUTOLABEL_INFERENCE_DIR, '须显式指定冻结的 7A worker，不能跟随正在开发的脚本');
  const root = await mkdtemp(path.resolve('.qa/media-process-'));
  const tools = path.resolve('build/media-tools'), ffmpegPath = path.join(tools, 'ffmpeg.exe'), ffprobePath = path.join(tools, 'ffprobe.exe');
  const sourcePath = path.join(root, 'source.mp4'), dataDir = path.join(root, 'data');
  const invoke = promisify(execFile);
  await invoke(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', sourcePath], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir, credentials: async () => [], mediaToolPaths: async () => ({ ffmpegPath, ffprobePath }) });
  let javaPid = 0, owned: Array<{ pid: number; started: string; executable: string }> = [];
  const children = async (): Promise<typeof owned> => {
    assert.ok(Number.isSafeInteger(javaPid) && javaPid > 0);
    const command = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${javaPid}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o'); executable = $_.ExecutablePath } } | ConvertTo-Json -Compress`;
    const { stdout } = await invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' });
    if (!stdout.trim()) return []; const parsed = JSON.parse(stdout); return (Array.isArray(parsed) ? parsed : [parsed]).filter(item => [ffmpegPath, ffprobePath].some(value => value.toLowerCase() === item.executable?.toLowerCase()));
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  const wait = async (condition: () => Promise<boolean>, message: string, limit = 10000) => {
    const deadline = Date.now() + limit; while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(message);
  };
  const report: Record<string, unknown> = { ffmpegVersion: JSON.parse(await readFile(path.join(tools, 'versions.json'), 'utf8')), sourcePath, dataDir,
    engineJar: process.env.AUTOLABEL_ENGINE_JAR, workerDirectory: process.env.AUTOLABEL_INFERENCE_DIR };
  try {
    assert.equal((await engine.start()).state, 'ready'); javaPid = (engine as any).child.pid;
    const localRuntime = await engine.request('local.runtime.get') as any;
    assert.equal(localRuntime.configured, false);
    assert.equal(localRuntime.workerHash, createHash('sha256').update(await readFile(path.join(process.env.AUTOLABEL_INFERENCE_DIR!, 'worker.py'))).digest('hex'));
    report.frozenWorkerMatched = true;
    assert.deepEqual(await engine.request('media.runtime.get'), { configured: true, ffmpegConfigured: true, ffprobeConfigured: true, busy: false });
    const project = await engine.request('project.create', { name: '媒体进程隔离验收', taskType: 'detect' }) as any;
    const create = async () => {
      const job = await engine.request('media.video.create', { projectId: project.id, sourcePath,
        parameters: { mode: 'every_n', everyNFrames: 1, ranges: [{ start: 0, end: 12 }], outputSize: { width: 5000, height: 5000 }, timeoutMs: 60000, maxOutputBytes: 268435456 } }) as any;
      await wait(async () => { owned = await children(); return owned.some(item => item.executable.toLowerCase() === ffmpegPath.toLowerCase()); }, '没有观测到本次 Java 的真实 FFmpeg 子进程');
      return job;
    };
    const first = await create(); report.cancelPid = owned.map(item => item.pid);
    const update = await engine.request('system.prepareUpdate') as any; assert.equal(update.ready, false); assert.equal(update.locked, false); assert.ok(update.counts.activeMediaWorkers > 0);
    const operationId = randomUUID(); const maintenance = await engine.request('system.prepareDataMaintenance', { operationId }) as any;
    assert.equal(maintenance.ready, false); assert.equal(maintenance.locked, true); assert.ok(maintenance.counts.activeMediaWorkers > 0);
    await engine.request('system.cancelDataMaintenance', { operationId });
    const start = Date.now(); await engine.request('media.job.cancel', { jobId: first.id });
    await wait(async () => !(await engine.request('media.runtime.get') as any).busy && owned.every(item => !alive(item.pid)), '取消后仍存在本次媒体进程');
    assert.equal((await engine.request('media.job.get', { jobId: first.id }) as any).status, 'cancelled'); report.cancelMs = Date.now() - start;
    const idleOwner = randomUUID(); const idle = await engine.request('system.prepareDataMaintenance', { operationId: idleOwner }) as any;
    assert.equal(idle.ready, true); await engine.request('system.cancelDataMaintenance', { operationId: idleOwner }); report.maintenanceWaitedForMedia = true;
    const second = await create(); report.stopPid = owned.map(item => item.pid);
    const stopping = Date.now(); await engine.stop(); await wait(async () => owned.every(item => !alive(item.pid)), '正常退出后仍存在本次媒体进程'); report.stopMs = Date.now() - stopping;
    assert.equal((await engine.start()).state, 'ready'); javaPid = (engine as any).child.pid;
    const interrupted = await engine.request('media.job.get', { jobId: second.id }) as any;
    assert.equal(interrupted.status, 'interrupted'); assert.equal((await children()).length, 0);
    report.restartStatus = interrupted.status; report.passed = true;
    await writeFile(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
    t.diagnostic(`取消 ${report.cancelMs} ms，退出 ${report.stopMs} ms，维护屏障与重启无重发通过；证据 ${path.join(root, 'verification.json')}`);
  } finally {
    await engine.stop();
    if (owned.some(item => alive(item.pid))) for (const item of await children()) {
      if (owned.some(captured => captured.pid === item.pid && captured.started === item.started)) process.kill(item.pid);
    }
  }
});

test('媒体探测刚提交即退出及排队任务更新屏障', { skip: process.env.AUTOLABEL_MEDIA_GAP_INTEGRATION !== '1', timeout: 30000 }, async t => {
  assert.ok(process.env.AUTOLABEL_ENGINE_JAR && process.env.AUTOLABEL_INFERENCE_DIR && process.env.AUTOLABEL_MEDIA_SOURCE, '须指定候选引擎、冻结 worker 和隔离视频夹具');
  const root = await mkdtemp(path.resolve('.qa/media-gap-')), sourcePath = path.resolve(process.env.AUTOLABEL_MEDIA_SOURCE);
  const ffmpegPath = path.resolve('build/media-tools/ffmpeg.exe'), ffprobePath = path.resolve('build/media-tools/ffprobe.exe');
  const engine = new EngineManager({ packaged: false, root: process.cwd(), resources: '', dataDir: path.join(root, 'data'), credentials: async () => [], mediaToolPaths: async () => ({ ffmpegPath, ffprobePath }) });
  try {
    assert.equal((await engine.start()).state, 'ready'); const javaPid = (engine as any).child.pid;
    const project = await engine.request('project.create', { name: '媒体退出间隙验收', taskType: 'detect' }) as any;
    await engine.suspend();
    const queued = await engine.request('media.video.create', { projectId: project.id, sourcePath, parameters: { mode: 'interval', intervalSeconds: 1, ranges: [{ start: 0, end: 2 }] } }) as any;
    assert.equal(queued.status, 'queued');
    const update = await engine.request('system.prepareUpdate') as any;
    assert.equal(update.ready, false); assert.equal(update.locked, false); assert.equal(update.counts.unfinishedMediaJobs, 1);
    const operationId = randomUUID();
    const maintenance = await engine.request('system.prepareDataMaintenance', { operationId }) as any;
    assert.equal(maintenance.ready, true); await engine.request('system.cancelDataMaintenance', { operationId });
    await engine.request('media.job.cancel', { jobId: queued.id });
    await engine.resume();
    // 刚提交探测就走真实桌面退出，不等待 FFprobe 完成或人为拉长启动间隙。
    const probing = engine.request('media.video.inspect', { sourcePath }).then(() => 'completed', () => 'interrupted');
    const started = Date.now(); await engine.stop(); const stoppedMs = Date.now() - started, probeState = await probing;
    assert.equal(probeState, 'interrupted', '探测若在关闭宽限窗口内完成，则未覆盖本次取消分支');
    assert.ok(Number.isSafeInteger(javaPid) && javaPid > 0);
    const command = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${javaPid}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; executable = $_.ExecutablePath } } | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' });
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const remaining = (Array.isArray(parsed) ? parsed : [parsed]).filter(item => [ffmpegPath, ffprobePath].some(filename => filename.toLowerCase() === item.executable?.toLowerCase()));
    assert.deepEqual(remaining, []);
    const report = { passed: true, engineJar: process.env.AUTOLABEL_ENGINE_JAR, workerDirectory: process.env.AUTOLABEL_INFERENCE_DIR,
      queuedBlocksUpdate: true, queuedAllowsDataMaintenance: true, immediatelyStoppedProbe: probeState, stopMs: stoppedMs, stopAndVerifyMs: Date.now() - started, ownedMediaProcessesRemaining: remaining.length };
    await writeFile(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
    t.diagnostic(`探测刚提交即退出 ${report.stopMs} ms；证据 ${path.join(root, 'verification.json')}`);
  } finally { await engine.stop(); }
});
