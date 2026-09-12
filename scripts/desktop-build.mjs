import { build } from 'esbuild';
import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './desktop-icon.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'desktop/dist'), { recursive: true });
const entries = { main: 'desktop/main.ts', preload: 'desktop/preload.ts' };
try { await access(path.join(root, 'agent/worker.ts')); entries.agent = 'agent/worker.ts'; } catch { console.warn('Agent 入口尚未准备，桌面诊断仍可构建。'); }
await build({ absWorkingDir: root, entryPoints: entries, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outdir: 'desktop/dist', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: false, logLevel: 'info' });
