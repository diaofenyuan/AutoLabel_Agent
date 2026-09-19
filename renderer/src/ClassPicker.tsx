import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { errorMessage, request } from './bridge';
import { Button, Field, Notice } from './ui';
import type { LabelClass, Project } from './types';

const MAX_NAME = 60;
const RULES_LABEL = '标注要求（可选）';

/**
 * 类别选择器：把「要标什么」放回输入卡这一层。
 *
 * 以前类别只能在对话里让助手调 set_project_classes 建、或进项目概览的「类别与点位模板」改，
 * 对话模型不可用时整条链就断在这里。这里直接读写项目的类别与标注要求，
 * 与模板对话框共用同一条 project.update 通路，因此运行、导出、复现看到的是同一份模板。
 *
 * 「标注要求」落在 settings.rules：它已经会随项目模板冻结进每次运行、并作为 template.rules 发给模型，
 * 正好用来写「只要画面中间那个小手办，不要框旁边的大号毛绒公仔」这类区分口径。
 */
export default function ClassPicker({ project, disabled, onUpdated }: { project: Project; disabled?: boolean; onUpdated: (project: Project) => void }) {
  const [open, setOpen] = useState(false);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [draft, setDraft] = useState('');
  const [rules, setRules] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const rulesAreText = project.settings?.rules === undefined || typeof project.settings.rules === 'string';
  // 每次打开都从项目当前值重新取一遍：别把编辑期间的旧副本带进下一次打开。
  useEffect(() => {
    if (!open) return;
    setClasses(structuredClone(project.classes));
    setDraft(''); setError('');
    setRules(rulesAreText ? String(project.settings?.rules ?? '') : '');
  }, [open, project, rulesAreText]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  function add() {
    const name = draft.trim();
    if (!name) return;
    if (name.length > MAX_NAME) { setError(`类别名最多 ${MAX_NAME} 个字。`); return; }
    if (classes.some(item => item.name.trim() === name)) { setError('这个类别已经有了。'); return; }
    setError('');
    setClasses(list => [...list, { id: crypto.randomUUID(), name, color: '#4a83ff' }]);
    setDraft('');
  }
  async function save() {
    if (classes.some(item => !item.name.trim())) { setError('类别名称不能为空。'); return; }
    setBusy(true); setError('');
    try {
      const updated = await request<Project>('project.update', {
        projectId: project.id, classes,
        // rules 只写回我们自己编辑的文本；原本是 JSON 的沿用原值，不在这里覆盖。
        settings: rulesAreText ? { ...project.settings, rules } : project.settings,
      });
      onUpdated(updated); setOpen(false);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  // 触发按钮尽量把类别名列全（≤3 个直接列），再多也只留前两个加总数：
  // 「只显示第一个类别」会让刚加的类别看不见，用户会以为没保存。
  // 收起时直接用项目当前值，避免没打开过弹层就把已有类别显示成「还没有类别」。
  const names = (open ? classes : project.classes).map(item => item.name);
  const label = !names.length ? '还没有类别' : names.length <= 3 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 个`;
  return <div className="class-picker" ref={root}>
    <button type="button" className="model-picker-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}
      title="要标注的类别，以及给模型的区分口径">
      <span className="truncate">类别：{label}</span><ChevronDown size={13} />
    </button>
    {open && <div className="picker-popover" role="dialog" aria-label="类别与标注要求">
      <div className="class-picker-head"><strong>要标注的类别</strong><small className="muted">名称就是导出时写在标签里的类别名</small></div>
      <div className="class-picker-list">
        {classes.map((item, index) => <div className="class-chip" key={item.id}>
          <span className="truncate">{item.name}</span>
          <button type="button" aria-label={`删除类别 ${item.name}`} disabled={busy} onClick={() => setClasses(list => list.filter((_, i) => i !== index))}><Trash2 size={13} /></button>
        </div>)}
        {!classes.length && <p className="quiet-empty">还没有类别。先写一个，例如「手办」。</p>}
      </div>
      <div className="class-picker-add">
        <input value={draft} maxLength={MAX_NAME} placeholder="添加类别，例如：手办" aria-label="添加类别"
          onChange={e => { setDraft(e.target.value); setError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}/>
        <Button type="button" disabled={busy || !draft.trim()} onClick={add}><Plus size={13} />添加</Button>
      </div>
      {rulesAreText
        ? <Field label={RULES_LABEL} hint="会随项目的标注规则发给模型。写清区分口径最有效，例如：只要画面中间那个粉色头发的小手办，不要框旁边的大号毛绒公仔。">
            <textarea aria-label={RULES_LABEL} rows={3} disabled={busy} value={rules} onChange={e => setRules(e.target.value)} placeholder="例如：只要画面中间的小手办，不要框旁边的毛绒公仔。"/>
          </Field>
        : <Notice>这个项目的标注规则是结构化内容，请到项目概览的「类别与点位模板」里编辑。</Notice>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="picker-foot">
        <span className="muted tiny">类别与要求改动会影响本项目的后续运行与导出</span>
        <Button className="primary" type="button" busy={busy} disabled={busy || !classes.length} onClick={() => void save()}>保存</Button>
      </div>
    </div>}
  </div>;
}
