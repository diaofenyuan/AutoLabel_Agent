import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

// 本地协议夹具用于核对复用是否真的少发请求，不代表外部模型的标注质量。
/**
 * 复用来源与事件名可读性验收。
 *
 * 当前状态：跑不通——主体（配置复用策略、预检、跑完整流程）依赖流程编排页，
 * 而流程改由对话发起后该页已从界面移除（.flow-node / 移除步骤 / 预检当前流程 均已不存在）；
 * 剩下的展示分支要看的数据也正由那段流程产出。要恢复得先用接口造出流程运行，再断言界面上复用来源是否可读。
 */
export async function checkDesktopReuse(window: BrowserWindow, output: string): Promise<void> {
  let calls = 0, capabilityCalls = 0;
  const checks: unknown[] = [], json = JSON.stringify;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); let assetId = '';
    for (const part of (body.messages ?? []).flatMap((m: any) => Array.isArray(m.content) ? m.content : [])) if (part.type === 'text') try { const value = JSON.parse(part.text); if (value.role === 'target') assetId = value.assetId; } catch { /* 普通提示词不包含结构化目标。 */ }
    if (!assetId) { capabilityCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(json({ model: 'fixture-reuse', choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] })); return; }
    calls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(json({ model: 'fixture-reuse', choices: [{ message: { role: 'assistant', content: json({ assetId, annotations: [{ id: 'local-reuse-box', type: 'detect', classId: 'vehicle', bbox: { x: 221, y: 483, width: 537, height: 350 } }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = (command: string, payload: unknown = {}) => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  async function wait(expression: string) { const end = Date.now() + 18000; while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 60)); } throw Error(`复用界面等待超时：${expression}`); }
  async function button(label: string, scope = 'document') { await wait(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}).click()`); }
  async function click(selector: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`document.querySelector(${json(selector)}).click()`); }
  async function fill(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async function select(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async function node(label: string) { await js(`[...document.querySelectorAll('.flow-node')].find(b=>b.innerText.includes(${json(label)})).click()`); await wait(`document.querySelector('.flow-inspector h2')?.innerText.includes(${json(label)})`); }
  async function capture(suffix: string, selector: string) { await js(`document.activeElement?.blur();document.querySelector(${json(selector)}).scrollIntoView({block:'center',behavior:'instant'})`); await new Promise(r => setTimeout(r, 350)); await writeFile(output.replace(/\.json$/, suffix), (await window.webContents.capturePage()).toPNG()); }
  async function latest(projectId: string) { return (await api('flow.list', { projectId })).items[0]; }
  async function completed(id: string) { await wait(`window.autoLabel.request('flow.get',{flowRunId:${json(id)}}).then(r=>r.status==='completed')`); return api('flow.get', { flowRunId: id }); }
  window.setContentSize(1440, 940); window.show();
  try {
    if (process.env.AUTOLABEL_REUSE_DISPLAY_ONLY === '1') {
      await wait(`!!document.querySelector('.nav-item')&&!document.querySelector('.connection-banner')`); await click('.nav-item:nth-child(4)'); await button('标注任务'); await wait(`document.querySelectorAll('.run-list .run-row').length>=3`); await click('.run-list .run-row:nth-child(2)'); await wait(`document.querySelector('.sample-table')?.innerText.includes('复用成功')`);
      await click('.sample-table .reuse-provenance>summary'); await wait(`document.querySelector('.sample-table .reuse-provenance dd')?.innerText.includes('自动标注')`);
      assert.equal(await js(`[...document.querySelectorAll('.timeline strong')].some(e=>/^(flow|sample|run|call|annotation)\./.test(e.innerText))`), false);
      const sourceId = await js<string>(`document.querySelector('.reuse-provenance>details dd').textContent`); assert.ok(sourceId.length > 20); assert.equal(await js(`document.querySelector('.reuse-provenance').innerText.includes(${json(sourceId)})`), false); await capture('-task-samples.png', '.sample-table');
      await button('流程运行'); await wait(`!!document.querySelector('.flow-run-list>button')`); await js(`[...document.querySelectorAll('.flow-run-list>button')].find(b=>b.innerText.includes('修订 2')).click()`); await button('查看固定产物'); await wait(`!!document.querySelector('.flow-artifact-view .reuse-provenance')`); await click('.flow-artifact-view .reuse-provenance>summary'); await wait(`document.querySelector('.flow-artifact-view .reuse-provenance dd')?.innerText.includes('自动标注')`); await capture('-flow-source.png', '.flow-artifact-view');
      await writeFile(output, json({ passed: true, mode: 'reuse-display-ui', newModelCalls: calls, chineseEventNames: true, sourceNameReadable: true, idsInCollapsedDiagnostics: true })); return;
    }
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const port = (server.address() as { port: number }).port;
    const provider = await api('provider.save', { name: `复用 UI 本地协议-${Date.now()}`, baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'chat-completions', model: 'fixture-reuse', maxRetries: 0 });
    await api('credential.set', { providerId: provider.id, key: 'isolated-reuse-ui-fixture' });
    for (const capability of ['image', 'structured']) assert.equal((await api('provider.test', { providerId: provider.id, model: 'fixture-reuse', capability })).status, 'verified');
    await new Promise<void>(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    await button('打开示例'); await wait(`!!document.querySelector('.annotation-canvas image')`);
    const assetId = await js<string>(`new URL(document.querySelector('.annotation-canvas image').getAttribute('href')).pathname.slice(1)`), original = await api('asset.get', { assetId });
    await click('.nav-item:nth-child(3)'); await wait(`!!document.querySelector('.flow-node')`);
    for (const label of ['导入素材', '检查与复核', '数据集导出']) { await node(label); await click('[aria-label="移除步骤"]'); }
    await node('API 标注'); await click('.flow-inspector .reuse-policy>summary');
    assert.equal(await js(`document.querySelector('[aria-label="允许复用已有候选"]').checked`), true);
    assert.equal(await js(`document.querySelector('[aria-label="强制重新请求模型"]').checked`), false);
    assert.equal(await js(`document.querySelector('[aria-label="复用结果有效期"]').value`), '');
    await select('[aria-label="步骤接口"]', provider.id); await fill('[aria-label="步骤模型"]', 'fixture-reuse'); await fill('[aria-label="步骤标注规则"]', '按目标图片输出车辆候选框。'); await fill('[aria-label="流程共享请求上限"]', '3');
    await fill('[aria-label="复用结果有效期"]', '0'); await button('预检当前流程'); await wait(`!!document.querySelector('.workflow-page>.inline-error')||document.querySelector('.flow-preflight')?.innerText.includes('预检尚未通过')`);
    assert.equal(calls, 0); assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='运行完整流程').disabled`), true);
    await fill('[aria-label="复用结果有效期"]', '3600'); await fill('[aria-label="流程名称"]', `候选复用验收-${Date.now()}`); await button('保存流程');
    await button('预检当前流程'); await wait(`!!document.querySelector('.flow-preflight')`); assert.ok(await js(`document.querySelector('.flow-preflight').innerText.includes('预检通过')`), await js(`document.querySelector('.flow-preflight').textContent`)); await button('运行完整流程');
    await wait(`!!document.querySelector('.flow-run-detail h3')`); const first = await completed((await latest(original.projectId)).id);
    const firstChild = await api('run.get', { runId: first.steps[0].childRunId }); assert.equal(firstChild.statistics.requestsUsed, 1); assert.equal(calls, 1);
    assert.equal(firstChild.reuseEnabled, true); assert.equal(firstChild.forceRerun, false); assert.equal(firstChild.reuseMaxAgeSeconds, 3600);
    checks.push({ check: 'policy-and-first-request', defaults: true, invalidAgeBlocked: true, maxAgeSeconds: 3600, requests: 1 });

    await button('从指定步骤重跑'); await button('创建重跑修订', dialog); await wait(`!document.querySelector('dialog[open]')&&document.querySelector('.flow-run-detail h3')?.innerText.includes('修订 2')`);
    const second = await completed((await latest(original.projectId)).id), secondChild = await api('run.get', { runId: second.steps[0].childRunId });
    assert.equal(calls, 1); assert.equal(second.statistics.requestsUsed, 0); assert.equal(second.statistics.reused, 1); assert.equal(secondChild.statistics.succeeded, 1); assert.equal(secondChild.statistics.reused, 1); assert.equal(secondChild.statistics.requestsUsed, 0);
    assert.equal(secondChild.samples[0].reusedFrom.sourceRunId, firstChild.id);
    await button('查看固定产物'); await wait(`!!document.querySelector('.flow-artifact-view .reuse-provenance')`); await click('.flow-artifact-view .reuse-provenance>summary'); await button('查看来源运行');
    await wait(`!!document.querySelector('.reuse-source-run')`); assert.ok(await js(`document.querySelector('.reuse-source-run').textContent.includes(${json(firstChild.id)})&&document.querySelector('.reuse-source-run').innerText.includes('原运行已发送 1 次请求')`)); await button('关闭来源运行'); await capture('-flow-source.png', '.flow-artifact-view');
    await click('.nav-item:nth-child(4)'); await button('标注任务'); await click('.run-list .run-row'); await wait(`document.querySelector('.sample-table')?.innerText.includes('复用成功（本样本 0 请求）')`);
    assert.equal(await js(`[...document.querySelectorAll('.run-counts>div')].find(e=>e.innerText.includes('已发送请求')).querySelector('strong').innerText`), '0');
    assert.equal(await js(`[...document.querySelectorAll('.run-counts>div')].find(e=>e.innerText.includes('成功中复用')).querySelector('strong').innerText`), '1'); await capture('-task-samples.png', '.sample-table');
    checks.push({ check: 'real-reuse-and-provenance', newRequests: 0, reusedSubsetOfSucceeded: true, sourceRunId: firstChild.id, tasksShowZeroRequests: true });

    await button('流程运行'); await click('.flow-run-list>button'); await wait(`document.querySelector('.flow-run-detail h3')?.innerText.includes('修订 2')`); await button('从指定步骤重跑');
    await click('dialog[open] .reuse-policy>summary'); await click('dialog[open] [aria-label="强制重新请求模型"]'); await button('创建重跑修订', dialog); await wait(`!document.querySelector('dialog[open]')&&document.querySelector('.flow-run-detail h3')?.innerText.includes('修订 3')`);
    const third = await completed((await latest(original.projectId)).id), thirdChild = await api('run.get', { runId: third.steps[0].childRunId });
    assert.equal(calls, 2); assert.equal(thirdChild.forceRerun, true); assert.equal(thirdChild.statistics.requestsUsed, 1); assert.equal(thirdChild.statistics.reused, 0); assert.deepEqual(await api('asset.get', { assetId }), original);
    checks.push({ check: 'explicit-force-rerun', newRequests: 1, reused: 0, humanAnnotationsUnchanged: true });
    await writeFile(output, json({ passed: true, mode: 'reuse-ui', protocolFixtureCalls: calls, capabilityFixtureCalls: capabilityCalls, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'reuse-ui', protocolFixtureCalls: calls, checks, error: e instanceof Error ? e.message : String(e), body: await js('document.body.innerText') })); throw e; }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
