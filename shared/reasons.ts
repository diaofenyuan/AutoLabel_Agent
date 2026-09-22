/**
 * 原因码 → 中文说明与建议动作（引擎与界面共用）。
 *
 * 放在 `shared/` 而不是渲染层：助手也要在对话里解释「为什么这些素材进不了数据集版本」，
 * 两处各维护一份映射必然漂移，而漂移的后果是原始码重新泄漏给用户。
 *
 * 这里只放纯数据与查表函数，不依赖任何运行时；界面侧的组件渲染留在 `renderer/src/reasonCodes.tsx`。
 */

/** 建议动作的标识：由调用方按自身能力提供 handler，缺少 handler 的动作不渲染，避免点了没反应。 */
export type ReasonActionId = 'openTemplate' | 'openChat' | 'openExport' | 'openAssets' | 'openScreening' | 'openModelLibrary' | 'openAiSettings';
export type ReasonActionHandlers = { [K in ReasonActionId]?: () => void };

export const ACTION_LABELS: Record<ReasonActionId, string> = {
  openTemplate: '打开类别与点位模板',
  openChat: '去对话里处理',
  openExport: '改用数据导出',
  openAssets: '查看素材',
  openScreening: '去素材筛选',
  openModelLibrary: '去模型库下载编码器',
  openAiSettings: '去接口设置'
};

/** 聚合计数用的短标签：必须覆盖 DatasetSelection 的全部原因码，否则会在界面上漏出原始码。 */
export const REASON_LABELS: Record<string, string> = {
  annotation_scope_excluded: '尚未生成正式标注，不在当前标注范围',
  annotation_scope_confirmed_only: '尚未人工确认',
  form_video_frame: '视频抽帧素材（同一视频的帧视为一个来源组）',
  form_derived: '衍生素材',
  form_overlay_rendering: '叠加框线的效果图',
  explicit_exclude: '被显式排除',
  empty_label_excluded: '空标签策略为「全部排除」',
  empty_label_limit_exceeded: '空标签超出保留上限',
  class_excluded: '命中「排除类别」',
  class_not_included: '不在「包含类别」范围',
  size_excluded: '尺寸不在筛选区间',
  source_group_excluded: '来源组不在所选范围',
  time_excluded: '导入时间不在筛选区间',
  sampled_out: '采样未入选（只作用于训练集）',
  near_duplicate_folded: '近重复折叠，保留代表样张'
};

/** 问题码 → 建议动作。只收录「确实有下一步」的码，其余只展示引擎给的中文说明。 */
export const REASON_ACTIONS: Record<string, ReasonActionId> = {
  annotation_scope_excluded: 'openChat',
  annotation_scope_confirmed_only: 'openChat',
  form_video_frame: 'openExport',
  asset_unlabeled: 'openChat',
  export_empty: 'openChat',
  classes_empty: 'openTemplate',
  classification_missing: 'openTemplate',
  media_missing: 'openAssets',
  dataset_augment_flip_requires_symmetry: 'openTemplate',
  screening_not_complete: 'openScreening',
  dataset_split_leak_detected: 'openScreening',
  vocabulary_encoder_missing: 'openModelLibrary',
  vocabulary_term_needs_english: 'openTemplate',
  model_not_found: 'openAiSettings'
};

/** 聚合计数用的中文标签；未收录的码退化为中性描述，绝不把原始码摆到界面上。 */
export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? '其他原因';
}

export function reasonAction(code: string): { id: ReasonActionId; label: string } | null {
  const id = REASON_ACTIONS[code];
  return id ? { id, label: ACTION_LABELS[id] } : null;
}

/**
 * 「原因码 → 张数」聚合转成可直接写进对话的中文说明。
 * 刻意**不保留原因码本身**：助手读到什么就会复述什么，带上原始码就迟早会出现在用户可见文本里。
 */
export function reasonBreakdown(reasons: Record<string, number>): Array<{ label: string; count: number; suggestion?: string }> {
  return Object.entries(reasons).map(([code, count]) => {
    const action = REASON_ACTIONS[code];
    return { label: reasonLabel(code), count, ...(action ? { suggestion: ACTION_LABELS[action] } : {}) };
  });
}
