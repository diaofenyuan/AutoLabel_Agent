import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GPU_FALLBACK_LADDER, explicitLaunchArgs, gpuCrashReason } from './gpu-fallback.mjs';
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
 * AUTOLABEL_EXTRA_LAUNCH_ARGS，表现就是「npm run dev 直接崩、没有提示」。这里按同一特征自动重试；
 * 调用方显式配置过开关时不重复叠加。
 *
 * 重试按 GPU_FALLBACK_LADDER 逐级进行：先只关 GPU 沙箱保住硬件加速，确实还不行才整机退软件渲染。
 * 早前直接跳到软件渲染，在显卡本身正常的机器上也把硬件加速关掉了。
 *
 * 判定不能只看退出码：本机实测 GPU 进程连续崩溃而主进程退出码仍是 0（窗口建好了，
 * 只是渲染退回软件路径）。所以在启动观察期内直接监听崩溃日志并重启，运行稳定后就不再打扰——
 * 长时间运行中偶发的一行崩溃日志不代表启动失败。
 *
 * 必须开 ELECTRON_ENABLE_LOGGING：「Renderer process crashed」这类关键行默认不落 stdout，
 * 而渲染崩溃正是本机第二级降级要解决的场景，不开日志就永远判不出来、只会停在第一级。
 */
const configured = explicitLaunchArgs();
function launch(extraArgs) {
  const child = spawn(require('electron'), [root, ...extraArgs], {
    cwd: root, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
    env: { ...env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  // 输出要同时回显并留一份：直接用 inherit 就拿不到用于判定失败特征的日志串。
  let output = '';
  const sink = chunk => { const text = chunk.toString(); output += text; process.stdout.write(text); };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
  const exited = new Promise(resolve => {
    child.once('error', error => { console.error(error.message); resolve(1); });
    child.once('exit', code => resolve(code ?? 0));
  });
  // 崩溃信号单独走回调，与退出码解耦：GPU 崩溃后主进程通常继续存活，只等 exit 事件永远不会降级。
  // 渲染进程崩溃（Renderer process crashed）同样算启动失败——本机沙箱冲突会让 GPU 修好后
  // 界面进程仍然崩掉，只认 GPU 特征会在第一级降级后误判为「已恢复」。
  let onCrash = null;
  const feed = chunk => { const text = chunk.toString(); const reason = gpuCrashReason(text); if (onCrash && reason) onCrash(reason); };
  child.stderr.on('data', feed);
  child.stdout.on('data', feed);
  return { exited, child, setCrashHandler: handler => { onCrash = handler; } };
}
const stop = () => vite.kill();
process.once('SIGINT', stop); process.once('SIGTERM', stop);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 启动观察期：GPU 与渲染进程的崩溃都集中在窗口创建前后几秒内，超时即视为启动成功。
 * 之所以要有「观察期」而不是全程监听，是因为应用长时间运行中偶发的一行崩溃日志
 * 不代表启动有问题，那时再自动重启反而会打断正在做的标注工作。
 */
const WATCH_MS = 12000;

let tier = 0;
let current = launch(configured);
const startedAt = Date.now();
// 崩溃一次只处理一次：GPU 进程本身会连续崩好几下，不加这个闸门会被放大成多次重启。
let handling = false;

/**
 * 判定一次启动尝试是否失败并顺延到下一级降级。
 * 两种失败形态都要覆盖：运行中崩溃（GPU 或渲染进程，进程本身可能还活着），
 * 以及进程带着崩溃码直接退出（渲染崩溃后的 0xFFFF7003 之类，静默无日志）。
 */
const escalate = async (why) => {
  if (configured.length || handling) return false;
  const step = GPU_FALLBACK_LADDER[tier];
  if (!step) return false;
  handling = true;
  tier += 1;
  console.log(`\n检测到 ${why}，附加降级开关重启：${step.join(' ')}`);
  const previous = current;
  previous.child.kill();
  // 必须等旧实例真正退出再拉起，否则单实例锁会让新实例立刻退出。
  await previous.exited.catch(() => 0);
  await sleep(500);
  current = launch(step);
  current.setCrashHandler(reason => { void escalate(reason); });
  // 带崩溃码退出同样算失败，否则第二级实例静默退出会被当成正常结束。
  current.exited.then(code => {
    if (code && Date.now() - startedAt < WATCH_MS * GPU_FALLBACK_LADDER.length) {
      void escalate(`进程以退出码 ${code} 结束`);
    } else if (code) {
      // 观察期之后才退出：此时降级链已经跑完仍失败，才是真正无可用配置。
      if (tier >= GPU_FALLBACK_LADDER.length) console.error('GPU 降级已用尽仍未正常启动，详见用户数据目录下的 startup.log。');
    }
  });
  handling = false;
  return true;
};

current.setCrashHandler(reason => { void escalate(reason); });
current.exited.then(code => {
  if (code && Date.now() - startedAt < WATCH_MS) void escalate(`进程以退出码 ${code} 结束`);
});
// 观察期覆盖整条降级链：每级都要经历一次崩溃到重启，链没走完就不算启动成功。
await sleep(WATCH_MS * (1 + tier));
const exit = await current.exited;
vite.kill();
process.exitCode = exit;
