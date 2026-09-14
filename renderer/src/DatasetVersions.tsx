import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, GitCompare, Layers, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage } from './bridge';
import { Button, Empty, Field, Modal } from './ui';
import type { Project } from './types';

interface Count { outcome: string; split: string; count: number }
interface VersionIssue { severity: string; code: string; message: string; assetId?: string }
export interface DatasetVersion {
  id: string; projectId: string; number: number; name: string; status: string; sourceKind: string; taskType: string;
  annotationScope: string; recipeHash: string; contentHash?: string; manifestHash?: string; createdAt: string; completedAt?: string;
  recipe?: { selection?: { annotationScope?: string }; split?: { seed?: string; train?: number; val?: number; test?: number } };
  summary?: { images?: number; excluded?: number; objects?: number; bytes?: number; groups?: number; issues?: number; errors?: number; warnings?: number };
  split?: { seed?: string; train?: number; val?: number; test?: number; groups?: number; actual?: Array<{ split: string; images: number; objects: number }> };
  selection?: { annotationScope?: string; excluded?: number; excludedByReason?: Record<string, number> };
  failure?: { code: string; message: string };
  counts?: Count[];
  build?: { status: string; progress?: { stage?: string; done?: number; total?: number } };
  inspection?: { issues?: VersionIssue[]; summary?: Record<string, unknown> };
}
interface CompareResult {
  versionId: string; otherVersionId: string; added: string[]; removed: string[]; changed: Array<{ assetId: string; fields: string[] }>;
  unchanged: number; classesChanged: boolean; recipeChanged: boolean;
}
interface VerifyResult { verified: number; total: number; missing: string[]; changed: string[]; consistent: boolean; contentHash: string }

const statusText: Record<string, string> = { draft: '草稿', building: '生成中', ready: '已生成', failed: '生成失败', cancelled: '已取消', deleted: '已删除' };
const stageText: Record<string, string> = { queued: '排队中', scanning: '解析原始数据集', splitting: '计算划分', copying: '复制与校验副本', publishing: '发布版本', done: '已完成', failed: '已失败', cancelled: '已取消' };
const scopeLabels: Array<[string, string]> = [['labeled', '有正式标注（候选 / 已修改 / 已确认）'], ['confirmed', '仅人工已确认']];
const size = (value?: number) => value === undefined ? '—' : `${(value / 1024 / 1024).toFixed(1)} MB`;

export function DatasetVersionDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { notify } = useApp();
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState('');
  const [detail, setDetail] = useState<DatasetVersion | null>(null);
  const [base, setBase] = useState('');
  const [compared, setCompared] = useState<CompareResult | null>(null);
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [annotationScope, setAnnotationScope] = useState('labeled');
  const [seed, setSeed] = useState('');
  const [preflight, setPreflight] = useState<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  const refresh = useCallback(async () => {
    try { setVersions((await request<{ items: DatasetVersion[] }>('dataset.version.list', { projectId: project.id })).items); }
    catch (e) { notify(errorMessage(e), true); }
    finally { setLoading(false); }
  }, [project.id, notify]);

  useEffect(() => { void refresh(); }, [refresh]);
  const building = versions.some(version => version.status === 'building');
  // 生成是长任务：只在有版本正在生成时轮询，避免空闲页面持续打扰引擎。
  useEffect(() => {
    if (!building) return;
    timer.current = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer.current);
  }, [building, refresh]);

  useEffect(() => {
    if (!detailId) { setDetail(null); return; }
    void request<DatasetVersion>('dataset.version.get', { versionId: detailId }).then(setDetail).catch(e => notify(errorMessage(e), true));
  }, [detailId, versions, notify]);

  async function preflightCurrent() {
    setBusy(true);
    try { setPreflight(await request('dataset.version.preflight', { projectId: project.id, annotationScope })); }
    catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  async function submit() {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { projectId: project.id, annotationScope };
      if (name.trim()) payload.name = name.trim();
      if (seed.trim()) payload.seed = seed.trim();
      const created = await request<DatasetVersion>('dataset.version.create', payload);
      setCreating(false); setName(''); setSeed(''); setPreflight(null);
      setBase(created.id); setDetailId(created.id);
      await refresh();
      notify('版本已开始生成，进度在下方实时更新。');
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  async function act(action: string, versionId: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      if (action === 'compare') setCompared(await request<CompareResult>('dataset.version.compare', { versionId: base, otherVersionId: versionId }));
      else if (action === 'verify') setVerified(await request<VerifyResult>('dataset.version.verify', { versionId }));
      else await request(`dataset.version.${action}`, { versionId, ...extra });
      if (action === 'verify') notify('复核完成。');
      if (action === 'delete') { setDetailId(''); setCompared(null); setVerified(null); notify('版本已删除（副本保留，可由生命周期清理）。'); }
      await refresh();
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  return <Modal title={`数据集版本 · ${project.name}`} onClose={onClose} wide>
    <div className="asset-action-body dataset-version-body">
      <div className="section-toolbar">
        <h2 style={{ fontSize: 13 }}>版本列表 <span className="count">{versions.length}</span></h2>
        <div className="actions">
          <Button busy={loading} onClick={() => void refresh()}><RefreshCw size={14} />刷新</Button>
          <Button className="primary" onClick={() => { setCreating(true); setPreflight(null); }}><Plus size={14} />新建版本</Button>
        </div>
      </div>
      <p className="muted tiny">版本生成后不可变更：任何调整都会产生新版本号。划分以来源组为最小单位，默认按 70 / 20 / 10 逼近。</p>
      {creating && <form className="form-stack" style={{ marginTop: 16 }} onSubmit={e => { e.preventDefault(); void submit(); }}>
        <Field label="版本名称" hint="留空则只显示版本号。"><input maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder={`v${(versions[0]?.number ?? 0) + 1}`} /></Field>
        <Field label="标注范围"><select value={annotationScope} onChange={e => setAnnotationScope(e.target.value)}>{scopeLabels.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
        <Field label="划分种子" hint="留空自动生成。同一种子对同一数据源会得到完全相同的划分。"><input maxLength={256} value={seed} onChange={e => setSeed(e.target.value)} placeholder="自动生成" /></Field>
        <div className="modal-actions"><Button type="button" onClick={() => { setCreating(false); setPreflight(null); }}>取消</Button><Button busy={busy} onClick={() => void preflightCurrent()}>检查数据源</Button><Button className="primary" busy={busy} type="submit">生成版本</Button></div>
        {preflight && <div className="version-preview"><p>可用素材 {String(preflight.assets ?? 0)} 张 · 来源组 {String(preflight.groups ?? 0)} 个 · 范围外 {String(preflight.excluded ?? 0)} 张</p>
          {Number(preflight.blocking ?? 0) > 0 && <p className="inline-error">存在 {String(preflight.blocking)} 个阻断问题，需先处理才能生成版本。</p>}</div>}
      </form>}
      {loading ? <div className="page-loading" role="status"><LoaderCircle className="spin" size={18} />读取版本…</div>
        : versions.length ? <div className="training-cards">{versions.map(version => {
          const summary = version.summary ?? {};
          const counts = (version.counts ?? []).reduce((total: number, item: Count) => total + Number(item.count), 0);
          const images = summary.images ?? counts;
          return <div className="training-card" key={version.id} style={detailId === version.id ? { borderColor: 'var(--accent)' } : undefined}>
            <header><strong style={{ fontSize: 13 }}>v{version.number}{version.name ? ` · ${version.name}` : ''}</strong>
              <span className={`training-badge ${version.status === 'ready' ? 'ready' : version.status === 'failed' ? 'invalid' : ''}`}>{statusText[version.status] ?? version.status}</span></header>
            <p className="muted tiny">{version.annotationScope === 'confirmed' ? '仅已确认标注' : '有正式标注'} · {version.taskType.toUpperCase()} · {images} 张图片 · {String(summary.objects ?? '—')} 个目标</p>
            <p className="muted tiny">{size(summary.bytes)} · 排除 {String(summary.excluded ?? 0)} 张 · 来源组 {String(summary.groups ?? '—')} 个</p>
            {version.status === 'building' && version.build?.progress && <><div className="progress"><span style={{ width: `${Math.min(100, (version.build.progress.done ?? 0) / Math.max(1, version.build.progress.total ?? 1) * 100)}%` }} /></div>
              <p className="muted tiny">{stageText[version.build.progress.stage ?? ''] ?? version.build.progress.stage} · {version.build.progress.done} / {version.build.progress.total}</p></>}
            {version.failure && <p className="inline-error">{version.failure.message}</p>}
            {version.status === 'ready' && Number(summary.errors ?? 0) === 0 && summary.warnings !== undefined && Number(summary.warnings) > 0
              && <p className="tiny muted">体检提示 {String(summary.warnings)} 项，不阻断消费。</p>}
            <div className="actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <Button onClick={() => setDetailId(detailId === version.id ? '' : version.id)}><Layers size={13} />详情</Button>
              {version.status === 'ready' && <Button disabled={busy} onClick={() => void act('verify', version.id)}><ShieldCheck size={13} />复核</Button>}
              {version.status === 'ready' && <Button disabled={busy || !base || base === version.id} onClick={() => void act('compare', version.id)}><GitCompare size={13} />对比</Button>}
              {version.status === 'ready' && <Button onClick={() => setBase(base === version.id ? '' : version.id)}>{base === version.id ? '取消基准' : '设为基准'}</Button>}
              {version.status === 'building' && <Button disabled={busy} onClick={() => void act('cancel', version.id)}><X size={13} />取消生成</Button>}
              {version.status !== 'building' && <Button disabled={busy} onClick={() => void act('delete', version.id, { confirm: true })}><Trash2 size={13} />删除</Button>}
            </div>
          </div>;
        })}</div>
        : <Empty icon={<Layers size={26} />} title="还没有数据集版本" description="从当前项目的素材与标注生成一个不可变、可复核的数据集版本。" />}
      {compared && <div className="quality-summary" style={{ marginTop: 18 }}>
        <h3 style={{ fontSize: 12 }}>对比结果：v{versions.find(v => v.id === compared.versionId)?.number} → v{versions.find(v => v.id === compared.otherVersionId)?.number}</h3>
        <p>新增 {compared.added.length} 项 · 移除 {compared.removed.length} 项 · 变更 {compared.changed.length} 项 · 未变 {compared.unchanged} 项</p>
        {compared.classesChanged && <p className="inline-error">类别表或关键点模板发生变化，指标不能直接横向比较。</p>}
        {compared.recipeChanged && <p className="tiny muted">配方（标注范围或种子）不同。</p>}
        {!!compared.changed.length && <ul className="training-preflight-issues">{compared.changed.slice(0, 20).map(item => <li key={item.assetId}>{item.assetId} · {item.fields.join(' / ')}</li>)}</ul>}
      </div>}
      {verified && <div className="quality-summary" style={{ marginTop: 18 }}>
        <h3 style={{ fontSize: 12 }}>复核结果</h3>
        <p>{verified.consistent ? <><Check size={13} /> 副本与清单完全一致</> : <><AlertCircle size={13} /> 副本与清单不一致</>} · 已校验 {verified.verified} / {verified.total} 个文件</p>
        {!!verified.missing.length && <p className="inline-error">缺失 {verified.missing.length} 个文件，例如 {verified.missing[0]}。</p>}
        {!!verified.changed.length && <p className="inline-error">内容变更 {verified.changed.length} 个文件，例如 {verified.changed[0]}。</p>}
      </div>}
      {detail && <DetailView version={detail} onClose={() => setDetailId('')} notify={notify} />}
    </div>
  </Modal>;
}

function DetailView({ version, onClose, notify }: { version: DatasetVersion; onClose: () => void; notify: (m: string, error?: boolean) => void }) {
  const [items, setItems] = useState<{ items: Array<Record<string, unknown>>; total: number } | null>(null);
  useEffect(() => {
    void request<{ items: Array<Record<string, unknown>>; total: number }>('dataset.version.items', { versionId: version.id, outcome: 'filtered_out', limit: 50 })
      .then(setItems).catch(e => notify(errorMessage(e), true));
  }, [version.id, notify]);
  const issues = version.inspection?.issues ?? [];
  const reasons = version.selection?.excludedByReason ?? {};
  return <section className="operation-section">
    <div className="section-toolbar"><h2 style={{ fontSize: 13 }}>v{version.number} 详情</h2><button className="text-button" onClick={onClose}>收起</button></div>
    <div className="training-summary">
      <p>状态：{statusText[version.status] ?? version.status} · 来源：{version.sourceKind} · 任务：{version.taskType}</p>
      <p>内容哈希：<code>{version.contentHash ?? '—'}</code></p>
      <p>清单哈希：<code>{version.manifestHash ?? '—'}</code></p>
      <p>配方哈希：<code>{version.recipeHash}</code></p>
      <p>划分种子：<code>{version.split?.seed ?? version.recipe?.split?.seed ?? '—'}</code></p>
      {!!version.split?.actual?.length && <p>实际划分：{version.split.actual.map(entry => `${entry.split} ${entry.images} 张 / ${entry.objects} 目标`).join(' · ')}</p>}
      {!!Object.keys(reasons).length && <p>遗漏范围：{Object.entries(reasons).map(([code, count]) => `${code} ${count}`).join(' · ')}</p>}
    </div>
    {version.failure && <p className="inline-error">{version.failure.message}（{version.failure.code}）</p>}
    {!!issues.length && <div className="operation-issues"><h3 style={{ fontSize: 12, marginBottom: 8 }}>体检问题（{issues.length}）</h3>
      <div className="label-pairs">{issues.slice(0, 50).map((issue, index) => <div className="issue-detail" key={index}>
        <strong>{issue.code}</strong><small>{issue.severity}{issue.assetId ? ` · ${issue.assetId}` : ''}</small><p>{issue.message}</p></div>)}</div></div>}
    {!!items?.items.length && <div className="operation-issues"><h3 style={{ fontSize: 12, marginBottom: 8 }}>被排除的素材（{items.total}）</h3>
      <div className="label-pairs">{items.items.slice(0, 50).map(item => <div className="issue-detail" key={String(item.assetId)}>
        <strong>{String(item.name ?? item.assetId)}</strong><small>{String(item.reasonCode ?? '')} · {String(item.status ?? '')}</small></div>)}</div></div>}
  </section>;
}
