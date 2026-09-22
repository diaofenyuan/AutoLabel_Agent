import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const entries = [['desktop/security.test.ts', 'desktop/dist/security.test.cjs'], ['desktop/materials.test.ts', 'desktop/dist/materials.test.cjs'], ['desktop/transcode.test.ts', 'desktop/dist/transcode.test.cjs'], ['desktop/project-classes.test.ts', 'desktop/dist/project-classes.test.cjs'],
  // 渲染层的纯函数（拖入提示文案、术语人话化）也走这里：不依赖 Electron 与界面，直接断言最快。
  ['renderer/tests/drop-messages.test.ts', 'desktop/dist/drop-messages.test.cjs'],
  ['renderer/tests/tool-labels.test.ts', 'desktop/dist/tool-labels.test.cjs'],
  ['renderer/tests/glossary.test.ts', 'desktop/dist/glossary.test.cjs'],
  // 这五套原先是孤儿 runner（没有 npm 脚本、无人登记），回归等于没跑；并进来才算数。
  ['desktop/storage.test.ts', 'desktop/dist/storage.test.cjs'],
  ['desktop/flow.test.ts', 'desktop/dist/flow.test.cjs'],
  ['desktop/track-validation.test.ts', 'desktop/dist/track-validation.test.cjs'],
  ['desktop/media-execution.test.ts', 'desktop/dist/media-execution.test.cjs'],
  ['desktop/local-execution.test.ts', 'desktop/dist/local-execution.test.cjs'],
  ['desktop/model-library.test.ts', 'desktop/dist/model-library.test.cjs']];
for (const [entry, outfile] of entries) await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'warning',
  // 纯 node 里没有 electron 运行时：vault 等模块的 electron 依赖打到确定性桩上（真链路由冒烟验收覆盖）。
  alias: { electron: './desktop/test-support/electron-stub.cjs' } });
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...entries.map(entry => entry[1])], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
