import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['desktop/security.test.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'desktop/dist/security.test.cjs', logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'desktop/dist/security.test.cjs'], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
