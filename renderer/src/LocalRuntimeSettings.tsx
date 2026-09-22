import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, RefreshCw, Sparkles } from 'lucide-react';
import type { LocalRuntimeState } from '../../shared/inference';
import { runtimeSetupBusy, RUNTIME_SETUP_PHASE_NAMES, type RuntimeSetupState } from '../../shared/runtime-setup';
import { getBridge, request, errorMessage, isDemo } from './bridge';
import { Button, Notice } from './ui';
import { useApp } from './context';

const localErrorActions: Record<string, string> = {
  model_task_unverified: '无法确认模型任务类型。请重新导出带任务元数据的模型，再登记新版本。',
  model_task_mismatch: '模型与所选任务类型不一致。请选择与项目任务类型匹配的模型后重试。',
  device_unavailable: '所选设备不可用。请明确选择 CPU 后重新加载模型。',
  local_model_load_required: '模型尚未加载。请先加载所选模型并读取类别，再执行本地预标注。',
  class_map_incomplete: '类别映射尚未完整。请为每个模型类别选择项目类别，或明确选择忽略后再执行。',
  // 开放词汇的类别名：中文名不会被编码成有意义的向量，所以下载编码器也不是出路，必须改填英文名。
  vocabulary_term_needs_english: '类别名是中文，而开放词汇的文本编码器只认英文。请改成英文名（例如「手办」→ figurine、「公仔」→ plush toy），或换成内置词表里已有的名字。',
  vocabulary_encoder_missing: '英文类别名不在内置词表里，需要 CLIP 文本编码器：到「模型库」下载「CLIP 文本编码器 ViT-B/32」后再试；中文名即使下载了也不会生效。',
};

export function LocalError({ error, code }: { error: string; code?: string }) {
  const { navigate } = useApp();
  const errorCode = code ?? error.match(/\b(model_task_unverified|model_task_mismatch|device_unavailable|local_model_load_required|class_map_incomplete|vocabulary_term_needs_english|vocabulary_encoder_missing)\b/)?.[0];
  const action = errorCode ? localErrorActions[errorCode] : undefined;
  return error ? <div className="local-error"><p>{action ?? '本地推理操作未完成。请展开诊断详情，确认原因后重试。'}</p>
    {/* 缺编码器的出路只有一个：到模型库下载。给真按钮，不指望用户自己找设置的哪一层。 */}
    {errorCode === 'vocabulary_encoder_missing' && <div className="actions"><Button onClick={() => void navigate('settings', 'ai-library')}>去模型库下载编码器</Button></div>}
    <details><summary>诊断详情</summary><p>{code ? `[${code}] ${error}` : error}</p></details></div> : null;
}

/**
 * 本地推理环境。
 *
 * 主入口是「一键准备」：自己找 Python、建独立环境、按固定版本从国内镜像装好依赖，最后交给引擎检测。
 * 手动选解释器是给已有环境的人用的，折在「高级」里——两种人都能一次做到，但第一次用的人不用先做选择题。
 */
export default function LocalRuntimeSettings({ onBusyChange, beforeConfigure }: { onBusyChange?: (busy: boolean) => void; beforeConfigure?: () => void }) {
  const [runtime, setRuntime] = useState<LocalRuntimeState | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [chosenPath, setChosenPath] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const [setup, setSetup] = useState<RuntimeSetupState | null>(null), [setupError, setSetupError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const settled = useRef('');
  async function execute(command: string, payload: Record<string, unknown> = {}) {
    setBusy(true); onBusyChange?.(true); setError('');
    try { if (command === 'local.runtime.configure') beforeConfigure?.(); setRuntime(await request<LocalRuntimeState>(command, payload)); setCheckedAt(new Date().toLocaleTimeString('zh-CN')); }
    catch (e) { setRuntime(null); setError(errorMessage(e)); } finally { setBusy(false); onBusyChange?.(false); }
  }
  useEffect(() => { if (!isDemo) void execute('local.runtime.get'); }, []);
  // 安装要几分钟，界面按秒轮询进度；离开设置页不会中断安装，回来时状态还在。
  useEffect(() => {
    if (isDemo || !setup || !runtimeSetupBusy(setup.phase)) return;
    const timer = setInterval(() => { void request<RuntimeSetupState>('local.runtime.setup.get').then(setSetup).catch(() => undefined); }, 1200);
    return () => clearInterval(timer);
  }, [setup?.phase]);
  // 准备完成后刷新一次环境状态：这一步的结果就是「能不能用」，必须当场看到。
  useEffect(() => {
    if (!setup || setup.phase !== 'ready' || settled.current === setup.finishedAt) return;
    settled.current = setup.finishedAt ?? '';
    void execute('local.runtime.get');
  }, [setup?.phase, setup?.finishedAt]);
  async function prepare() {
    setSetupError('');
    try { setSetup(await request<RuntimeSetupState>('local.runtime.setup.start')); }
    catch (e) { setSetupError(errorMessage(e)); }
  }
  async function choose() {
    try { const paths = await (await getBridge()).chooseFiles({ kind: 'python' }); if (paths[0]) { setChosenPath(paths[0]); await execute('local.runtime.configure', { pythonPath: paths[0] }); } }
    catch (e) { setError(errorMessage(e)); }
  }
  const preparing = Boolean(setup && runtimeSetupBusy(setup.phase));
  return <section className="settings-section local-runtime-settings">
    <div className="section-toolbar"><h2>本地推理环境</h2><Button disabled={isDemo || busy || preparing} busy={busy} onClick={() => void execute('local.runtime.probe')}><RefreshCw size={14}/>重新检测环境</Button></div>
    <Notice>{isDemo ? '本地推理需要桌面应用。' : '用本机模型标注不需要 API Key，也不需要自己准备 Python 依赖：点「一键准备」即可。已经装好依赖的机器可以直接在「高级」里指定原有解释器。'}</Notice>
    <div className="local-runtime-summary"><strong>{runtime ? runtime.available ? '环境检测通过' : '环境尚未就绪' : '环境状态未确认'}</strong><p>解释器配置：{runtime ? runtime.configured ? '已配置' : '未配置' : '未确认'} · 推理组件：{runtime ? runtime.workerAvailable ? '已检测到' : '不可用' : '未确认'}</p>{checkedAt && <small>状态更新：{checkedAt}</small>}</div>
    <div className="actions"><Button className="primary" disabled={isDemo || preparing} busy={preparing} onClick={() => void prepare()}><Sparkles size={14}/>{setup?.phase === 'ready' ? '重新准备' : '一键准备（推荐）'}</Button></div>
    {setupError && <LocalError error={setupError}/>}
    {setup && setup.phase !== 'idle' && <div className={`runtime-setup ${setup.phase}`} data-phase={setup.phase}>
      <div className="runtime-setup-head"><strong>{RUNTIME_SETUP_PHASE_NAMES[setup.phase]}</strong><span className="muted tiny">{setup.environment}</span></div>
      <p className="runtime-setup-message">{setup.message}</p>
      {(setup.pythonVersion || setup.basePython) && <p className="muted tiny break-word">Python {setup.pythonVersion ?? '未识别'}（{setup.basePython}）</p>}
      <ul className="runtime-setup-dependencies">{setup.dependencies.map(item => <li key={item.name}><strong>{item.name} {item.installed ?? item.version}</strong><small>{item.note}</small></li>)}</ul>
      {setup.phase === 'ready' && <p className="muted tiny">依赖版本已核对，安装记录写在环境目录的 autolabel-env.json 里。</p>}
      {setup.log.length > 0 && <details className="local-runtime-diagnostics runtime-setup-log"><summary>安装输出</summary><pre>{setup.log.join('\n')}</pre></details>}
    </div>}
    <button className="text-button advanced-toggle local-runtime-advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>高级：手动指定已装好依赖的 Python 解释器<ChevronRight className={advanced ? 'rotate-90' : ''} size={13}/></button>
    {advanced && <div className="advanced-fields" aria-label="手动选择 Python 解释器">
      {chosenPath && <p className="muted tiny break-word">本次选择：{chosenPath}</p>}
      <div className="actions"><Button disabled={isDemo || busy || preparing} onClick={() => void choose()}><FolderOpen size={14}/>选择 Python 解释器</Button><Button disabled={isDemo || busy || preparing || !runtime?.configured} title={!runtime?.configured ? '尚未配置本机解释器，先一键准备或手动选择' : undefined} onClick={() => { setChosenPath(''); void execute('local.runtime.configure', { pythonPath: null }); }}>清除本机解释器配置</Button></div>
      <p className="muted tiny">只接受本机已安装 Ultralytics 与 PyTorch 的解释器；配置只保存在这台电脑。</p>
    </div>}
    {runtime && <><div className="local-runtime-versions"><span>Python {runtime.pythonVersion ?? '未检测'}</span><span>Ultralytics {runtime.ultralyticsVersion ?? '未检测'}</span><span>PyTorch {runtime.torchVersion ?? '未检测'}</span></div><p className="muted tiny">CUDA：{runtime.cudaAvailable === undefined ? '未确认' : runtime.cudaAvailable ? '可用' : '不可用'}</p>{runtime.devices.length > 0 && <p className="muted">检测到的设备：{runtime.devices.map(d => d.name).join('、')}</p>}{runtime.issue && <LocalError error={runtime.issue.message} code={runtime.issue.code}/>}{runtime.slots.length > 0 && <details className="local-slots"><summary>设备当前状态</summary>{runtime.slots.map(s => <p key={s.device}>{runtime.devices.find(d => d.id === s.device)?.name ?? s.device} · {s.busy ? '正在执行' : '空闲'}{s.modelVersion !== undefined ? ` · 模型版本 ${s.modelVersion}` : ''}</p>)}</details>}</>}
    {runtime && <details className="local-runtime-diagnostics"><summary>环境诊断信息</summary><p>ONNX Runtime：{runtime.onnxruntimeVersion ?? '未检测'}</p><p>NumPy：{runtime.numpyVersion ?? '未检测'}</p><p>OpenCV：{runtime.opencvVersion ?? '未检测'}</p></details>}
    <LocalError error={error}/>
  </section>;
}
