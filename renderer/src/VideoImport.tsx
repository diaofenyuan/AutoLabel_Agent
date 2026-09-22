import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { VIDEO_DENSITY_LABELS, VIDEO_DENSITY_SECONDS, VIDEO_SCENE_MIN_INTERVAL_SECONDS, VIDEO_SCENE_THRESHOLD, type MediaJob, type VideoCreateRequest, type VideoDensity, type VideoExtractionParameters, type VideoExtractionRecipe, type VideoInspection, type VideoRecipeDraft, type VideoTimeRange } from '../../shared/media';
import { getBridge, request, errorMessage, isDemo } from './bridge';
import { useApp } from './context';
import { Button, Field, IconButton, Modal, Notice } from './ui';
import { MediaError } from './mediaUi';
import { FrameAutoImportOption } from './FrameJobStrip';

/**
 * 默认降采样阈值与目标长边。
 * 走查的对照测试证明体积不是超时的主因（4 MiB 与 100 KB 的失败率都约 70%），
 * 但它确实是放大项：先按住最容易放大问题的那个因素，同时不把「降采样」当成重试出口的替代品。
 */
const DOWNSAMPLE_THRESHOLD = 1600;
const DOWNSAMPLE_LONG_EDGE = 1024;
import type { MediaErrorActionHandlers } from './mediaErrorMap';
import { listRecipes, recipeScopeNote, recipeSummary, removeRecipe, saveRecipe } from './videoRecipes';

/** 引擎单次抽帧上限，与 VideoFrames.java 的 maxFrames 默认值一致；超过就整单失败，所以在 UI 侧提前拦截。 */
const MAX_FRAMES = 10000;

/** 源帧率可能是 "30000/1001" 这样的分数；估帧数时才需要，解析不出来就如实返回未知。 */
function parseRate(reported: string | null | undefined): number | null {
  if (!reported) return null;
  const [numerator, denominator] = reported.split('/').map(Number);
  if (!Number.isFinite(numerator)) return null;
  const divisor = denominator === undefined ? 1 : denominator;
  if (!Number.isFinite(divisor) || divisor === 0) return null;
  return numerator / divisor;
}

function durationLabel(duration: number | null) { return duration === null ? '时长未知' : `${duration.toFixed(2)} 秒`; }

/** 转码兜底用：把几何与色彩恒定的副本交给引擎，绕开「不猜测」的严格校验；命令同时可复制到终端执行。 */
function transcodeCommand(sourcePath: string, targetPath: string) {
  return `ffmpeg -y -i "${sourcePath}" -map 0:v:0 -c:v libx264 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1" -an -sn "${targetPath}"`;
}

export default function VideoImport({ projectId, initialSourcePath, onClose, onCreated }: {
  projectId: string; initialSourcePath?: string; onClose: () => void; onCreated: (job: MediaJob, temporarySource?: string) => void;
}) {
  const { notify, project, navigate } = useApp();
  const [sourcePath, setSourcePath] = useState(initialSourcePath ?? ''), [inspection, setInspection] = useState<VideoInspection | null>(null), [error, setError] = useState('');
  const [inspecting, setInspecting] = useState(false), [busy, setBusy] = useState(false);
  const [transcodePath, setTranscodePath] = useState(''), [transcoding, setTranscoding] = useState(false), [elapsed, setElapsed] = useState(0);
  const [density, setDensity] = useState<VideoDensity>('scene'), [customMode, setCustomMode] = useState<'interval' | 'every_n' | 'fps'>('interval'), [customValue, setCustomValue] = useState('1');
  const [recipes, setRecipes] = useState<VideoExtractionRecipe[]>([]), [recipeId, setRecipeId] = useState(''), [recipeNotice, setRecipeNotice] = useState('');
  const [savingRecipe, setSavingRecipe] = useState(false), [recipeName, setRecipeName] = useState(''), [recipeBusy, setRecipeBusy] = useState(false);
  /**
   * 配方从引擎读取：它是跟着数据目录走的长期资产，不放在界面本地存储里，因此换数据目录、迁移机器或
   * 从备份恢复后都还在。读取失败只意味着这次没有可套用的配方，不该影响手动抽帧，所以静默忽略。
   */
  useEffect(() => {
    let live = true;
    void listRecipes().then(items => { if (live) setRecipes(items); }).catch(() => { /* 无配方时按默认参数手动抽帧。 */ });
    return () => { live = false; };
  }, []);
  // 拖入视频时直接把路径带进来并立即检查，省掉「再点一次选择文件」。
  useEffect(() => { if (initialSourcePath) void inspect(initialSourcePath); }, [initialSourcePath]);
  const [advanced, setAdvanced] = useState(false), [command, setCommand] = useState('');
  const [whole, setWhole] = useState(true), [ranges, setRanges] = useState<VideoTimeRange[]>([{ start: 0, end: 1 }]);
  const [resize, setResize] = useState(false), [width, setWidth] = useState('640'), [height, setHeight] = useState('640'), [fit, setFit] = useState<'contain' | 'stretch'>('contain');
  /** 尺寸被用户显式改过之后就不再自动降采样：默认值可以猜，用户的选择不能覆盖。 */
  const sizeTouched = useRef(false);
  const [downsampled, setDownsampled] = useState(false);
  const [format, setFormat] = useState<'png' | 'jpg'>('png'), [quality, setQuality] = useState('3');
  const duration = inspection?.durationSeconds ?? null;
  const durationUnknown = inspection !== null && duration === null;
  /**
   * 参数变化即清掉上一次的错误，同时取消配方选中：用户手动改过选项后，下拉框不该继续宣称
   * 「当前套用的是某某配方」。套用配方自身会一次性写入全部字段，用 ref 跳过这一次重置。
   */
  const applyingRecipe = useRef(false);
  useEffect(() => {
    setError('');
    if (applyingRecipe.current) { applyingRecipe.current = false; return; }
    setRecipeId(''); setRecipeNotice('');
  }, [density, customMode, customValue, whole, ranges, resize, width, height, fit, format, quality]);
  /** 转码副本只在弹窗存活期间有效：换源或放弃时立即删除，只有真正创建了抽帧任务的那份留给任务卡回收。 */
  async function discardTemporary(path: string) {
    try { await (await getBridge()).discardTranscode({ path }); }
    catch { /* 清理失败不影响继续标注，应用启动时还会统一清扫临时目录。 */ }
  }
  const created = useRef(false), pending = useRef('');
  pending.current = transcodePath;
  useEffect(() => () => { if (!created.current && pending.current) void discardTemporary(pending.current); }, []);
  useEffect(() => {
    if (!transcoding) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [transcoding]);
  async function choose() {
    setInspecting(true); setError('');
    try {
      const paths = await (await getBridge()).chooseFiles({ kind: 'video' });
      if (!paths[0]) return;
      // 只有确实选中了新文件才丢弃旧副本：用户取消选择器时，当前来源必须保持可用。
      const previous = transcodePath;
      setTranscodePath(''); pending.current = '';
      if (previous) void discardTemporary(previous);
      setSourcePath(paths[0]); setInspection(null);
      await inspect(paths[0]);
    } catch (e) { setError(errorMessage(e)); } finally { setInspecting(false); }
  }
  /** 选择与检查合成一步：用户选完文件即自动探测，不再有「尚未完成检查」的中间态。 */
  async function inspect(path: string) {
    if (!path) return;
    setInspecting(true); setError('');
    try {
      const info = await request<VideoInspection>('media.video.inspect', { sourcePath: path });
      setInspection(info);
      setWhole(info.durationSeconds !== null);
      setRanges([{ start: 0, end: info.durationSeconds ?? 0 }]);
      // 时长未知时引擎必须拿到明确范围，直接展开高级区，不让用户自己去翻。
      setAdvanced(info.durationSeconds === null);
      // 4K 原帧送模型会显著抬高超时概率（走查里 23 帧有 16 帧超时）。这里默认把长边压到 1024，
      // 保持宽高比所以不会留黑边；用户改过尺寸或套过配方时不覆盖他的选择。
      const longEdge = Math.max(info.width, info.height);
      if (!sizeTouched.current && longEdge > DOWNSAMPLE_THRESHOLD && info.width > 0 && info.height > 0) {
        const scale = DOWNSAMPLE_LONG_EDGE / longEdge;
        setResize(true); setFit('contain');
        setWidth(String(Math.max(1, Math.round(info.width * scale))));
        setHeight(String(Math.max(1, Math.round(info.height * scale))));
        setDownsampled(true);
      }
    } catch (e) { setInspection(null); setError(errorMessage(e)); } finally { setInspecting(false); }
  }
  const mode = density === 'custom' ? customMode : density === 'scene' ? 'scene' : 'interval';
  const sampling = density === 'custom' ? customValue : density === 'scene' ? '' : String(VIDEO_DENSITY_SECONDS[density as Exclude<VideoDensity, 'custom' | 'scene'>]);
  /** 估算帧数取区间上界，宁可高估也不放过超限。 */
  function estimateFrames(): number | null {
    if (mode === 'scene') return null;
    if (duration === null) return null;
    const value = Number(sampling);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (mode === 'interval') return Math.ceil(duration / value);
    if (mode === 'fps') return Math.ceil(duration * value);
    const fps = parseRate(inspection?.reportedFrameRate);
    return fps === null ? null : Math.ceil(duration * fps / value);
  }
  /** 超限时给出一个必定跑得完的间隔秒数，把「失败」变成「点一下就好」。 */
  function suggestedSeconds(): number | null {
    if (duration === null || duration <= 0) return null;
    const estimatedFrames = estimateFrames();
    if (estimatedFrames === null || estimatedFrames <= MAX_FRAMES) return null;
    return Math.max(1, Math.ceil(duration / MAX_FRAMES));
  }
  const estimated = estimateFrames(), suggested = suggestedSeconds();
  function applySuggestion() {
    if (suggested === null) return;
    if (suggested <= VIDEO_DENSITY_SECONDS.dense) setDensity('dense');
    else if (suggested <= VIDEO_DENSITY_SECONDS.standard) setDensity('standard');
    else if (suggested <= VIDEO_DENSITY_SECONDS.sparse) setDensity('sparse');
    else { setDensity('custom'); setCustomMode('interval'); setCustomValue(String(suggested)); }
  }
  function parameters(): VideoExtractionParameters {
    if (!inspection) throw new Error('请先选择并成功检查视频。');
    const selectedRanges = whole && inspection.durationSeconds !== null ? [{ start: 0, end: inspection.durationSeconds }] : ranges;
    if (!selectedRanges.length || selectedRanges.length > 32 || selectedRanges.some((r, i) => !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end > 604800 || r.end <= r.start || (inspection.durationSeconds !== null && r.end > inspection.durationSeconds) || (i > 0 && r.start < selectedRanges[i - 1].end))) throw new Error('时间段需按先后顺序填写：起点非负、终点大于起点、范围互不重叠，且不超过已知视频时长。');
    const value = Number(sampling); if (mode !== 'scene' && (!Number.isFinite(value) || (mode === 'every_n' ? !Number.isSafeInteger(value) || value < 1 || value > 1000000 : value < .001 || value > (mode === 'fps' ? 240 : 604800)))) throw new Error('间隔范围为 0.001～604800 秒；源帧间隔为 1～1000000 整数；目标帧率为 0.001～240。');
    const size = { width: Number(width), height: Number(height), fit };
    if (resize && (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 20000 || size.height > 20000 || size.width * size.height > 40000000)) throw new Error('输出宽高需为 1～20000 的整数，且不超过 4000 万像素。');
    const jpegQuality = Number(quality); if (format === 'jpg' && (!Number.isInteger(jpegQuality) || jpegQuality < 2 || jpegQuality > 31)) throw new Error('JPEG 质量参数需为 2～31 的整数。');
    return { ranges: selectedRanges, streamIndex: inspection.streamIndex, ...(resize ? { outputSize: size } : {}), format, ...(format === 'jpg' ? { jpegQuality } : {}), ...(mode === 'scene' ? { mode: 'scene' as const, sceneThreshold: VIDEO_SCENE_THRESHOLD, minIntervalSeconds: VIDEO_SCENE_MIN_INTERVAL_SECONDS } : mode === 'interval' ? { mode, intervalSeconds: value } : mode === 'every_n' ? { mode, everyNFrames: value } : { mode, targetFps: value }) };
  }
  async function create() { setBusy(true); setError(''); try { const payload: VideoCreateRequest = { projectId, sourcePath, expectedSourceHash: inspection!.sourceHash, parameters: parameters() }; const job = await request<MediaJob>('media.video.create', { ...payload }); created.current = true; onCreated(job, transcodePath || undefined); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  /**
   * 一键转码：把硬阻断变成两步可走通。转码产物交给引擎前先回到同一条检查链路，
   * 用户仍然看到真实的时长、分辨率与预估帧数，而不是「转完就直接跑」。
   */
  async function transcode() {
    if (!sourcePath) return;
    setTranscoding(true); setError('');
    const previous = transcodePath;
    try {
      const result = await (await getBridge()).transcodeVideo({ sourcePath });
      if (previous) void discardTemporary(previous);
      setTranscodePath(result.path); setSourcePath(result.path);
      await inspect(result.path);
    } catch (e) { setError(errorMessage(e)); } finally { setTranscoding(false); }
  }
  const text = transcodeCommand(sourcePath, '<输出路径>.mp4');
  async function copyTranscodeCommand() {
    try { await navigator.clipboard.writeText(text); notify('已复制转码命令，可在本机终端执行后重新选择转码后的文件。'); }
    catch { setCommand(text); notify('无法访问剪贴板，命令已显示在弹窗内，可手动复制。'); }
  }
  const available = recipes;
  /**
   * 当前表单对应的配方草案。表单里的数值始终是字符串（避免输入过程中被改写），只在交给引擎时转成数字；
   * 顺带把当前项目的任务类型与类别集记进配方，套用时才能核对「这条配方是不是为这类标注准备的」。
   */
  function recipeDraft(name: string, id?: string): VideoRecipeDraft | null {
    const custom = Number(customValue), widthValue = Number(width), heightValue = Number(height), qualityValue = Number(quality);
    if (!Number.isFinite(custom) || custom <= 0) return null;
    if (!Number.isInteger(widthValue) || !Number.isInteger(heightValue) || !Number.isInteger(qualityValue)) return null;
    return { ...(id ? { id } : {}), name, density, customMode, customValue: custom, resize, width: widthValue, height: heightValue, fit, format, quality: qualityValue,
      taskType: project?.taskType ?? null, classNames: project ? project.classes.map(item => item.name) : [], note: '' };
  }
  function applyRecipe(recipe: VideoExtractionRecipe) {
    applyingRecipe.current = true;
    setDensity(recipe.density); setCustomMode(recipe.customMode); setCustomValue(String(recipe.customValue));
    sizeTouched.current = true; setDownsampled(false);
    setResize(recipe.resize); setWidth(String(recipe.width)); setHeight(String(recipe.height)); setFit(recipe.fit);
    setFormat(recipe.format); setQuality(String(recipe.quality));
    setRecipeId(recipe.id);
    // 配方自带的说明（内置推荐配方都有）跟着一起给出，用户才知道这条推荐为什么这样配。
    setRecipeNotice([`已套用「${recipe.name}」：${recipeSummary(recipe)}`, recipe.note, recipeScopeNote(recipe, project)].filter(Boolean).join(' '));
    setError('');
  }
  /** 同名视为更新而非新增：这条规则在引擎侧落地，反复保存不会攒出一串无法区分的同名项。 */
  async function commitRecipe() {
    const name = recipeName.trim();
    if (!name) { notify('请先填写配方名称。', true); return; }
    const draft = recipeDraft(name);
    if (!draft) { notify('请先填写合法的采样值与输出尺寸，再保存配方。', true); return; }
    setRecipeBusy(true);
    try {
      const saved = await saveRecipe(draft);
      setRecipes(await listRecipes());
      setRecipeId(saved.id); setRecipeNotice(`已保存配方「${name}」：${recipeSummary(saved)}`);
      setSavingRecipe(false); setRecipeName('');
      notify(`配方「${name}」已保存在数据目录中，之后可在任意项目里套用。`);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setRecipeBusy(false); }
  }
  async function dropRecipe(id: string) {
    setRecipeBusy(true);
    try {
      await removeRecipe(id);
      setRecipes(await listRecipes());
      if (recipeId === id) { setRecipeId(''); setRecipeNotice(''); }
      notify('配方已删除。');
    } catch (e) { notify(errorMessage(e), true); }
    finally { setRecipeBusy(false); }
  }
  /** 只挂当前确实兑现得了的动作，缺 handler 的动作不会渲染成死按钮。 */
  const errorHandlers: MediaErrorActionHandlers = {
    reselect: () => void choose(),
    retry: () => void inspect(sourcePath),
    // 未配置 FFmpeg 时给出直达设置页的出口，用户不必自己猜「媒体运行时」在设置的哪一层。
    openMediaRuntime: () => void navigate('settings', 'media'),
    ...(suggested !== null ? { reduceDensity: applySuggestion } : {}),
    ...(sourcePath ? { copyCommand: () => void copyTranscodeCommand(), transcode: () => void transcode() } : {})
  };
  const fileName = sourcePath ? sourcePath.split(/[\\/]/).pop() : '';
  const blocked = busy || inspecting || transcoding || recipeBusy;
  return <Modal title="从视频抽取素材" onClose={() => { if (!blocked) onClose(); }}><div className="form-stack video-import">
    {!inspection
      ? <div className="video-start">
        <p className="video-start-lead">选择一段本机视频，抽帧后即可开始标注。</p>
        <Button className="primary" busy={inspecting} disabled={isDemo || transcoding} onClick={() => void choose()}><FolderOpen size={15} />{sourcePath ? '重新选择视频' : '选择视频'}</Button>
        <p className="muted tiny">默认按「场景变化」抽帧：每 1 秒取一个候选帧，与上一张保留帧相比画面变化明显才留下，相近的帧自动跳过，输出 PNG；采样密度与输出尺寸可在选择后调整。</p>
        {sourcePath && <p className="muted tiny">已选择：{fileName}（尚未通过检查）</p>}
      </div>
      : <>
        <div className="video-inspection"><div className="video-inspection-head"><strong title={sourcePath}>{inspection.sourceName}</strong><button className="text-button" onClick={() => void choose()} disabled={blocked}>重新选择</button></div><p>{inspection.width} × {inspection.height} · {durationLabel(duration)}</p><p className="muted tiny">报告帧率：{inspection.reportedFrameRate ?? '未知'} · 报告帧数：{inspection.reportedFrameCount ?? '未知'}</p>{transcodePath && <p className="muted tiny">来源为本机转码副本（临时文件，导入素材后自动删除）。</p>}</div>
        {inspection.geometryNotice && <Notice>{inspection.geometryNotice}</Notice>}
        {downsampled && <Notice>源视频长边 {Math.max(inspection.width, inspection.height)} 像素，已默认把输出缩到长边 {DOWNSAMPLE_LONG_EDGE} 像素（保持宽高比）：原尺寸送模型会明显更容易超时。需要全分辨率时在下面取消「指定输出尺寸」。</Notice>}
        <div className="video-recipe"><Field label="抽帧配方"><select aria-label="抽帧配方" disabled={blocked} value={recipeId} onChange={e => { const picked = available.find(item => item.id === e.target.value); if (picked) applyRecipe(picked); else { setRecipeId(''); setRecipeNotice(''); } }}><option value="">自定义（不使用配方）</option><optgroup label="推荐配方">{available.filter(item => item.builtin).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>{available.some(item => !item.builtin) && <optgroup label="我的配方">{available.filter(item => !item.builtin).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}</select></Field><div className="video-recipe-actions"><Button disabled={blocked} onClick={() => { setSavingRecipe(true); setRecipeName(''); }}>保存当前为配方</Button>{available.some(item => item.id === recipeId && !item.builtin) && <Button disabled={blocked} onClick={() => void dropRecipe(recipeId)}>删除配方</Button>}</div></div>
        {savingRecipe && <div className="video-recipe-save"><input aria-label="配方名称" maxLength={40} placeholder="例如：园区监控夜间" disabled={blocked} value={recipeName} onChange={e => setRecipeName(e.target.value)} /><Button className="primary" busy={recipeBusy} disabled={blocked} onClick={() => void commitRecipe()}>保存</Button><Button disabled={blocked} onClick={() => { setSavingRecipe(false); setRecipeName(''); }}>取消</Button></div>}
        {recipeNotice && <p className="muted tiny">{recipeNotice}</p>}
        <div className="field-grid">
          <Field label="采样密度"><select aria-label="视频采样密度" disabled={busy} value={density} onChange={e => setDensity(e.target.value as VideoDensity)}>{(Object.keys(VIDEO_DENSITY_LABELS) as VideoDensity[]).map(key => <option key={key} value={key}>{VIDEO_DENSITY_LABELS[key]}</option>)}</select></Field>
          {density === 'custom' && <Field label="采样方式"><select aria-label="视频采样方式" disabled={busy} value={customMode} onChange={e => { setCustomMode(e.target.value as typeof customMode); setCustomValue(e.target.value === 'every_n' ? '10' : '1'); }}><option value="interval">每隔指定秒数</option><option value="every_n">每 N 个源帧</option><option value="fps">按目标帧率</option></select></Field>}
        </div>
        {density === 'custom' && <Field label={customMode === 'interval' ? '间隔（秒）' : customMode === 'every_n' ? '源帧间隔 N' : '目标帧率（帧/秒）'}><input aria-label="视频采样值" type="number" min={customMode === 'every_n' ? 1 : 0.001} step={customMode === 'every_n' ? 1 : 'any'} disabled={busy} value={customValue} onChange={e => setCustomValue(e.target.value)} /></Field>}
        {mode === 'scene'
          ? <p className="muted tiny">「场景变化」每 {VIDEO_SCENE_MIN_INTERVAL_SECONDS} 秒取一个候选帧，与上一张保留帧相比灰度差异达到 {VIDEO_SCENE_THRESHOLD} 才留下（首帧必留）；相近的帧自动跳过，实际帧数取决于画面变化（上限 {MAX_FRAMES} 帧）。</p>
          : estimated !== null && <p className="muted tiny">按当前密度预计抽出约 {estimated} 帧{duration !== null && `，视频时长 ${duration.toFixed(2)} 秒`}。</p>}
        {suggested !== null && <Notice>按当前密度预计 {estimated} 帧，超过引擎单次上限 {MAX_FRAMES} 帧，整单会失败。建议改为每 {suggested} 秒一帧，或只抽其中一段。<div className="notice-actions"><Button onClick={applySuggestion}>改为每 {suggested} 秒一帧</Button></div></Notice>}
        <details className="video-advanced" open={advanced || durationUnknown} onToggle={e => setAdvanced((e.target as HTMLDetailsElement).open)}><summary>高级设置 · 时间范围与输出尺寸</summary>
          <label className="checkbox-row"><input type="checkbox" disabled={busy || duration === null} checked={whole} onChange={e => setWhole(e.target.checked)} />使用整段已知时长</label>
          {durationUnknown && <Notice>视频时长未知，请明确填写抽帧时间范围。</Notice>}
          {!whole && <><p className="muted tiny">单位为秒，相对首个实际源帧；包含起点，不包含终点。相邻时间段允许接续。</p>{ranges.map((range, i) => <div className="video-range-row" key={i}><Field label={`第 ${i + 1} 段起点`}><input aria-label={`视频时间段 ${i + 1} 起点`} type="number" min={0} step="any" disabled={busy} value={range.start} onChange={e => setRanges(list => list.map((r, index) => index === i ? { ...r, start: Number(e.target.value) } : r))} /></Field><Field label="终点"><input aria-label={`视频时间段 ${i + 1} 终点`} type="number" min={0} step="any" disabled={busy} value={range.end} onChange={e => setRanges(list => list.map((r, index) => index === i ? { ...r, end: Number(e.target.value) } : r))} /></Field><IconButton label={`移除时间段 ${i + 1}`} disabled={busy || ranges.length === 1} onClick={() => setRanges(list => list.filter((_, index) => i !== index))}><Trash2 size={14} /></IconButton></div>)}<Button disabled={busy || ranges.length >= 32} onClick={() => setRanges(list => [...list, { start: list.at(-1)?.end ?? 0, end: (list.at(-1)?.end ?? 0) + 1 }])}><Plus size={13} />添加时间段</Button></>}
          <label className="checkbox-row"><input type="checkbox" disabled={busy} checked={resize} onChange={e => { sizeTouched.current = true; setDownsampled(false); setResize(e.target.checked); }} />指定输出尺寸</label>
          {resize && <><div className="field-grid"><Field label="宽度（像素）"><input aria-label="视频输出宽度" type="number" min={1} disabled={busy} value={width} onChange={e => { sizeTouched.current = true; setDownsampled(false); setWidth(e.target.value); }} /></Field><Field label="高度（像素）"><input aria-label="视频输出高度" type="number" min={1} disabled={busy} value={height} onChange={e => { sizeTouched.current = true; setDownsampled(false); setHeight(e.target.value); }} /></Field></div><Field label="适配方式"><select aria-label="视频尺寸适配" disabled={busy} value={fit} onChange={e => setFit(e.target.value as typeof fit)}><option value="contain">等比缩放并留边</option><option value="stretch">拉伸到指定尺寸</option></select></Field></>}
          <Field label="输出格式"><select aria-label="视频输出格式" disabled={busy} value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="png">PNG</option><option value="jpg">JPEG</option></select></Field>
          {format === 'jpg' && <Field label="JPEG 质量参数（2 高，31 低）"><input aria-label="视频JPEG质量" type="number" min={2} max={31} disabled={busy} value={quality} onChange={e => setQuality(e.target.value)} /></Field>}
        </details>
      </>}
    {transcoding && <Notice>正在用本机 FFmpeg 生成转码副本（已用时 {elapsed} 秒）。转码完成后会自动重新检查这段视频。</Notice>}
    <MediaError error={error} handlers={errorHandlers} busy={blocked} />
    {command && <textarea className="transcode-command" aria-label="转码命令" readOnly value={command} />}
    <FrameAutoImportOption disabled={busy} />
    <div className="modal-actions"><Button disabled={blocked} onClick={onClose}>取消</Button>{inspection && <Button className="primary" disabled={isDemo} busy={busy} onClick={() => void create()}>开始抽帧</Button>}</div>
  </div></Modal>;
}
