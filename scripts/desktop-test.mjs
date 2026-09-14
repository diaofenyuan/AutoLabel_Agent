import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const entries = [['desktop/security.test.ts', 'desktop/dist/security.test.cjs'], ['desktop/materials.test.ts', 'desktop/dist/materials.test.cjs']];
for (const [entry, outfile] of entries) await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'warning' });
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...entries.map(entry => entry[1])], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
