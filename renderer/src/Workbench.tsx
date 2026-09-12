import { useCallback, useEffect, useRef, useState } from 'react';
import { MousePointer2, SquareDashed, Pentagon, RotateCw, GitBranch, Tag, Hand, ZoomIn, ZoomOut, Maximize, Undo2, Redo2, Trash2, Eye, EyeOff, Upload, Download, ChevronLeft, ChevronRight, FolderOpen, SlidersHorizontal, Check, Scan, Save, Ellipsis } from 'lucide-react';
import { useApp } from './context';
import { getBridge, request, isDemo, errorMessage } from './bridge';
import { Button, Empty, Field, IconButton, Notice } from './ui';
import { taskNames, statusNames, type Annotation, type Asset, type Point, type Project, type TaskType } from './types';
import ExportDialog from './ExportDialog';
import ChatPanel from './ChatPanel';
import AssetActions from './AssetActions';
import VideoImport from './VideoImport';
import { keypointEdges } from './keypointEdges';
import TemplateDialog from './TemplateDialog';
import VideoTimeline from './VideoTimeline';
import AttributeValues from './AttributeValues';
import TemplateRuleSummary from './TemplateRuleSummary';
import { annotationAttributeIssues, attributeDefinitions } from './templateAttributes';
import { deletePolygonPoint, insertPolygonPoint, MAX_POLYGON_POINTS } from './polygonEditing';

type Tool = 'select' | 'pan' | TaskType;
const toolItems = [ ['select','选择 · V',MousePointer2], ['detect','检测框 · B',SquareDashed], ['segment','多边形 · S',Pentagon], ['obb','旋转框 · O',RotateCw], ['pose','关键点 · P',GitBranch], ['classify','图片分类 · C',Tag], ['pan','平移 · H',Hand] ] as const;
const clone = <T,>(value: T): T => structuredClone(value);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
function moveShape(shape: Annotation, dx: number, dy: number): Annotation {
  return { ...shape, bbox: shape.bbox && { ...shape.bbox, x: shape.bbox.x + dx, y: shape.bbox.y + dy }, points: shape.points?.map(p => ({ x: p.x + dx, y: p.y + dy })), keypoints: shape.keypoints?.map(p => p.visibility === 0 ? p : ({ ...p, x: p.x + dx, y: p.y + dy })) };
}

export default function Workbench() {
  const { project, projects, assets, assetOffset, assetTotal, assetPageSize, assetsLoading, loadAssetPage, selectedAssetIds, setSelectedAssetIds, openProject, refreshProjects, refreshAssets, notify, guard, navigate, setMediaTaskId } = useApp();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusedAsset, setFocusedAsset] = useState<Asset | null>(null);
  const [switching, setSwitching] = useState(false);
  const switchLock = useRef(false);
  const [pageInput, setPageInput] = useState('1');
  const [importing, setImporting] = useState(false);
  const [videoImport, setVideoImport] = useState(false);
  async function showVideoImport() { try { await guard.current?.(); setVideoImport(true); } catch (e) { notify(errorMessage(e), true); } }
  const [exporting, setExporting] = useState(false);
  const [template, setTemplate] = useState(false);
  const [view, setView] = useState<'images' | 'video'>('images');
  const showTimeline = view === 'video' && project && ['detect', 'pose'].includes(project.taskType);
  async function switchView(next: 'images' | 'video') { try { await guard.current?.(); setView(next); } catch (e) { notify(errorMessage(e), true); } }
  const active = focusedAsset?.projectId === project?.id ? focusedAsset : assets.find(a => a.id === activeId) ?? assets[0];
  const pageNumber = Math.floor(assetOffset / assetPageSize) + 1;
  const pageCount = Math.max(1, Math.ceil(assetTotal / assetPageSize));
  useEffect(() => setPageInput(String(pageNumber)), [pageNumber, project?.id]);
  async function turnPage(offset: number, last = false) {
    try { const items = await loadAssetPage(offset); setFocusedAsset(null); setActiveId((last ? items.at(-1) : items[0])?.id ?? null); }
    catch (e) { notify(`已保留当前图片。${errorMessage(e)}`, true); }
  }
  async function moveAsset(delta: number) {
    const index = assets.findIndex(a => a.id === active?.id);
    if (index < 0) return;
    if (assets[index + delta]) await selectAsset(assets[index + delta].id);
    else if (assetOffset + index + delta >= 0 && assetOffset + index + delta < assetTotal) await turnPage(assetOffset + delta * assetPageSize, delta < 0);
  }
  async function importImages() {
    if (!project) return;
    setImporting(true);
    try {
      await guard.current?.();
      const paths = await (await getBridge()).chooseFiles({ kind: 'images', multiple: true });
      if (!paths.length) return;
      const result = await request<{ imported: number; skipped: number; errors: Array<string | { name?: string; message: string }> }>('asset.import', { projectId: project.id, paths, mode: 'copy' });
      await Promise.all([refreshAssets(), refreshProjects()]);
      notify(`已导入 ${result.imported} 张，跳过 ${result.skipped} 张。${result.errors.length ? result.errors.map(e => typeof e === 'string' ? e : `${e.name ?? ''}：${e.message}`).join('；') : ''}`, result.errors.length > 0);
    } catch (e) { notify(errorMessage(e), true); } finally { setImporting(false); }
  }
  const selectAsset = useCallback(async (id: string) => {
    if (switchLock.current || assetsLoading) return;
    switchLock.current = true; setSwitching(true);
    try { await guard.current?.(); setFocusedAsset(null); setActiveId(id); }
    catch (e) { notify(`草稿未保存，请保留当前图片。${errorMessage(e)}`, true); }
    finally { switchLock.current = false; setSwitching(false); }
  }, [guard, notify, assetsLoading]);
  const agentView = useRef({ assets, projectId: project?.id, assetsLoading });
  agentView.current = { assets, projectId: project?.id, assetsLoading };
  useEffect(() => {
    let off: (() => void) | undefined; let disposed = false;
    void getBridge().then(bridge => { if (!disposed) off = bridge.onAgentEvent?.(event => {
      if (event.type === 'agent.open_asset' && typeof event.payload.assetId === 'string') {
        if (document.querySelector('dialog[open]')) { notify('请先关闭当前弹窗，再让助手打开图片。'); return; }
        const { assets, projectId, assetsLoading } = agentView.current;
        const assetId = event.payload.assetId;
        if (assets.some(a => a.id === assetId)) void selectAsset(assetId);
        else if (!switchLock.current && !assetsLoading && !document.querySelector('dialog[open]')) {
          switchLock.current = true; setSwitching(true);
          void (async () => {
            try {
              await guard.current?.();
              const target = await request<Asset>('asset.get', { assetId });
              if (disposed) return;
              if (target.projectId !== projectId) { notify('该素材属于其他项目，请先打开对应项目。'); return; }
              setFocusedAsset(target); notify('已单独打开助手指定图片；分页和跨页勾选保持不变。');
            } catch (e) { notify(errorMessage(e), true); }
            finally { switchLock.current = false; setSwitching(false); }
          })();
        }
      }
    }); });
    return () => { disposed = true; off?.(); };
  }, [notify, selectAsset, guard]);
  if (!project) return <Empty icon={<FolderOpen size={28} />} title="选择一个项目" description="打开已有项目，或从预置人工样例开始。"><div className="empty-projects">{projects.map(p => <Button key={p.id} onClick={() => void openProject(p).catch(e => notify(errorMessage(e), true))}>{p.name}<ChevronRight size={14} /></Button>)}<Button className="primary" onClick={() => void request<Project>('project.example').then(openProject).then(refreshProjects).catch(e => notify(errorMessage(e), true))}><Scan size={15} />打开人工示例</Button></div></Empty>;
  return <div className={`workbench ${showTimeline ? 'has-video-timeline' : ''}`}>
    <div className="workbench-projectbar"><div className="project-picker"><select aria-label="当前项目" disabled={assetsLoading || switching || importing} value={project.id} onChange={e => { const p = projects.find(p => p.id === e.target.value); if (p) void openProject(p).catch(error => notify(errorMessage(error), true)); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><span className="subtle-separator" /><span className="muted truncate">{active?.name ?? '还没有图片'}</span></div><div className="actions"><Button busy={importing} disabled={assetsLoading || switching} onClick={() => void importImages()}><Upload size={14} />导入图片</Button><Button disabled={isDemo || assetsLoading || switching || importing} onClick={() => void showVideoImport()}>从视频抽帧</Button><IconButton label="类别与点位模板" disabled={assetsLoading || switching} onClick={() => void Promise.resolve(guard.current?.()).then(() => setTemplate(true)).catch(e => notify(errorMessage(e), true))}><SlidersHorizontal size={16} /></IconButton><IconButton label="导出数据集" disabled={!assetTotal || assetsLoading || switching} onClick={() => void Promise.resolve(guard.current?.()).then(() => setExporting(true)).catch(e => notify(errorMessage(e), true))}><Download size={16} /></IconButton></div></div>
    {['detect', 'pose'].includes(project.taskType) && <div className="tabs workbench-view-tabs"><button className={!showTimeline?'selected':''} disabled={assetsLoading||switching||importing} onClick={()=>void switchView('images')}>图片标注</button><button className={showTimeline?'selected':''} disabled={isDemo||assetsLoading||switching||importing} onClick={()=>void switchView('video')}>视频轨迹</button></div>}
    <div className="asset-pagination" aria-label="素材分页"><div className="asset-page-selection"><label><input type="checkbox" aria-label="勾选当前页" disabled={!assets.length || assetsLoading || switching} checked={assets.length > 0 && assets.every(a => selectedAssetIds.includes(a.id))} onChange={e => setSelectedAssetIds(ids => e.target.checked ? [...new Set([...ids, ...assets.map(a => a.id)])] : ids.filter(id => !assets.some(a => a.id === id)))}/>当前页</label><span>已勾选 {selectedAssetIds.length} 张（跨页）</span><button className="text-button" disabled={!selectedAssetIds.length || assetsLoading || switching} onClick={() => setSelectedAssetIds([])}>清空勾选</button></div><div className="asset-page-navigation"><span aria-live="polite">{assetsLoading ? '正在保存草稿并读取素材…' : `第 ${assetTotal ? assetOffset + 1 : 0}–${assetOffset + assets.length} 张 / 共 ${assetTotal} 张`}</span><IconButton label="上一页素材" disabled={assetOffset === 0 || assetsLoading || switching} onClick={() => void turnPage(assetOffset - assetPageSize)}><ChevronLeft size={15}/></IconButton><form onSubmit={e => { e.preventDefault(); const next = Number(pageInput); if (Number.isInteger(next) && next >= 1 && next <= pageCount) void turnPage((next - 1) * assetPageSize); else { setPageInput(String(pageNumber)); notify(`页码范围为 1–${pageCount}。`, true); } }}><input aria-label="素材页码" type="number" min={1} max={pageCount} value={pageInput} disabled={assetsLoading || switching} onChange={e => setPageInput(e.target.value)}/><span>/ {pageCount} 页</span><Button type="submit" disabled={assetsLoading || switching}>跳转</Button></form><IconButton label="下一页素材" disabled={assetOffset + assets.length >= assetTotal || assetsLoading || switching} onClick={() => void turnPage(assetOffset + assetPageSize)}><ChevronRight size={15}/></IconButton></div></div>
    {focusedAsset?.id === active?.id && active && <div className="focused-asset-note">单图定位：{active.name}<button className="text-button" onClick={() => void selectAsset(assets[0]?.id ?? '')}>返回当前页</button></div>}
    {showTimeline ? <VideoTimeline key={project.id} project={project}/> : active ? <Editor key={active.id} asset={active} switching={switching} onSelect={selectAsset} onMove={moveAsset} onAssetUpdated={updated => setFocusedAsset(current => current?.id === updated.id ? updated : current)} onExport={() => setExporting(true)} /> : <Empty icon={<Upload size={28} />} title="导入第一张图片" description="支持 JPEG 与 PNG。无需配置模型，即可人工标注。"><Button busy={importing} className="primary" onClick={() => void importImages()}>选择图片</Button></Empty>}
    {videoImport && <VideoImport projectId={project.id} onClose={() => setVideoImport(false)} onCreated={job => { setVideoImport(false); setMediaTaskId(job.id); void navigate('tasks'); }}/>}
    {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    {template && <TemplateDialog onClose={() => setTemplate(false)} />}
  </div>;
}

interface DragState { start: Point; client: Point; original: Annotation[]; id?: string; handle?: string; pointIndex?: number; pan?: Point; creating?: Annotation }
function Editor({ asset, switching, onSelect, onMove, onAssetUpdated, onExport }: { asset: Asset; switching: boolean; onSelect: (id: string) => Promise<void>; onMove: (delta: number) => Promise<void>; onAssetUpdated: (asset: Asset) => void; onExport: () => void }) {
  const { project, assets, assetOffset, assetTotal, assetsLoading, selectedAssetIds, setSelectedAssetIds, setAssets, prefs, notify, refreshProjects, guard, syncWindowDirtySource } = useApp();
  const validDraft = asset.draft && (asset.metadata?.draftBaseVersion === undefined || asset.metadata.draftBaseVersion === asset.version);
  const [annotations, setAnnotations] = useState<Annotation[]>(() => clone(validDraft ? asset.draft! : asset.annotations));
  const [selected, setSelected] = useState<string | null>(annotations[0]?.id ?? null);
  const [classId, setClassId] = useState(project!.classes[0]?.id ?? '');
  const [tool, setTool] = useState<Tool>('select');
  const [locating, setLocating] = useState<{id:string;index:number}|null>(null);
  const [vertex, setVertex] = useState<{id:string;index:number}|null>(null);
  const [inserting, setInserting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [polygon, setPolygon] = useState<Point[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'objects' | 'assistant'>('objects');
  const [dirty, setDirty] = useState(Boolean(validDraft));
  const [draftStatus, setDraftStatus] = useState(validDraft ? '已恢复草稿' : '已保存');
  const [saving, setBusy] = useState(false);
  const busy = saving || assetsLoading || switching;
  const [assetStatus, setAssetStatus] = useState(asset.status);
  const [draftConflict, setDraftConflict] = useState(Boolean(asset.draft && !validDraft));
  const [imageError, setImageError] = useState(false);
  const [more, setMore] = useState(false);
  const [, renderHistory] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<DragState | null>(null);
  const history = useRef<Annotation[][]>([]);
  const future = useRef<Annotation[][]>([]);
  const version = useRef(asset.version);
  const value = useRef(annotations); value.current = annotations;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const dirtySource = 'workbench:' + asset.id;
  const lastDraft = useRef(validDraft ? JSON.stringify(annotations) : '');
  const operation = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);
  const current = annotations.find(a => a.id === selected);
  const scale = fit * zoom;
  const index = assets.findIndex(a => a.id === asset.id);
  const keypointNames = Array.isArray(project!.settings.keypointNames) ? project!.settings.keypointNames.map(String) : ['左上', '右上', '右下', '左下'];
  useEffect(() => { syncWindowDirtySource(dirtySource, dirty); return () => syncWindowDirtySource(dirtySource, false); }, [dirty, dirtySource, syncWindowDirtySource]);
  useEffect(() => {
    mounted.current = true;
    const element = viewport.current!;
    const observer = new ResizeObserver(([entry]) => setFit(Math.max(0.05, Math.min((entry.contentRect.width - 40) / asset.width, (entry.contentRect.height - 40) / asset.height))));
    observer.observe(element);
    return () => { mounted.current = false; observer.disconnect(); clearTimeout(timer.current); };
  }, [asset.height, asset.width]);
  const flushDraft = useCallback(async () => {
    clearTimeout(timer.current);
    const snapshot = clone(value.current); const serialized = JSON.stringify(snapshot);
    if (!dirtyRef.current || serialized === lastDraft.current) { await operation.current; return; }
    const job = operation.current.catch(() => {}).then(async () => {
      if (serialized === lastDraft.current) return;
      await request('annotation.draft', { assetId: asset.id, annotations: snapshot, baseVersion: version.current });
      lastDraft.current = serialized;
      setAssets(list => list.map(a => a.id === asset.id ? { ...a, draft: snapshot, metadata: { ...a.metadata, draftBaseVersion: version.current } } : a));
      if (mounted.current) setDraftStatus(isDemo ? '草稿已存于浏览器' : '草稿已保存');
    });
    operation.current = job;
    try { await job; } catch (e) { if (mounted.current) setDraftStatus('草稿保存失败'); throw e; }
  }, [asset.id, setAssets]);
  useEffect(() => {
    const beforeSwitch = async () => {
      if (drag.current || polygon.length) throw new Error('请先完成当前拖动或多边形，或按 Escape 取消绘制。');
      await flushDraft();
    };
    guard.current = beforeSwitch;
    return () => { if (guard.current === beforeSwitch) guard.current = null; };
  }, [flushDraft, guard, polygon.length]);
  useEffect(() => {
    if (!dirty || drag.current) return;
    if (JSON.stringify(annotations) === lastDraft.current) {
      setDraftStatus(status => status === '已恢复草稿' ? status : isDemo ? '草稿已存于浏览器' : '草稿已保存');
      return;
    }
    setDraftStatus('草稿待保存');
    timer.current = setTimeout(() => { void flushDraft().catch(e => notify(errorMessage(e), true)); }, 700);
    return () => clearTimeout(timer.current);
  }, [annotations, dirty, flushDraft, notify]);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current && JSON.stringify(value.current) !== lastDraft.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  function change(next: Annotation[]) {
    if (busy) return;
    history.current = [...history.current.slice(-59), clone(value.current)]; future.current = [];
    value.current = next; setAnnotations(next); setDirty(true); renderHistory(v => v + 1);
  }
  function undo(redo = false) {
    if (busy) return;
    const from = redo ? future : history; const to = redo ? history : future;
    if (!from.current.length) return;
    to.current.push(clone(value.current)); const next = from.current.pop()!;
    value.current = next; setAnnotations(next); setDirty(true); setVertex(null); setInserting(false); renderHistory(v => v + 1);
  }
  function updateShape(update: Partial<Annotation>) { if (current) change(annotations.map(a => a.id === current.id ? { ...a, ...update } : a)); }
  function deleteSelected() { if (busy || drag.current || polygon.length) return; if (selected) { change(annotations.filter(a => a.id !== selected)); setSelected(null); setVertex(null); setInserting(false); } }
  function deleteVertex() {
    if (busy || drag.current || polygon.length || !vertex || current?.id !== vertex.id || !current.points) return;
    const points = deletePolygonPoint(current.points, vertex.index);
    if (!points) { notify('多边形至少保留 3 个顶点。'); return; }
    updateShape({ points }); setVertex(null);
  }
  function deleteFocused() { if (vertex && current?.id === vertex.id) deleteVertex(); else deleteSelected(); }
  function finishPolygon() {
    if (polygon.length < 3 || polygon.length > MAX_POLYGON_POINTS) { notify('多边形需要 3–4096 个顶点。', true); return; }
    const shape: Annotation = { id: crypto.randomUUID(), type: 'segment', classId, points: polygon };
    change([...value.current, shape]); setSelected(shape.id); setPolygon([]); setTool('select');
  }
  function setActiveTool(next: Tool) {
    if (busy) return;
    if (next !== 'select' && next !== 'pan' && next !== project!.taskType) { notify(`当前项目使用 ${taskNames[project!.taskType]}，其他标注类型请新建对应项目。`); return; }
    setPolygon([]); setLocating(null); setVertex(null); setInserting(false); setTool(next);
    if (next === 'classify') {
      const existing = annotations.find(a => a.type === 'classify');
      const shape: Annotation = { id: existing?.id ?? crypto.randomUUID(), type: 'classify', classId };
      change([...annotations.filter(a => a.type !== 'classify'), shape]); setSelected(shape.id);
    }
  }
  async function save(confirm = false) {
    if (busy) return;
    if (drag.current) { notify('请先完成当前拖动，再保存标注。'); return; }
    if (polygon.length) { notify('请先按 Enter 完成多边形，或按 Escape 取消。', true); return; }
    const attributeIssues = annotationAttributeIssues(value.current, project?.settings.attributes);
    if (attributeIssues.length) { notify(`请先补齐属性：${attributeIssues.slice(0, 3).join('；')}`, true); return; }
    clearTimeout(timer.current); setBusy(true);
    const snapshot = clone(value.current);
    try {
      const job = operation.current.catch(() => {}).then(async () => {
        const saved = await request<Asset>('annotation.save', { assetId: asset.id, annotations: snapshot, baseVersion: version.current, confirm });
        version.current = saved.version; lastDraft.current = '';
        setAssets(list => list.map(a => a.id === saved.id ? saved : a));
        onAssetUpdated(saved);
        return saved;
      });
      operation.current = job.then(() => {});
      const saved = await job;
      if (mounted.current) { setAssetStatus(saved.status); setDirty(false); dirtyRef.current = false; setDraftStatus('已保存'); }
      await refreshProjects();
      notify(confirm ? (index >= 0 && assetOffset + index === assetTotal - 1 ? '已确认，当前已是项目最后一张。' : index < 0 ? '已确认并保存单独打开的图片。' : '已确认并保存。') : (isDemo ? '标注已保存在浏览器演示空间。' : '标注已保存。'));
      if (confirm && index >= 0 && assetOffset + index + 1 < assetTotal) await onMove(1);
    } catch (e) { notify(errorMessage(e), true); } finally { if (mounted.current) setBusy(false); }
  }
  const handlers = useRef({ save, undo, deleteFocused, setActiveTool, finishPolygon });
  handlers.current = { save, undo, deleteFocused, setActiveTool, finishPolygon };
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const input = event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable);
      if (input || event.isComposing || document.querySelector('dialog[open]')) return;
      const cmd = event.ctrlKey || event.metaKey;
      if (cmd && event.key.toLowerCase() === 's') { event.preventDefault(); void handlers.current.save(); }
      else if (cmd && event.key.toLowerCase() === 'z') { event.preventDefault(); handlers.current.undo(event.shiftKey); }
      else if (cmd && event.key === 'Enter') { event.preventDefault(); void handlers.current.save(true); }
      else if (event.key === 'Escape') { setPolygon([]); setLocating(null); setVertex(null); setInserting(false); setTool('select'); }
      else if (event.key === 'Enter' && polygon.length) { event.preventDefault(); handlers.current.finishPolygon(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); handlers.current.deleteFocused(); }
      else if (!cmd && !event.altKey) {
        const keys: Record<string, Tool> = { v: 'select', b: 'detect', o: 'obb', s: 'segment', p: 'pose', c: 'classify', h: 'pan' };
        if (keys[event.key.toLowerCase()]) handlers.current.setActiveTool(keys[event.key.toLowerCase()]);
        if (event.key === '+' || event.key === '=') setZoom(v => Math.min(6, v * 1.2));
        if (event.key === '-') setZoom(v => Math.max(0.25, v / 1.2));
      }
    }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [polygon.length]);
  function point(event: React.PointerEvent): Point {
    const bounds = svgRef.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width * asset.width, 0, asset.width), y: clamp((event.clientY - bounds.top) / bounds.height * asset.height, 0, asset.height) };
  }
  function pointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (busy || imageError || event.button !== 0) return;
    const start = point(event); event.currentTarget.focus();
    if (locating) {
      change(annotations.map(a => a.id === locating.id ? { ...a, keypoints: a.keypoints?.map((p,i) => i === locating.index ? { ...p, ...start, visibility: 2 as const } : p) } : a));
      setLocating(null); return;
    }
    if (tool === 'segment') { if (polygon.length >= MAX_POLYGON_POINTS) { notify('已达到 4096 个顶点，请完成当前多边形。'); return; } if (!polygon.length || Math.hypot(start.x - polygon[polygon.length - 1].x, start.y - polygon[polygon.length - 1].y) > 3 / scale) setPolygon(list => [...list, start]); return; }
    event.currentTarget.setPointerCapture(event.pointerId);
    const original = clone(annotations);
    const edge = (event.target as SVGElement).getAttribute('data-segment-edge');
    if (tool === 'select' && inserting && current?.type === 'segment' && current.points && edge !== null) {
      const points = insertPolygonPoint(current.points, Number(edge), start);
      if (points) { updateShape({ points }); setVertex({ id: current.id, index: Number(edge) + 1 }); setInserting(false); }
      else notify('无法在此位置插点；请选择边的内部，最多 4096 个顶点。');
      return;
    }
    const target = (event.target as SVGElement).closest('[data-annotation]');
    if (tool === 'pan') { drag.current = { start, original, client: { x: event.clientX, y: event.clientY }, pan }; return; }
    if (tool === 'select' && target) {
      const id = target.getAttribute('data-annotation')!; setSelected(id);
      const selectedPoint = (event.target as SVGElement).getAttribute('data-point');
      setVertex(selectedPoint !== null && annotations.find(a => a.id === id)?.type === 'segment' ? { id, index: Number(selectedPoint) } : null);
      if (id !== selected) setInserting(false);
      drag.current = { start, original, id, client: start, handle: (event.target as SVGElement).getAttribute('data-handle') ?? undefined, pointIndex: (event.target as SVGElement).hasAttribute('data-point') ? Number((event.target as SVGElement).getAttribute('data-point')) : undefined };
    } else if (tool === 'detect' || tool === 'obb' || tool === 'pose') {
      const creating: Annotation = { id: crypto.randomUUID(), classId, type: tool, bbox: { x: start.x, y: start.y, width: 0, height: 0 }, ...(tool === 'obb' ? { rotation: 0 } : {}) };
      drag.current = { start, original, creating, client: start }; setSelected(creating.id);
    } else { setSelected(null); setVertex(null); setInserting(false); }
  }
  function pointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const state = drag.current; if (!state) return;
    if (state.pan) { setPan({ x: state.pan.x + event.clientX - state.client.x, y: state.pan.y + event.clientY - state.client.y }); return; }
    const p = point(event); let next = clone(state.original);
    if (state.creating) {
      const bbox = { x: Math.min(p.x, state.start.x), y: Math.min(p.y, state.start.y), width: Math.abs(p.x - state.start.x), height: Math.abs(p.y - state.start.y) };
      next.push({ ...state.creating, bbox });
    } else if (state.id) next = next.map(shape => {
      if (shape.id !== state.id) return shape;
      if (state.pointIndex !== undefined) {
        if (shape.keypoints) return { ...shape, keypoints: shape.keypoints.map((item,i) => i === state.pointIndex ? { ...item, ...p } : item) };
        if (shape.points) return { ...shape, points: shape.points.map((item,i) => i === state.pointIndex ? p : item) };
      }
      if (state.handle && shape.bbox) {
        const box = shape.bbox; const x2 = box.x + box.width; const y2 = box.y + box.height;
        const x = state.handle.includes('w') ? Math.min(p.x, x2 - 1) : box.x;
        const y = state.handle.includes('n') ? Math.min(p.y, y2 - 1) : box.y;
        const width = (state.handle.includes('e') ? Math.max(p.x, x + 1) : x2) - x;
        const height = (state.handle.includes('s') ? Math.max(p.y, y + 1) : y2) - y;
        return { ...shape, bbox: { x, y, width, height } };
      }
      const points = [...(shape.points ?? []), ...(shape.keypoints?.filter(p => p.visibility > 0) ?? [])];
      if (shape.bbox) points.push({ x: shape.bbox.x, y: shape.bbox.y }, { x: shape.bbox.x + shape.bbox.width, y: shape.bbox.y + shape.bbox.height });
      if (!points.length) return shape;
      const dx = clamp(p.x - state.start.x, -Math.min(...points.map(pt => pt.x)), asset.width - Math.max(...points.map(pt => pt.x)));
      const dy = clamp(p.y - state.start.y, -Math.min(...points.map(pt => pt.y)), asset.height - Math.max(...points.map(pt => pt.y)));
      return moveShape(shape, dx, dy);
    });
    value.current = next; setAnnotations(next);
  }
  function pointerUp(event: React.PointerEvent<SVGSVGElement>) {
    // 松手位置是本次手势的最终坐标，快速拖动也不能依赖最后一次 move 已到达。
    if (drag.current && !drag.current.pan) pointerMove(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const state = drag.current; drag.current = null; if (!state || state.pan) return;
    let next = value.current;
    if (state.creating) {
      const created = next.find(a => a.id === state.creating!.id);
      if (!created?.bbox || created.bbox.width < 2 || created.bbox.height < 2) { value.current = state.original; setAnnotations(state.original); return; }
      if (created.type === 'pose') {
        // 点名模板不包含位置证据；只有人工定位后才将点标为可见。
        next = next.map(a => a.id === created.id ? { ...a, keypoints: keypointNames.map(name => ({ x: 0, y: 0, name, visibility: 0 as const })) } : a);
        notify('关键点尚未定位，请在右侧逐点选择“在图上定位”。');
      }
      setTool('select');
    }
    if (JSON.stringify(next) !== JSON.stringify(state.original)) {
      history.current.push(state.original); future.current = []; value.current = next; setAnnotations(next); setDirty(true); renderHistory(v => v + 1);
    }
  }
  function updateBox(field: 'x'|'y'|'width'|'height', n: number) {
    if (!current?.bbox || !Number.isFinite(n)) return;
    const b = { ...current.bbox };
    b[field] = Math.round(n * 100) / 100;
    b.x = clamp(b.x, 0, asset.width - 1); b.y = clamp(b.y, 0, asset.height - 1);
    b.width = clamp(b.width, 1, asset.width - b.x); b.height = clamp(b.height, 1, asset.height - b.y);
    updateShape({ bbox: b });
  }
  async function openActions() {
    if (busy || drag.current || polygon.length) { notify('请先完成当前编辑操作，再打开素材操作。'); return; }
    setBusy(true);
    try { await flushDraft(); setMore(true); } catch(e) { notify(errorMessage(e), true); } finally { setBusy(false); }
  }
  function applyAsset(next: Asset) {
    // 抽屉打开前已排空草稿队列；同步清理本地撤销链，避免把导入前的旧草稿重新写回。
    clearTimeout(timer.current); const hasDraft = Boolean(next.draft && (next.metadata?.draftBaseVersion === undefined || next.metadata.draftBaseVersion === next.version));
    const data = clone(hasDraft ? next.draft! : next.annotations);
    version.current = next.version; value.current = data; dirtyRef.current = hasDraft;
    lastDraft.current = hasDraft ? JSON.stringify(data) : ''; history.current = []; future.current = [];
    setAnnotations(data); setSelected(data[0]?.id ?? null); setVertex(null); setInserting(false); setDirty(hasDraft); setDraftStatus(hasDraft ? '已恢复草稿' : '已保存');
    setAssetStatus(next.status); setDraftConflict(Boolean(next.draft && !hasDraft)); setImageError(false); setHidden(new Set());
    setAssets(list => list.map(a => a.id === next.id ? next : a));
    onAssetUpdated(next);
  }
  return <>
    {more && <AssetActions asset={asset} onClose={() => setMore(false)} onApplied={applyAsset} onUseVersion={data => { change(data); setSelected(data[0]?.id ?? null); setHidden(new Set()); }} />}
    <div className="editor-actionbar"><div className="editor-state"><span className={`tiny-badge ${assetStatus === 'confirmed' ? 'good' : ''}`}>{statusNames[assetStatus]}</span><span className={draftStatus.includes('失败') ? 'text-error' : 'muted'}>{dirty ? draftStatus : `版本 ${version.current} · 已保存`}</span>{isDemo && <span className="demo-caption">合成样例 / 浏览器演示</span>}</div><div className="actions"><IconButton label="更多素材操作" disabled={busy} onClick={() => void openActions()}><Ellipsis size={17} /></IconButton><Button disabled={!history.current.length || busy} onClick={() => undo()}><Undo2 size={14} />撤销</Button><Button busy={busy} onClick={() => void save()}><Save size={14} />保存</Button><Button busy={busy} className="primary" onClick={() => void save(true)}>确认并下一张<ChevronRight size={14} /></Button></div></div>
    {draftConflict && <Notice>发现基于旧版本的草稿。当前显示正式版本。<button className="text-button" onClick={() => { change(clone(asset.draft!)); setDraftConflict(false); notify('旧草稿已载入编辑区，请人工核对后保存。'); }}>载入旧草稿并核对</button></Notice>}
    <div className="editor-grid"><div className="editor-main"><div className="canvas-row"><div className="canvas-tools">{toolItems.map(([key,label,Icon]) => <IconButton key={key} label={label} active={tool === key} disabled={busy || (key !== 'select' && key !== 'pan' && key !== project!.taskType)} onClick={() => setActiveTool(key)}><Icon size={19} strokeWidth={1.65} /></IconButton>)}<span className="tool-divider" /><IconButton label="放大" onClick={() => setZoom(v => Math.min(6, v * 1.2))}><ZoomIn size={18} /></IconButton><IconButton label="缩小" onClick={() => setZoom(v => Math.max(0.25, v / 1.2))}><ZoomOut size={18} /></IconButton><IconButton label="适应画布" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize size={17} /></IconButton><IconButton label="重做" disabled={!future.current.length || busy} onClick={() => undo(true)}><Redo2 size={17} /></IconButton></div>
      <div className={`canvas-viewport tool-${tool}`} ref={viewport} style={{ background: prefs.canvasBackground }} onWheel={e => { if (e.ctrlKey) { e.preventDefault(); setZoom(v => clamp(v * (e.deltaY > 0 ? 0.9 : 1.1), 0.25, 6)); } }}>
        {imageError && <div className="image-failure"><FolderOpen size={24} /><p>图片无法读取，请检查文件或引擎连接。</p></div>}
        <svg ref={svgRef} className="annotation-canvas" aria-label="图片标注画布" role="application" tabIndex={0} width={asset.width} height={asset.height} viewBox={`0 0 ${asset.width} ${asset.height}`} style={{ transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`, visibility: imageError ? 'hidden' : 'visible' }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { if (drag.current) { setAnnotations(drag.current.original); value.current = drag.current.original; drag.current = null; } }} onDoubleClick={() => { if (tool === 'segment') finishPolygon(); }}>
          <image href={asset.mediaUrl} width={asset.width} height={asset.height} onError={() => setImageError(true)} />
          {annotations.map((shape, i) => {
            if (hidden.has(shape.id)) return null;
            const label = project!.classes.find(c => c.id === shape.classId); const color = label?.color ?? '#4a83ff'; const active = shape.id === selected; const b = shape.bbox;
            return <g key={shape.id} data-annotation={shape.id} className="annotation-shape" style={{ color }}>
              {b && <g transform={shape.type === 'obb' ? `rotate(${shape.rotation ?? 0},${b.x + b.width/2},${b.y + b.height/2})` : undefined}><rect x={b.x} y={b.y} width={b.width} height={b.height} fill={active ? `${color}13` : 'transparent'} stroke={color} strokeWidth={(active ? 1.8 : 1.3) / scale} /><rect x={b.x} y={Math.max(0, b.y - 21 / scale)} width={(label?.name.length ?? 2) * 12 / scale + 14 / scale} height={21 / scale} rx={2 / scale} fill={color} /><text x={b.x + 7 / scale} y={Math.max(0,b.y - 21/scale) + 14 / scale} fontSize={11 / scale} fill="white">{label?.name ?? '类别缺失'}</text>{active && shape.type !== 'obb' && [['nw',b.x,b.y],['ne',b.x+b.width,b.y],['sw',b.x,b.y+b.height],['se',b.x+b.width,b.y+b.height]].map(([key,x,y]) => <rect key={key} data-handle={key} x={Number(x)-3/scale} y={Number(y)-3/scale} width={6/scale} height={6/scale} fill="white" stroke={color} strokeWidth={1/scale} />)}</g>}
              {shape.points && <><polygon points={shape.points.map(p => `${p.x},${p.y}`).join(' ')} fill={`${color}22`} stroke={color} strokeWidth={1.8/scale} />{active && shape.type === 'segment' && inserting && shape.points.map((p,j) => <line key={`edge-${j}`} data-segment-edge={j} x1={p.x} y1={p.y} x2={shape.points![(j+1)%shape.points!.length].x} y2={shape.points![(j+1)%shape.points!.length].y} stroke="transparent" strokeWidth={14/scale} className="segment-insert-edge"/>)}{active && shape.points.map((p,j) => <circle key={j} data-point={j} data-selected-vertex={vertex?.id===shape.id&&vertex.index===j?true:undefined} cx={p.x} cy={p.y} r={(vertex?.id===shape.id&&vertex.index===j?5:4)/scale} fill={vertex?.id===shape.id&&vertex.index===j?color:'white'} stroke={color} strokeWidth={1.2/scale} />)}</>}
              {shape.keypoints && <>{keypointEdges(shape.keypoints, project?.settings.keypointConnections).map(([from, to], edge) => <line key={edge} data-keypoint-edge x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={1/scale}/>)}{shape.keypoints.map((p,j) => p.visibility > 0 && <g key={j}><circle data-point={j} cx={p.x} cy={p.y} r={5/scale} fill={p.visibility === 2 ? color : 'white'} stroke={color} strokeWidth={1.5/scale} opacity={p.visibility === 0 ? .4 : 1} /><text x={p.x+8/scale} y={p.y-7/scale} fontSize={10/scale} paintOrder="stroke" stroke="#fff" strokeWidth={2/scale} fill={color}>{j+1}</text></g>)}</>}
              {shape.type === 'classify' && <g transform={`translate(${12/scale},${(12+i*30)/scale})`}><rect width={130/scale} height={25/scale} rx={5/scale} fill={color} /><text x={9/scale} y={17/scale} fill="white" fontSize={12/scale}>{label?.name} · 图片分类</text></g>}
            </g>;
          })}
          {polygon.length > 0 && <g><polyline points={polygon.map(p => `${p.x},${p.y}`).join(' ')} fill="#4a83ff22" stroke="#4a83ff" strokeWidth={1.5/scale} />{polygon.map((p,i) => <circle key={i} cx={p.x} cy={p.y} r={4/scale} fill="#4a83ff" />)}</g>}
        </svg>
        <div className="canvas-caption">{inserting ? '点击选中多边形的边插入顶点 · Esc 取消' : vertex && current?.id === vertex.id ? `已选择顶点 ${vertex.index + 1} · Delete 删除顶点 · Esc 取消选择` : locating ? `点击图片定位 ${annotations.find(a => a.id === locating.id)?.keypoints?.[locating.index]?.name ?? '关键点'} · Esc 取消` : tool === 'segment' ? `${polygon.length} 个点 · Enter 完成，Esc 取消` : tool === 'pan' ? '拖动画面平移' : tool === 'select' ? '选择并拖动对象或控制点' : tool === 'classify' ? '在右侧选择图片类别' : '按住并拖动，创建标注'}<span>{Math.round(zoom*100)}%</span></div>
      </div></div>
      <div className="filmstrip"><IconButton label="上一张图片" disabled={index < 0 || assetOffset + index < 1 || busy} onClick={() => void onMove(-1)}><ChevronLeft size={16} /></IconButton><div className="filmstrip-items">{assets.map(a => <div className="thumbnail-item" key={a.id}><button className={`thumbnail ${a.id === asset.id ? 'selected' : ''}`} disabled={busy} title={`${a.name} · ${statusNames[a.status]}`} aria-label={`打开图片 ${a.name}`} onClick={() => void onSelect(a.id)}><img loading="lazy" src={a.thumbnailUrl || a.mediaUrl} alt={a.name} /><span>{a.name}</span>{a.status === 'confirmed' && <Check className="thumb-confirmed" size={13} />}</button><input type="checkbox" aria-label={`勾选图片 ${a.name}`} disabled={busy} checked={selectedAssetIds.includes(a.id)} onChange={e => setSelectedAssetIds(ids => e.target.checked ? [...new Set([...ids, a.id])] : ids.filter(id => id !== a.id))}/></div>)}</div><span className="muted nowrap">{index < 0 ? '单图定位' : `${assetOffset + index + 1} / ${assetTotal}`}</span><IconButton label="下一张图片" disabled={index < 0 || assetOffset + index >= assetTotal - 1 || busy} onClick={() => void onMove(1)}><ChevronRight size={16} /></IconButton></div>
    </div>
    <aside className="inspector"><div className="tabs"><button className={tab === 'objects' ? 'selected' : ''} onClick={() => setTab('objects')}>对象 <span>{annotations.length}</span></button><button className={tab === 'assistant' ? 'selected' : ''} onClick={() => setTab('assistant')}>助手</button></div>
      {tab === 'assistant' ? <ChatPanel assetId={asset.id} /> : <><div className="inspector-scroll"><div className="object-list">{annotations.length ? annotations.map((shape,i) => <div className={`object-row ${shape.id === selected ? 'selected' : ''}`} key={shape.id}><button className="object-select" onClick={() => { setSelected(shape.id); setVertex(null); setInserting(false); setClassId(shape.classId); setTool('select'); }}><span className="object-index">{i+1}</span><span className="class-dot" style={{ background: project!.classes.find(c => c.id === shape.classId)?.color }} /><span>{project!.classes.find(c => c.id === shape.classId)?.name ?? '类别缺失'}</span><small>{shape.type.toUpperCase()}</small></button><IconButton label={hidden.has(shape.id) ? '显示对象' : '隐藏对象'} onClick={() => setHidden(values => { const next = new Set(values); next.has(shape.id) ? next.delete(shape.id) : next.add(shape.id); return next; })}>{hidden.has(shape.id) ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></div>) : <p className="quiet-empty">还没有标注对象<br />选择左侧工具开始绘制</p>}</div>
        <section className="inspector-section"><div className="section-toolbar"><h3>{current ? '对象属性' : '绘制属性'}</h3>{current && <IconButton label="删除选中对象" disabled={busy} onClick={deleteSelected}><Trash2 size={14} /></IconButton>}</div>
          <Field label="类别"><select value={current?.classId ?? classId} disabled={busy} onChange={e => { setClassId(e.target.value); if (current) updateShape({ classId: e.target.value }); }}>{project!.classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          {current?.bbox && <div className="geometry-fields">{(['x','y','width','height'] as const).map((key,i) => <Field key={key} label={['X','Y','宽度','高度'][i]}><input type="number" aria-label={`对象${key}`} disabled={busy} min={0} step={1} value={Math.round(current.bbox![key] * 100)/100} onChange={e => updateBox(key, Number(e.target.value))} /></Field>)}</div>}
          {current?.type === 'obb' && <Field label="旋转角度"><div className="input-suffix"><input aria-label="旋转角度" type="number" min={-180} max={180} value={current.rotation ?? 0} onChange={e => updateShape({ rotation: clamp(Number(e.target.value),-180,180) })} /><span>°</span></div></Field>}
          {current && <AttributeValues definition={project!.settings.attributes} value={current.attributes} disabled={busy} onChange={attributes => updateShape({ attributes })}/>}
          {current && !attributeDefinitions(project!.settings.attributes)?.definitions.some(d => d.id === 'note') && <Field label="备注"><textarea rows={2} value={String(current.attributes?.note ?? '')} onChange={e => updateShape({ attributes: { ...current.attributes, note: e.target.value } })} placeholder="记录遮挡、模糊或特殊情况" /></Field>}
          {current?.type === 'segment' && current.points && <div className="segment-controls"><p>轮廓点 · {current.points.length} / 4096</p><div className="actions"><Button disabled={busy || current.points.length >= MAX_POLYGON_POINTS} aria-pressed={inserting} onClick={() => { setInserting(v => !v); setVertex(null); setTool('select'); }}>在边上插点</Button><Button disabled={busy || vertex?.id !== current.id || current.points.length <= 3} onClick={deleteVertex}>删除选中顶点</Button></div><p className="muted tiny">选择顶点后 Delete 删点；上方垃圾桶删除整个对象。</p></div>}
          {current?.points && <details className="point-fields"><summary>顶点坐标 · {current.points.length}</summary>{current.points.map((p,i) => <div className="point-row" key={i}><button className="text-button" aria-label={`选择顶点${i+1}`} aria-pressed={vertex?.id===current.id&&vertex.index===i} onClick={() => { setVertex({id:current.id,index:i}); setInserting(false); setTool('select'); }}>{i+1}</button>{(['x','y'] as const).map(key => <input key={key} aria-label={`轮廓点${i+1}${key}`} type="number" value={Math.round(p[key])} onChange={e => updateShape({ points: current.points!.map((pt,j) => i === j ? { ...pt, [key]: clamp(Number(e.target.value),0,key==='x'?asset.width:asset.height) } : pt) })} />)}</div>)}</details>}
          {current?.keypoints && <div className="point-fields"><h4>关键点与可见性</h4>{current.keypoints.map((p,i) => <div className="keypoint-field" key={i}><label>{i+1}. {p.name}<select aria-label={`${p.name}可见性`} value={p.visibility} onChange={e => updateShape({ keypoints: current.keypoints!.map((pt,j) => i === j ? { ...pt, visibility: Number(e.target.value) as 0|1|2 } : pt) })}><option value={2}>可见</option><option value={1}>遮挡可定位</option><option value={0}>不可定位</option></select></label><Button disabled={busy} aria-label={`定位${p.name}`} onClick={() => { setTool('select'); setLocating({id:current.id,index:i}); }}>在图上定位</Button><div className="point-row">{(['x','y'] as const).map(key => <input key={key} aria-label={`${p.name}${key}`} type="number" value={Math.round(p[key])} onChange={e => updateShape({ keypoints: current.keypoints!.map((pt,j) => i === j ? { ...pt, [key]: clamp(Number(e.target.value),0,key==='x'?asset.width:asset.height) } : pt) })} />)}</div></div>)}</div>}
        <TemplateRuleSummary settings={project!.settings}/></section>
        <div className="asset-metadata"><span>{asset.width} × {asset.height} px</span><span>{asset.source === 'manual' ? '人工编辑' : asset.source === 'import' ? '导入素材' : asset.source}</span></div>
      </div><div className="inspector-composer"><ChatPanel compact assetId={asset.id} /></div></>}
    </aside></div>
    <footer className="editor-footer"><span><kbd>V</kbd> 选择 <kbd>B</kbd> 检测框 <kbd>Ctrl + S</kbd> 保存</span><button className="text-button" onClick={() => void flushDraft().then(onExport).catch(e => notify(errorMessage(e), true))}><Download size={12} />导出数据集</button></footer>
  </>;
}

