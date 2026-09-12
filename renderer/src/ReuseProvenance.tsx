import { useState } from 'react';
import type { CandidateReuseProvenance } from '../../shared/reuse';
import type { Run } from './types';
import { statusNames } from './types';
import { request, errorMessage } from './bridge';
import { Button, Modal, Notice } from './ui';

export default function ReuseProvenance({ source }: { source?: CandidateReuseProvenance }) {
  const [run, setRun] = useState<Run | null>(null), [viewing, setViewing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function readSource(open = false) {
    if (!source) return;
    if (run) { if (open) setViewing(true); return; }
    setBusy(true); setError('');
    try { setRun(await request<Run>('run.get', { runId: source.sourceRunId })); if (open) setViewing(true); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  if (!source) return <small className="muted">复用来源未记录。</small>;
  const sample = run?.samples?.find(s => s.id === source.sourceSampleId);
  return <><details className="reuse-provenance" onToggle={e => { if (e.currentTarget.open && !run && !busy) void readSource(); }}><summary>复用来源 · {source.sourceModel ?? '模型未记录'} · 候选版本 {source.sourceCandidateVersion}</summary><dl>
    <dt>来源运行</dt><dd>{run ? String(run.name ?? run.model ?? '未命名运行') : busy ? '正在读取名称…' : '名称暂不可用'}</dd><dt>完成时间</dt><dd>{new Date(source.sourceCompletedAt).toLocaleString('zh-CN')}</dd><dt>来源模型</dt><dd>{source.sourceModel ?? '未记录'}</dd><dt>候选版本</dt><dd>{source.sourceCandidateVersion}</dd>
  </dl><Button busy={busy} onClick={() => void readSource(true)}>查看来源运行</Button><details><summary>诊断定位信息</summary><dl><dt>来源运行 ID</dt><dd>{source.sourceRunId}</dd><dt>来源样本 ID</dt><dd>{source.sourceSampleId}</dd><dt>来源素材 ID</dt><dd>{source.sourceAssetId}</dd><dt>原始请求 ID</dt><dd>{source.sourceAttemptId}</dd></dl><p>模型版本</p><pre>{JSON.stringify(source.sourceModelVersion, null, 2)}</pre><p>匹配记录：{source.reuseFingerprint}</p></details>{error && <p className="inline-error">{error}</p>}</details>
    {viewing && run && <Modal title="复用来源运行" onClose={() => setViewing(false)}><div className="form-stack reuse-source-run"><h3>{String(run.name ?? run.model ?? '来源运行')}</h3><p>{statusNames[run.status] ?? run.status} · 原运行已发送 {run.statistics?.requestsUsed ?? '未记录'} 次请求</p><Notice>以上是来源运行的历史请求数。本次命中的复用样本没有新增模型请求。</Notice>{sample ? <p>来源样本：{sample.name ?? '名称未记录'} · {statusNames[sample.status] ?? sample.status} · 候选版本 {sample.candidateVersion ?? '未记录'}</p> : <p className="muted">来源样本未包含在本次读取的运行明细中，可按记录的样本 ID 继续追溯。</p>}<p>完成时间：{new Date(source.sourceCompletedAt).toLocaleString('zh-CN')} · 模型：{source.sourceModel ?? '未记录'}</p><p>本次引用的来源候选版本：{source.sourceCandidateVersion}</p><details><summary>诊断定位信息</summary><p>运行 ID：{run.id}</p><p>样本 ID：{source.sourceSampleId}</p><p>原始请求 ID：{source.sourceAttemptId}</p></details><div className="modal-actions"><Button onClick={() => setViewing(false)}>关闭来源运行</Button></div></div></Modal>}
  </>;
}
