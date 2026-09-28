import { useApp } from './context';

/**
 * 「已配置 AI」只认默认对话接口、模型名和对应凭据都齐全。
 * 全应用与 AI 配置有关的提示都读这一个值，避免把仅保存了其他接口凭据误报成可用。
 */
export function useAiConfigured(): boolean {
  const { providers, prefs } = useApp();
  const providerId = prefs.chatProviderId?.trim();
  const model = prefs.chatModel?.trim();
  return Boolean(providerId && model && providers.some(provider => provider.id === providerId && provider.hasCredential));
}
