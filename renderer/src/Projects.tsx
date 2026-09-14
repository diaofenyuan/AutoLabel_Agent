import { useState } from 'react';
import { ArrowRight, Plus, FolderOpen, Image, Info, Scan, Layers } from 'lucide-react';
import { useApp } from './context';
import { DatasetVersionDialog } from './DatasetVersions';
import { request, errorMessage, isDemo } from './bridge';
import { Button, Composer, Empty, Field, Modal, PageHeader, SearchField } from './ui';
import { taskNames, type Project, type TaskType } from './types';

export function Projects() {
  const { projects, loading, openProject, refreshProjects, notify } = useApp();
  const [search, setSearch] = useState('');
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<TaskType>('detect');
  const [classes, setClasses] = useState('车辆, 行人');
  const [busy, setBusy] = useState(false);
  const [description, setDescription] = useState('');
  const [versionProject, setVersionProject] = useState<Project | null>(null);
  async function example() {
    setBusy(true);
    try { const project = await request<Project>('project.example'); await refreshProjects(); await openProject(project); }
    catch (e) { notify(errorMessage(e), true); } finally { setBusy(false); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const labels = [...new Set(classes.split(/[,，\n]/).map(v => v.trim()).filter(Boolean))];
      if (!labels.length) throw new Error('请至少添加一个类别。');
      let project = await request<Project>('project.create', { name: name.trim(), description, taskType: type,
        classes: labels.map((label, i) => ({ id: `class-${i + 1}`, name: label, color: ['#4a83ff', '#ba6de2', '#e99636', '#2baf90'][i % 4] })),
      });
      if (type === 'pose') project = await request<Project>('project.update', { projectId: project.id, settings: { keypointNames: ['左上', '右上', '右下', '左下'] } });
      await refreshProjects(); setCreate(false); await openProject(project); notify(isDemo ? '项目已创建在浏览器演示空间。' : '项目已创建。');
    } catch (error) { notify(errorMessage(error), true); } finally { setBusy(false); }
  }
  const list = projects.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="content projects-page">
    <PageHeader title="项目中心" description="在本地管理素材、标注和数据集" actions={<Button className="primary" onClick={() => setCreate(true)}><Plus size={15} />新建项目</Button>} />
    <div className="getting-started"><Info size={16} /><span>还没有 API Key？可以先体验人工标注。</span><button className="text-button" disabled={busy} onClick={() => void example()}>打开示例<ArrowRight size={14} /></button></div>
    <div className="section-toolbar"><h2>最近的项目 <span className="count">{projects.length}</span></h2><SearchField value={search} onChange={setSearch} placeholder="搜索项目" /></div>
    {loading ? <div className="skeleton-list">{[1,2,3].map(n => <div className="skeleton" key={n} />)}</div> : list.length ? <div className="project-list">{list.map(project => <div className="project-row" key={project.id}><button className="project-entry" onClick={() => void openProject(project).catch(e => notify(errorMessage(e), true))}><div className="project-thumb">{isDemo && project.settings.demoExample ? <img src="./example-street.png" alt="合成城市道路示例" /> : <FolderOpen size={24} strokeWidth={1.4} />}</div><div className="project-info"><h3>{project.name}</h3><p>{project.taskType.toUpperCase()}<span>/</span>{project.assetCount} 张图片<span>/</span>{project.confirmedCount} 已确认</p>{project.description && <small>{project.description}</small>}</div><span className="project-open">打开<ArrowRight size={16} /></span></button><Button onClick={() => setVersionProject(project)}><Layers size={14} />数据集版本</Button></div>)}</div> : <Empty icon={<FolderOpen size={28} />} title={search ? '没有匹配的项目' : '从一个项目开始'} description={search ? '试试其他名称，或清空搜索。' : '创建项目后，导入图片并开始人工标注。'}><Button onClick={() => search ? setSearch('') : setCreate(true)}>{search ? '清空搜索' : '创建项目'}</Button></Empty>}
    <div className="project-composer"><Composer value={description} onChange={setDescription} onSend={() => { setName(description.split('\n')[0].slice(0,60)); setCreate(true); }} placeholder="描述一个新项目，或者从导入图片开始…"><span><Image size={14} />创建项目时保存为项目描述</span></Composer><div className="suggestions"><Button onClick={() => setCreate(true)}><Plus size={14} />创建项目</Button><Button busy={busy} onClick={() => void example()}><Scan size={14} />打开人工示例</Button></div></div>
    {create && <Modal title="新建项目" onClose={() => setCreate(false)}><form onSubmit={submit} className="form-stack"><Field label="项目名称"><input autoFocus required maxLength={80} placeholder="例如：道路目标检测" value={name} onChange={e => setName(e.target.value)} /></Field><Field label="任务类型"><select value={type} onChange={e => setType(e.target.value as TaskType)}>{Object.entries(taskNames).map(([key,label]) => <option key={key} value={key}>{key.toUpperCase()} · {label}</option>)}</select></Field><Field label="类别" hint="使用逗号分隔。类别顺序用于导出映射。"><input required value={classes} onChange={e => setClasses(e.target.value)} /></Field><Field label="项目描述"><textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="记录素材来源、标注范围与处理规则" /></Field><div className="modal-actions"><Button type="button" onClick={() => setCreate(false)}>取消</Button><Button className="primary" busy={busy} type="submit">创建并打开</Button></div></form></Modal>}
    {versionProject && <DatasetVersionDialog key={versionProject.id} project={versionProject} onClose={() => setVersionProject(null)} />}
  </div>;
}
