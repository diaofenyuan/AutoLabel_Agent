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
    // 在快照创建后换绑定，调度器会稳定把任务暂停在 credential_binding_changed。
    await api('credential.set', { providerId: pausedProvider.id, key: 'isolated-paused-second' });
    await runStatus(pausedRun.id, ['paused']);

    await gotoTasks(driver, '标注任务');
    await wait(`[...document.querySelectorAll('.run-list .run-row')].some(e=>e.innerText.includes('fixture-paused'))`);
    await js(`[...document.querySelectorAll('.run-list .run-row')].find(e=>e.innerText.includes('fixture-paused')).click()`); await wait(`!!document.querySelector('.run-detail')`);
    const controls = await js<Record<string, boolean>>(`(()=>Object.fromEntries([...document.querySelectorAll('.run-controls button')].map(b=>[b.innerText.trim(),!b.disabled])))()`);
    assert.equal(controls['暂停'], false); assert.equal(controls['恢复'], true); assert.equal(controls['取消'], true); assert.equal(controls['重试失败样本'], false);
    await button('恢复', "document.querySelector('.run-detail')"); await runStatus(pausedRun.id, ['paused']);
    await button('取消', "document.querySelector('.run-detail')"); const cancelled = await runStatus(pausedRun.id, ['cancelled']); assert.equal(cancelled.status, 'cancelled');

    const failedProvider = await api<any>('provider.save', { name: `任务控制失败重试-${Date.now()}`, baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: 'chat-completions', maxRetries: 0 });
    await api('credential.set', { providerId: failedProvider.id, key: 'isolated-run-control-fixture' });
    const failedRun = await api<any>('run.create', { projectId, assetIds: [asset.id], providerId: failedProvider.id, model: 'fixture-failed', prompt: '本地任务控制失败重试夹具', maxRequests: 2, concurrency: 1, forceRerun: true });
    await runStatus(failedRun.id, ['failed', 'completed_with_errors']);
    await button('刷新标注任务'); await wait(`[...document.querySelectorAll('.run-list .run-row')].some(e=>e.innerText.includes('fixture-failed'))`);
    await js(`[...document.querySelectorAll('.run-list .run-row')].find(e=>e.innerText.includes('fixture-failed')).click()`); await wait(`!!document.querySelector('.run-detail')`);
    await wait(`[...document.querySelectorAll('.run-controls button')].some(b=>b.innerText.trim()==='重试失败样本'&&!b.disabled)`);
    const beforeRetry = calls; await button('重试失败样本', "document.querySelector('.run-detail')"); await waitForServerCalls(beforeRetry);
    const afterRetry = await runStatus(failedRun.id, ['failed', 'completed_with_errors']);
    assert.ok(calls > beforeRetry);
    await writeFile(output, JSON.stringify({ passed: true, paused: { runId: pausedRun.id, resumeStayedPaused: true, cancelled: cancelled.status === 'cancelled', controls }, failedRetry: { runId: failedRun.id, callsBefore: beforeRetry, callsAfter: calls, status: afterRetry.status, retryDispatched: true } }, null, 2));
  } catch (error) {
    await writeFile(output, JSON.stringify({ passed: false, calls, error: error instanceof Error ? error.message : String(error), body: await js('document.body.innerText') }, null, 2));
    throw error;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
