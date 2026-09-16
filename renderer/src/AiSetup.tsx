import type { ReactNode } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useApp } from './context';
import { errorMessage } from './bridge';
import { IconButton } from './ui';

/**
 * 「已配置 AI」的单一判定：任一接口保存过凭据即视为可用。
 * 全应用与 AI 配置有关的提示都读这一个值，不再各页面各写一套判断（否则配好之后仍会冒出「未配置」文案）。
 */
export function useAiConfigured(): boolean {
  const { providers } = useApp();
  return providers.some(provider => provider.hasCredential);
}

/**
 * 未配置 AI 时的一次性引导条：仅在「确实没有凭据」且用户没有关掉它时出现。
 * 配好凭据后（或点过关闭后）整个组件不再渲染，因此不会出现「已配置却提示未配置」的状态。
 */
export function AiSetupNotice({ children }: { children?: ReactNode }) {
  const { prefs, savePrefs, navigate, notify } = useApp();
  const configured = useAiConfigured();
  if (configured || prefs.aiSetupDismissed) return null;
  return <div className="getting-started" role="status">
    <Sparkles size={16} />
    <span>配置 AI 后可以让助手自动标注。</span>
    {children}
    <button className="text-button" onClick={() => void navigate('settings', 'ai')}>前往设置 · 软件 AI 配置</button>
    <IconButton label="不再提示" onClick={() => void savePrefs({ ...prefs, aiSetupDismissed: true }).catch(e => notify(errorMessage(e), true))}><X size={14} /></IconButton>
  </div>;
}
