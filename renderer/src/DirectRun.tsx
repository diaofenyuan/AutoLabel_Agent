import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Play } from 'lucide-react';
import { deriveClassMap } from '../../shared/vocabulary';
import { formatModelBytes, type ModelLibraryEntry, type ModelLibraryState } from '../../shared/model-library';
import type { LocalModel } from '../../shared/inference';
import type { ResolvedConfiguration } from '../../shared/configuration';
import type { Project } from './types';
import { errorMessage, request } from './bridge';
import { useApp } from './context';
import { Button, Field, Notice } from './ui';

interface LocalChoice { entry: ModelLibraryEntry; model: LocalModel }

/** 云端标注的提示词：类别写清楚，再把项目的标注规则（区分口径）接在后面。 */
export function buildDirectPrompt(classes: Project['classes'], rules: string): string {
  const names = classes.map(item => item.name).join('、');
  return `把图片里属于这些类别的目标都用矩形框标出来：${names}。没有目标的图片返回空数组。${rules ? `补充要求：${rules}` : ''}`;
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
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<'cloud' | 'local'>('cloud');
  const [localId, setLocalId] = useState('');
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);

  const classes = project.classes;
  const rules = typeof project.settings?.rules === 'string' ? project.settings.rules : '';
  const cloudReady = Boolean(annotationConfig.providerId && annotationConfig.model);
  const picked = locals.find(item => item.entry.id === localId);
  const assetIds = scope === 'selected' ? selectedAssetIds : undefined;

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
      request<{ available: boolean }>('local.runtime.get'),
    ]).then(([library, models, runtime]) => {
      setLocalAvailable(Boolean(runtime.available));
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

  /** 本机路径：先把模型载入（已经载入同一版本就跳过），再按开放词汇/固定类别两条口径生成映射。 */
  async function createLocalRun(choice: LocalChoice) {
    const runtime = await request<{ slots: Array<{ device: string; busy: boolean; modelId?: string; modelVersion?: number; classes?: Array<{ id: string; name: string }> }> }>('local.runtime.get');
    const slot = runtime.slots.find(item => item.device === 'cpu');
    let modelClasses = slot?.modelId === choice.model.id && slot.modelVersion === choice.model.version ? slot.classes ?? [] : [];
    if (!modelClasses.length) {
      const loaded = await request<{ classes: Array<{ id: string; name: string }> }>('local.model.load',
        { modelId: choice.model.id, modelVersion: choice.model.version, device: 'cpu', timeoutMs: 300000 });
      modelClasses = loaded.classes;
    }
    if (choice.entry.openVocabulary) {
      const textClasses = classes.map(item => item.name);
      const derived = deriveClassMap(textClasses, classes);
      if (!textClasses.length) throw new Error('这个项目还没有类别：请先在输入卡的「类别」里写好要识别的名字。');
      if (derived.unmatched) throw new Error('有类别名没有对上项目类别，映射会变成「忽略」；请在输入卡的「类别」里核对名称后重试。');
      return request<{ id: string }>('local.run.create', {
        projectId: project.id, ...(assetIds ? { assetIds } : {}), modelId: choice.model.id, modelVersion: choice.model.version,
        device: 'cpu', textClasses, classMap: derived.classMap, confidence: 0.2, timeoutMs: 300000, forceRerun: true,
      });
    }
    // 固定类别表：模型每个类别都要有明确映射（对不上的明确为忽略），否则引擎会拒绝。
    const derived = deriveClassMap(modelClasses.map(item => item.name), classes);
    return request<{ id: string }>('local.run.create', {
      projectId: project.id, ...(assetIds ? { assetIds } : {}), modelId: choice.model.id, modelVersion: choice.model.version,
      device: 'cpu', classMap: derived.classMap, confidence: 0.2, timeoutMs: 300000, forceRerun: true,
    });
  }
  async function start() {
    setBusy(true); setError('');
    try {
      if (!classes.length) throw new Error('这个项目还没有类别：请先在输入卡的「类别」里写好要标的东西。');
      if (scope === 'selected' && !selectedAssetIds.length) throw new Error('还没有勾选素材：到项目概览里勾选，或把范围改成「全部未标注」。');
      const run = target === 'local'
        ? (picked ? await createLocalRun(picked) : (() => { throw new Error('请先选择一个内置模型。'); })())
        : await request<{ id: string }>('run.create', {
            projectId: project.id, ...(assetIds ? { assetIds } : {}), providerId: annotationConfig.providerId, model: annotationConfig.model,
            prompt: buildDirectPrompt(classes, rules), concurrency: annotationConfig.concurrency,
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
            内置模型<small>{loading ? '正在读取模型库…' : locals.length ? '本机运行，不花钱' : '没有可用模型'}</small>
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
