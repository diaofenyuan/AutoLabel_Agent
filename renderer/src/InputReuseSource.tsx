import { useState } from 'react';
import type { InputReuseProvenance } from '../../shared/reuse';
import type { Run } from './types';
import { statusNames } from './types';
import { request, errorMessage } from './bridge';
import { Button, Modal, Notice } from './ui';

export default function InputReuseSource({ source }: { source: InputReuseProvenance }) {
  const [run, setRun] = useState<Run | null>(null), [viewing, setViewing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function read(open = false) {
    if (run) { if (open) setViewing(true); return; }
    setBusy(true); setError('');
    try { setRun(await request<Run>('run.get', { runId: source.sourceRunId })); if (open) setViewing(true); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const local = source.source === 'local', sample = run?.samples?.find(s => s.id === source.sourceSampleId);
  const backend = local ? source.sourceObservedBackend : undefined;
  const backendText = !backend ? '未记录' : backend.kind === 'pytorch' ? `PyTorch · ${backend.device}` : `ONNX Runtime · ${backend.providers.join('、') || '执行提供者未记录'}`;
  const diagnostics = <><p>来源运行 ID：{source.sourceRunId}</p><p>来源输入 ID：{source.sourceInputId}</p><p>来源结果 ID：{source.sourceResultId}</p><p>来源样本 ID：{source.sourceSampleId}</p><p>来源父图 ID：{source.sourceAssetId}</p>{source.source === 'api' ? <><p>原始 API 请求 ID：{source.sourceAttemptId}</p>{source.sourceModelVersion && <pre>{JSON.stringify(source.sourceModelVersion, null, 2)}</pre>}</> : <><p>本地模型 ID：{source.sourceModelId}</p><p>模型文件标识：{source.sourceModelHash}</p><p>推理组件标识：{source.sourceWorkerHash}</p></>}<p>匹配记录：{source.reuseFingerprint}</p></>;
  return <><details className="reuse-provenance input-reuse-source" onToggle={e => { if (e.currentTarget.open && !run && !busy) void read(); }}><summary>输入结果来源 · {local ? '本地推理' : '接口推理'}{source.sourceModel ? ` · ${source.sourceModel}` : ''}</summary><dl><dt>来源运行</dt><dd>{run ? String(run.name ?? run.model ?? '未命名运行') : busy ? '正在读取名称…' : '名称暂不可用'}</dd><dt>完成时间</dt><dd>{new Date(source.sourceCompletedAt).toLocaleString('zh-CN')}</dd><dt>来源模型</dt><dd>{source.sourceModel ?? '未记录'}</dd>{source.source === 'local' && <><dt>固定版本</dt><dd>{source.sourceModelVersion}</dd><dt>请求设备</dt><dd>{source.sourceRequestedDevice ?? '未记录'}</dd><dt>实际后端</dt><dd>{backendText}</dd></>}</dl><Button busy={busy} onClick={() => void read(true)}>打开来源任务</Button><details><summary>输入来源诊断信息</summary>{diagnostics}</details>{error && <p className="inline-error">{error}</p>}</details>
    {viewing && run && <Modal title="输入结果来源任务" onClose={() => setViewing(false)}><div className="form-stack reuse-source-run"><h3>{String(run.name ?? run.model ?? '来源任务')}</h3><p>{statusNames[run.status] ?? run.status} · {local ? '本地推理' : '接口推理'}</p><p>来源运行的历史 API 请求数：{run.statistics?.requestsUsed ?? '未记录'}</p><Notice>此次复用引用已保存的模型输入结果，没有为该输入新增 API 请求。来源记录与当前任务分别保留。</Notice>{sample && <p>来源输入：{sample.name ?? '名称未记录'} · {statusNames[sample.status] ?? sample.status}</p>}<p>结果时间：{new Date(source.sourceCompletedAt).toLocaleString('zh-CN')}</p>{source.source === 'local' && <p>模型固定版本 {source.sourceModelVersion} · 实际后端 {backendText}</p>}<details><summary>输入来源诊断信息</summary>{diagnostics}</details><div className="modal-actions"><Button onClick={() => setViewing(false)}>关闭来源任务</Button></div></div></Modal>}
  </>;
}
