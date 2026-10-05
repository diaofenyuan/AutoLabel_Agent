/**
 * 复核来源切换时该落在哪条记录。
 *
 * 走查发现：从某次评测点「进入问题复核」后切到「难例优先队列」，面板会把来源记录
 * 悄悄换成 `evaluations[0]`（列表按创建倒序=最新一份）。若用户看的是历史评测，
 * 难例队列就建到了另一份评测上，而上一屏的上下文与按钮文案都让人以为还是原来那份。
 * 这里在切换时优先沿用当前选中的评测/运行，只有它在新来源里不存在时才退回最新一条。
 *
 * 抽成纯函数是为可回归：组件模块在 node 单测里不可导入（依赖界面与 bridge）。
 */
export type ReviewScope = 'evaluation' | 'run' | 'random' | 'hard';
export type ReviewRecordScope = Exclude<ReviewScope, 'random'>;

export function pickReviewTarget(next: ReviewRecordScope, currentRecordId: string, options: { evaluations: string[]; runs: string[] }): string {
  const { evaluations, runs } = options;
  if (next === 'evaluation') return evaluations.includes(currentRecordId) ? currentRecordId : evaluations[0] ?? '';
  if (next === 'run') return runs.includes(currentRecordId) ? currentRecordId : runs[0] ?? '';
  // 难例队列用一个 scopeId 同时表达评测与运行：来源记录带 `evaluation:` / `run:` 前缀，沿用时要按类型重新加前缀。
  if (evaluations.includes(currentRecordId)) return `evaluation:${currentRecordId}`;
  if (runs.includes(currentRecordId)) return `run:${currentRecordId}`;
  return evaluations[0] ? `evaluation:${evaluations[0]}` : runs[0] ? `run:${runs[0]}` : '';
}
