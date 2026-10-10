import { useState } from 'react';
import { Button, Modal, Notice } from './ui';

export interface ManualExamplePromptProps {
  /** 按接口能力收窄后的抽样张数；0 表示这张图不能用参考帧。 */
  count: number;
  /** 未标注素材总数，用于如实告知不足。 */
  available: number;
  busy?: boolean;
  error?: string;
  onAnnotate: (neverRemind: boolean) => void;
  onSkip: (neverRemind: boolean) => void;
}

/**
 * 开始标注前的一次性提示：AI 标注前先让用户手工标几张当参考。
 *
 * 单独一个组件而不是复用 confirmDialog：全局确认框只有「是/否」两个按钮，
 * 装不下「不再提示」复选框，也放不下张数说明。文案统一说「照你的标准标」，
 * 不提「训练」——这里没有训练模型，说成训练会让人误以为会改变模型权重。
 */
export default function ManualExamplePrompt({ count, available, busy, error, onAnnotate, onSkip }: ManualExamplePromptProps) {
  const [neverRemind, setNeverRemind] = useState(false);
  const enough = count > 0 && available > 0;
  return <Modal title="先标注几张示例，AI 会照你的标准标" onClose={() => { if (!busy) onSkip(neverRemind); }}>
    <div className="form-stack">
      <Notice>AI 会照你标的示例学你的标准：框贴多紧、哪些要标、哪些要避开，都会一起发给模型。小目标、同款干扰物这类场景，比只写提示词准得多。</Notice>
      <p className="muted tiny">
        {enough
          ? `本次将从 ${available} 张未标注图片里随机抽 ${count} 张，标完直接作为本次运行的参考。`
          : available === 0
            ? '这个项目还没有未标注的图片，暂时没有可抽的示例。'
            : '当前标注接口不支持多图参考，无法使用人工示例。'}
      </p>
      {available > 0 && available < 5 && <p className="muted tiny">未标注图片不足 5 张，按实际张数提供示例；示例越少，参考效果越有限。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <label className="checkbox-row">
        <input type="checkbox" aria-label="不再提示人工示例" disabled={busy} checked={neverRemind} onChange={event => setNeverRemind(event.target.checked)} />
        不再提示
      </label>
      <div className="modal-actions">
        <Button disabled={busy} onClick={() => onSkip(neverRemind)}>跳过，直接用 AI 标注</Button>
        <Button className="primary" busy={busy} disabled={!enough} onClick={() => onAnnotate(neverRemind)}>立即标注示例</Button>
      </div>
    </div>
  </Modal>;
}