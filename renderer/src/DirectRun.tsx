import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Play } from 'lucide-react';
import { deriveClassMap } from '../../shared/vocabulary';
import { formatModelBytes, type ModelLibraryEntry, type ModelLibraryState } from '../../shared/model-library';
import type { LocalModel, LocalRuntimeState } from '../../shared/inference';
import type { ResolvedConfiguration } from '../../shared/configuration';
import type { Project } from './types';
import { errorMessage, request } from './bridge';
import { useApp } from './context';
import { Button, Field, Notice } from './ui';

interface LocalChoice { entry: ModelLibraryEntry; model: LocalModel }

/** 本地推理优先选空闲 GPU；没有可用 GPU 时才回退 CPU，避免高性能机器默认浪费在 CPU 上。 */
function preferredLocalDevice(runtime: Pick<LocalRuntimeState, 'devices' | 'slots'>): string {
  const idleGpu = runtime.slots.find(slot => !slot.busy && slot.device !== 'cpu')?.device;
  if (idleGpu) return idleGpu;
  return runtime.devices.find(device => device.id !== 'cpu')?.id ?? 'cpu';
}

/** 云端标注提示词：项目规则长期生效，单次说明只影响本次运行；框贴目标外缘以减少背景误框。 */
export function buildDirectPrompt(classes: Project['classes'], rules: string, instructions = ''): string {
  const names = classes.map(item => item.name).join('、');
  return `把图片里属于这些类别的目标都用矩形框标出来：${names}。矩形框要贴合目标可见外缘，只包含目标本体及其自身组成；如果目标带有底座、支架、坐垫或托架，这些与目标固定相连的部分也要一并包含。不要包含大块背景、手、线缆、桌面物品或相邻物品；多个目标分别标注。没有目标的图片返回空数组。${rules ? `项目区分规则：${rules}` : ''}${instructions.trim() ? `本次补充要求：${instructions.trim()}` : ''}`;
}

export interface AnnotationRegion { left: number; top: number; right: number; bottom: number }

/** 读项目设置里的标注区域：比例不在 0～1 或退化就当没设，绝不把可疑值直接发给引擎。 */
export function readRegion(value: unknown): AnnotationRegion | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const pick = (key: string) => typeof item[key] === 'number' ? item[key] as number : Number.NaN;
  const region = { left: pick('left'), top: pick('top'), right: pick('right'), bottom: pick('bottom') };
  const values = [region.left, region.top, region.right, region.bottom];
  return values.every(value => Number.isFinite(value) && value >= 0 && value <= 1) && region.right > region.left && region.bottom > region.top ? region : null;
}

/**
 * 直达标注：选好模型、范围、类别就能直接建任务，不必先让助手理解一遍。
 *
 * 这条通路存在的理由很具体：对话里的一切操作都要求一个「能调工具的对话模型」，
 * 没配或模型不支持工具调用时，连「用内置模型标注（无需 API Key）」都走不通。
 * 这里用与助手完全相同的引擎命令（run.create / local.run.create），只是把参数在界面里摊开。
 * 结果仍然是候选：人工已确认的内容不会被覆盖。
 */
export default function DirectRun({ project, annotationConfig, selectedAssetIds, disabled }: {
  project: Project; annotationConfig: ResolvedConfiguration; selectedAssetIds: string[]; disabled?: boolean;
}) {
  const { notify, navigate } = useApp();
  const [open, setOpen] = useState(false);
  const [locals, setLocals] = useState<LocalChoice[]>([]);
  const [localAvailable, setLocalAvailable] = useState(false);
  const [localDevice, setLocalDevice] = useState('cpu');
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<'cloud' | 'local'>('cloud');
  const [instructions, setInstructions] = useState('');
  const [localId, setLocalId] = useState('');
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  // 发送副本：默认长边 1920 的 JPEG。实测 4K 帧按原图发（3.4 MB）时某些接口会跑到超时，
  // 缩到 0.16 MB 后同样的模型 20 多秒返回；区域裁剪进一步把小目标放大，框也更贴。
  const [sendMode, setSendMode] = useState<'original' | 'edge1920' | 'edge1152'>('edge1920');
  // 参考帧：把一张已人工确认的图当作「照这个样子标」的示例（few-shot）。小目标靠它比靠提示词有效得多。
  const [referenceId, setReferenceId] = useState('');
  const [references, setReferences] = useState<Array<{ id: string; name: string; objects: number }>>([]);
  // 本机小目标模式：4K 帧里的小物件（手办、小零件）在 640 下常常直接漏检，提高到 1280 并放低置信度更稳。
  const [localQuality, setLocalQuality] = useState<'standard' | 'small'>('standard');
  const localParameters = localQuality === 'small' ? { imageSize: 1280, confidence: 0.15 } : { imageSize: 640, confidence: 0.25 };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);

  const classes = project.classes;
  const rules = typeof project.settings?.rules === 'string' ? project.settings.rules : '';
  // 标注区域由素材页在画布上框定，存在项目设置里；这里只读它，避免在两处各存一份口径。
  const region = readRegion(project.settings?.annotationRegion);
  const cloudReady = Boolean(annotationConfig.providerId && annotationConfig.model);
  const picked = locals.find(item => item.entry.id === localId);
  const assetIds = scope === 'selected' ? selectedAssetIds : undefined;
  const payload = target === 'cloud' && (sendMode !== 'original' || region)
    ? { ...(sendMode === 'original' ? {} : { maxEdge: sendMode === 'edge1920' ? 1920 : 1152, quality: 92 }), ...(region ? { region } : {}) }
    : null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  useEffect(() => {
    if (!open || locals.length) return;
    setLoading(true);
    void Promise.all([
      request<ModelLibraryState>('model.library.status'),
      request<{ items: LocalModel[] }>('local.model.list', { offset: 0, limit: 500 }),
      request<LocalRuntimeState>('local.runtime.get'),
    ]).then(([library, models, runtime]) => {
      setLocalAvailable(Boolean(runtime.available));
      setLocalDevice(preferredLocalDevice(runtime));
      const list: LocalChoice[] = [];
      for (const entry of library.entries) {
        if (entry.state !== 'ready' || entry.taskType === null) continue;
        const model = models.items.find(item => item.catalogId === entry.id);
        if (model) list.push({ entry, model });
      }
      setLocals(list);
      setTarget(cloudReady || !list.length ? 'cloud' : 'local');
    }).catch(error => setError(errorMessage(error))).finally(() => setLoading(false));
  }, [open, locals.length, cloudReady]);

  useEffect(() => {
    if (!open || !project) return;
    // 只有「人工确认过」的素材能当参考（引擎侧同样要求 confirmed/modified）；这里只读已加载的一页，仅用于挑选。
    void request<{ items: Array<{ id: string; name: string; status: string; annotations: unknown[] }> }>('asset.list', { projectId: project.id, limit: 500 })
      .then(list => setReferences(list.items.filter(item => item.status === 'confirmed' || item.status === 'modified')
        .map(item => ({ id: item.id, name: item.name, objects: item.annotations.length }))))
      .catch(() => setReferences([]));
  }, [open, project?.id]);
  useEffect(() => { setInstructions(''); }, [project.id]);

  /** 本机路径：先把模型载入（已经载入同一版本就跳过），再按开放词汇/固定类别两条口径生成映射。 */
  async function createLocalRun(choice: LocalChoice) {
    // 重新读取设备状态，避免弹层打开后 GPU 被训练任务占用仍硬选旧设备。
    const runtime = await request<LocalRuntimeState>('local.runtime.get');
    const device = preferredLocalDevice(runtime);
    setLocalDevice(device);
    const slot = runtime.slots.find(item => item.device === device);
    let modelClasses = slot?.modelId === choice.model.id && slot.modelVersion === choice.model.version ? slot.classes ?? [] : [];
    if (!modelClasses.length) {
      const loaded = await request<{ classes: Array<{ id: string; name: string }> }>('local.model.load',
        { modelId: choice.model.id, modelVersion: choice.model.version, device, timeoutMs: 300000 });
      modelClasses = loaded.classes;
    }
    if (choice.entry.openVocabulary) {
      const textClasses = classes.map(item => item.name);
      const derived = deriveClassMap(textClasses, classes);
      if (!textClasses.length) throw new Error('这个项目还没有类别：请先在输入卡的「类别」里写好要识别的名字。');
      if (derived.unmatched) throw new Error('有类别名没有对上项目类别，映射会变成「忽略」；请在输入卡的「类别」里核对名称后重试。');
      return request<{ id: string }>('local.run.create', {
        projectId: project.id, ...(assetIds ? { assetIds } : {}), modelId: choice.model.id, modelVersion: choice.model.version,
        device, textClasses, classMap: derived.classMap, ...localParameters, timeoutMs: 300000, forceRerun: true,
      });
    }
    // 固定类别表：模型每个类别都要有明确映射（对不上的明确为忽略），否则引擎会拒绝。
    const derived = deriveClassMap(modelClasses.map(item => item.name), classes);
    return request<{ id: string }>('local.run.create', {
      projectId: project.id, ...(assetIds ? { assetIds } : {}), modelId: choice.model.id, modelVersion: choice.model.version,
      device, classMap: derived.classMap, ...localParameters, timeoutMs: 300000, forceRerun: true,
    });
  }
  /**
   * 参考帧不能同时是待标注目标（引擎会直接拒绝）。选了参考之后：
   * 「已勾选」把参考从目标里剔掉；「全部未标注」取全项目素材（分页）再剔掉参考。
   */
  async function resolveTargets(): Promise<string[] | undefined> {
    if (!referenceId) return assetIds;
    if (scope === 'selected') {
      const targets = selectedAssetIds.filter(id => id !== referenceId);
      if (!targets.length) throw new Error('参考帧不能同时当成待标注目标：请另外勾选要标注的素材，或换一张参考。');
      return targets;
    }
    // 引擎的 asset.list 单页上限是 500：分页取全，避免大项目漏掉后面的素材。
    const ids: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await request<{ items: Array<{ id: string }>; total: number }>('asset.list', { projectId: project.id, offset, limit: 500 });
      ids.push(...page.items.map(item => item.id));
      if (!page.items.length || ids.length >= page.total) break;
    }
    const targets = ids.filter(id => id !== referenceId);
    if (!targets.length) throw new Error('这个项目里只有这一张已确认的图：它当参考之后就没有可标注的素材了。');
    return targets;
  }

  async function start() {
    setBusy(true); setError('');
    try {
      if (!classes.length) throw new Error('这个项目还没有类别：请先在输入卡的「类别」里写好要标的东西。');
      if (scope === 'selected' && !selectedAssetIds.length) throw new Error('还没有勾选素材：到项目概览里勾选，或把范围改成「全部未标注」。');
      const resolved = await resolveTargets();
      const run = target === 'local'
        ? (picked ? await createLocalRun(picked) : (() => { throw new Error('请先选择一个内置模型。'); })())
        : await request<{ id: string }>('run.create', {
            projectId: project.id, ...(resolved ? { assetIds: resolved } : {}), providerId: annotationConfig.providerId, model: annotationConfig.model,
            prompt: buildDirectPrompt(classes, rules, instructions), concurrency: annotationConfig.concurrency, ...(payload ? { payload } : {}),
            ...(referenceId ? { referenceAssetIds: [referenceId] } : {}),
          });
      setOpen(false);
      notify('已创建标注任务，进度在任务中心；结果会写成候选，不会覆盖你已确认的内容。');
      void navigate('tasks');
      return run;
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  const blocked = !classes.length ? { text: '这个项目还没有类别，先写清要标什么。', go: null }
    : target === 'cloud' && !cloudReady ? { text: '还没有配置标注模型（接口 + 模型）。', go: () => void navigate('settings', 'ai') }
    : target === 'local' && !localAvailable ? { text: '本机推理环境还没准备好，内置模型暂时不能跑。', go: () => void navigate('settings', 'ai') }
    : target === 'local' && !picked ? { text: '还没有启用可用的内置模型。', go: () => void navigate('settings', 'ai') }
    : null;
  return <div className="direct-run" ref={root}>
    <button type="button" className="model-picker-trigger direct-run-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      title="不经过对话，直接用选好的模型建标注任务" onClick={() => setOpen(value => !value)}>
      <Play size={12} />开始标注<ChevronDown size={12} />
    </button>
    {open && <div className="picker-popover" role="dialog" aria-label="直接开始标注">
      <div className="class-picker-head"><strong>直接开始标注</strong><small className="muted">不经过对话，用选好的模型与范围直接建任务</small></div>
      <div className="direct-run-body">
        <p className="muted tiny">用哪个模型</p>
        <div className="direct-run-options">
          <button type="button" className={target === 'cloud' ? 'selected' : ''} aria-pressed={target === 'cloud'} onClick={() => setTarget('cloud')}>
            云端标注模型<small>{cloudReady ? `${annotationConfig.model}` : '未配置'}</small>
          </button>
          <button type="button" className={target === 'local' ? 'selected' : ''} aria-pressed={target === 'local'} onClick={() => setTarget('local')}>
            内置模型<small>{loading ? '正在读取模型库…' : locals.length ? `本机运行 · ${localDevice === 'cpu' ? 'CPU' : `GPU ${localDevice}`} · 不花钱` : '没有可用模型'}</small>
          </button>
        </div>
        {target === 'local' && Boolean(locals.length) && <Field label="内置模型">
          <select value={localId} onChange={event => setLocalId(event.target.value)}>
            <option value="">选择一个内置模型</option>
            {locals.map(item => <option key={item.entry.id} value={item.entry.id}>
              {item.entry.name}{item.entry.openVocabulary ? '（开放词汇）' : ''} · {formatModelBytes(item.entry.sizeBytes)}
            </option>)}
          </select>
        </Field>}
        <p className="muted tiny">处理哪些素材</p>
        <div className="direct-run-options">
          <button type="button" className={scope === 'all' ? 'selected' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            全部未标注<small>本项目里还没有候选的素材</small>
          </button>
          <button type="button" className={scope === 'selected' ? 'selected' : ''} aria-pressed={scope === 'selected'} onClick={() => setScope('selected')}>
            已勾选<small>{selectedAssetIds.length ? `${selectedAssetIds.length} 张` : '先在项目概览里勾选'}</small>
          </button>
        </div>
        {target === 'local' && <>
          <p className="muted tiny">识别精度</p>
          <div className="direct-run-options">
            <button type="button" className={localQuality === 'standard' ? 'selected' : ''} aria-pressed={localQuality === 'standard'} aria-label="标准模式" onClick={() => setLocalQuality('standard')}>
              标准<small>图像尺寸 640 · 置信度 0.25</small>
            </button>
            <button type="button" className={localQuality === 'small' ? 'selected' : ''} aria-pressed={localQuality === 'small'} aria-label="小目标模式" onClick={() => setLocalQuality('small')}>
              小目标（手办/小零件）<small>图像尺寸 1280 · 置信度 0.15 · 更慢但少漏检</small>
            </button>
          </div>
        </>}
        {target === 'cloud' && <>
          <Field label="本次补充要求（可选）" hint="只影响本次任务；项目区分规则会继续生效。">
            <textarea rows={3} maxLength={4000} value={instructions} onChange={event => setInstructions(event.target.value)}
              placeholder="例如：只标画面中间的粉发手办，包含自身底座，忽略背景大型摆件。" />
          </Field>
          <p className="muted tiny">发送给模型</p>
          <div className="direct-run-options">
            {([['edge1920', '长边 1920（推荐）', '4K 帧约 3 MB → 约 0.3 MB'], ['edge1152', '长边 1152', '更省流量，小目标更依赖裁剪'],
              ['original', '原图', '无损，但大图更容易超时']] as const).map(([value, label, note]) =>
              <button key={value} type="button" className={sendMode === value ? 'selected' : ''} aria-pressed={sendMode === value} onClick={() => setSendMode(value)}>
                {label}<small>{note}</small>
              </button>)}
          </div>
          <span className="muted tiny">只标注区域：{region ? `左 ${Math.round(region.left * 100)}% 上 ${Math.round(region.top * 100)}% 右 ${Math.round(region.right * 100)}% 下 ${Math.round(region.bottom * 100)}%（在素材页的画布上框定，坐标会自动换算回整图）` : '整图（在素材页的画布上可以框一块只标它）'}</span>
          {/* 参考帧：小目标最有效的一招——给模型一张「照这个样子标」的示例。 */}
          {references.length
            ? <><Field label="参考帧（可选）" hint="挑一张已经人工确认过的图当示例；它自己不会被标注，会从本次目标里自动排除。">
                <select value={referenceId} onChange={event => setReferenceId(event.target.value)}>
                  <option value="">不用参考</option>
                  {references.map(item => <option key={item.id} value={item.id}>{item.name} · 已人工确认 {item.objects} 个对象</option>)}
                </select>
              </Field></>
            : <span className="muted tiny">还没有可当参考的素材：先手标一张并点「保存并确认」，它就能在这里当示例。</span>}
        </>}
        <p className="muted tiny">类别：{classes.length ? classes.map(item => item.name).join('、') : '（还没有类别）'}{rules ? ` · 已写区分口径` : ''}</p>
        {rules && <p className="muted tiny direct-run-rules">{rules}</p>}
        {blocked && <Notice>{blocked.text}{blocked.go && <button type="button" className="text-button" onClick={blocked.go}>去配置</button>}</Notice>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
      <div className="picker-foot">
        <span className="muted tiny">结果作为候选，不覆盖已人工确认的标注</span>
        <Button className="primary" type="button" busy={busy} disabled={busy || Boolean(blocked)} onClick={() => void start()}>开始标注</Button>
      </div>
    </div>}
  </div>;
}
