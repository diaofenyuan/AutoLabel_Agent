import type { TrackCommandMap, TrackIssue, TrackKeyframeState } from '../../shared/tracks';
import { request } from './bridge';

export const keyframeStates: Record<TrackKeyframeState, string> = { located: '可定位', occluded: '遮挡但可定位', enter: '进入画面', exit: '离开画面', unlocatable: '不可定位' };
export const generationStates: Record<string, string> = { queued: '排队中', running: '生成中', cancelling: '正在取消', cancelled: '已取消', completed: '已完成', completed_with_errors: '完成，有需处理项', interrupted: '已中断', failed: '失败' };
export const generationActive = (status: string) => ['queued', 'running', 'cancelling'].includes(status);
export const frameStates: Record<string, string> = { empty: '未标注', candidate: '候选', manual: '人工版本', confirmed: '人工已确认', applied: '候选已保存', protected: '保留人工内容', blocked: '生成受阻', unchanged: '无变化', conflict: '版本冲突', removed: '贡献已移除' };
export function trackRequest<K extends keyof TrackCommandMap>(command: K, payload: TrackCommandMap[K]['request']): Promise<TrackCommandMap[K]['response']> { return request(command, payload as unknown as Record<string, unknown>); }
export function TrackIssues({ issues }: { issues: TrackIssue[] }) { return issues.length ? <div className="track-issues">{issues.map((issue, i) => <div key={i} className={issue.severity === 'error' ? 'inline-error' : 'muted tiny'}><p>{issue.message}</p>{issue.metricValue !== undefined && <p>实际值 {issue.metricValue}{issue.threshold !== undefined ? ` · 阈值 ${issue.threshold}` : ''}</p>}<details><summary>问题定位</summary><pre>{JSON.stringify(issue, null, 2)}</pre></details></div>)}</div> : null; }
export function TrackError({ error }: { error: string }) {
  if (!error) return null;
  const action = /conflict|stale|version|plan_changed/i.test(error) ? '内容已发生变化。请刷新时间轴并重新核对，再提交操作。' : /not_implemented|unknown_command|INVALID_COMMAND/i.test(error) ? '当前引擎尚未支持视频轨迹，请更新并重启应用。' : /protected|draft/i.test(error) ? '该帧有人工作业或草稿，请保留现有内容并核对处理范围。' : '操作未完成，请检查下方原因后重试。';
  return <div className="media-error" role="alert"><p>{action}</p><details><summary>查看原因</summary><p>{error}</p></details></div>;
}
