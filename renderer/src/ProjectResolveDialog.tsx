import { useState } from 'react';
import { Button, Field, Modal } from './ui';
import { errorMessage } from './bridge';
import type { Project } from './types';

export type ProjectChoice = { mode: 'create'; name: string } | { mode: 'existing'; project: Project };

/**
 * 项目归属确认框：新建项目必须由用户命名，不再从描述或文件夹名自动取名。
 * 发送 / 导入 / 新建入口先经过这里确认落点（新建命名或选已有项目），确认后才执行真正的动作。
 *
 * `defaultProjectId` 只是「上次勾过记住的那个项目」：它把默认选项挪过去，不代替确认，
 * 也不会因此少问一次——项目归属始终是用户点过确认的。
 */
export default function ProjectResolveDialog({ title, confirmLabel, projects, suggestName = '', allowExisting = true, defaultProjectId = '', onRemember, onClose, onConfirm }: {
  title: string; confirmLabel: string; projects: Project[]; suggestName?: string; allowExisting?: boolean;
  defaultProjectId?: string;
  /** 勾选/取消「以后默认进这个项目」时回调；不传表示这个入口不提供记住。 */
  onRemember?: (projectId: string) => void;
  onClose: () => void;
  onConfirm: (choice: ProjectChoice) => Promise<void>;
}) {
  const matched = suggestName ? projects.find(project => project.name === suggestName) : undefined;
  const remembered = projects.find(project => project.id === defaultProjectId);
  // 描述/文件夹名命中同名项目时以它优先：那是本次动作自己的线索，比记住的默认值更贴题。
  const preferred = matched ?? remembered;
  const [mode, setMode] = useState<'create' | 'existing'>(allowExisting && preferred ? 'existing' : 'create');
  const [name, setName] = useState(suggestName);
  const [selectedId, setSelectedId] = useState(preferred?.id ?? projects[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 勾选状态由设置派生，而不是各存一份：改了选中项目以后，勾选框会立刻跟着反映真实落点。
  const remembersCurrent = defaultProjectId !== '' && mode === 'existing' && selectedId === defaultProjectId;
  async function confirm() {
    setBusy(true); setError('');
    try {
      if (mode === 'create') {
        if (!name.trim()) throw new Error('请填写项目名称。');
        await onConfirm({ mode: 'create', name: name.trim() });
      } else {
        const project = projects.find(item => item.id === selectedId);
        if (!project) throw new Error('请选择一个项目。');
        await onConfirm({ mode: 'existing', project });
      }
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <Modal title={title} onClose={onClose}>
    <div className="form-stack">
      {allowExisting && <div className="segmented">
        <button type="button" className={mode === 'create' ? 'selected' : ''} onClick={() => setMode('create')}>新建项目</button>
        <button type="button" className={mode === 'existing' ? 'selected' : ''} disabled={!projects.length} onClick={() => setMode('existing')}>选择已有项目</button>
      </div>}
      {mode === 'create'
        ? <Field label="项目名称"><input autoFocus maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="给项目起个名字"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (name.trim()) void confirm(); } }} /></Field>
        : <Field label="选择项目"><select value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}（{project.assetCount} 张素材）</option>)}
          </select></Field>}
      {/* 只在「选已有项目」时给出记住：记住一个新名字没有意义，下次它还不存在。 */}
      {onRemember && mode === 'existing' && <label className="checkbox-row remember-row">
        <input type="checkbox" checked={remembersCurrent} onChange={e => onRemember(e.target.checked ? selectedId : '')} />
        以后欢迎页的素材默认进这个项目
      </label>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <Button type="button" onClick={onClose}>取消</Button>
        <Button className="primary" busy={busy} disabled={mode === 'create' && !name.trim()} onClick={() => void confirm()}>{confirmLabel}</Button>
      </div>
    </div>
  </Modal>;
}
