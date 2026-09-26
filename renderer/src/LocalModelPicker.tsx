import { useEffect, useRef, useState } from 'react';
import { Boxes, ChevronDown } from 'lucide-react';
import { formatModelBytes, type ModelLibraryEntry, type ModelLibraryState } from '../../shared/model-library';
import { deriveClassMap } from '../../shared/vocabulary';
import type { LocalModel } from '../../shared/inference';
import type { Project } from './types';
import { request, errorMessage, isDemo } from './bridge';
import { useApp } from './context';

/** 直接列出的上限：超过就折进「还有 N 个 · 全部」，不让一屏全是模型名。 */
const VISIBLE_LIMIT = 5;

interface Choice { entry: ModelLibraryEntry; model?: LocalModel }

/**
 * 对话内选内置模型。
 *
 * 与「任务流程」用同一套交互：选中后只把提示词写进输入框，不直接执行、不偷偷计费。
 * 差别在于这里给的是**本机模型**——不产生接口费用，也不需要 API Key。
 * 开放词汇模型会让你先填类别名，并把「哪些能对上项目类别、哪些会被忽略」在发送前摊开：
 * 对不上的绝不静默丢掉，也不替你猜。
 */
export default function LocalModelPicker({ project, disabled, onPick }: { project?: Project | null; disabled?: boolean; onPick: (prompt: string) => void }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [terms, setTerms] = useState('');
  const [loading, setLoading] = useState(false), [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { navigate } = useApp();
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  async function load() {
    if (isDemo || choices.length) return;
    setLoading(true); setNote('');
    try {
      const [library, models] = await Promise.all([
        request<ModelLibraryState>('model.library.status'),
        request<{ items: LocalModel[] }>('local.model.list', { offset: 0, limit: 500 }),
      ]);
      const list: Choice[] = [];
      for (const entry of library.entries) {
        if (entry.state !== 'ready' || entry.taskType === null) continue;
        // 只有「就绪且已启用（登记过）」的模型才能直接拿去标注；没启用的提示先去做一次启用。
        const model = models.items.find(item => item.catalogId === entry.id);
        if (model) list.push({ entry, model });
      }
      setChoices(list);
      const ready = library.entries.filter(entry => entry.state === 'ready' && entry.taskType !== null).length;
      if (!list.length) setNote(ready ? `模型库里有 ${ready} 个模型已就绪，但还没启用。到「设置 → 软件 AI 配置 → 模型库」点一次「启用」即可。`
        : '模型库里还没有就绪的模型。到「设置 → 软件 AI 配置 → 模型库」启用一个内置模型（随安装包提供，不需要 API Key）。');
    } catch (error) { setNote(errorMessage(error)); }
    finally { setLoading(false); }
  }
  function select(choice: Choice) {
    setPicked(choice);
    // 开放词汇默认给一组常见类别，用户改的是内容而不是从零想起；固定类别表模型不需要填。
    setTerms(choice.entry.openVocabulary ? '人 / 汽车 / 交通标志' : '');
  }
  const split = (value: string) => [...new Set(value.split(/[，,、/;\n]/).map(item => item.trim()).filter(Boolean))];
  const termsList = split(terms);
  const preview = picked?.entry.openVocabulary && project?.classes.length ? deriveClassMap(termsList, project.classes) : null;
  function buildPrompt() {
    if (!picked) return;
    const { entry, model } = picked;
    const scope = project ? '本项目里还没标注的图片' : '项目里还没标注的图片';
    const head = `用本机模型「${entry.name}」（${formatModelBytes(entry.sizeBytes)}，不产生接口费用）标注${scope}`;
    if (entry.openVocabulary) {
      if (!termsList.length) { setNote('请先填写要识别的类别名，用「/」分隔。'); return; }
      const names = termsList.map(name => `「${name}」`).join('、');
      const mapping = preview?.entries.filter(item => item.reason !== 'exact') ?? [];
      const explained = mapping.length
        ? `其中 ${mapping.filter(item => item.reason === 'alias').map(item => `「${item.text}」按同义词对上项目类别`).join('；')}${preview && preview.unmatched ? `；${preview.unmatched} 个类别名没有对上项目类别，先列为「忽略」等我确认` : ''}。`
        : '';
      onPick(`${head}：要识别的类别名是 ${names}。${explained}请在执行前把类别映射逐项列给我看，并给出预检结果与将处理的张数，我确认后再跑。`
        + `（模型标识 ${model?.id ?? entry.id}，优先使用已准备好的 GPU，没有 GPU 时使用 CPU；结果作为候选标注，不要覆盖我已人工确认的内容。）`);
      setOpen(false);
      return;
    }
    onPick(`${head}：模型自带固定类别表，请先读出它的类别，逐项给出「模型类别 → 项目类别」的映射建议（对不上的明确标为忽略），`
      + `把预检结果与将处理的张数一起列给我，我确认后再执行。（模型标识 ${model?.id ?? entry.id}，优先使用已准备好的 GPU，没有 GPU 时使用 CPU；结果作为候选标注，不要覆盖我已人工确认的内容。）`);
    setOpen(false);
  }
  const visible = expanded ? choices : choices.slice(0, VISIBLE_LIMIT);
  return <div className="local-model-picker" ref={root}>
    <button type="button" disabled={disabled} aria-label="选择本机模型标注" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setOpen(value => !value); void load(); }}>
      <Boxes size={13} />内置模型{picked ? ` · ${picked.entry.name}` : ''}<ChevronDown size={11} />
    </button>
    {open && <div className="picker-popover local-model-menu" role="dialog" aria-label="选择本机模型">
      {loading && <p className="muted tiny">正在读取模型库…</p>}
      {!loading && !choices.length && <p className="muted tiny">{note || '模型库里还没有可用的模型。'}</p>}
      {!loading && Boolean(choices.length) && <>
        <p className="muted tiny">本机运行，不需要 API Key，也不产生接口费用。</p>
        {visible.map(choice => <button key={choice.entry.id} type="button" className={picked?.entry.id === choice.entry.id ? 'local-model-option selected' : 'local-model-option'}
          onClick={() => select(choice)}>
          <strong>{choice.entry.name}</strong>
          <small>{choice.entry.taskType ? `${choice.entry.openVocabulary ? '开放词汇 · ' : ''}${formatModelBytes(choice.entry.sizeBytes)}` : ''}</small>
        </button>)}
        {choices.length > VISIBLE_LIMIT && !expanded && <button type="button" className="local-model-more" onClick={() => setExpanded(true)}>还有 {choices.length - VISIBLE_LIMIT} 个 · 全部</button>}
      </>}
      {picked && <div className="local-model-terms">
        {picked.entry.openVocabulary
          ? <label className="field"><span>要识别的类别名（用「/」分隔）</span>
            <input autoFocus value={terms} onChange={event => setTerms(event.target.value)} placeholder="例如：人 / 汽车 / 交通标志"/></label>
          : <p className="muted tiny">这个模型自带固定类别表，类别映射会在执行前列给你确认。</p>}
        {preview && <ul className="local-model-map">{preview.entries.map(item => <li key={item.text} className={item.reason === 'none' ? 'unmatched' : ''}>
          <span>{item.text}</span>
          <strong>{item.reason === 'none' ? '忽略（没有对上的项目类别）'
            : `${project?.classes.find(klass => klass.id === item.projectClassId)?.name ?? item.projectClassId}${item.reason === 'alias' ? '（按同义词对上）' : ''}`}</strong>
        </li>)}</ul>}
        {project && !project.classes.length && picked.entry.openVocabulary && <p className="muted tiny">这个项目还没有类别，执行前需要先建类别，否则映射无处可去。</p>}
        {!project && picked.entry.openVocabulary && <p className="muted tiny">还没进入项目：发送后助手会先确认项目与类别，再列映射给你看。</p>}
        <div className="actions">
          <button type="button" className="button primary" onClick={buildPrompt}>填进输入框</button>
          <button type="button" className="text-button" onClick={() => { setOpen(false); void navigate('settings', 'ai-library'); }}>去模型库</button>
        </div>
      </div>}
      {note && Boolean(choices.length) && <p className="inline-error" role="alert">{note}</p>}
      <p className="muted tiny">这里只把要求写进输入框，不会直接执行；执行前的预检与张数由助手列出来等你确认。</p>
    </div>}
  </div>;
}
