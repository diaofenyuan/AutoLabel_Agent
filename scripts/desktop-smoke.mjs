import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const windowOnly = process.argv.includes('--window');
const uiOnly = process.argv.includes('--ui');
const connectionOnly = process.argv.includes('--connection-ui');
const manualOnly = process.argv.includes('--manual');
const releaseOnly = process.argv.includes('--release');
const release5Only = process.argv.includes('--release5');
const release6aOnly = process.argv.includes('--release6a');
const release6bOnly = process.argv.includes('--release6b');
const release7aOnly = process.argv.includes('--release7a');
const release7bOnly = process.argv.includes('--release7b');
const updateUiOnly = process.argv.includes('--update-ui');
const runControlOnly = process.argv.includes('--run-controls');
const mediaOnly = process.argv.includes('--media');
const trainingUiOnly = process.argv.includes('--training-ui');
if ((manualOnly || mediaOnly) && packaged) throw new Error('手工开发验收不能在稳定安装包中运行');
const label = trainingUiOnly ? 'training-ui-check' : mediaOnly ? 'media-check' : runControlOnly ? 'run-control-check' : updateUiOnly ? 'update-ui-check' : connectionOnly ? 'connection-ui-check' : release7bOnly ? 'release7b-check' : release7aOnly ? 'release7a-check' : release6bOnly ? 'release6b-check' : release6aOnly ? 'release6a-check' : release5Only ? 'release5-check' : releaseOnly ? 'release-check' : manualOnly ? 'manual-check' : uiOnly ? 'ui-check' : windowOnly ? 'window-check' : packaged ? 'packaged-smoke' : 'desktop-smoke';
const output = path.join(root, 'build', label + '.json');
await mkdir(path.dirname(output), { recursive: true });
const testUserData = process.env.AUTOLABEL_TEST_USER_DATA
  ? path.resolve(root, process.env.AUTOLABEL_TEST_USER_DATA)
  : path.join(root, 'build', label + ((updateUiOnly || runControlOnly || mediaOnly || trainingUiOnly) ? `-user-data-${Date.now()}` : '-user-data'));
const env = { ...process.env, AUTOLABEL_TEST_USER_DATA: testUserData, AUTOLABEL_SMOKE_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;
if (packaged) { env.JAVA_HOME = 'C:\\nonexistent'; env.AUTOLABEL_JAVA_HOME = 'C:\\nonexistent'; }
if (updateUiOnly) { env.AUTOLABEL_UPDATE_TEST = '1'; env.AUTOLABEL_UPDATE_UI_CHECK = '1'; }
if (runControlOnly) env.AUTOLABEL_RUN_CONTROL_UI_CHECK = '1';
if (mediaOnly) env.AUTOLABEL_MEDIA_UI_CHECK = '1';
const releaseDirectory = path.resolve(root, process.env.AUTOLABEL_RELEASE_DIR || 'build/release');
const executable = packaged ? path.join(releaseDirectory, 'win-unpacked/自动标注小助手.exe') : createRequire(import.meta.url)('electron');
const args = packaged ? ['--desktop-smoke'] : [root, '--desktop-smoke'];
if (windowOnly) args.push('--desktop-window-check');
if (uiOnly) args.push('--desktop-ui-check');
if (releaseOnly) args.push('--desktop-release-check');
if (release5Only) args.push('--desktop-release5-check');
if (release6aOnly) args.push('--desktop-release6a-check');
if (release6bOnly) args.push('--desktop-release6b-check');
if (release7aOnly) args.push('--desktop-release7a-check');
if (release7bOnly) args.push('--desktop-release7b-check');
if (updateUiOnly || runControlOnly || mediaOnly) args.push('--desktop-manual-check');
if (connectionOnly) args.push('--desktop-connection-check');
if (trainingUiOnly) args.push('--desktop-training-check');
if (manualOnly || updateUiOnly || runControlOnly || mediaOnly) {
  const { build } = await import('esbuild');
  await build({ entryPoints: [path.join(root, 'renderer/tests/desktop-manual-check.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: path.join(root, 'desktop/dist/manual.test.cjs'), logLevel: 'warning' });
  args.push('--desktop-manual-check');
}
// 受限或显卡不可用环境（Chromium GPU 进程无法启动）可显式追加开关：
// AUTOLABEL_EXTRA_LAUNCH_ARGS="--no-sandbox --in-process-gpu --disable-gpu"
const extraLaunchArgs = (process.env.AUTOLABEL_EXTRA_LAUNCH_ARGS || '').split(/\s+/).filter(Boolean);
args.push(...extraLaunchArgs);
const run = async runArgs => {
const child = spawn(executable, runArgs, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
return new Promise((resolve, reject) => {
  // 打包态首次启动（解压 asar 与初始化运行时）可能超过默认 60 秒，受限环境可显式放宽。
  const timeoutMs = Number(process.env.AUTOLABEL_SMOKE_TIMEOUT ?? 60000);
  const timeout = setTimeout(() => { child.kill(); reject(new Error('桌面验收超时')); }, timeoutMs);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('exit', code => { clearTimeout(timeout); resolve(code); });
});
};
const exit = await run(args);
assert.equal(exit, 0);
let result = JSON.parse(await readFile(output, 'utf8'));
if (release7bOnly) {
  assert.equal(result.packaged, true); assert.equal(result.passed, true); assert.equal(result.engineState, 'ready'); assert.equal(result.databaseVersion, 5);
  assert.equal(result.runtime.configured, true); assert.equal(result.localRuntime.configured, false); assert.equal(result.localRuntime.workerAvailable, true);
  console.log(`7B 新包启动、固定媒体工具与许可证资料检查通过：${output}`); process.exit(0);
}
if (release7aOnly) {
  assert.equal(result.packaged, true); assert.equal(result.engineState, 'ready'); assert.equal(result.databaseVersion, 4);
  assert.equal(result.runtime.configured, false); assert.equal(result.runtime.workerAvailable, true); assert.equal(result.modelCount, 0);
  assert.equal(result.capabilities.viewReuse, true); assert.ok(result.capabilities.availableSteps.includes('transform')); assert.ok(result.capabilities.availableSteps.includes('local'));
  assert.equal(result.preflight.canStart, true); assert.equal(result.flow.status, 'completed'); assert.equal(result.flow.requestsUsed, 0);
  assert.equal(result.flow.artifactKind, 'views'); assert.equal(result.flow.inputCount, 1); assert.ok(result.flow.inputId);
  assert.deepEqual(result.preview, { loaded: true, width: 64, height: 64 });
  console.log(`7A 新包启动、固定 worker 与模型输入预览检查通过：${output}`); process.exit(0);
}
if (release6bOnly) {
  assert.equal(result.packaged, true); assert.equal(result.engineState, 'ready'); assert.equal(result.databaseVersion, 3);
  assert.deepEqual(result.policyDefaults, { reuseEnabled: true, forceRerun: false, maxAge: '' });
  assert.equal(result.requests, 1); assert.equal(result.reused.requestsUsed, 0); assert.equal(result.reused.reused, 1);
  assert.equal(result.reused.attempts, 0); assert.equal(result.reused.sourceRunId, result.firstRunId); assert.equal(result.readableResult, true);
  console.log(`6B 新包复用策略与结果读取检查通过：${output}`); process.exit(0);
}
if (release6aOnly) {
  assert.equal(result.packaged, true); assert.equal(result.engineState, 'ready'); assert.equal(result.databaseVersion, 3); assert.equal(result.resourceRead, true);
  for (const kind of ['filter', 'review', 'export']) assert.ok(result.capabilities.availableSteps.includes(kind));
  assert.equal(result.preflight.canStart, true); assert.equal(result.manualGate, true); assert.equal(result.gateWithoutAcknowledgement, true);
  assert.equal(result.flow.status, 'completed'); assert.equal(result.flow.requestsUsed, 0); assert.equal(result.flow.artifactKind, 'export'); assert.ok(result.flow.exportId);
  console.log(`6A 新包流程启动检查通过：${output}`); process.exit(0);
}
if (release5Only) {
  assert.equal(result.packaged, true); assert.equal(result.engineState, 'ready'); assert.equal(result.rendererAssetPageLimit, 100);
  assert.equal(result.paginationControls, true); assert.equal(result.resourcesEntry, true); assert.equal(result.resourceCommand.kind, 'prompt');
  assert.equal(result.backupEntry, true); assert.equal(result.preflight.ready, true); assert.equal(result.preflight.credentialsIncluded, false); assert.equal(result.storage.busy, false);
  console.log(`5+backup 新包启动检查通过：${output}`); process.exit(0);
}
if (releaseOnly) {
  assert.equal(result.packaged, true); assert.equal(result.engineState, 'ready'); assert.equal(result.estimate.estimatedCost, 0.0013);
  assert.equal(result.budget.cost.hardLimit, false); assert.equal(result.newPage, true); assert.equal(result.rerunRegistered, true);
  console.log(`新包版本与 4C 启动检查通过：${output}`); process.exit(0);
}
if (manualOnly) { assert.equal(result.passed, true); console.log(`新源码手工链路检查通过：${output}`); process.exit(0); }
if (updateUiOnly) { assert.equal(result.passed, true); assert.deepEqual(result.states, ['available','ready','install-gate','cancelled','checksum-error']); console.log(`更新界面本地回环检查通过：${output}`); process.exit(0); }
if (runControlOnly) { assert.equal(result.passed, true); assert.equal(result.paused.cancelled, true); assert.equal(result.failedRetry.retryDispatched, true); assert.ok(result.failedRetry.callsAfter > result.failedRetry.callsBefore); console.log(`任务中心暂停/恢复/取消/失败重试界面检查通过：${output}`); process.exit(0); }
if (mediaOnly) { assert.equal(result.passed, true); assert.equal(result.timeline?.frameCount, 4); assert.equal(result.timeline?.previewLoaded, true); console.log(`视频时间轴与轨迹候选界面检查通过：${output}`); process.exit(0); }
if (trainingUiOnly) { assert.equal(result.passed, true); assert.ok(['ready', 'invalid'].includes(result.dataset.status)); assert.equal(result.wizard.tabs.length, 3); console.log(`训练页向导与真实快照界面检查通过：${output}`); process.exit(0); }
if (connectionOnly) { assert.equal(result.before.ready, true); assert.equal(result.before.banner, false); assert.equal(result.disconnected.visible, true); assert.equal(result.disconnected.buttonEnabled, true); assert.equal(result.restored.ready, true); assert.equal(result.restored.banner, false); console.log(`断线重连桌面界面检查通过：${output}`); process.exit(0); }
if (uiOnly) {
  // 主导航收敛后验收覆盖三项主导航 + 示例工作台。
  const pages = result.pages.filter(page => page.page);
  assert.equal(pages.length, 4); assert.ok(pages.every(page => page.bridge && page.bodyLength > 40 && !page.error));
  assert.ok(result.pages.find(page => page.check === 'manual-example')?.loaded);
  assert.ok(pages.find(page => page.page === 'workbench').canvasObjects > 0);
  assert.equal(await run(args.map(arg => arg === '--desktop-ui-check' ? '--desktop-ui-resume' : arg)), 0);
  result = JSON.parse(await readFile(output, 'utf8')); assert.equal(result.restartPersistence.restored, true);
  console.log(`主导航与人工示例检查通过：${output}`); process.exit(0);
}
if (windowOnly) {
  for (const view of [result.ui, result.fallback]) {
    assert.equal(view.headerCount, 1); assert.equal(view.drag, 'drag'); assert.equal(view.controls.length, 3);
    assert.ok(view.controls.every(control => control.region === 'no-drag'));
    assert.equal(view.maximized, true); assert.equal(view.restored, true);
  }
  assert.equal(result.resizable, true); assert.equal(result.updateStatus.state, 'unconfigured');
  console.log(`窗口与诊断界面检查通过：${output}`); process.exit(0);
}
assert.equal(result.bridge, true); assert.equal(result.nodeExposed, false);
assert.equal(result.blockedCommand, true); assert.equal(result.blockedPath, true);
assert.equal(result.status.state, 'ready'); assert.equal(result.receivedCommittedEvent, true);
assert.equal(result.media.loaded, true); assert.equal(result.workerResponded, true);
assert.equal(result.credentialEncryptedAtRest, true); assert.equal(result.credentialRoundtrip, true);
if (packaged) assert.equal(result.diagnostics.packaged, true);
console.log(`桌面验收通过：${output}`);
