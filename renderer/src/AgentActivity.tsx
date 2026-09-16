import { useEffect, useState } from 'react';
import { toolLabel } from './toolLabels';
import { CircleAlert, CircleCheck, ClipboardList, LoaderCircle, ListChecks } from 'lucide-react';
import { Button } from './ui';
import { getBridge } from './bridge';
import { useApp } from './context';

export interface AgentStep { id: string; name: string; status: 'completed' | 'failed' | 'planned'; result: unknown }

/**
 * 工具步骤流：订阅 agent 工作进程的事件，按会话累积。
 * 状态放在模块级 Map 而不是组件里：切页会卸载会话视图，步骤与由此派生的任务卡片都不该跟着丢；
 * 同一会话的后续轮次也不清空，长时间训练不会被下一句提问抹掉。
 */
const activity = new Map<string, AgentStep[]>();
const listeners = new Set<() => void>();
let connected = false;


function publish(sessionId: string, step: AgentStep) {
  const current = activity.get(sessionId) ?? [];
  activity.set(sessionId, [...current.filter(item => item.id !== step.id), step].slice(-50));
  rememberTaskOrigin(sessionId, step);
  listeners.forEach(listener => listener());
}

/**
 * 任务来源会话：引擎的任务记录里没有对话标识，任务看板的「回到会话」只能靠这里记下的对应关系。
 * 存在 localStorage 里，重启后仍能跳回最初发起它的那段对话；只保留最近 500 条，避免无限增长。
 */
const ORIGIN_KEY = 'autolabel.taskOrigins';
function readOrigins(): Record<string, string> {
  try { const raw = JSON.parse(localStorage.getItem(ORIGIN_KEY) ?? '{}'); return raw && typeof raw === 'object' ? raw as Record<string, string> : {}; }
  catch { return {}; }
}
export function taskOrigin(id: string): string | undefined {
  const value = readOrigins()[id];
  return typeof value === 'string' ? value : undefined;
}
function rememberTaskOrigin(sessionId: string, step: AgentStep) {
  const result = step.result as Record<string, unknown> | null | undefined;
  if (!result) return;
  const ids = [result.job, result.run].map(item => item as Record<string, unknown> | undefined)
    .map(item => typeof item?.id === 'string' ? item.id : undefined)
    .filter((id): id is string => Boolean(id));
  if (!ids.length) return;
  const origins = readOrigins(); let changed = false;
  for (const id of ids) if (!origins[id]) { origins[id] = sessionId; changed = true; }
  if (!changed) return;
  try { localStorage.setItem(ORIGIN_KEY, JSON.stringify(Object.fromEntries(Object.entries(origins).slice(-500)))); } catch { /* 存不下就只在本次会话内生效 */ }
}
function connect() {
  if (connected) return;
  connected = true;
  void getBridge().then(bridge => bridge.onAgentEvent?.(event => {
    if (event.type !== 'agent.tool') return;
    const action = event.payload.action as AgentStep | undefined;
    if (!action || typeof action.id !== 'string' || typeof action.name !== 'string') return;
    if (action.status !== 'completed' && action.status !== 'failed' && action.status !== 'planned') return;
    publish(event.sessionId, action);
  })).catch(() => { connected = false; });
}

export function useAgentSteps(sessionId: string) {
  const [steps, setSteps] = useState<AgentStep[]>(() => activity.get(sessionId) ?? []);
  useEffect(() => {
    if (!sessionId) { setSteps([]); return; }
    connect();
    setSteps(activity.get(sessionId) ?? []);
    const listener = () => setSteps(activity.get(sessionId) ?? []);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [sessionId]);
  return steps;
}

function failureReason(result: unknown): string {
  if (!result || typeof result !== 'object') return typeof result === 'string' ? result : '';
  const value = result as Record<string, unknown>;
  return typeof value.message === 'string' ? value.message : '';
}
function failureCode(result: unknown): string {
  const value = result as Record<string, unknown> | null;
  return typeof value?.code === 'string' ? value.code : '';
}
/**
 * 可自己修好的失败：给出直达动作。
 *
 * 原先失败只留一句说明，用户读完还得自己找入口——「请先配置标注类别」不说是哪儿配。
 * 这里只收录确实有落点的码；其余失败继续如实显示原因，不假装有下一步。
 */
const failureActions: Record<string, { label: string; page: 'overview' | 'chat' | 'settings'; section?: 'ai' }> = {
  CLASSES_REQUIRED: { label: '去项目概览配置类别', page: 'overview' },
  IMAGES_REQUIRED: { label: '去导入素材', page: 'chat' },
  MODEL_REQUIRED: { label: '去配置对话模型', page: 'settings', section: 'ai' },
  PROMPT_REQUIRED: { label: '去补充标注要求', page: 'chat' }
};

/** 失败步骤可展开看原因；成功步骤只留一行，不把 JSON 摊在对话里。 */
export function AgentSteps({ steps, busy }: { steps: AgentStep[]; busy: boolean }) {
  const { navigate } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  if (!steps.length) return null;
  const failed = steps.filter(step => step.status === 'failed').length;
  return <details className="agent-steps" open={busy || failed > 0}>
    <summary>
      <ListChecks size={14} />
      <span>执行步骤 · {steps.length} 步{failed ? ` · ${failed} 步未完成` : ''}</span>
    </summary>
    <ol>
      {steps.map(step => <li key={step.id} data-status={step.status}>
        <button className="agent-step" type="button" onClick={() => setOpen(open === step.id ? null : step.id)}>
          {step.status === 'completed' ? <CircleCheck size={13} /> : step.status === 'planned' ? <LoaderCircle size={13} /> : <CircleAlert size={13} />}
          <span>{toolLabel(step.name)}</span>
          <small>{step.status === 'completed' ? '已完成' : step.status === 'planned' ? '待确认' : '未完成'}</small>
        </button>
        {open === step.id && <div className="agent-step-detail">
          <p className="muted tiny">{failureReason(step.result) || (step.status === 'planned' ? '处于「先看方案」，确认后才执行。' : '引擎未报告补充说明。')}</p>
          {step.status === 'failed' && failureActions[failureCode(step.result)] && (() => {
            const action = failureActions[failureCode(step.result)];
            return <div className="actions"><Button onClick={() => void navigate(action.page, action.section)}>{action.label}</Button></div>;
          })()}
          <pre>{JSON.stringify(step.result, null, 2)}</pre>
        </div>}
      </li>)}
    </ol>
    {failed > 0 && <p className="muted tiny">展开失败的步骤可以看引擎返回的原因。</p>}
  </details>;
}

/**
 * 确认卡片：先看方案时 agent 只给出将执行的操作，写操作一个都没跑。
 * 确认 = 以完全访问模式重发同一条需求，由用户自己按下这一步；界面不代为执行。
 */
export function PlanCard({ actions, busy, onConfirm, onRefine }: {
  actions: AgentStep[]; busy: boolean; onConfirm: () => void; onRefine: () => void;
}) {
  const planned = actions.filter(action => action.status === 'planned');
  if (!planned.length) return null;
  return <section className="plan-card" aria-label="待确认方案">
    <header><ClipboardList size={15} /><strong>待确认的 {planned.length} 个操作</strong></header>
    <ul>{planned.map(action => <li key={action.id}>
      <span>{toolLabel(action.name)}</span>
      <small>{describeArguments(action.result)}</small>
    </li>)}</ul>
    <p className="muted tiny">当前是「先看方案」：这些写操作还没有执行。确认后会改用完全访问模式重发这条需求。</p>
    <div className="actions">
      <Button disabled={busy} onClick={onRefine}>先改要求</Button>
      <Button className="primary" disabled={busy} onClick={onConfirm}>确认执行</Button>
    </div>
  </section>;
}

function describeArguments(result: unknown) {
  const value = result as Record<string, unknown> | null;
  const args = value?.arguments;
  if (!args || typeof args !== 'object') return '';
  const text = JSON.stringify(args);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
