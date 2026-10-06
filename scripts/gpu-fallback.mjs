/**
 * Chromium GPU 通道不可用时的降级开关与判定。
 *
 * 无显卡通道的机器（虚拟化、远程会话、无驱动）上 GPU 进程起不来，应用会在窗口创建前直接退出
 * 或伴随 `gpu_process_host` 报错崩溃。这类机器是常见环境，因此验收脚本与开发启动共用同一份判定，
 * 而不是各自抄一遍——抄漏一处，用户看到的就是「双击没反应」。
 *
 * 降级分两级，顺序不能颠倒：
 * 1. GPU_SANDBOX_ARGS 只关 GPU 进程的沙箱。多数「GPU 进程崩溃」其实是沙箱与本机环境的冲突
 *    （多路虚拟显示器驱动、Hyper-V、驱动版本组合），关掉沙箱后硬件加速仍能正常用。
 * 2. GPU_SOFTWARE_ARGS 才是整机退回软件渲染，只在第一级仍然失败时兜底。
 * 早前只有第 2 级，于是在「显卡完全正常、只是沙箱起不来」的机器上也直接关了硬件加速：
 * 应用能开窗，但 canvas、光栅化全部走 CPU，滚动和图片缩放明显发涩，属于把可用硬件白白丢掉。
 */

/** 第一级降级：保留硬件加速，仅关闭 GPU 进程沙箱。 */
export const GPU_SANDBOX_ARGS = ['--disable-gpu-sandbox'];

/**
 * 第二级降级：整机退回软件渲染，仅在第一级无效时使用。
 *
 * 必须带上 --disable-gpu-sandbox：--disable-gpu 会连 GPU 进程一起停掉，而本机的问题出在沙箱本身，
 * 少了这一项就等于把仍然可用的 RTX 显卡也一并关掉，白白退化成软件渲染。
 */
export const GPU_SOFTWARE_ARGS = ['--no-sandbox', '--in-process-gpu', '--disable-gpu-sandbox', '--disable-gpu'];

/**
 * 降级阶梯，供调用方逐级尝试。
 * 调用方通常只需遍历本数组，无需自行拼装参数，避免各处降级顺序漂移。
 */
export const GPU_FALLBACK_LADDER = [GPU_SANDBOX_ARGS, GPU_SOFTWARE_ARGS];

/**
 * 兼容旧调用点的降级参数：取阶梯最后一级（软件渲染）。
 * 新代码请直接遍历 {@link GPU_FALLBACK_LADDER}，别再用这个常量。
 */
export const GPU_FALLBACK_ARGS = GPU_SOFTWARE_ARGS;

/** 人工显式配置的开关：调用方未配置时才允许自动降级，避免同一开关叠两次。 */
export function explicitLaunchArgs(env = process.env) {
  return String(env.AUTOLABEL_EXTRA_LAUNCH_ARGS ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * 日志里出现 GPU / 渲染进程崩溃特征时返回崩溃原因，否则返回空串。
 *
 * 渲染进程崩溃一并纳入：本机沙箱冲突下，GPU 通道修好后界面进程仍会崩，
 * 只认 GPU 特征会把「仍不可用」误判成「已恢复」，降级就停在第一级不再往下走。
 * 返回原因而非布尔，是为了让调用方能在提示里说清到底是哪一类崩溃。
 */
export function gpuCrashReason(output = '') {
  const renderer = /Renderer process crashed/i.test(output);
  const gpu = /gpu_process_host|GPU process isn't usable|GPU process exited unexpectedly|Passthrough is not supported/i.test(output);
  if (gpu && renderer) return 'GPU 与渲染进程崩溃';
  if (renderer) return '渲染进程崩溃';
  if (gpu) return 'GPU 进程崩溃';
  return '';
}

/** 是否出现 GPU / 渲染进程崩溃特征，与主进程退出码无关。 */
export function hasGpuCrash(output = '') {
  return gpuCrashReason(output) !== '';
}

/** 是否为 GPU 通道不可用导致的启动失败，而不是业务断言失败。 */
export function isGpuLaunchFailure(code, output = '') {
  if (!code) return false;
  return hasGpuCrash(output)
    // Node 在 Windows 上把原生崩溃码 0x80000003 呈现为无符号形态 2147483651。
    // 0xC0000005（访问冲突，GPU 进程在本机虚拟显示驱动下崩溃的典型码）同样按失败处理，
    // 否则会漏判成「启动成功」，用户只看到界面卡顿而没有任何提示。
    || code === 2147483651 || code === -1073741819 || code === 3221225477;
}