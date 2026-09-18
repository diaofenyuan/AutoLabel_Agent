import { useApp } from './context';

/**
 * 「已配置 AI」的单一判定：任一接口保存过凭据即视为可用。
 * 全应用与 AI 配置有关的提示都读这一个值，不再各页面各写一套判断（否则配好之后仍会冒出「未配置」文案）。
 */
export function useAiConfigured(): boolean {
  const { providers } = useApp();
  return providers.some(provider => provider.hasCredential);
}
