import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GPU_FALLBACK_ARGS, explicitLaunchArgs, isGpuLaunchFailure } from './gpu-fallback.mjs';
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

/**
 * 启动 Electron（开发态），并与 desktop-smoke.mjs 共用同一份 GPU 降级判定。
 *
 * 无显卡通道的机器上 Chromium 会在窗口创建前退出，开发入口原先把这种情况只留给人工设置
 * AUTOLABEL_EXTRA_LAUNCH_ARGS，表现就是「npm run dev 直接崩、没有提示」。这里按同一特征自动重试一次；
 * 调用方显式配置过开关时不重复叠加。
 */
const configured = explicitLaunchArgs();
function launch(extraArgs) {
  const child = spawn(require('electron'), [root, ...extraArgs], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true, env });
  // 输出要同时回显并留一份：直接用 inherit 就拿不到用于判定失败特征的日志串。
  let output = '';
  const sink = chunk => { const text = chunk.toString(); output += text; process.stdout.write(text); };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
  const exited = new Promise(resolve => {
    child.once('error', error => { console.error(error.message); resolve(1); });
    child.once('exit', code => resolve(code ?? 0));
  });
  return { exited, output: () => output };
}
const stop = () => vite.kill();
process.once('SIGINT', stop); process.once('SIGTERM', stop);

let current = launch(configured);
let exit = await current.exited;
if (!configured.length && isGpuLaunchFailure(exit, current.output())) {
  console.log('\n检测到 GPU 通道不可用，自动附加降级开关重试一次。');
  current = launch(GPU_FALLBACK_ARGS);
  exit = await current.exited;
  if (isGpuLaunchFailure(exit, current.output())) {
    console.error('降级后仍无法启动：用户数据目录下的 startup.log 记录了本次启动的失败原因。');
  }
}
vite.kill();
process.exitCode = exit;
