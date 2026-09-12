import type { DesktopBridge } from '../../shared/protocol';

export const isDemo = !window.autoLabel;
let demo: Promise<DesktopBridge> | undefined;
export async function getBridge(): Promise<DesktopBridge> {
  // 只在普通浏览器启用独立演示，桌面引擎故障绝不能降级成演示成功。
  if (window.autoLabel) return window.autoLabel;
  demo ??= import('./demo').then(module => module.demoBridge);
  return demo;
}
export async function request<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  return (await getBridge()).request<T>(command, payload);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
