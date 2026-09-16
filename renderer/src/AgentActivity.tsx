import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, ClipboardList, LoaderCircle, ListChecks } from 'lucide-react';
import { Button } from './ui';
import { getBridge } from './bridge';

export interface AgentStep { id: string; name: string; status: 'completed' | 'failed' | 'planned'; result: unknown }

/**
 * 工具步骤流：订阅 agent 工作进程的事件，按会话累积。
 * 状态放在模块级 Map 而不是组件里：切页会卸载会话视图，步骤与由此派生的任务卡片都不该跟着丢；
 * 同一会话的后续轮次也不清空，长时间训练不会被下一句提问抹掉。
 */
const activity = new Map<string, AgentStep[]>();
const listeners = new Set<() => void>();
let connected = false;

/** 工具名 → 中文步骤名。没有映射的工具直接显示原名，不假装它是什么操作。 */
const toolNames: Record<string, string> = {
  project_summary: '读取项目概况', list_assets: '读取素材列表', inspect_asset: '查看素材标注', open_asset: '定位素材',
  list_runs: '读取任务列表', run_annotation: '提交标注任务', control_run: '控制标注任务',
  export_preflight: '检查导出条件', export_dataset: '导出数据集', list_export_formats: '读取导出格式',
  list_evaluation_sets: '读取评测集', list_evaluations: '读取评测', inspect_evaluation: '查看评测指标',
  preflight_comparison: '预检评测比较', compare_results: '建立评测比较', inspect_comparison: '查询比较进度', finish_comparison: '固定比较指标',
  inspect_budget: '读取请求预算', estimate_cost: '估算费用', list_review_items: '读取待复核问题',
  list_model_configurations: '读取接口与模型', preflight_evaluation_rerun: '预检评测重跑', run_evaluation: '提交评测重跑',
  list_local_models: '读取本地模型', get_local_runtime: '读取本地运行环境',
  list_media_jobs: '读取媒体任务', inspect_media_job: '查看抽帧任务', list_video_frames: '读取视频帧',
  preview_screening: '预览筛选', run_screening: '提交筛选任务', inspect_screening: '查看筛选结果',
  list_track_timelines: '读取视频时间轴', inspect_track_timeline: '查看时间轴', list_tracks: '读取轨迹',
  inspect_track: '查看轨迹', list_track_keyframes: '读取关键帧', list_track_generations: '读取轨迹生成',
  inspect_track_generation: '查看轨迹生成', inspect_track_generation_results: '查看轨迹结果',
  preview_track_generation: '预检轨迹生成', generate_tracks: '生成轨迹候选', cancel_track_generation: '取消轨迹生成',
  preflight_flow: '预检流程', start_flow: '启动流程', list_flows: '读取流程运行', inspect_flow: '查看流程进度',
  inspect_flow_artifact: '读取流程产物', control_flow: '控制流程', retry_flow: '重试流程', rerun_flow: '重跑流程',
  list_dataset_versions: '读取数据集版本', list_training_datasets: '读取训练快照', create_training_dataset: '建立训练快照',
  preflight_training: '预检训练', start_training: '提交训练任务', list_training_jobs: '读取训练任务',
  inspect_training_job: '查看训练进度', cancel_training_job: '取消训练任务',
};
export const toolLabel = (name: string) => toolNames[name] ?? name;

function publish(sessionId: string, step: AgentStep) {
  const current = activity.get(sessionId) ?? [];
  activity.set(sessionId, [...current.filter(item => item.id !== step.id), step].slice(-50));
  listeners.forEach(listener => listener());
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

/** 失败步骤可展开看原因；成功步骤只留一行，不把 JSON 摊在对话里。 */
export function AgentSteps({ steps, busy }: { steps: AgentStep[]; busy: boolean }) {
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
