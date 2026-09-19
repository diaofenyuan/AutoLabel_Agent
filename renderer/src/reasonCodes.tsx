import type { ReactNode } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import { ACTION_LABELS, REASON_ACTIONS, REASON_LABELS, reasonLabel, type ReasonActionHandlers } from '../../shared/reasons';
import { Button } from './ui';

// 原因码中文映射与建议动作放在 shared：助手在对话里解释同一件事时读的是同一份表。
export { reasonLabel, reasonAction } from '../../shared/reasons';
export type { ReasonActionHandlers, ReasonActionId } from '../../shared/reasons';

/**
 * 原因码 → 面向用户的中文说明与建议动作。
 *
 * 设计取舍：引擎返回的两类信息用途不同，这里分开处理，避免把同一句中文维护成两份。
 * 1. `issues[]` 自带 `message`（引擎已经是中文且比通用映射更具体）→ 界面直接展示 message，
 *    本模块只负责从 `code` 推出「下一步能做什么」，不再复述 message。
 * 2. `excludedByReason` 是「原因码 → 张数」的聚合，没有 message → 必须由 `reasonLabel` 提供中文，
 *    否则界面只能把 `annotation_scope_excluded 10` 这样的原始码摆在用户面前。
 *
 * 动作由调用方按自身能力提供 handler，缺少 handler 的动作不渲染——避免出现点了没反应的按钮。
 */
const ERROR_TITLES: Record<string, string> = {
  dataset_version_blocked: '数据集体检未通过，请先处理列出的问题',
  dataset_scope_invalid: '标注范围取值无效',
  dataset_too_large: '当前范围超出单个数据集版本的上限',
  dataset_parameter_unknown: '数据集请求里有不支持的参数',
  dataset_parameter_missing: '数据集请求缺少必填参数',
  dataset_parameter_invalid: '数据集参数取值不合法',
  dataset_split_unknown_asset: '显式划分清单里有不在当前范围的素材',
  dataset_split_leak_detected: '近重复候选跨划分，严格防泄漏已阻断',
  dataset_hash_failed: '数据集指纹计算失败',
  export_blocked: '导出检查发现阻断问题，请先处理',
  export_task_mismatch: '导出任务类型与项目标注类型不一致',
  export_empty: '当前范围没有可导出的素材',
  classes_empty: '项目尚未定义标注类别',
  asset_selection_empty: '所选素材为空，请先选择素材',
  asset_project_mismatch: '所选素材不属于当前项目',
  split_ratio_invalid: '训练集比例必须大于 0 且小于 1',
  disk_space_low: '导出目标磁盘空间不足',
  export_write_failed: '导出写入失败，请检查目标目录后重试',
  INVALID_PAYLOAD: '请求参数不完整或格式不正确，请重新操作',
  PAYLOAD_TOO_LARGE: '本次请求内容过大，请减少批量后重试',
  PATH_DENIED: '所选路径尚未授权，请用界面上的选择入口重新选择',
  PATH_MISSING: '所选路径已失效，请重新选择',
  COMMAND_DENIED: '此操作未开放给界面',
  OUTPUT_FORMAT_MISMATCH: '输出文件扩展名与图片格式不一致',
  STORAGE_BUSY: '数据维护正在进行，请等待完成后再试',
  AGENT_COMMAND_DENIED: '此操作不在助手权限范围内，需要你本人确认',
  MEDIA_JOB_MISMATCH: '媒体任务解析结果与请求不一致',
  CREDENTIAL_BUSY: '接口凭据正在保存或删除，请稍后重试',
  SECRET_FIELD_DENIED: '凭据请用 API Key 专用输入保存',
  // 本机开放词汇的两个类别名问题：只拿到原因码时也要能直接看出下一步。
  vocabulary_term_needs_english: '类别名是中文，开放词汇的文本编码器只认英文：请改成英文名（例如「手办」→ figurine）',
  vocabulary_encoder_missing: '这个英文类别名不在内置词表里，需要先在模型库下载「CLIP 文本编码器 ViT-B/32」'
};

const BRACKET_CODE = /^\[([A-Za-z0-9_]+)\]\s*([\s\S]*)$/;

/** 引擎的规范形式是 `[code] message`；识别不出原因码时返回空码，由调用方走兜底文案。 */
export function parseReasonCode(raw: string): { code: string; message: string } {
  const trimmed = (raw ?? '').trim();
  const matched = BRACKET_CODE.exec(trimmed);
  return matched ? { code: matched[1], message: matched[2].trim() || trimmed } : { code: '', message: trimmed };
}

/**
 * 错误文本 → 用户可见文案。
 *
 * 策略：**只摘掉方括号里的原始码，保留引擎自己的中文说明**。引擎的说明通常比通用映射更具体
 * （例如「参数格式不正确：taskType」能直接指出是哪个字段），用通用标题覆盖它反而会丢信息；
 * 只有在引擎没有给出说明时才回落到标题表，避免出现空提示。
 */
export function readableError(raw: unknown): string {
  const { code, message } = parseReasonCode(raw instanceof Error ? raw.message : String(raw));
  if (message) return message;
  return ERROR_TITLES[code] ?? REASON_LABELS[code] ?? '操作未完成，请重试。';
}

interface IssueShape { severity?: string; code?: string; message?: string }

/**
 * 体检问题清单：按严重度分组，逐条展示引擎返回的中文说明，并把建议动作去重后统一放在清单下方。
 * 原本这里是「存在 N 个阻断问题」——只报数量不报内容，用户无法据此采取任何行动。
 *
 * `grouped` 用于问题按素材逐条返回的场景（导出体检会给范围里每一张未标注素材各生成一条），
 * 此时把同一原因合并成一行并标出张数，否则 23 张未标注会渲染成 23 行完全相同的文案。
 */
export function ReasonIssueList({ issues, handlers, limit = 6, grouped = false }: { issues: readonly IssueShape[]; handlers?: ReasonActionHandlers; limit?: number; grouped?: boolean }): ReactNode {
  const collapse = (list: readonly IssueShape[]) => {
    if (!grouped) return list.map(issue => ({ ...issue, count: 1 }));
    const merged = new Map<string, { severity?: string; code?: string; message?: string; count: number }>();
    for (const issue of list) {
      const key = `${issue.severity ?? ''}|${issue.code ?? ''}|${issue.message ?? ''}`;
      const existing = merged.get(key);
      if (existing) existing.count++; else merged.set(key, { severity: issue.severity, code: issue.code, message: issue.message, count: 1 });
    }
    return [...merged.values()];
  };
  const errors = collapse(issues.filter(issue => issue.severity === 'error'));
  const warnings = collapse(issues.filter(issue => issue.severity !== 'error'));
  if (!errors.length && !warnings.length) return null;
  const actions = [...new Set(errors.map(issue => REASON_ACTIONS[issue.code ?? '']).filter(Boolean))].filter(id => handlers?.[id]);
  const render = (issue: { severity?: string; code?: string; message?: string; count: number }, index: number, tone: 'error' | 'warning') => <li key={`${tone}-${index}`} className={tone === 'error' ? 'reason-error' : 'reason-warning'}>
    {tone === 'error' ? <AlertCircle size={14} /> : <Info size={14} />}
    <span>{issue.message || reasonLabel(issue.code ?? '')}{issue.count > 1 ? `（${issue.count} 张）` : ''}</span>
  </li>;
  return <div className="reason-issues">
    {errors.length > 0 && <>
      <p className="reason-issues-head">需要先处理（{errors.length} 项）</p>
      <ul>{errors.slice(0, limit).map((issue, index) => render(issue, index, 'error'))}</ul>
      {errors.length > limit && <p className="muted tiny">另有 {errors.length - limit} 项同类问题，展开「检查详情」可看全部。</p>}
      {actions.length > 0 && <div className="reason-issues-actions">{actions.map(id => <Button key={id} onClick={handlers![id]!}>{ACTION_LABELS[id]}</Button>)}</div>}
    </>}
    {warnings.length > 0 && <>
      <p className="reason-issues-head muted">不阻断，但值得留意（{warnings.length} 项）</p>
      <ul>{warnings.slice(0, limit).map((issue, index) => render(issue, index, 'warning'))}</ul>
      {warnings.length > limit && <p className="muted tiny">另有 {warnings.length - limit} 项提示，展开「检查详情」可看全部。</p>}
    </>}
  </div>;
}

/**
 * 遗漏范围摘要：把「原因码 张数」渲染成可读列表。
 *
 * 传入 `handlers` 时，每一类原因后面带上它能兑现的下一步（例如视频帧 → 「改用数据导出」）。
 * 聚合结构里没有逐张素材明细，界面无法列出「被排除的 7 张是哪 7 张」，
 * 但把出路摆在原因旁边同样能让用户从「知道被排除了」走到「知道该用哪条链路」。
 */
export function ReasonSummary({ reasons, limit = 6, handlers }: { reasons: Record<string, number>; limit?: number; handlers?: ReasonActionHandlers }): ReactNode {
  const entries = Object.entries(reasons);
  if (!entries.length) return null;
  const shown = entries.slice(0, limit);
  return <ul className="reason-summary">
    {shown.map(([code, count]) => {
      const action = REASON_ACTIONS[code];
      const handler = action ? handlers?.[action] : undefined;
      return <li key={code}><span>{reasonLabel(code)}</span><strong>{count} 张</strong>
        {handler && <Button onClick={handler}>{ACTION_LABELS[action!]}</Button>}</li>;
    })}
    {entries.length > limit && <li className="muted tiny">另有 {entries.length - limit} 类原因未显示。</li>}
  </ul>;
}
