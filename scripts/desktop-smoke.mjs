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
const reasonOnly = process.argv.includes('--reason');
const annotateOnly = process.argv.includes('--annotate');
const unknownRetryOnly = process.argv.includes('--unknown-retry');
const frameScopeOnly = process.argv.includes('--frame-scope');
const projectIdentityOnly = process.argv.includes('--project-identity');
const directoryImportOnly = process.argv.includes('--directory-import');
const trainingUiOnly = process.argv.includes('--training-ui');
if ((manualOnly || mediaOnly || reasonOnly || annotateOnly || unknownRetryOnly || frameScopeOnly || projectIdentityOnly || directoryImportOnly) && packaged) throw new Error('手工开发验收不能在稳定安装包中运行');
const label = trainingUiOnly ? 'training-ui-check' : directoryImportOnly ? 'directory-import-check' : projectIdentityOnly ? 'project-identity-check' : frameScopeOnly ? 'frame-scope-check' : unknownRetryOnly ? 'unknown-retry-check' : annotateOnly ? 'annotate-check' : mediaOnly ? 'media-check' : reasonOnly ? 'reason-check' : runControlOnly ? 'run-control-check' : updateUiOnly ? 'update-ui-check' : connectionOnly ? 'connection-ui-check' : release7bOnly ? 'release7b-check' : release7aOnly ? 'release7a-check' : release6bOnly ? 'release6b-check' : release6aOnly ? 'release6a-check' : release5Only ? 'release5-check' : releaseOnly ? 'release-check' : manualOnly ? 'manual-check' : uiOnly ? 'ui-check' : windowOnly ? 'window-check' : packaged ? 'packaged-smoke' : 'desktop-smoke';
const output = path.join(root, 'build', label + '.json');
await mkdir(path.dirname(output), { recursive: true });
const testUserData = process.env.AUTOLABEL_TEST_USER_DATA
  ? path.resolve(root, process.env.AUTOLABEL_TEST_USER_DATA)
  : path.join(root, 'build', label + ((updateUiOnly || runControlOnly || mediaOnly || reasonOnly || annotateOnly || unknownRetryOnly || frameScopeOnly || projectIdentityOnly || directoryImportOnly || trainingUiOnly) ? `-user-data-${Date.now()}` : '-user-data'));
const env = { ...process.env, AUTOLABEL_TEST_USER_DATA: testUserData, AUTOLABEL_SMOKE_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;
if (packaged) { env.JAVA_HOME = 'C:\\nonexistent'; env.AUTOLABEL_JAVA_HOME = 'C:\\nonexistent'; }
if (updateUiOnly) { env.AUTOLABEL_UPDATE_TEST = '1'; env.AUTOLABEL_UPDATE_UI_CHECK = '1'; }
if (runControlOnly) env.AUTOLABEL_RUN_CONTROL_UI_CHECK = '1';
if (mediaOnly) env.AUTOLABEL_MEDIA_UI_CHECK = '1';
if (reasonOnly) env.AUTOLABEL_REASON_UI_CHECK = '1';
if (annotateOnly) env.AUTOLABEL_ANNOTATE_UI_CHECK = '1';
if (unknownRetryOnly) env.AUTOLABEL_UNKNOWN_RETRY_UI_CHECK = '1';
if (frameScopeOnly) env.AUTOLABEL_FRAME_SCOPE_UI_CHECK = '1';
if (projectIdentityOnly) env.AUTOLABEL_PROJECT_IDENTITY_UI_CHECK = '1';
if (directoryImportOnly) env.AUTOLABEL_DIRECTORY_IMPORT_UI_CHECK = '1';
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
if (updateUiOnly || runControlOnly || mediaOnly || reasonOnly || annotateOnly || unknownRetryOnly || frameScopeOnly || projectIdentityOnly || directoryImportOnly) args.push('--desktop-manual-check');
if (connectionOnly) args.push('--desktop-connection-check');
if (trainingUiOnly) args.push('--desktop-training-check');
if (manualOnly || updateUiOnly || runControlOnly || mediaOnly || reasonOnly || annotateOnly || unknownRetryOnly || frameScopeOnly || projectIdentityOnly || directoryImportOnly) {
  const { build } = await import('esbuild');
  await build({ entryPoints: [path.join(root, 'renderer/tests/desktop-manual-check.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: path.join(root, 'desktop/dist/manual.test.cjs'), logLevel: 'warning' });
  args.push('--desktop-manual-check');
}
// 受限或显卡不可用环境（Chromium GPU 进程无法启动）可显式追加开关：
// AUTOLABEL_EXTRA_LAUNCH_ARGS="--no-sandbox --in-process-gpu --disable-gpu"
const explicitLaunchArgs = (process.env.AUTOLABEL_EXTRA_LAUNCH_ARGS || '').trim();
// GPU 降级开关：无显卡通道的机器（虚拟化 / 远程会话 / 无驱动）上 Chromium GPU 进程起不来，
// 会在窗口创建前直接崩溃（退出码 0x80000003）并伴随 gpu_process_host 报错。这类机器是常见
// 验收环境，因此不要求人工设置环境变量，而是在首次失败后按特征自动重试一次。
const GPU_FALLBACK_ARGS = ['--no-sandbox', '--in-process-gpu', '--disable-gpu'];
// 只有显式传入才采用人工配置，避免与自动降级重复叠加同一个开关。
args.push(...(explicitLaunchArgs ? explicitLaunchArgs.split(/\s+/).filter(Boolean) : []));
// 仅当调用方未显式配置时才在失败后自动降级；已显式配置的环境保持原有行为，不做二次重试。
const allowAutoFallback = !explicitLaunchArgs;
// lastOutput 用于在刻意捕获输出时（GPU 失败判定）回传本次运行的日志。
let lastOutput = '';
const run = async (runArgs, collect) => {
lastOutput = '';
const stdio = collect ? ['ignore', 'pipe', 'pipe'] : 'inherit';
const child = spawn(executable, runArgs, { cwd: root, env, windowsHide: true, stdio });
if (collect) {
  const sink = chunk => { lastOutput += chunk.toString(); };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
}
return new Promise((resolve, reject) => {
  // 打包态首次启动（解压 asar 与初始化运行时）可能超过默认 60 秒，受限环境可显式放宽。
  const timeoutMs = Number(process.env.AUTOLABEL_SMOKE_TIMEOUT ?? 60000);
  const timeout = setTimeout(() => { child.kill(); reject(new Error('桌面验收超时')); }, timeoutMs);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('exit', code => { clearTimeout(timeout); resolve(code); });
});
};
// 判定是否为 GPU 通道不可用导致的启动失败，而非业务断言失败。
const isGpuLaunchFailure = code => code !== 0 && (
  /gpu_process_host|GPU process isn't usable|GPU process exited unexpectedly/i.test(lastOutput) ||
  // Node 在 Windows 上把原生崩溃码 0x80000003 呈现为无符号形态 2147483651。
  code === 2147483651
);
// 已生效的降级开关：需要传给同一脚本内的后续启动（如 ui-check 的重启持久化校验）。
let activeFallbackArgs = [];
let exit = await run(args, allowAutoFallback);
if (allowAutoFallback && isGpuLaunchFailure(exit)) {
  console.log('检测到 GPU 通道不可用，自动附加降级开关重试一次。');
  activeFallbackArgs = GPU_FALLBACK_ARGS;
  exit = await run([...args, ...activeFallbackArgs], false);
}
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
if (reasonOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 数据集版本与导出两处都必须给出中文明细、隐藏原始码，且直达动作真的落到模板入口。
  assert.equal(byCheck.get('dataset-version-preflight')?.rawCodesHidden, true);
  assert.equal(byCheck.get('dataset-version-preflight')?.directActionWorks, true);
  assert.equal(byCheck.get('annotation-scope-all')?.excluded, 0);
  assert.equal(byCheck.get('annotation-scope-all')?.deniesUnlabeledBlock, true);
  assert.equal(byCheck.get('export-preflight')?.groupedByReason, true);
  assert.equal(byCheck.get('export-preflight')?.rawCodesHidden, true);
  // 一键剔除未标注素材必须真的把素材移出范围，并且可恢复。
  assert.equal(byCheck.get('export-exclude-unlabeled')?.excluded, 2);
  assert.equal(byCheck.get('export-exclude-unlabeled')?.restorable, true);
  assert.equal(byCheck.get('export-exclude-unlabeled')?.exportReady, true);
  console.log(`数据集与导出的原因呈现检查通过：${output}`); process.exit(0);
}
if (directoryImportOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 含 webp 与 txt 的文件夹只导入 2 张，且扫描如实报出 2 个用不上的文件。
  assert.equal(byCheck.get('image-folder-import')?.assets, 2);
  assert.equal(byCheck.get('image-folder-import')?.unsupported, 2);
  // 视频文件夹先列候选再逐个发起，点「抽帧」真的打开抽帧面板。
  assert.equal(byCheck.get('video-folder-picker')?.candidates, 2);
  assert.equal(byCheck.get('video-folder-picker')?.panelOpened, true);
  // 拖入契约：图片与文件夹放行、txt 与 webp 带原因拒绝、超量回落上限与本次数量。
  assert.equal(byCheck.get('drop-contract')?.declared, 2);
  assert.equal(byCheck.get('drop-contract')?.extensionReasons, 2);
  assert.deepEqual(byCheck.get('drop-contract')?.overLimit, { limit: 500, received: 501 });
  console.log(`目录导入、拖入限制与白名单一致性检查通过：${output}`); process.exit(0);
}
if (projectIdentityOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 重复导入并入同名项目，素材不重复入库；落点在发送前可见。
  assert.equal(byCheck.get('duplicate-import-reuses-project')?.reuseNotice, true);
  assert.equal(byCheck.get('duplicate-import-reuses-project')?.assets, 2);
  assert.ok(byCheck.get('sidebar-shows-asset-count'));
  assert.ok(byCheck.get('home-shows-destination'));
  console.log(`项目身份与落点可见性检查通过：${output}`); process.exit(0);
}
if (frameScopeOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 抽帧入库即告知可用范围，且数据集版本预检给出中文原因与真实出路。
  // 抽帧产物必须自动入库：这是「抽帧完成 ≠ 素材可用」那条断链的修复点。
  assert.equal(byCheck.get('frames-auto-imported')?.stripVisible, true);
  assert.ok(byCheck.get('frames-auto-imported')?.assets > 0);
  assert.equal(byCheck.get('import-states-usable-scope')?.noticeVisible, true);
  assert.ok(byCheck.get('import-states-usable-scope')?.assets > 0);
  assert.equal(byCheck.get('dataset-preflight-video-frame-reason')?.reasonReadable, true);
  assert.equal(byCheck.get('dataset-preflight-video-frame-reason')?.rawCodesHidden, true);
  assert.equal(byCheck.get('dataset-preflight-video-frame-reason')?.exportExitWorks, true);
  console.log(`视频帧可用范围与数据集版本原因检查通过：${output}`); process.exit(0);
}
if (unknownRetryOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // failed=0 / unknown>0 时必须有可用出口，且「需要处理」给出三个下一步。
  assert.equal(byCheck.get('unknown-retry-entry')?.failed, 0);
  assert.ok(byCheck.get('unknown-retry-entry')?.unknown > 0);
  assert.equal(byCheck.get('unknown-retry-entry')?.nextSteps, 3);
  // 确认前零请求，确认后引擎收到 retryUnknown: true。
  assert.equal(byCheck.get('unknown-retry-needs-confirmation')?.callsBeforeConfirm, byCheck.get('unknown-retry-needs-confirmation')?.callsAfterCancel);
  assert.equal(byCheck.get('unknown-retry-dispatched')?.retryUnknown, true);
  console.log(`结果未知的补救出口检查通过：${output}`); process.exit(0);
}
if (annotateOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 入口存在但在无类别时明确不可用，且指向真实模板入口。
  assert.equal(byCheck.get('annotate-entry-blocked-without-classes')?.pointsToTemplate, true);
  assert.ok(byCheck.get('class-created-from-real-entry')?.classId, '类别应经真实入口写入项目');
  // 画布改动必须真的落库成正式标注，并能在重开后看到。
  assert.equal(byCheck.get('annotate-save-writes-annotation')?.x, 77);
  assert.equal(byCheck.get('annotate-save-writes-annotation')?.status, 'modified');
  assert.equal(byCheck.get('annotate-save-and-confirm')?.status, 'confirmed');
  assert.ok(byCheck.get('annotate-reopen-visible')?.historyVersions >= 3);
  // 文案不再宣传不可用快捷键。
  assert.equal(byCheck.get('shortcut-copy-matches-capability')?.helpGhosts, 0);
  assert.equal(byCheck.get('shortcut-copy-matches-capability')?.settingsGhosts, 0);
  // AI 能力验证必须如实说明测试图尺寸与结论边界，超时设置要能被找到。
  assert.equal(byCheck.get('split-vocabulary')?.sourceGroupDefined, true);
  assert.equal(byCheck.get('split-vocabulary')?.ratioDefaultDocumented, true);
  assert.equal(byCheck.get('split-vocabulary')?.insufficientGroupsExplained, true);
  assert.equal(byCheck.get('split-vocabulary')?.checkButtonDoesNotCreateVersion, true);
  assert.equal(byCheck.get('ai-capability-honesty')?.rows, 6);
  assert.equal(byCheck.get('ai-capability-honesty')?.timeoutDiscoverable, true);
  console.log(`素材人工标注入口与文案一致性检查通过：${output}`); process.exit(0);
}
if (trainingUiOnly) { assert.equal(result.passed, true); assert.ok(['ready', 'invalid'].includes(result.dataset.status)); assert.equal(result.readOnly, true); console.log(`训练改由对话发起后的只读看板检查通过：${output}`); process.exit(0); }
if (connectionOnly) { assert.equal(result.before.ready, true); assert.equal(result.before.banner, false); assert.equal(result.disconnected.visible, true); assert.equal(result.disconnected.buttonEnabled, true); assert.equal(result.restored.ready, true); assert.equal(result.restored.banner, false); console.log(`断线重连桌面界面检查通过：${output}`); process.exit(0); }
if (uiOnly) {
  // 主导航收敛后验收覆盖三项主导航 + 项目概览（只读抽查的落点）。
  const pages = result.pages.filter(page => page.page);
  assert.equal(pages.length, 4); assert.ok(pages.every(page => page.bridge && page.bodyLength > 40 && !page.error));
  const example = result.pages.find(page => page.check === 'manual-example');
  assert.ok(example?.image?.loaded && String(example.mediaUrl).startsWith('autolabel-media://asset/'));
  assert.ok(pages.some(page => page.page === 'overview'));
  // 重启持久化校验是同一验收流程内的第二次启动，需沿用本次已生效的降级开关，
  // 否则无 GPU 环境会在这一步重新崩掉。
  assert.equal(await run(args.map(arg => arg === '--desktop-ui-check' ? '--desktop-ui-resume' : arg).concat(activeFallbackArgs)), 0);
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
