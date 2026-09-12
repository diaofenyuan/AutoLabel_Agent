import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useApp } from './context';
import { errorMessage, request } from './bridge';
import { Button, Field, Modal, Notice } from './ui';
import type { Project } from './types';
import TemplateSettingsEditor from './TemplateSettingsEditor';

export default function TemplateDialog({ onClose }: { onClose: () => void }) {
  const { project, setProject, refreshProjects, notify } = useApp();
  const [classes, setClasses] = useState(structuredClone(project!.classes));
  const [settings, setSettings] = useState(structuredClone(project!.settings));
  const [names, setNames] = useState(Array.isArray(settings.keypointNames) ? settings.keypointNames.join(', ') : '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const points = names.split(/[,，\n]/).map(n => n.trim()).filter(Boolean);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (!classes.length || classes.some(c => !c.name.trim())) throw new Error('类别名称不能为空。');
      if (project!.taskType === 'pose' && (!points.length || new Set(points).size !== points.length)) throw new Error('关键点名称须非空且不能重复。');
      const next = project!.taskType === 'pose' ? { ...settings, keypointNames: points } : settings;
      const updated = await request<Project>('project.update', { projectId: project!.id, classes, settings: next });
      setProject(updated); await refreshProjects(); notify('标注模板已保存。'); onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <Modal title="类别与点位模板" wide onClose={() => { if (!busy) onClose(); }}><form className="form-stack template-dialog" onSubmit={save}><Notice>模板用于当前项目。已有固定资源、运行和标准答案继续使用各自保存的模板。</Notice><section><h3>类别</h3>{classes.map((c, i) => <div className="class-editor" key={c.id}><input aria-label={`类别${i + 1}颜色`} disabled={busy} type="color" value={c.color} onChange={e => setClasses(list => list.map((v, j) => j === i ? { ...v, color: e.target.value } : v))}/><input aria-label={`类别${i + 1}名称`} required disabled={busy} value={c.name} onChange={e => setClasses(list => list.map((v, j) => j === i ? { ...v, name: e.target.value } : v))}/><small>{i}</small></div>)}<Button type="button" disabled={busy} onClick={() => setClasses(list => [...list, { id: crypto.randomUUID(), name: '', color: '#4a83ff' }])}><Plus size={14}/>添加类别</Button></section>
    {project!.taskType === 'pose' && <Field label="关键点名称与顺序" hint="以逗号分隔；名称和顺序改变后，请核对原有点位与连接。"><input aria-label="关键点名称与顺序" required disabled={busy} value={names} onChange={e => setNames(e.target.value)}/></Field>}
    <TemplateSettingsEditor settings={settings} keypointNames={points} pose={project!.taskType === 'pose'} disabled={busy} onChange={(key, value) => setSettings(previous => ({ ...previous, [key]: value }))}/>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button busy={busy} className="primary" type="submit">保存模板</Button></div></form></Modal>;
}
