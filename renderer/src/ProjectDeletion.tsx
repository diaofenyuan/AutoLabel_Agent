import { useCallback, useEffect, useState } from 'react';
import { FolderX, ShieldAlert, Trash2 } from 'lucide-react';
import { Button, Modal, Notice } from './ui';
import { errorMessage, isDemo, request } from './bridge';
import type { Project } from './types';

interface DeletionCounts {
  assets?: number; versions?: number; drafts?: number; runs?: number; samples?: number; attempts?: number;
  exports?: number; flowRuns?: number; mediaJobs?: number; timelines?: number; tracks?: number;
  generations?: number; evaluationSets?: number; evaluations?: number; reviewItems?: number;
  trainingDatasets?: number; trainingJobs?: number; [key: string]: number | undefined;
}
interface DeletionPreflight {
  projectId: string;
  name: string;
  counts: DeletionCounts;
  managedBytes: number;
  externalExportPaths: string[];
  blockers: Array<{ kind: string; message: string }>;
}
interface DeletionResult {
  deleted: boolean;
  name: string;
  removedFiles: number;
  removedBytes: number;
  fileFailures: Array<{ path: string; message: string }>;
  externalExportPaths: string[];
}

const countNames: Record<string, string> = {
  assets: '素材', versions: '标注版本', drafts: '草稿', runs: '标注任务', samples: '任务样本',
  attempts: '调用尝试', exports: '导出版本', flowRuns: '自动流程', mediaJobs: '素材任务',
  timelines: '轨迹时间轴', tracks: '轨迹', generations: '轨迹生成', evaluationSets: '评测集',
  evaluations: '评测', reviewItems: '复核项', trainingDatasets: '训练数据集快照', trainingJobs: '训练任务',
};

function formatBytes(bytes: number) {
  if (!bytes || bytes < 1) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * 项目删除两步弹窗：影响清单 → 删除选项。
 * 阻断项存在时不允许删除；外部导出目录只列出、永不删除。
 * 不再要求手工输入项目名：影响清单已明确展示删除范围，避免重复确认造成误操作成本。
 */
export function ProjectDeletionDialog({ project, onClose, onDeleted }: {
  project: Project; onClose: () => void; onDeleted: (projectId: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [preflight, setPreflight] = useState<DeletionPreflight | null>(null);
  const [removeManagedFiles, setRemoveManagedFiles] = useState(true);
  const [createBackup, setCreateBackup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<DeletionResult | null>(null);

  const load = useCallback(async () => {
    if (isDemo) { setPreflight(null); return; }
    setBusy(true); setError('');
    try { setPreflight(await request<DeletionPreflight>('project.delete.preflight', { projectId: project.id })); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  const blocked = (preflight?.blockers.length ?? 0) > 0;

  async function remove() {
    setBusy(true); setError('');
    try {
      const data = await request<DeletionResult>('project.delete', {
        projectId: project.id, removeManagedFiles, createBackup,
      });
      setResult(data);
      setStep(3);
      onDeleted(project.id);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  const counts = preflight?.counts ?? {};

  return <Modal title="删除项目" onClose={() => { if (!busy) onClose(); }}>
    <div className="form-stack">
      <div className="tabs" role="tablist">
        {[['影响清单', 1], ['删除选项', 2]].map(([label, index]) => <button key={index as number} role="tab"
          aria-selected={step === index} disabled={busy || step === 3 || (index as number) > 1} className={step === index ? 'selected' : ''}
          onClick={() => setStep(index as number)}>{String(index)}. {label}</button>)}
      </div>
      {step === 3 && result
        ? <Notice>
            已删除项目「{result.name}」：清理受管文件 {result.removedFiles} 个（{formatBytes(result.removedBytes)}）。
            {!!result.fileFailures.length && `有 ${result.fileFailures.length} 个文件未能删除，请在存储位置中手动清理。`}
            {!!result.externalExportPaths.length && `位于数据目录外的 ${result.externalExportPaths.length} 个历史导出目录未被删除。`}
            对话历史仍然保留，并标记为「项目已删除」。
          </Notice>
        : step === 1
          ? <>
              <p className="muted">删除前请核对影响范围。删除只作用于本机数据，不可撤销。</p>
              <div className="deletion-counts">
                {Object.entries(counts).filter(([, value]) => (value ?? 0) > 0).map(([key, value]) =>
                  <p key={key} className="muted tiny">{countNames[key] ?? key}：{value}</p>)}
                {!Object.values(counts).some(value => (value ?? 0) > 0) && <p className="muted tiny">该项目还没有产生数据。</p>}
              </div>
              <p className="muted tiny">受管文件占用：{formatBytes(preflight?.managedBytes ?? 0)}</p>
              {!!preflight?.externalExportPaths.length && <div className="issue warning">
                <FolderX size={13} />数据目录外的历史导出目录不会被删除：
                {preflight.externalExportPaths.map(item => <span key={item} className="break-word">{item}</span>)}</div>}
              {blocked && <div className="issue error"><ShieldAlert size={13} />
                {preflight!.blockers.map(item => <span key={item.kind}>{item.message}</span>)}</div>}
              {error && <p className="inline-error">{error}</p>}
              <div className="modal-actions">
                <Button disabled={busy} onClick={onClose}>取消</Button>
                <Button disabled={busy || blocked || !preflight} onClick={() => setStep(2)}>下一步：删除选项</Button>
              </div>
            </>
          : <>
              <Notice>将删除项目「{project.name}」。删除会按选项处理受管文件；外部导出目录一律不删除。</Notice>
              <label className="checkbox-row"><input type="checkbox" disabled={busy} checked={removeManagedFiles}
                onChange={e => setRemoveManagedFiles(e.target.checked)} />同时删除受管文件（素材、流程产物、媒体产物）</label>
              <label className="checkbox-row"><input type="checkbox" disabled={busy} checked={createBackup}
                onChange={e => setCreateBackup(e.target.checked)} />删除前先创建备份（失败即中止删除）</label>
              <p className="muted tiny">删除过程中会持有数据维护锁，其他写操作会等待。</p>
              {error && <p className="inline-error">{error}</p>}
              <div className="modal-actions">
                <Button disabled={busy} onClick={() => setStep(1)}>上一步</Button>
                <Button className="primary" busy={busy} onClick={() => void remove()}><Trash2 size={14} />删除项目</Button>
              </div>
            </>}
      {step === 3 && <div className="modal-actions"><Button className="primary" onClick={onClose}>完成</Button></div>}
    </div>
  </Modal>;
}
