import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPU_FALLBACK_LADDER, GPU_FALLBACK_ARGS, GPU_SANDBOX_ARGS, GPU_SOFTWARE_ARGS,
  explicitLaunchArgs, gpuCrashReason, hasGpuCrash, isGpuLaunchFailure,
} from '../scripts/gpu-fallback.mjs';

/**
 * 降级阶梯的形状直接决定「别的机器还能不能正常用」，改错了不会立刻暴露，
 * 只会在某些用户的机器上表现为窗口起不来，所以这里逐条钉住。
 */
test('降级阶梯先关 GPU 沙箱，再整机退软件渲染', () => {
  assert.equal(GPU_FALLBACK_LADDER.length, 2);
  assert.deepEqual(GPU_FALLBACK_LADDER[0], GPU_SANDBOX_ARGS);
  assert.deepEqual(GPU_FALLBACK_LADDER[1], GPU_SOFTWARE_ARGS);
});

test('第一级保留硬件加速：不出现关闭 GPU 的开关', () => {
  // 本机显卡本身正常，只关沙箱就能恢复；一旦这级带上 --disable-gpu，用户显卡就被白白关掉了。
  assert.ok(!GPU_SANDBOX_ARGS.includes('--disable-gpu'));
  assert.deepEqual(GPU_SANDBOX_ARGS, ['--disable-gpu-sandbox']);
});

test('第二级软件渲染仍保留 --disable-gpu-sandbox', () => {
  // 少这一项会把仍然可用的显卡一并关掉，退化成纯 CPU 渲染。
  assert.ok(GPU_SOFTWARE_ARGS.includes('--disable-gpu-sandbox'));
  assert.ok(GPU_SOFTWARE_ARGS.includes('--disable-gpu'));
  assert.ok(GPU_SOFTWARE_ARGS.includes('--no-sandbox'));
});

test('兼容常量指向最后一级，旧调用点不会拿到半套参数', () => {
  assert.deepEqual(GPU_FALLBACK_ARGS, GPU_SOFTWARE_ARGS);
});

test('人工显式配置的开关原样解析', () => {
  assert.deepEqual(explicitLaunchArgs({ AUTOLABEL_EXTRA_LAUNCH_ARGS: '--disable-gpu-sandbox --no-sandbox' }),
    ['--disable-gpu-sandbox', '--no-sandbox']);
  // 未配置时为空数组，调用方据此判断「允许自动降级」。
  assert.deepEqual(explicitLaunchArgs({}), []);
  assert.deepEqual(explicitLaunchArgs({ AUTOLABEL_EXTRA_LAUNCH_ARGS: '   ' }), []);
});

test('识别 GPU 与渲染两类崩溃并说明原因', () => {
  assert.equal(gpuCrashReason('GPU process exited unexpectedly: exit_code=-1073741819'), 'GPU 进程崩溃');
  // 渲染崩溃必须单独识别：只认 GPU 会让降级停在第一级，界面仍然起不来。
  assert.equal(gpuCrashReason('Renderer process crashed'), '渲染进程崩溃');
  assert.equal(gpuCrashReason('gpu_process_host 报错\nRenderer process crashed'), 'GPU 与渲染进程崩溃');
  assert.equal(gpuCrashReason('正常业务输出'), '');
  assert.equal(hasGpuCrash('Renderer process crashed'), true);
  assert.equal(hasGpuCrash('一切正常'), false);
});

test('原生崩溃码按 GPU 不可用处理', () => {
  const log = 'GPU process exited unexpectedly';
  // 0x80000003：Node 在 Windows 上呈现为无符号形态。
  assert.equal(isGpuLaunchFailure(2147483651, ''), true);
  // 0xC0000005：访问冲突，本机虚拟显示驱动下的典型码，有符号与无符号两种呈现都要覆盖。
  assert.equal(isGpuLaunchFailure(-1073741819, ''), true);
  assert.equal(isGpuLaunchFailure(3221225477, ''), true);
  assert.equal(isGpuLaunchFailure(1, log), true);
});

test('不把正常退出与业务断言失败误判成 GPU 问题', () => {
  // 误判会让正常用户莫名进入降级重启，白白多等几秒甚至丢失未保存内容。
  assert.equal(isGpuLaunchFailure(0, ''), false);
  assert.equal(isGpuLaunchFailure(0, 'GPU process exited unexpectedly'), false);
  assert.equal(isGpuLaunchFailure(1, 'assertion failed: expected 1 to equal 2'), false);
});