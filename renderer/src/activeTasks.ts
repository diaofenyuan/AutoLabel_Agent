import { useEffect, useState } from 'react';
import type { FlowRun } from '../../shared/flow';
import type { MediaJob } from '../../shared/media';
import { activeTrainingJob } from '../../shared/training';
import type { TrainingJob } from '../../shared/training';
import { request } from './bridge';
import { useApp } from './context';

/**
 * 进行中的长任务数量：侧栏「任务」徽标与任务看板共用。
 * 只统计引擎真实报告的状态，轮询而不是合成进度；引擎未就绪时保持 0。
 */
const ACTIVE_RUN = ['running', 'queued', 'paused', 'pausing', 'needs_attention'];
const ACTIVE_FLOW = ['running', 'queued', 'paused', 'pausing', 'needs_attention'];
const ACTIVE_MEDIA = ['queued', 'running', 'cancelling'];

export function useActiveTaskCount() {
  const { engine } = useApp();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (engine.state !== 'ready') { setCount(0); return; }
    let disposed = false;
    const load = async () => {
      const [runs, flows, media, jobs] = await Promise.allSettled([
        request<Array<{ status: string }>>('run.list'),
        request<{ items: FlowRun[] }>('flow.list', { limit: 100 }),
        request<{ items: MediaJob[] }>('media.job.list', { limit: 100 }),
        request<{ items: TrainingJob[] }>('training.job.list', { limit: 100 }),
      ]);
      if (disposed) return;
      const runsActive = runs.status === 'fulfilled' ? runs.value.filter(run => ACTIVE_RUN.includes(run.status)).length : 0;
      const flowsActive = flows.status === 'fulfilled' ? flows.value.items.filter(run => ACTIVE_FLOW.includes(run.status)).length : 0;
      const mediaActive = media.status === 'fulfilled' ? media.value.items.filter(job => ACTIVE_MEDIA.includes(job.status)).length : 0;
      const trainingActive = jobs.status === 'fulfilled' ? jobs.value.items.filter(job => activeTrainingJob(job.status)).length : 0;
      setCount(runsActive + flowsActive + mediaActive + trainingActive);
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 8000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [engine.state]);
  return count;
}
