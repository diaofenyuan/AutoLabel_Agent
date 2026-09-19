import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 直达标注验收：不依赖对话模型也能开始标注。
 *
 * 背景：对话里的一切操作都要求一个「能调工具的对话模型」，没配或模型不支持工具调用时，
 * 连「用内置模型标注（无需 API Key）」都走不通——发送直接被拦截。本次验收断言：
 * 1. 没有配置对话模型时，发送仍被明确拦下（原路径没被放宽）；
 * 2. 输入卡的「开始标注」能直接用**标注模型**建任务，全程不经过对话；
 * 3. 结果落成候选（candidate），人工已确认的内容不受影响；
 * 4. 项目没有类别时，弹层给出原因并禁用开始按钮，而不是让用户点了才发现。
 *
 * 夹具是一个回环服务商：只回一份合法标注 JSON，classId 用项目里真实存在的类别。
 */
export async function checkDesktopDirectRun(window: BrowserWindow, output: string): Promise<void> {
  let calls = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    calls++;
    const body = raw ? JSON.parse(raw) : {};
    let assetId: string | undefined;
    for (const message of body.messages ?? []) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== 'text') continue;
        try { const parsed = JSON.parse(part.text); if (parsed?.role === 'target') assetId = parsed.assetId; } catch { /* 非 JSON 的文本段忽略 */ }
      }
    }
    const content = JSON.stringify({ assetId, annotations: [{ id: 'direct-run-fixture', classId: 'vehicle', type: 'detect', bbox: { x: 221, y: 483, width: 537, height: 350 } }] });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '直达标注验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  const fixtures = path.join(userData, 'fixtures', `direct-${Date.now()}`);
  await mkdir(fixtures, { recursive: true });
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  async function waitFor(expression: string, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}`);
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

    // ===== 先配好「标注模型」，但**不配对话模型** =====
    const address = server.address() as { port: number };
    const provider = await api<{ id: string }>('provider.save', {
      name: `直达标注夹具-${Date.now()}`, baseUrl: `http://127.0.0.1:${address.port}/v1`,
      protocol: 'chat-completions', timeoutMs: 20000, maxRetries: 0,
    });
    await api('credential.set', { providerId: provider.id, key: 'isolated-direct-run' });
    const settings = await api<Record<string, unknown>>('settings.get');
    await api('settings.save', { settings: { ...settings, annotationProviderId: provider.id, annotationModel: 'fixture-direct', chatProviderId: '', chatModel: '' } });
    // 偏好是开机读入的：改完设置要重新载入界面，才能拿到新的标注模型。
    window.webContents.reload();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const reloaded = await api<Record<string, unknown>>('settings.get');
    assert.equal(reloaded.chatProviderId, '', '本次验收必须保持未配置对话模型');

    // ===== 载入示例项目：没有对话模型，发送仍然被拦 =====
    await js(`([...document.querySelectorAll('.onboarding-lane button')].find(node=>node.innerText.trim()==='载入示例项目')).click()`);
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    await js(`(()=>{const e=document.querySelector('.chat-panel textarea');e.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'帮我把这些图标注一下');
      e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    // 等输入真的进了 React 状态、发送键变为可用再点，避免点了禁用按钮什么都不发生。
    await waitFor(`document.querySelector('.chat-panel textarea').value.length>0`);
    await waitFor(`!document.querySelector('.chat-panel .send-button').disabled`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await js(`document.querySelector('.chat-panel .send-button').click()`);
    await waitFor(`[...document.querySelectorAll('.toast')].some(node=>node.innerText.includes('对话'))`, 20000);
    const sendBlocked = await js<string>(`[...document.querySelectorAll('.toast')].map(node=>node.innerText).join(' | ')`);
    assert.ok(sendBlocked.includes('对话'), `没有对话模型时发送应被明确拦下，实际提示：${sendBlocked}`);
    checks.push({ check: 'direct-run-chat-still-blocked', toast: sendBlocked.replace(/\s+/g, ' ') });

    // ===== 直达标注：用标注模型直接建任务，不经过对话 =====
    const before = calls;
    await js(`document.querySelector('.chat-panel .direct-run-trigger').click()`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover')`);
    const panel = await js<{ text: string; startDisabled: boolean }>(`(()=>{const p=document.querySelector('.direct-run .picker-popover');
      const start=[...p.querySelectorAll('button')].find(b=>b.innerText.trim()==='开始标注');
      return { text: p.innerText.replace(/\\s+/g,' ').slice(0,240), startDisabled: Boolean(start?.disabled) };})()`);
    assert.ok(panel.text.includes('fixture-direct'), `弹层应显示当前标注模型，实际：${panel.text}`);
    assert.equal(panel.startDisabled, false, '前置齐全时开始按钮应可用');
    await button('开始标注', `document.querySelector('.direct-run .picker-popover')`);
    await waitFor(`!document.querySelector('.direct-run .picker-popover')`);
    // 运行必须有真实请求发生：夹具服务只回合法 JSON，不依赖调度时机。
    await waitFor(`window.autoLabel.request('run.list',{}).then(list=>list.some(run=>run.model==='fixture-direct'))`, 20000);
    const runs = await api<Array<{ id: string; model: string; status: string }>>('run.list', {});
    const direct = runs.find(item => item.model === 'fixture-direct');
    assert.ok(direct, `应创建使用标注模型的运行，实际：${json(runs.map(item => item.model))}`);
    const settled = await runStatus(direct!.id, ['completed', 'completed_with_errors', 'needs_attention', 'cancelled']);
    assert.equal(settled.statistics.succeeded, 1, `直达标注应成功一张，实际：${json(settled.statistics)}`);
    assert.ok(calls > before, '夹具服务应收到真实请求');
    const projectId = (await api<Array<{ id: string }>>('project.list', {}))[0].id;
    const assets = await api<{ items: Array<{ id: string; status: string; annotations?: unknown[] }> }>('asset.list', { projectId, limit: 100 });
    const history = await api<Array<{ version: number; source: string }>>('annotation.history', { assetId: assets.items[0].id });
    // 示例素材自带预置人工标注：结果只能作为候选版本存在，人工内容不能被覆盖。
    assert.ok(history.some(item => item.source === 'api'), `应写入候选版本，实际版本来源：${json(history.map(item => item.source))}`);
    assert.ok((assets.items[0].annotations?.length ?? 0) >= 2, `人工预置标注不应被覆盖，实际：${json(assets.items[0].annotations?.length)}`);
    checks.push({ check: 'direct-run-creates-run-without-chat', runId: direct!.id, model: direct!.model, status: settled.status,
      versionSources: history.map(item => item.source), humanAnnotations: assets.items[0].annotations?.length ?? 0 });

    // ===== 没有类别时必须说清原因并禁用开始 =====
    // 用界面内的「新建项目」建一个空项目：不碰系统文件框，落点更稳。
    await js(`[...document.querySelectorAll('.sidebar-scroll .nav-item')].find(b=>b.innerText.trim()==='新对话').click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
    await js(`document.querySelector('.sidebar-group-more[aria-label="新建项目"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`);
    const dialog = "document.querySelector('dialog[open]')";
    await js(`(()=>{const e=${dialog}.querySelector('input[placeholder="给项目起个名字"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(`无类别-${Date.now()}`)});
      e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await button('创建项目', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    await waitFor(`!!document.querySelector('.chat-panel .direct-run-trigger')`);
    await js(`document.querySelector('.chat-panel .direct-run-trigger').click()`);
    await waitFor(`!!document.querySelector('.direct-run .picker-popover')`);
    const blocked = await js<{ text: string; startDisabled: boolean }>(`(()=>{const p=document.querySelector('.direct-run .picker-popover');
      const start=[...p.querySelectorAll('button')].find(b=>b.innerText.trim()==='开始标注');
      return { text: p.innerText.replace(/\\s+/g,' '), startDisabled: Boolean(start?.disabled) };})()`);
    assert.ok(blocked.text.includes('还没有类别'), `没有类别时应说明原因，实际：${blocked.text.slice(0, 200)}`);
    assert.equal(blocked.startDisabled, true, '没有类别时开始按钮应禁用');
    checks.push({ check: 'direct-run-blocks-without-classes', reason: blocked.text.slice(0, 160) });
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  } finally {
    server.close();
  }
}
