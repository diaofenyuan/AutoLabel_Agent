import { app, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkRelease6a(window: BrowserWindow, output: string, engine: any, grants: any, userData: string): Promise<void> {
  const diagnostics = await engine.request('diagnostics.get');
  const report: Record<string, unknown> = { packaged: app.isPackaged, appVersion: app.getVersion(), engineState: engine.status.state, databaseVersion: diagnostics.databaseVersion };
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('6A 页面入口未就绪');
  };
  const request = (command: string, payload: Record<string, unknown> = {}) => window.webContents.executeJavaScript(`window.autoLabel.request(${JSON.stringify(command)},${JSON.stringify(payload)})`);
  // 示例只从「设置 → 示例」载入；载入后落到该项目的会话。
  const loadExample = async () => {
    await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='设置');item.click();})()`);
    await waitFor(`!!document.querySelector('.settings-tabs')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='示例').click()`);
    await waitFor(`!!document.querySelector('[aria-label="载入示例"]')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="载入示例"]').click()`);
    // 载入示例自己会跳到该项目的会话：等它落定再导航，否则后面的跳转会被它覆盖。
    await waitFor(`!!document.querySelector('.page-chat') && !document.querySelector('.page-loading')`);
  };
  const waitRun = async (flowRunId: string, expected: string[]) => {
    const deadline = Date.now() + 10000; let run: any;
    do { run = await request('flow.get', { flowRunId }); if (expected.includes(run.status)) return run; if (run.status === 'failed') throw new Error(JSON.stringify(run.steps)); await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
    throw new Error('流程状态未收敛：' + JSON.stringify(run));
  };
  window.show();
  await waitFor(`!!document.querySelector('.chat-home') && !document.querySelector('.connection-banner')`);
  await loadExample();
  await waitFor(`!!document.querySelector('.chat-panel') && !document.querySelector('.page-loading')`);
  const projects = await request('project.list'); const project = projects[0];
  const assets = await request('asset.list', { projectId: project.id, limit: 1 });
  const asset = await request('asset.get', { assetId: assets.items[0].id });
  await request('annotation.save', { assetId: asset.id, annotations: asset.annotations, baseVersion: asset.version, confirm: true });
  const resources = await request('resource.list', { kind: 'prompt' }); report.resourceRead = Array.isArray(resources);
  report.capabilities = await request('flow.capabilities');
  const outputDir = path.join(userData, 'release-flow-output'); await mkdir(outputDir, { recursive: true }); await grants.add(outputDir, 'directory');
  const definition = { version: 1, name: '6A 安装包人工检查链路', steps: [
    { id: 'filter.1', kind: 'filter', enabled: true, parameters: { assetIds: [asset.id], minWidth: 1 } },
    { id: 'review.1', kind: 'review', enabled: true, parameters: { buildIssues: false, waitForHuman: true } },
    { id: 'export.1', kind: 'export', enabled: true, parameters: { outputDir, trainRatio: 0.8, onlyConfirmed: true, annotationSelection: 'protected' } },
  ] };
  const input = { projectId: project.id, definition, input: { source: 'project', selection: 'explicit', assetIds: [asset.id] } };
  report.preflight = await request('flow.preflight', input);
  const created = await request('flow.create', input);
  const paused = await waitRun(created.id, ['paused', 'needs_attention']);
  report.manualGate = !paused.steps.find((step: any) => step.stepId === 'export.1')?.outputArtifactId;
  try { await request('flow.resume', { flowRunId: created.id }); } catch { /* 没有人工确认时，引擎应继续保留人工 gate。 */ }
  const stillPaused = await request('flow.get', { flowRunId: created.id });
  report.gateWithoutAcknowledgement = ['paused', 'needs_attention'].includes(stillPaused.status) && !stillPaused.steps.find((step: any) => step.stepId === 'export.1')?.outputArtifactId;
  await request('flow.resume', { flowRunId: created.id, acknowledgeReviewStepId: 'review.1' });
  const finished = await waitRun(created.id, ['completed', 'completed_with_errors']);
  const artifactId = finished.steps.find((step: any) => step.stepId === 'export.1')?.outputArtifactId;
  const artifact = await request('flow.artifact', { artifactId, limit: 1 });
  report.flow = { status: finished.status, requestsUsed: finished.statistics.requestsUsed, artifactKind: artifact.kind, exportId: artifact.exportId };
  await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='任务');
    if(!item)throw new Error('缺少任务导航项');item.click();})()`);
  await waitFor(`!!document.querySelector('.page-tasks') && !document.querySelector('.page-loading')`);
  await waitFor(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='自动流程')`);
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='自动流程').click()`);
  await waitFor(`[...document.querySelectorAll('.flow-run-list button')].some(b=>b.innerText.includes('6A 安装包人工检查链路'))`);
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('.flow-run-list button')].find(b=>b.innerText.includes('6A 安装包人工检查链路')).click()`);
  await waitFor(`!!document.querySelector('.flow-run-list button.selected')`);
  await window.webContents.executeJavaScript(`(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  await writeFile(output.replace(/\.json$/i, '.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(output, JSON.stringify(report, null, 2));
}
