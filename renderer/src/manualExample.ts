import type { Project } from './types';

/**
 * 「人工标注参考示例」的项目级状态。
 *
 * 存在 project.settings 里而不是新增一张表：参考示例的有效性本身就是项目级事实
 * （同一批素材只对本项目有意义），跟 annotationRegion 是同一类「这个项目要标什么」的设置。
 * 素材本身仍然是事实来源——本文件只记 id 列表，不复制标注内容。
 */
export interface ManualExampleState {
  /** 已人工确认、可以作为参考的素材 id，有序。 */
  assetIds: string[];
  confirmedAt?: number;
  /** 用户勾过「不再提示」。 */
  promptDismissed?: boolean;
  /** 最近一次随运行发送的时间，用于界面提示新鲜度。 */
  usedAt?: number;
}

const KEY = 'manualExample';

export function readManualExample(project: Pick<Project, 'settings'> | null | undefined): ManualExampleState | null {
  const raw = project?.settings?.[KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const ids = Array.isArray(value.assetIds) ? value.assetIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [];
  return {
    assetIds: ids,
    ...(typeof value.confirmedAt === 'number' ? { confirmedAt: value.confirmedAt } : {}),
    ...(value.promptDismissed === true ? { promptDismissed: true } : {}),
    ...(typeof value.usedAt === 'number' ? { usedAt: value.usedAt } : {}),
  };
}

export function writeManualExample(state: ManualExampleState): Record<string, unknown> {
  return { [KEY]: { assetIds: state.assetIds, confirmedAt: state.confirmedAt ?? Date.now(), promptDismissed: state.promptDismissed === true, usedAt: state.usedAt } };
}

/**
 * 参考示例是否仍然可信。
 *
 * 判失效而不是一直静默，是因为参考的全部价值在于「这是人工定的标准」：素材一旦退回候选
 * 或被删除，它就不再是标准，而用户会以为「我配过了」。宁可多弹一次，也不要让标准悄悄失真。
 */
export function manualExampleUsable(state: ManualExampleState | null, assets: Array<{ id: string; status: string }>): boolean {
  if (!state?.assetIds.length) return false;
  const known = new Map(assets.map(item => [item.id, item.status]));
  return state.assetIds.every(id => { const status = known.get(id); return status === 'confirmed' || status === 'modified'; });
}

/** 是否该在开始标注前提示：没有可用示例，且用户没要求闭嘴。 */
export function shouldPromptManualExample(project: Pick<Project, 'settings'> | null | undefined, assets: Array<{ id: string; status: string }>): boolean {
  if (readManualExample(project)?.promptDismissed) return false;
  return !manualExampleUsable(readManualExample(project), assets);
}

/**
 * 抽样张数上限：受引擎硬约束 references + 1 ≤ provider.maxImages 限制
 * （Runs.java 会直接 422）。写死 10 在常见的 8 图上限下必然失败，所以按接口能力收窄。
 * 上限 ≤ 1 的接口根本用不了参考帧，入口应当隐藏。
 */
export function manualExampleLimit(maxImages: number | undefined): number {
  const cap = typeof maxImages === 'number' && Number.isFinite(maxImages) ? Math.floor(maxImages) : 8;
  if (cap <= 1) return 0;
  return Math.min(10, cap - 1);
}