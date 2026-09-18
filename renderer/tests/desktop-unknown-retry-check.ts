import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 结果未知的补救出口验收。
 *
 * 走查结论是：4K 视频 23 帧里 16 帧停在「结果未知」，`failed=0` 让「重试失败样本」永远点不亮，
 * 界面内没有任何出口；同一个 `needs_attention` 状态在对话区完全不可见。本次验收断言：
 * 1. `failed=0 / unknown>0` 时「重试未知样本」可用，「重试失败样本」保持禁用；
 * 2. 运行终态为「需要处理」时给出三个可点击的下一步；
 * 3. 点「重试未知样本」先弹二次确认，**未确认前不发任何请求**（原请求可能已计费）；
 * 4. 确认后引擎收到 `retryUnknown: true`（按 `run.retry` 事件载荷断言）。
 *
 * 夹具用挂起不响应的回环服务 + 1 秒超时稳定产生 `provider_timeout`（引擎把它判为 unknown、不可自动重试）。
 * 这里不依赖「重发后样本一定回到成功」：超时夹具下重发大概率再次超时，断言改为校验真实发出的载荷，
 * 否则测试会变成在赌调度时机。确认前的零请求断言足以证明这条路径确实由人发起。
 */
export async function checkDesktopUnknownRetry(window: BrowserWindow, output: string): Promise<void> {
  let calls = 0;
  // 只挂住回环夹具的响应，不结束连接：引擎按 timeoutMs 判为结果未知。
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => { request.resume(); request.on('end', () => { calls++; held.push(response); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '结果未知重试验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  const batch = `unknown-${Date.now()}`;
  const fixtures = path.join(userData, 'fixtures', batch);
  await mkdir(fixtures, { recursive: true });
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  async function waitFor(expression: string, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}（当前弹窗文本：${await js<string>(`${dialog}?${dialog}.innerText.slice(0,400):'(无弹窗)'`)}）`);
  }
  async function button(text: string, scope = 'document') {
    await waitFor(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
    await js(`([...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)})).click()`);
  }
  const runStatus = async (runId: string, states: string[]) => {
    await waitFor(`window.autoLabel.request('run.get',{runId:${json(runId)}}).then(r=>${json(states)}.includes(r.status))`, 40000);
    return api<any>('run.get', { runId });
  };
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const picture = path.join(fixtures, 'frame-1.png');
    await copyFile(path.resolve('renderer/design/codex-flow.png'), picture);
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'images', paths: [picture] }]));
    await button('导入图片');
    // 项目必须由用户确认归属：导入前先过确认框，名称已按文件夹名预填。
    await button('导入并继续');
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    const created = (await api<Array<{ id: string; name: string }>>('project.list')).find(item => item.name === batch);
    assert.ok(created, `欢迎页导入应建立名为 ${batch} 的项目`);
    const projectId = created!.id;
    const listed = await api<{ items: Array<{ id: string }> }>('asset.list', { projectId, limit: 100 });
    await api('project.update', { projectId, classes: [{ id: 'figure', name: '粉色手办', color: '#e0559b' }] });

    const address = server.address() as { port: number };
    const provider = await api<{ id: string }>('provider.save', {
      name: `未知结果重试夹具-${Date.now()}`, baseUrl: `http://127.0.0.1:${address.port}/v1`,
      protocol: 'chat-completions', timeoutMs: 1000, maxRetries: 0,
    });
    await api('credential.set', { providerId: provider.id, key: 'isolated-unknown-retry' });
    // 凭据在创建后不再改动：这里要靠真实超时进入 unknown，而不是靠暂停在凭据变更上。
    const run = await api<{ id: string }>('run.create', { projectId, assetIds: listed.items.map(item => item.id), providerId: provider.id, model: 'fixture-unknown', prompt: '未知结果重试夹具', maxRequests: 5, concurrency: 1, forceRerun: true });
    const settled = await runStatus(run.id, ['needs_attention']);
    assert.equal(settled.statistics.failed, 0, `超时应计为未知而不是失败，实际：${json(settled.statistics)}`);
    assert.ok(settled.statistics.unknown > 0, `应有结果未知样本，实际：${json(settled.statistics)}`);

    // ===== 任务区：unknown>0 / failed=0 时的按钮可用性与下一步 =====
    await js(`[...document.querySelectorAll('.sidebar-bottom .nav-item')].find(b=>b.innerText.trim()==='任务').click()`);
    await waitFor(`!!document.querySelector('.task-kind-tabs')`);
    await button('标注任务');
    // 列表由事件驱动刷新，可能比引擎状态晚一拍；等这一行自己写出「需要处理」再点，
    // 否则点开的是落定之前的旧状态，下面的下一步区块会「不存在」。
    await waitFor(`[...document.querySelectorAll('.run-list .run-row')].some(e=>e.innerText.includes('fixture-unknown')&&e.innerText.includes('需要处理'))`);
    await js(`[...document.querySelectorAll('.run-list .run-row')].find(e=>e.innerText.includes('fixture-unknown')).click()`);
    await waitFor(`!!document.querySelector('.run-detail')`);
    const controls = await js<Record<string, boolean>>(`(()=>Object.fromEntries([...document.querySelectorAll('.run-controls button')].map(b=>[b.innerText.trim(),!b.disabled])))()`);
    assert.equal(controls['重试失败样本'], false, 'failed=0 时「重试失败样本」不应可用');
    const unknownLabel = Object.keys(controls).find(label => label.startsWith('重试未知样本'));
    assert.ok(unknownLabel, `没有「重试未知样本」入口，实际按钮：${json(Object.keys(controls))}`);
    assert.equal(controls[unknownLabel!], true, 'unknown>0 时「重试未知样本」应可用');
    const nextText = await js<string>(`document.querySelector('.run-next-steps').innerText`);
    for (const action of ['重试未知样本', '去导出', '在对话里说明怎么处理']) assert.ok(nextText.includes(action), `「需要处理」应给出「${action}」，实际：${nextText}`);
    assert.ok(await js<boolean>(`document.querySelector('.run-detail').innerText.includes('默认不重发')`), '应说明未知样本默认不重发');
    checks.push({ check: 'unknown-retry-entry', failed: settled.statistics.failed, unknown: settled.statistics.unknown, nextSteps: 3 });

    // ===== 二次确认：未确认前一个请求都不能发出去 =====
    const beforeConfirm = calls;
    await js(`[...document.querySelectorAll('.run-detail button')].find(b=>b.innerText.trim().startsWith('重试未知样本')).click()`);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('结果未知')`);
    const confirmText = await js<string>(`${dialog}.innerText`);
    assert.ok(confirmText.includes('计费') || confirmText.includes('处理'), `确认弹窗应说明重发代价，实际：${confirmText.slice(0, 300)}`);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(calls, beforeConfirm, '确认前不应发出任何重发请求');
    await button('取消', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    assert.equal(calls, beforeConfirm, '取消后也不应发出重发请求');
    checks.push({ check: 'unknown-retry-needs-confirmation', callsBeforeConfirm: beforeConfirm, callsAfterCancel: calls });

    // ===== 确认后：引擎必须收到 retryUnknown: true =====
    await js(`[...document.querySelectorAll('.run-detail button')].find(b=>b.innerText.trim().startsWith('重试未知样本')).click()`);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('结果未知')`);
    await button('发送重试请求（含未知）', dialog);
    await waitFor(`window.autoLabel.request('event.list',{after:0}).then(list=>list.some(e=>e.type==='run.retry'&&e.runId===${json(run.id)}&&e.payload.retryUnknown===true))`, 30000);
    const events = await api<Array<{ type: string; runId?: string; payload: Record<string, unknown> }>>('event.list', { after: 0 });
    const retryEvent = events.filter(event => event.type === 'run.retry' && event.runId === run.id).at(-1);
    assert.equal(retryEvent?.payload.retryUnknown, true, `run.retry 事件必须带 retryUnknown:true，实际：${json(retryEvent)}`);
    checks.push({ check: 'unknown-retry-dispatched', retryUnknown: true, calls: calls });
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, calls, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  } finally {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
