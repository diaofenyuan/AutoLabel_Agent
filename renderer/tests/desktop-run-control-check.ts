import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { gotoTasks, openExampleCanvas } from './desktop-navigation';

// 只使用回环失败夹具与缺少凭据的本地状态，不触碰真实模型或用户目录。
export async function checkDesktopRunControls(window: BrowserWindow, output: string): Promise<void> {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      calls++;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '本地任务控制验收夹具故意失败' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const json = JSON.stringify;
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}) => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const wait = async (expression: string, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await js<boolean>(expression)) return; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error(`任务控制界面等待超时：${expression}`);
  };
  const button = async (label: string, scope = 'document') => {
    await wait(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`);
    await js(`([...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)})).click()`);
  };
  const runStatus = async (runId: string, states: string[]) => {
    await wait(`window.autoLabel.request('run.get',{runId:${json(runId)}}).then(r=>${json(states)}.includes(r.status))`, 20000);
    return api<any>('run.get', { runId });
  };
  async function waitForServerCalls(after: number) {
    const end = Date.now() + 20000;
    while (Date.now() < end) { if (calls > after) return; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error(`本地失败夹具请求未增加：${after} -> ${calls}`);
  }
  try {
    window.show();
    await wait(`!!document.querySelector('.onboarding-lanes button')&&!document.querySelector('.connection-banner')`);
    const driver = { js, wait };
    const asset = await api<any>('asset.get', { assetId: await openExampleCanvas(driver) });
    const projectId = String(asset.projectId);
    const address = server.address() as { port: number };
    const pausedProvider = await api<any>('provider.save', { name: `任务控制缺失凭据-${Date.now()}`, baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: 'chat-completions', maxRetries: 0 });
    await api('credential.set', { providerId: pausedProvider.id, key: 'isolated-paused-first' });
    const pausedRun = await api<any>('run.create', { projectId, assetIds: [asset.id], providerId: pausedProvider.id, model: 'fixture-paused', prompt: '本地任务控制暂停夹具', maxRequests: 1, concurrency: 1, forceRerun: true });
    await api('chat.history.ensure', { sessionId: 'task-session-check', projectId, title: '任务回跳验收' });
    await js(`localStorage.setItem('autolabel.taskOrigins',${json(JSON.stringify({ [pausedRun.id]: 'task-session-check' }))})`);
    // 在快照创建后换绑定，调度器会稳定把任务暂停在 credential_binding_changed。
    await api('credential.set', { providerId: pausedProvider.id, key: 'isolated-paused-second' });
    await runStatus(pausedRun.id, ['paused']);

    await gotoTasks(driver, '标注任务');
    const taskKinds = await js<{ group: string; pressed: string[] }>(`(()=>{const group=document.querySelector('.task-kind-tabs');return {group:group?.getAttribute('aria-label')??'',pressed:[...document.querySelectorAll('.task-kind-tabs button[aria-pressed="true"]')].map(node=>node.innerText.trim())};})()`);
    assert.equal(taskKinds.group, '任务类型');
    assert.deepEqual(taskKinds.pressed, ['标注任务']);
    const taskFilters = await js<{ group: string; pressed: string[] }>(`(()=>{const group=[...document.querySelectorAll('.section-toolbar [role="group"]')].find(node=>node.getAttribute('aria-label')==='任务状态筛选');return {group:group?.getAttribute('aria-label')??'',pressed:[...group?.querySelectorAll('button[aria-pressed="true"]')??[]].map(node=>node.innerText.trim())};})()`);
    assert.equal(taskFilters.group, '任务状态筛选');
    assert.deepEqual(taskFilters.pressed, ['全部任务']);
    await wait(`[...document.querySelectorAll('.run-list .run-row')].some(e=>e.innerText.includes('fixture-paused'))`);
    await js(`(()=>{const input=document.querySelector('.tasks-page .search-field input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;setter?.call(input,'自动标注 · fixture-paused');input?.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(`[...document.querySelectorAll('.run-list .run-row')].length===1&&document.querySelector('.run-list .run-row')?.innerText.includes('fixture-paused')`);
    await js(`(()=>{const input=document.querySelector('.tasks-page .search-field input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;setter?.call(input,'');input?.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(`[...document.querySelectorAll('.run-list .run-row')].some(e=>e.innerText.includes('fixture-paused'))`);
    await js(`[...document.querySelectorAll('.run-list .run-row')].find(e=>e.innerText.includes('fixture-paused')).click()`); await wait(`!!document.querySelector('.run-detail')`);
    assert.ok(await js<boolean>(`!!document.querySelector('[aria-label="回到发起任务的会话"]')`), '任务来源会话应提供回跳入口');
    const controls = await js<Record<string, boolean>>(`(()=>Object.fromEntries([...document.querySelectorAll('.run-controls button')].map(b=>[b.innerText.trim(),!b.disabled])))()`);
    assert.equal(controls['暂停'], false); assert.equal(controls['恢复'], true); assert.equal(controls['取消'], true); assert.equal(controls['重试失败样本'], false);
    await button('恢复', "document.querySelector('.run-detail')"); await runStatus(pausedRun.id, ['paused']);
    await button('取消', "document.querySelector('.run-detail')"); const cancelled = await runStatus(pausedRun.id, ['cancelled']); assert.equal(cancelled.status, 'cancelled');

    const failedProvider = await api<any>('provider.save', { name: `任务控制失败重试-${Date.now()}`, baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: 'chat-completions', maxRetries: 0 });
    await api('credential.set', { providerId: failedProvider.id, key: 'isolated-run-control-fixture' });
    const failedRun = await api<any>('run.create', { projectId, assetIds: [asset.id], providerId: failedProvider.id, model: 'fixture-failed', prompt: '本地任务控制失败重试夹具', maxRequests: 2, concurrency: 1, forceRerun: true });
    await runStatus(failedRun.id, ['failed', 'completed_with_errors']);
    await wait(`window.autoLabel.request('run.list',{}).then(list=>list.some(run=>run.id===${json(failedRun.id)}))`, 20000);
    await button('刷新标注任务'); await wait(`[...document.querySelectorAll('.run-list .run-row')].some(e=>e.innerText.includes('fixture-failed'))`);
    await js(`[...document.querySelectorAll('.run-list .run-row')].find(e=>e.innerText.includes('fixture-failed')).click()`); await wait(`document.querySelector('.run-detail')?.getAttribute('data-status')==='completed_with_errors'||document.querySelector('.run-detail')?.getAttribute('data-status')==='failed'`);
    assert.ok(await js<boolean>(`[...document.querySelectorAll('.sample-failure-reason')].some(node=>node.textContent?.trim())`), '失败样本应显示引擎返回的原因');
    await wait(`[...document.querySelectorAll('.run-controls button')].some(b=>b.innerText.trim()==='重试失败样本'&&!b.disabled)`);
    const beforeRetry = calls; await button('重试失败样本', "document.querySelector('.run-detail')"); await waitForServerCalls(beforeRetry);
    const afterRetry = await runStatus(failedRun.id, ['failed', 'completed_with_errors']);
    assert.ok(calls > beforeRetry);
    // 连续切换两条任务，确认详情最终跟随最后一次点击，且行级加载态正常收敛。
    const pausedRow = `[...document.querySelectorAll('.run-list .run-row')].find(e=>e.innerText.includes('fixture-paused'))`;
    const failedRow = `[...document.querySelectorAll('.run-list .run-row')].find(e=>e.innerText.includes('fixture-failed'))`;
    await js(`${pausedRow}.click();${failedRow}.click()`);
    await wait(`document.querySelector('.run-detail')?.getAttribute('data-status')==='failed'||document.querySelector('.run-detail')?.getAttribute('data-status')==='completed_with_errors'`);
    await new Promise(resolve => setTimeout(resolve, 600));
    const latestSelectionWon = await js<boolean>(`['failed','completed_with_errors'].includes(document.querySelector('.run-detail')?.getAttribute('data-status')??'')`);
    assert.equal(latestSelectionWon, true, '较早返回的任务详情不能覆盖最近一次点击');
    await wait(`!document.querySelector('.run-row[aria-busy="true"]')`);
    await writeFile(output.replace(/\.json$/, '-desktop.png'), (await window.webContents.capturePage()).toPNG());
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await new Promise(resolve => setTimeout(resolve, 250));
    await writeFile(output.replace(/\.json$/, '-mobile.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    window.webContents.debugger.detach();
    await js(`document.querySelector('[aria-label="关闭任务详情"]')?.click()`);
    await wait(`!document.querySelector('.run-detail')`);
    await writeFile(output, JSON.stringify({ passed: true, taskKinds, taskFilters, searchByName: true, failureReasonVisible: true, latestTaskSelectionWins: latestSelectionWon, paused: { runId: pausedRun.id, resumeStayedPaused: true, cancelled: cancelled.status === 'cancelled', controls }, failedRetry: { runId: failedRun.id, callsBefore: beforeRetry, callsAfter: calls, status: afterRetry.status, retryDispatched: true } }, null, 2));
  } catch (error) {
    await writeFile(output, JSON.stringify({ passed: false, calls, error: error instanceof Error ? error.message : String(error), body: await js('document.body.innerText') }, null, 2));
    throw error;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
