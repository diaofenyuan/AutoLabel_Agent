/**
 * gpu-fallback.mjs 的类型声明。
 *
 * 该模块是纯 ESM 的 .mjs，桌面 tsconfig 没开 allowJs/CheckJS，TypeScript 无法推断其导出；
 * 测试文件按声明导入，既保留运行期真实行为，也让类型检查能盯住调用点用错参数。
 */
export declare const GPU_SANDBOX_ARGS: string[];
export declare const GPU_SOFTWARE_ARGS: string[];
export declare const GPU_FALLBACK_LADDER: string[][];
export declare const GPU_FALLBACK_ARGS: string[];
export declare function explicitLaunchArgs(env?: Record<string, string | undefined>): string[];
export declare function gpuCrashReason(output?: string): string;
export declare function hasGpuCrash(output?: string): boolean;
export declare function isGpuLaunchFailure(code: number, output?: string): boolean;