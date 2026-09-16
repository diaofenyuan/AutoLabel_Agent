import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const entries = [['desktop/security.test.ts', 'desktop/dist/security.test.cjs'], ['desktop/materials.test.ts', 'desktop/dist/materials.test.cjs'], ['desktop/transcode.test.ts', 'desktop/dist/transcode.test.cjs'],
  // 渲染层的纯函数（拖入提示文案）也走这里：不依赖 Electron 与界面，直接断言最快。
  ['renderer/tests/drop-messages.test.ts', 'desktop/dist/drop-messages.test.cjs']];
for (const [entry, outfile] of entries) await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...entries.map(entry => entry[1])], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
