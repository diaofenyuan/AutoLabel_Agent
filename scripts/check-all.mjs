// 一键全跑：类型检查 → 全部单测 → 引擎测试 → UI 验收串跑。
//   node scripts/check-all.mjs            全量（含真下载/真推理的慢速验收）
//   node scripts/check-all.mjs --skip-ui  只跑前半段（打包链路前置用）
//   node scripts/check-all.mjs --skip-slow 跳过真实下载 torch 与真实推理的几条
// 前半段任何一步红就停下并报出名字；UI 串跑用 GPU 降级开关，受限/无显卡环境同样能跑。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const skipUi = process.argv.includes('--skip-ui');
const skipSlow = process.argv.includes('--skip-slow');
// Windows 上 npm 是 npm.cmd：不给精确可执行名，spawnSync 会找不到命令。
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [
  ['类型检查（桌面）', npm, ['run', 'check:desktop']],
  ['类型检查（助手）', npm, ['run', 'check:agent']],
  ['桌面单测', npm, ['run', 'test:desktop']],
  ['助手单测', npm, ['run', 'test:agent']],
  ['引擎测试', 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/engine-build.ps1', '-Test']],
];
// 27 条手工 UI 验收（与 desktop-smoke.mjs 的 MANUAL_CHECKS 对应）+ 开发态三项桌面检查。
// 一键准备两条会真实下载几百 MB、本机标注两条跑真实推理：默认计入，--skip-slow 可跳过。
const manual = ['update-ui', 'usability', 'run-controls', 'media-ui', 'reason-ui', 'annotate-ui', 'unknown-retry-ui', 'frame-scope-ui',
  'project-identity-ui', 'directory-import-ui', 'onboarding-ui', 'ai-preset-ui', 'composer-ui', 'settings-ui', 'error-action-ui',
  'sidebar-ui', 'provider-delete-ui', 'editing-ui', 'quality-ui', 'local-ui', 'storage-ui', 'model-library-ui',
  'local-annotate-ui', 'direct-run-ui', 'builtin-five-ui', 'rerun-ui', 'five-ui', 'connection-ui'];
const slow = new Set(['runtime-setup-ui', 'runtime-setup-offline-ui', 'local-annotate-ui', 'builtin-five-ui', 'five-ui']);
if (!skipUi) {
  for (const name of manual) if (!(skipSlow && slow.has(name))) steps.push([`UI 验收 ${name}`, npm, ['run', `check:${name}`]]);
  for (const name of ['runtime-setup-ui', 'runtime-setup-offline-ui']) if (!skipSlow) steps.push([`UI 验收 ${name}`, npm, ['run', `check:${name}`]]);
  steps.push(['UI 验收 主导航与人工示例', 'node', ['scripts/desktop-smoke.mjs', '--ui']]);
  steps.push(['UI 验收 窗口与诊断', 'node', ['scripts/desktop-smoke.mjs', '--window']]);
  steps.push(['桌面冒烟（默认）', 'node', ['scripts/desktop-smoke.mjs']]);
  // check-all 的 UI 清单与 desktop-smoke.mjs 的 MANUAL_CHECKS 逐条对应：新增手工验收时两边都要登记，否则这里会红。
  const smokeFlags = (readFileSync('scripts/desktop-smoke.mjs', 'utf8').match(/flag: '--/g) ?? []).length;
  if (manual.length !== smokeFlags) throw new Error(`UI 清单条数（${manual.length}）与 desktop-smoke.mjs 的 MANUAL_CHECKS（${smokeFlags}）不一致，请同步登记`);
}
const started = Date.now();
for (const [label, command, args] of steps) {
  console.log(`\n=== ${label} ===`);
  const env = { ...process.env, AUTOLABEL_EXTRA_LAUNCH_ARGS: process.env.AUTOLABEL_EXTRA_LAUNCH_ARGS || '--no-sandbox --in-process-gpu --disable-gpu' };
  // shell:true 下必须自己引号包好再拼一条命令：把参数数组交给 shell 只拼接不转义（DEP0190）。
  const line = [command, ...args].map(part => /\s/.test(part) ? `"${part}"` : part).join(' ');
  const code = (spawnSync(line, [], { stdio: 'inherit', windowsHide: true, shell: true, env }).status ?? 1);
  if (code !== 0) { console.error(`一键全跑在「${label}」失败（退出码 ${code}）。`); process.exit(code); }
}
console.log(`\n一键全跑通过：${steps.length} 步，用时 ${Math.round((Date.now() - started) / 1000)}s`);
