import { app, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function checkRelease7a(window: BrowserWindow, output: string, engine: any): Promise<void> {
  const diagnostics = await engine.request('diagnostics.get');
  const report: Record<string, unknown> = { packaged: app.isPackaged, appVersion: app.getVersion(), engineState: engine.status.state, databaseVersion: diagnostics.databaseVersion };
  const js = (code: string) => window.webContents.executeJavaScript(code);
  const request = (command: string, payload: Record<string, unknown> = {}) => js(`window.autoLabel.request(${JSON.stringify(command)},${JSON.stringify(payload)})`);
  const wait = async (expression: string) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error('7A 页面未就绪：' + expression);
  };
  const clickButton = async (label: string) => {
    await wait(`[...document.querySelectorAll('button')].some(button=>button.innerText.trim()===${JSON.stringify(label)}&&!button.disabled)`);
    await js(`[...document.querySelectorAll('button')].find(button=>button.innerText.trim()===${JSON.stringify(label)}&&!button.disabled).click()`);
  };
  window.setContentSize(1440, 940); window.show();
  await wait(`!!document.querySelector('.getting-started button') && !document.querySelector('.connection-banner')`);
  report.runtime = await request('local.runtime.get');
  report.modelCount = (await request('local.model.list')).total;
  report.capabilities = await request('flow.capabilities');
  if (process.env.AUTOLABEL_RELEASE_POSE_DISPLAY === '1') {
    // 只读取已完成的隔离 Pose 结果；副本不配置解释器，也不恢复模型执行授权。
    assert.equal(report.databaseVersion, 4); assert.equal((report.runtime as any).configured, false);
    const audit = async () => {
      const runs = await request('run.list'); let requests = 0, attempts = 0;
      for (const run of runs) {
        requests += (await request('run.get', { runId: run.id })).statistics.requestsUsed;
        attempts += (await request('run.attempts', { runId: run.id })).length;
      }
      return { runIds: runs.map((run: any) => run.id).sort(), requests, attempts };
    };
    const before = await audit();
    const run = await request('run.get', { runId: '6946ec65-018f-4180-b936-2da7f3116158' });
    const result = await request('run.result.get', { resultId: run.samples[0].resultId });
    const source = result.provenance.reusedFrom;
    assert.equal(result.source, 'reuse'); assert.equal(source.source, 'local');
    assert.equal(source.sourceRunId, 'a6840493-a659-422c-8aa2-11a526d7a92f');
    assert.equal(source.sourceResultId, '55a99813-56cc-4a14-826a-a79389819b68');
    assert.equal(source.sourceModelVersion, 1); assert.equal(source.sourceObservedBackend.kind, 'pytorch');
    assert.equal(source.sourceObservedBackend.device, 'cpu'); assert.equal(source.sourceAttemptId, undefined);
    await js(`document.querySelectorAll('.nav-item')[3].click()`); await clickButton('标注任务');
    await wait(`!!document.querySelector('.run-list .run-row')`); await js(`document.querySelector('.run-list .run-row').click()`);
    await clickButton('查看输入与结果');
    await wait(`document.querySelector('.actual-input-preview img')?.complete && document.querySelector('.actual-input-preview img')?.naturalWidth > 0 && document.querySelectorAll('.actual-input-preview svg circle').length > 0`);
    const preview = await js(`(()=>{const img=document.querySelector('.actual-input-preview img'),svg=document.querySelector('.actual-input-preview svg'),a=img.getBoundingClientRect(),b=svg.getBoundingClientRect();return {loaded:img.complete,width:img.naturalWidth,height:img.naturalHeight,circles:svg.querySelectorAll('circle').length,aspect:a.width/a.height,overlayDelta:Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y),Math.abs(a.width-b.width),Math.abs(a.height-b.height))}})()`);
    assert.equal(preview.width, 810); assert.equal(preview.height, 1080); assert.equal(preview.circles, 49);
    assert.ok(Math.abs(preview.aspect - 0.75) < .001); assert.ok(preview.overlayDelta < 1);
    await js(`document.activeElement?.blur()`);
    await new Promise(resolve => setTimeout(resolve, 350));
    await writeFile(output.replace(/\.json$/i, '-result.png'), (await window.webContents.capturePage()).toPNG());
    await js(`document.querySelector('dialog[open] [aria-label="关闭弹窗"]').click()`);
    await wait(`!!document.querySelector('.sample-table .input-reuse-source > summary')`);
    await js(`document.querySelector('.sample-table .input-reuse-source > summary').click()`); await clickButton('打开来源任务');
    await wait(`!!document.querySelector('.reuse-source-run')`);
    const provenanceVisible = await js(`(()=>{const e=document.querySelector('.reuse-source-run');return e.textContent.includes(${JSON.stringify(source.sourceRunId)})&&e.textContent.includes(${JSON.stringify(source.sourceResultId)})&&e.innerText.includes('模型固定版本 1')&&e.innerText.includes('PyTorch')&&e.innerText.includes('cpu')})()`);
    assert.equal(provenanceVisible, true);
    await new Promise(resolve => setTimeout(resolve, 350));
    await writeFile(output.replace(/\.json$/i, '-source.png'), (await window.webContents.capturePage()).toPNG());
    const after = await audit(); assert.deepEqual(after, before); assert.equal(after.requests, 0); assert.equal(after.attempts, 0);
    Object.assign(report, { passed: true, readOnly: true, newInferenceRuns: 0, before, after, preview, source, provenanceVisible });
    await writeFile(output, JSON.stringify(report, null, 2)); return;
  }
  await js(`document.querySelector('.getting-started button').click()`);
  await wait(`!!document.querySelector('.annotation-canvas image')`);
  const project = (await request('project.list'))[0];
  const assets = await request('asset.list', { projectId: project.id, limit: 1 });
  // 无 Python 配置时仍验证真实像素处理及固定媒体读取，不向包中附带测试模型。
  const input = { projectId: project.id, input: { source: 'project', selection: 'explicit', assetIds: [assets.items[0].id] },
    definition: { version: 1, name: '7A 安装包固定输入预览', steps: [{ id: 'transform.1', kind: 'transform', enabled: true,
      parameters: { operations: [{ kind: 'resize', width: 64, height: 64, fit: 'contain' }], background: '#ffffff' } }] } };
  report.preflight = await request('flow.preflight', input);
  const created = await request('flow.create', input);
  await wait(`window.autoLabel.request('flow.get',{flowRunId:${JSON.stringify(created.id)}}).then(run=>run.status==='completed')`);
  const finished = await request('flow.get', { flowRunId: created.id });
  const artifact = await request('flow.artifact', { artifactId: finished.steps[0].outputArtifactId, limit: 1 });
  report.flow = { status: finished.status, requestsUsed: finished.statistics.requestsUsed, artifactKind: artifact.kind, inputCount: artifact.total, inputId: artifact.items[0]?.inputId };
  await js(`document.querySelectorAll('.nav-item')[3].click()`);
  await clickButton('自动流程');
  await wait(`[...document.querySelectorAll('.flow-run-list button')].some(button=>button.innerText.includes('7A 安装包固定输入预览'))`);
  await js(`[...document.querySelectorAll('.flow-run-list button')].find(button=>button.innerText.includes('7A 安装包固定输入预览')).click()`);
  await clickButton('查看固定产物'); await clickButton('查看实际输入');
  await wait(`document.querySelector('.actual-input-preview img')?.complete && document.querySelector('.actual-input-preview img')?.naturalWidth > 0`);
  report.preview = await js(`(()=>{const image=document.querySelector('.actual-input-preview img');return {loaded:image.complete,width:image.naturalWidth,height:image.naturalHeight};})()`);
  await js(`(async()=>{await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  await writeFile(output.replace(/\.json$/i, '.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(output, JSON.stringify(report, null, 2));
}
