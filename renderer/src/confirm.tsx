import { useSyncExternalStore } from 'react';
import { ConfirmModal } from './ui';

/**
 * 全局确认框：替代原生 window.confirm。
 * 原生弹窗与整体视觉不一致、自动化验收不可控，而且混在各组件里到处都是 window.confirm。
 * 调用点只需要 `if (!(await confirmDialog('…'))) return;`，弹窗本体由 App 根部的 ConfirmHost 渲染。
 */
type Pending = { message: string; resolve: (ok: boolean) => void };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise(resolve => { pending = { message, resolve }; listeners.forEach(listener => listener()); });
}

function settle(ok: boolean) {
  const current = pending; pending = null; listeners.forEach(listener => listener()); current?.resolve(ok);
}

export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, () => pending);
  if (!current) return null;
  return <ConfirmModal message={current.message} onYes={() => settle(true)} onNo={() => settle(false)} />;
}
