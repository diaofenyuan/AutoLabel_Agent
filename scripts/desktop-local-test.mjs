import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['desktop/local-execution.test.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'desktop/dist/local-execution.test.cjs', logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'desktop/dist/local-execution.test.cjs'], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
