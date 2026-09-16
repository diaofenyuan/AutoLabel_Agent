import { app, type BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

export async function checkRelease6b(window: BrowserWindow, output: string, engine: any): Promise<void> {
  const diagnostics = await engine.request('diagnostics.get');
  const report: Record<string, unknown> = { packaged: app.isPackaged, appVersion: app.getVersion(), engineState: engine.status.state, databaseVersion: diagnostics.databaseVersion };
  const js = (code: string) => window.webContents.executeJavaScript(code);
  const request = (command: string, payload: Record<string, unknown> = {}) => js(`window.autoLabel.request(${JSON.stringify(command)},${JSON.stringify(payload)})`);
  const wait = async (expression: string) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error('6B 页面未就绪：' + expression);
  };
  const completed = async (runId: string) => {
    await wait(`window.autoLabel.request('run.get',{runId:${JSON.stringify(runId)}}).then(run=>run.status==='completed')`);
    return request('run.get', { runId });
  };
  // 示例只从「设置 → 示例」载入：首屏不再有示例横幅。
  const loadExample = async () => {
    await js(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='设置');item.click();})()`);
    await wait(`!!document.querySelector('.settings-tabs')`);
    await js(`[...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='示例').click()`);
    await wait(`!!document.querySelector('[aria-label="载入示例"]')`);
    await js(`document.querySelector('[aria-label="载入示例"]').click()`);
  };
  let requests = 0; let asset: any;
  // 安装包只检查一组本地协议调用及复用读取，完整策略和竞态已由专项覆盖。
  const server = createServer((incoming, response) => {
    incoming.resume(); incoming.on('end', () => {
      requests++; response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: 'release-fixture', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ assetId: asset.id, annotations: asset.annotations }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    window.setContentSize(1440, 940); window.show();
    await wait(`!!document.querySelector('.chat-home') && !document.querySelector('.connection-banner')`);
    await loadExample();
    await wait(`!!document.querySelector('.annotation-canvas image')`);
    const project = (await request('project.list'))[0];
    const assets = await request('asset.list', { projectId: project.id, limit: 1 });
    asset = await request('asset.get', { assetId: assets.items[0].id });
    // 流程编辑器已不占导航位，改用快速跳转进入。
    await js(`(async()=>{
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const input=document.querySelector('.command-search input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'流程编辑器');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    })()`);
    await wait(`!!document.querySelector('.flow-node')`);
    await js(`[...document.querySelectorAll('.flow-node')].find(node=>node.innerText.includes('API 标注')).click()`);
    await wait(`!!document.querySelector('.flow-inspector .reuse-policy')`);
    await js(`document.querySelector('.flow-inspector .reuse-policy>summary').click()`);
    report.policyDefaults = await js(`({reuseEnabled:document.querySelector('[aria-label="允许复用已有候选"]').checked,forceRerun:document.querySelector('[aria-label="强制重新请求模型"]').checked,maxAge:document.querySelector('[aria-label="复用结果有效期"]').value})`);
    const port = (server.address() as { port: number }).port;
    const provider = await request('provider.save', { name: '6B 安装包本地协议', baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'chat-completions' });
    await request('credential.set', { providerId: provider.id, key: 'isolated-release6b-fixture' });
    const input = { projectId: project.id, assetIds: [asset.id], providerId: provider.id, model: 'release-fixture', prompt: '输出基准图标注',
      maxRequests: 1, budgetScopeId: 'release6b-fixture', reuseEnabled: true, forceRerun: false, reuseMaxAgeSeconds: null };
    const first = await completed((await request('run.create', input)).id); assert.equal(first.requestsUsed, 1);
    const reused = await completed((await request('run.create', input)).id);
    report.firstRunId = first.id; report.requests = requests;
    report.reused = { requestsUsed: reused.requestsUsed, reused: reused.statistics.reused,
      sourceRunId: reused.samples[0].reusedFrom?.sourceRunId, attempts: (await request('run.attempts', { runId: reused.id })).length };
    await js(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='任务');
      if(!item)throw new Error('缺少任务导航项');item.click();})()`);
    await wait(`!!document.querySelector('.page-tasks') && !document.querySelector('.page-loading')`);
    await wait(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='标注任务')`);
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='标注任务').click()`);
    await wait(`!!document.querySelector('.run-list .run-row')`);
    await js(`document.querySelector('.run-list .run-row').click()`);
    await wait(`document.querySelector('.sample-table')?.innerText.includes('复用成功（本样本 0 请求）')`);
    report.readableResult = await js(`[...document.querySelectorAll('.run-counts>div')].some(e=>e.innerText.includes('成功中复用')&&e.querySelector('strong')?.innerText==='1')`);
    await js(`(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    await writeFile(output.replace(/\.json$/i, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, JSON.stringify(report, null, 2));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
