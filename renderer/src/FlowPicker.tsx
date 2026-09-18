import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ListTodo } from 'lucide-react';

/**
 * 任务流程：把长任务写成人话交给对话，选中的流程只是填进输入框的起手式，不会直接执行。
 * 每一条都能落到已有的 agent 工具上（筛选 / 自动标注 / 复核 / 导出 / 训练 / 抽帧），
 * 参数与范围仍由用户在发送前确认或补充。
 */
const FLOWS: Array<{ id: string; label: string; hint: string; prompt: string }> = [
  { id: 'annotate', label: '批量自动标注', hint: '对未标注图片先预检再执行', prompt: '对项目里还没标注的图片做一次自动标注：先给我预检结果和将发送的请求数，确认后再执行。' },
  { id: 'screen', label: '先筛选再标注', hint: '剔除模糊与重复后标注', prompt: '先筛掉模糊和重复的图片，把被排除的和保留的分别列给我看，确认后对保留的图片做自动标注。' },
  { id: 'review', label: '抽查与修正', hint: '抽查结果并按描述改框', prompt: '抽查最近的标注结果：把明显不对的框列出来（含图片名与第几个框），我先决定怎么改，再按我说的修改。' },
  { id: 'export', label: '导出数据集', hint: '只导出已确认标注', prompt: '把已确认的标注导出成 YOLO 格式数据集，先告诉我导出范围和张数，再选择目录导出。' },
  { id: 'train', label: '训练一版模型', hint: '从数据集版本建快照后训练', prompt: '用最新的数据集版本训一版检测模型：先建不可变快照并预检，把数据集版本、配方与轮数报给我，确认后再提交。' },
  { id: 'video', label: '视频抽帧', hint: '把视频拆成可标注的帧', prompt: '把刚拖进来的视频抽帧成图片并入库，抽帧完成后再开始标注。' },
  { id: 'quality', label: '质量评测', hint: '用已发布真值比对运行', prompt: '用已发布的人工真值集评测最近一次运行：先预检可比较性，再固定指标并把分母与失败样本一起报给我。' },
];

export default function FlowPicker({ disabled, onPick }: { disabled?: boolean; onPick: (prompt: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  return <div className="flow-picker" ref={root}>
    <button type="button" disabled={disabled} aria-label="选择任务流程" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ListTodo size={13} />任务流程<ChevronDown size={11} />
    </button>
    {open && <div className="picker-popover flow-picker-menu" role="dialog" aria-label="选择任务流程">
      {FLOWS.map(flow => <button key={flow.id} type="button" disabled={disabled} className="flow-option"
        onClick={() => { setOpen(false); onPick(flow.prompt); }}>
        <strong>{flow.label}</strong><small>{flow.hint}</small>
      </button>)}
      <p className="muted tiny">选中的流程会写进输入框，检查后再发送；执行中的进度在任务卡片里回看。</p>
    </div>}
  </div>;
}
