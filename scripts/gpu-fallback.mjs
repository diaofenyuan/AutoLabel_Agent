/**
 * Chromium GPU 通道不可用时的降级开关与判定。
 *
 * 无显卡通道的机器（虚拟化、远程会话、无驱动）上 GPU 进程起不来，应用会在窗口创建前直接退出
 * 或伴随 `gpu_process_host` 报错崩溃。这类机器是常见环境，因此验收脚本与开发启动共用同一份判定，
 * 而不是各自抄一遍——抄漏一处，用户看到的就是「双击没反应」。
 */
export const GPU_FALLBACK_ARGS = ['--no-sandbox', '--in-process-gpu', '--disable-gpu'];

/** 人工显式配置的开关：调用方未配置时才允许自动降级，避免同一开关叠两次。 */
export function explicitLaunchArgs(env = process.env) {
  return String(env.AUTOLABEL_EXTRA_LAUNCH_ARGS ?? '').trim().split(/\s+/).filter(Boolean);
}

/** 是否为 GPU 通道不可用导致的启动失败，而不是业务断言失败。 */
export function isGpuLaunchFailure(code, output = '') {
  if (!code) return false;
  return /gpu_process_host|GPU process isn't usable|GPU process exited unexpectedly|Passthrough is not supported/i.test(output)
    // Node 在 Windows 上把原生崩溃码 0x80000003 呈现为无符号形态 2147483651。
    || code === 2147483651;
}
