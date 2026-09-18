import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GPU_FALLBACK_ARGS, explicitLaunchArgs, isGpuLaunchFailure } from './gpu-fallback.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const windowOnly = process.argv.includes('--window');
const uiOnly = process.argv.includes('--ui');
const connectionOnly = process.argv.includes('--connection-ui');
const releaseOnly = process.argv.includes('--release');
const release5Only = process.argv.includes('--release5');
const release6aOnly = process.argv.includes('--release6a');
const release6bOnly = process.argv.includes('--release6b');
const release7aOnly = process.argv.includes('--release7a');
const release7bOnly = process.argv.includes('--release7b');
const trainingUiOnly = process.argv.includes('--training-ui');
/**
 * 需要真实界面驱动的手工验收清单：一项一行。
 *
 * 这里此前是四份并列的清单（打包守卫、输出标签、独立测试目录、环境变量）外加两份参数拼接，
 * 新增一条要改七处，漏改一处就变成「脚本里写着、但永远跑不到」的死检查——本轮修的就是这个坑。
 * 改成表驱动后，新增一项只动这里一行，再在下方补一段自己的断言。
 */
const MANUAL_CHECKS = [
  { flag: '--update-ui', label: 'update-ui-check', env: 'AUTOLABEL_UPDATE_UI_CHECK', extraEnv: { AUTOLABEL_UPDATE_TEST: '1' } },
  { flag: '--run-controls', label: 'run-control-check', env: 'AUTOLABEL_RUN_CONTROL_UI_CHECK' },
  { flag: '--media', label: 'media-check', env: 'AUTOLABEL_MEDIA_UI_CHECK' },
  { flag: '--reason', label: 'reason-check', env: 'AUTOLABEL_REASON_UI_CHECK' },
  { flag: '--annotate', label: 'annotate-check', env: 'AUTOLABEL_ANNOTATE_UI_CHECK' },
  { flag: '--unknown-retry', label: 'unknown-retry-check', env: 'AUTOLABEL_UNKNOWN_RETRY_UI_CHECK' },
  { flag: '--frame-scope', label: 'frame-scope-check', env: 'AUTOLABEL_FRAME_SCOPE_UI_CHECK' },
  { flag: '--project-identity', label: 'project-identity-check', env: 'AUTOLABEL_PROJECT_IDENTITY_UI_CHECK' },
  { flag: '--directory-import', label: 'directory-import-check', env: 'AUTOLABEL_DIRECTORY_IMPORT_UI_CHECK' },
  { flag: '--onboarding-ui', label: 'onboarding-check', env: 'AUTOLABEL_ONBOARDING_UI_CHECK' },
  { flag: '--ai-preset', label: 'ai-preset-check', env: 'AUTOLABEL_AI_PRESET_UI_CHECK' },
  { flag: '--composer-ui', label: 'composer-check', env: 'AUTOLABEL_COMPOSER_UI_CHECK' },
  { flag: '--settings-ui', label: 'settings-check', env: 'AUTOLABEL_SETTINGS_UI_CHECK' },
  { flag: '--error-action', label: 'error-action-check', env: 'AUTOLABEL_ERROR_ACTION_UI_CHECK' },
  { flag: '--sidebar-ui', label: 'sidebar-check', env: 'AUTOLABEL_SIDEBAR_UI_CHECK' },
  { flag: '--provider-delete', label: 'provider-delete-check', env: 'AUTOLABEL_PROVIDER_DELETE_UI_CHECK' },
  { flag: '--editing', label: 'editing-check', env: 'AUTOLABEL_EDITING_UI_CHECK' },
  { flag: '--quality', label: 'quality-check', env: 'AUTOLABEL_QUALITY_UI_CHECK' },
  { flag: '--local', label: 'local-check', env: 'AUTOLABEL_LOCAL_UI_CHECK' },
  { flag: '--storage', label: 'storage-check', env: 'AUTOLABEL_STORAGE_UI_CHECK' },
  { flag: '--rerun', label: 'rerun-check', env: 'AUTOLABEL_RERUN_UI_CHECK' },
  { flag: '--five', label: 'five-check', env: 'AUTOLABEL_FIVE_UI_CHECK' },
];
const manual = MANUAL_CHECKS.find(entry => process.argv.includes(entry.flag)) ?? null;
/** 各断言分支仍按名字读，但名字不再是各自独立的一份声明，避免清单之间漂移。 */
const flagIs = flag => manual?.flag === flag;
const updateUiOnly = flagIs('--update-ui');
const runControlOnly = flagIs('--run-controls');
const mediaOnly = flagIs('--media');
const reasonOnly = flagIs('--reason');
const annotateOnly = flagIs('--annotate');
const unknownRetryOnly = flagIs('--unknown-retry');
const frameScopeOnly = flagIs('--frame-scope');
const projectIdentityOnly = flagIs('--project-identity');
const directoryImportOnly = flagIs('--directory-import');
const onboardingOnly = flagIs('--onboarding-ui');
const aiPresetOnly = flagIs('--ai-preset');
const composerOnly = flagIs('--composer-ui');
const settingsUiOnly = flagIs('--settings-ui');
const errorActionOnly = flagIs('--error-action');
const sidebarOnly = flagIs('--sidebar-ui');
if (manual && packaged) throw new Error('手工开发验收不能在稳定安装包中运行');
const label = manual?.label ?? (trainingUiOnly ? 'training-ui-check' : connectionOnly ? 'connection-ui-check' : release7bOnly ? 'release7b-check' : release7aOnly ? 'release7a-check' : release6bOnly ? 'release6b-check' : release6aOnly ? 'release6a-check' : release5Only ? 'release5-check' : releaseOnly ? 'release-check' : uiOnly ? 'ui-check' : windowOnly ? 'window-check' : packaged ? 'packaged-smoke' : 'desktop-smoke');
const output = path.join(root, 'build', label + '.json');
await mkdir(path.dirname(output), { recursive: true });
const testUserData = process.env.AUTOLABEL_TEST_USER_DATA
  ? path.resolve(root, process.env.AUTOLABEL_TEST_USER_DATA)
  : path.join(root, 'build', label + (manual || trainingUiOnly ? `-user-data-${Date.now()}` : '-user-data'));
const env = { ...process.env, AUTOLABEL_TEST_USER_DATA: testUserData, AUTOLABEL_SMOKE_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;
if (packaged) { env.JAVA_HOME = 'C:\\nonexistent'; env.AUTOLABEL_JAVA_HOME = 'C:\\nonexistent'; }
// 环境变量整块由清单推导，不再逐项手写。
if (manual?.env) env[manual.env] = '1';
Object.assign(env, manual?.extraEnv ?? {});
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
if (manual) args.push('--desktop-manual-check');
if (connectionOnly) args.push('--desktop-connection-check');
if (trainingUiOnly) args.push('--desktop-training-check');
if (manual) {
  const { build } = await import('esbuild');
  await build({ entryPoints: [path.join(root, 'renderer/tests/desktop-manual-check.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: path.join(root, 'desktop/dist/manual.test.cjs'), logLevel: 'warning' });
  args.push('--desktop-manual-check');
}
// 受限或显卡不可用环境（Chromium GPU 进程无法启动）可显式追加开关：
// AUTOLABEL_EXTRA_LAUNCH_ARGS="--no-sandbox --in-process-gpu --disable-gpu"
// GPU 降级开关与判定取共享模块：开发启动（desktop-dev.mjs）用的是同一份，避免两处判定漂移。
const explicit = explicitLaunchArgs();
args.push(...explicit);
// 仅当调用方未显式配置时才在失败后自动降级；已显式配置的环境保持原有行为，不做二次重试。
const allowAutoFallback = !explicit.length;
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
// 已生效的降级开关：需要传给同一脚本内的后续启动（如 ui-check 的重启持久化校验）。
let activeFallbackArgs = [];
let exit = await run(args, allowAutoFallback);
if (allowAutoFallback && isGpuLaunchFailure(exit, lastOutput)) {
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
if (updateUiOnly) { assert.equal(result.passed, true); assert.deepEqual(result.states, ['available','ready','install-gate','cancelled','checksum-error']); console.log(`更新界面本地回环检查通过：${output}`); process.exit(0); }
if (runControlOnly) { assert.equal(result.passed, true); assert.equal(result.paused.cancelled, true); assert.equal(result.failedRetry.retryDispatched, true); assert.ok(result.failedRetry.callsAfter > result.failedRetry.callsBefore); console.log(`任务中心暂停/恢复/取消/失败重试界面检查通过：${output}`); process.exit(0); }
if (mediaOnly) { assert.equal(result.passed, true); assert.equal(result.timeline?.frameCount, 4); assert.equal(result.timeline?.framesHaveSourcePts, true); assert.equal(result.timeline?.workspaceVisible, true); console.log(`视频抽帧参数、逐帧记录与轨迹工作区检查通过：${output}`); process.exit(0); }
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
if (sidebarOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 侧栏宽度与项目名的可显示宽度都要够认出名字。
  assert.ok(byCheck.get('sidebar-name-readable')?.sidebar >= 236);
  assert.ok(byCheck.get('sidebar-name-readable')?.titleWidth >= 84);
  assert.ok(byCheck.get('sidebar-name-readable')?.shown >= 5);
  // 悬浮操作仍然直接可达，没被收进溢出菜单。
  assert.ok(byCheck.get('sidebar-name-readable')?.actionButtons >= 3);
  console.log(`侧栏可读性检查通过：${output}`); process.exit(0);
}
if (errorActionOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 阻塞提示带出口，且点一下真的落到设置 · 软件 AI 配置。
  assert.equal(byCheck.get('blocked-notice-has-next-step')?.action, '去配置');
  assert.equal(byCheck.get('blocked-notice-has-next-step')?.landed?.page, '#settings');
  assert.equal(byCheck.get('blocked-notice-has-next-step')?.landed?.tab, '软件 AI 配置');
  // 普通成功提示不带出口。
  assert.ok(String(byCheck.get('blocked-notice-has-next-step')?.plainToastText ?? '').includes('示例项目已载入'));
  console.log(`阻塞提示的下一步检查通过：${output}`); process.exit(0);
}
if (settingsUiOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 默认六个常用区块，展开后十二个。
  assert.equal(byCheck.get('settings-layered-tabs')?.basic, 6);
  assert.equal(byCheck.get('settings-layered-tabs')?.all, 12);
  // 深链落到高级区块时自动展开并选中它。
  assert.ok(byCheck.get('settings-layered-tabs')?.deepLinkTabs >= 12);
  assert.equal(byCheck.get('settings-layered-tabs')?.deepLinkSelected, '对话记录');
  // 收起时不停在藏起来的区块上。
  assert.ok(['外观', '软件 AI 配置', '存储位置', '本地推理', '快捷键', '应用更新'].includes(String(byCheck.get('settings-layered-tabs')?.afterCollapse)));
  console.log(`设置页分层检查通过：${output}`); process.exit(0);
}
if (composerOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 空会话给出三个起手式，点一下真的填进输入框。
  assert.equal(byCheck.get('empty-session-samples')?.samples?.length, 3);
  // 收起态没有下拉框，摘要如实写出范围与执行方式。
  assert.equal(byCheck.get('composer-collapsed-to-one-line')?.selects, 0);
  assert.equal(byCheck.get('composer-collapsed-to-one-line')?.popover, false);
  // 展开态三件都在，计费提示跟着开关走。
  assert.deepEqual(byCheck.get('composer-expands-tools')?.modes, ['直接执行', '先看方案']);
  assert.equal(byCheck.get('composer-expands-tools')?.choices, 2);
  assert.equal(byCheck.get('composer-expands-tools')?.billing, true);
  assert.equal(byCheck.get('composer-expands-tools')?.flow, true);
  // 改选择后摘要跟着改。
  assert.ok(String(byCheck.get('composer-summary-follows-choice')?.summary ?? '').includes('先看方案'));
  // 主操作一眼可读：发送按钮不被挤成两行。
  assert.ok(byCheck.get('composer-send-button-legible')?.width >= 56);
  console.log(`会话输入卡简化检查通过：${output}`); process.exit(0);
}
if (aiPresetOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 预设选中即填好地址与名称。
  assert.equal(byCheck.get('preset-fills-address')?.baseUrl, 'http://127.0.0.1:11434/v1');
  // 用户自己起的接口名不被预设覆盖。
  assert.equal(byCheck.get('preset-keeps-custom-name')?.name, '我的标注接口');
  // 简版默认收起了协议 / 能力表 / 模型职责，主按钮把保存与读模型并成一步。
  assert.equal(byCheck.get('quick-form-hides-advanced')?.capability, false);
  assert.equal(byCheck.get('quick-form-hides-advanced')?.roles, false);
  assert.equal(byCheck.get('quick-form-hides-advanced')?.protocol, false);
  assert.equal(byCheck.get('quick-form-hides-advanced')?.keyEnabled, true);
  // 手动配置里一件没少。
  assert.equal(byCheck.get('manual-form-keeps-everything')?.capabilityRows, 6);
  console.log(`简版 AI 配置检查通过：${output}`); process.exit(0);
}
if (onboardingOnly) {
  assert.equal(result.passed, true);
  const byCheck = new Map(result.checks.map(check => [check.check, check]));
  // 首屏按顺序给出三条路；第 1 条明确不需要配置。
  assert.deepEqual(byCheck.get('home-shows-three-lanes')?.titles, ['先试一下', '导入我的素材', '让 AI 自动标注']);
  // 四个导入入口在首屏直接可见，不再藏在折叠菜单里。
  for (const label of ['导入图片', '导入图片文件夹', '导入视频', '导入视频文件夹']) {
    assert.ok(byCheck.get('home-shows-three-lanes')?.imports?.includes(label), `首屏缺少「${label}」入口`);
  }
  // 首屏的主操作要一眼可读：发送按钮被挤成两行时，第一次用的人连怎么发都看不出来。
  assert.ok(byCheck.get('home-send-button-legible')?.width >= 56);
  // 示例项目不经过设置页就能载入，并带着素材落在会话里。
  assert.ok(byCheck.get('home-loads-example')?.assets > 0);
  // 第 3 条路把人送到设置 · 软件 AI 配置。
  assert.equal(byCheck.get('ai-lane-opens-settings')?.section, '软件 AI 配置');
  console.log(`首屏三条上手路径检查通过：${output}`); process.exit(0);
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
  // 大尺寸来源默认降采样：1920×1080 应等比降到 1024×576 并写进抽帧参数。
  assert.deepEqual([byCheck.get('video-folder-picker')?.downsampled?.width, byCheck.get('video-folder-picker')?.downsampled?.height], ['1024', '576']);
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
  // 记住落点：勾过一次之后，下一次默认停在这个项目，且勾选保持。
  assert.ok(byCheck.get('remember-project-destination')?.defaultProjectId);
  assert.equal(byCheck.get('remembered-destination-default')?.mode, 'existing');
  assert.equal(byCheck.get('remembered-destination-default')?.checked, true);
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
  assert.equal(byCheck.get('ai-capability-honesty')?.oneClickVerify, true);
  // 导出：输出目录留空也能提交，且侧栏有明确的进入对话入口。
  assert.equal(byCheck.get('export-without-output-dir')?.submitted, true);
  assert.equal(byCheck.get('shortcut-copy-matches-capability')?.sidebarChatEntry, true);
  console.log(`素材人工标注入口与文案一致性检查通过：${output}`); process.exit(0);
}
/**
 * 这一组此前没有入口：脚本里既没有开关也没有 npm 脚本，唯一的调度处只认环境变量，
 * 于是它们永远跑不到，也就没人发现界面改版后它们已经失效。这里补上入口与断言。
 */
if (flagIs('--provider-delete')) {
  assert.equal(result.passed, true); assert.equal(result.deleted, true); assert.equal(result.credentialClearedFeedback, true); assert.equal(result.modelRequests, 0);
  console.log(`接口删除与凭据清理反馈检查通过：${output}`); process.exit(0);
}
if (flagIs('--editing')) {
  assert.equal(result.passed, true);
  console.log(`模板与画布编辑边界检查通过：${output}`); process.exit(0);
}
if (flagIs('--quality')) {
  assert.equal(result.passed, true);
  console.log(`独立人工答案与画布协议检查通过：${output}`); process.exit(0);
}
if (flagIs('--local')) {
  assert.equal(result.passed, true);
  console.log(`本地推理链路检查通过：${output}`); process.exit(0);
}
if (flagIs('--storage')) {
  assert.equal(result.passed, true); assert.equal(result.mode, 'storage-ui');
  console.log(`存储位置、备份与迁移检查通过：${output}`); process.exit(0);
}
if (flagIs('--rerun')) {
  assert.equal(result.passed, true); assert.equal(result.mode, 'rerun-ui');
  console.log(`重跑对比与费用口径检查通过：${output}`); process.exit(0);
}
if (flagIs('--five')) {
  assert.equal(result.passed, true); assert.equal(result.mode, 'five-ui');
  console.log(`五类任务界面链路检查通过：${output}`); process.exit(0);
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
