import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import type { LocalRuntimeState } from '../../shared/inference';
import { getBridge, request, errorMessage, isDemo } from './bridge';
import { Button, Notice } from './ui';

const localErrorActions: Record<string, string> = {
  model_task_unverified: '无法确认模型任务类型。请重新导出带任务元数据的模型，再登记新版本。',
  model_task_mismatch: '模型与所选任务类型不一致。请选择与项目任务类型匹配的模型后重试。',
  device_unavailable: '所选设备不可用。请明确选择 CPU 后重新加载模型。',
  local_model_load_required: '模型尚未加载。请先加载所选模型并读取类别，再执行本地预标注。',
  class_map_incomplete: '类别映射尚未完整。请为每个模型类别选择项目类别，或明确选择忽略后再执行。',
};

export function LocalError({ error, code }: { error: string; code?: string }) {
  const errorCode = code ?? error.match(/\b(model_task_unverified|model_task_mismatch|device_unavailable|local_model_load_required|class_map_incomplete)\b/)?.[0];
  const action = errorCode ? localErrorActions[errorCode] : undefined;
  return error ? <div className="local-error"><p>{action ?? '本地推理操作未完成。请展开诊断详情，确认原因后重试。'}</p><details><summary>诊断详情</summary><p>{code ? `[${code}] ${error}` : error}</p></details></div> : null;
}

export default function LocalRuntimeSettings({ onBusyChange, beforeConfigure }: { onBusyChange?: (busy: boolean) => void; beforeConfigure?: () => void }) {
  const [runtime, setRuntime] = useState<LocalRuntimeState | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [chosenPath, setChosenPath] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  async function execute(command: string, payload: Record<string, unknown> = {}) {
    setBusy(true); onBusyChange?.(true); setError('');
    try { if (command === 'local.runtime.configure') beforeConfigure?.(); setRuntime(await request<LocalRuntimeState>(command, payload)); setCheckedAt(new Date().toLocaleTimeString('zh-CN')); }
    catch (e) { setRuntime(null); setError(errorMessage(e)); } finally { setBusy(false); onBusyChange?.(false); }
  }
  useEffect(() => { if (!isDemo) void execute('local.runtime.get'); }, []);
  async function choose() {
    try { const paths = await (await getBridge()).chooseFiles({ kind: 'python' }); if (paths[0]) { setChosenPath(paths[0]); await execute('local.runtime.configure', { pythonPath: paths[0] }); } }
    catch (e) { setError(errorMessage(e)); }
  }
  return <section className="settings-section local-runtime-settings"><div className="section-toolbar"><h2>本地推理环境</h2><Button disabled={isDemo} busy={busy} onClick={() => void execute('local.runtime.probe')}><RefreshCw size={14}/>重新检测环境</Button></div><Notice>{isDemo ? '本地推理需要桌面应用。' : '选择本机已安装 Ultralytics 和 PyTorch 的 Python 解释器。配置只保存在这台电脑，检测结果决定能否使用本地模型。'}</Notice>
    <div className="local-runtime-summary"><strong>{runtime ? runtime.available ? '环境检测通过' : '环境尚未就绪' : '环境状态未确认'}</strong><p>解释器配置：{runtime ? runtime.configured ? '已配置' : '未配置' : '未确认'} · 推理组件：{runtime ? runtime.workerAvailable ? '已检测到' : '不可用' : '未确认'}</p>{checkedAt && <small>状态更新：{checkedAt}</small>}</div>
    {chosenPath && <p className="muted tiny break-word">本次选择：{chosenPath}</p>}<div className="actions"><Button disabled={isDemo || busy} onClick={() => void choose()}><FolderOpen size={14}/>选择 Python 解释器</Button><Button disabled={isDemo || busy || !runtime?.configured} onClick={() => { setChosenPath(''); void execute('local.runtime.configure', { pythonPath: null }); }}>清除本机解释器配置</Button></div>
    {runtime && <><div className="local-runtime-versions"><span>Python {runtime.pythonVersion ?? '未检测'}</span><span>Ultralytics {runtime.ultralyticsVersion ?? '未检测'}</span><span>PyTorch {runtime.torchVersion ?? '未检测'}</span></div><p className="muted tiny">CUDA：{runtime.cudaAvailable === undefined ? '未确认' : runtime.cudaAvailable ? '可用' : '不可用'}</p>{runtime.devices.length > 0 && <p className="muted">检测到的设备：{runtime.devices.map(d => d.name).join('、')}</p>}{runtime.issue && <LocalError error={runtime.issue.message} code={runtime.issue.code}/>}{runtime.slots.length > 0 && <details className="local-slots"><summary>设备当前状态</summary>{runtime.slots.map(s => <p key={s.device}>{runtime.devices.find(d => d.id === s.device)?.name ?? s.device} · {s.busy ? '正在执行' : '空闲'}{s.modelVersion !== undefined ? ` · 模型版本 ${s.modelVersion}` : ''}</p>)}</details>}</>}
    {runtime && <details className="local-runtime-diagnostics"><summary>环境诊断信息</summary><p>ONNX Runtime：{runtime.onnxruntimeVersion ?? '未检测'}</p><p>NumPy：{runtime.numpyVersion ?? '未检测'}</p><p>OpenCV：{runtime.opencvVersion ?? '未检测'}</p></details>}
    <LocalError error={error}/>
  </section>;
}
