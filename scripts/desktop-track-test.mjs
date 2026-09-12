import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['desktop/track-validation.test.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'desktop/dist/track-validation.test.cjs', logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'desktop/dist/track-validation.test.cjs'], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
