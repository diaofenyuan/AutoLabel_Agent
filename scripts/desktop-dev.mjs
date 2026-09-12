import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
await import('./desktop-build.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const vite = spawn(process.execPath, [path.join(root, 'renderer/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: path.join(root, 'renderer'), stdio: 'inherit', windowsHide: true });
const origin = `http://127.0.0.1:${port}`;
let ready = false;
for (let attempt = 0; attempt < 100 && vite.exitCode === null; attempt++) {
  try { const response = await fetch(origin); ready = response.ok; } catch { /* Vite 未就绪时有限等待。 */ }
  if (ready) break; await new Promise(resolve => setTimeout(resolve, 200));
}
if (!ready) { vite.kill(); throw new Error('开发界面启动失败，请先安装 renderer 依赖'); }
const env = { ...process.env, AUTOLABEL_RENDERER_URL: origin }; delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn(require('electron'), [root], { cwd: root, stdio: 'inherit', windowsHide: true, env });
const stop = () => { electron.kill(); vite.kill(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
electron.once('exit', code => { vite.kill(); process.exitCode = code ?? 0; });
electron.once('error', error => { stop(); console.error(error.message); process.exitCode = 1; });
