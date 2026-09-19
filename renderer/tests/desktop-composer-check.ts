import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/**
 * 会话输入卡简化验收。
 *
 * 走查结论是：输入框周围常驻四个控件（处理范围、执行方式、模型、更多），而「处理范围」「执行方式」
 * 对第一次用的人是两个答不上来的问题；空会话又只给一句「描述你的标注任务」，写不出第一句话。
 * 本次验收断言：
 * 1. 收起态没有下拉框，只有一行摘要如实写出当前的范围与执行方式；
 * 2. 点开摘要才出现处理范围、执行方式与任务流程，且「直接执行会真的发请求」这句留在能改开关的地方；
 * 3. 在弹层里改执行方式，摘要跟着改；
 * 4. 空会话给出三个起手式，点一下真的填进输入框（发送前仍可改）。
 */
export async function checkDesktopComposer(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  const summaryText = () => js<string>(`document.querySelector('.chat-panel .composer-summary')?.innerText.trim() ?? ''`);
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    // 用示例项目进入会话：一条链路上既拿到项目，又停在空会话（示例不会自动发第一条消息）。
    await js(`([...document.querySelectorAll('.onboarding-lane button')].find(node=>node.innerText.trim()==='载入示例项目')).click()`);
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);

    // ===== 空会话的起手式 =====
    const samples = await js<string[]>(`[...document.querySelectorAll('.chat-examples button')].map(node=>node.innerText.trim())`);
    assert.equal(samples.length, 3, `空会话应给出三个起手式，实际：${json(samples)}`);
    await js(`document.querySelectorAll('.chat-examples button')[0].click()`);
    await waitFor(`document.querySelector('.chat-panel textarea')?.value===${json(samples[0])}`);
    checks.push({ check: 'empty-session-samples', samples, filled: samples[0] });
    // 清空输入，后面的断言只针对工具行。
    await js(`(()=>{const e=document.querySelector('.chat-panel textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.chat-panel textarea')?.value===''`);

    // ===== 收起态：没有下拉框，只有一行摘要 =====
    const collapsed = await js<{ selects: number; summary: string; popover: boolean }>(`(()=>({
      selects: document.querySelectorAll('.chat-panel .chat-options select').length,
      summary: document.querySelector('.chat-panel .composer-summary')?.innerText.trim() ?? '',
      popover: !!document.querySelector('.chat-panel .composer-popover')
    }))()`);
    assert.equal(collapsed.selects, 0, '收起态不应出现任何下拉框');
    assert.equal(collapsed.popover, false, '收起态不应已经展开弹层');
    assert.ok(collapsed.summary.includes('全项目'), `摘要应写出当前处理范围，实际：${collapsed.summary}`);
    assert.ok(collapsed.summary.includes('直接执行'), `摘要应写出当前执行方式，实际：${collapsed.summary}`);
    checks.push({ check: 'composer-collapsed-to-one-line', ...collapsed });

    // ===== 展开态：范围、执行方式、任务流程都在 =====
    await js(`document.querySelector('.chat-panel .composer-summary').click()`);
    await waitFor(`!!document.querySelector('.chat-panel .composer-popover')`);
    const expanded = await js<{ scopes: string[]; modes: string[]; choices: number; billing: boolean; flow: boolean }>(`(()=>{const p=document.querySelector('.chat-panel .composer-popover');
      const groups=[...p.querySelectorAll('.composer-choices')];
      return { scopes:[...groups[0].querySelectorAll('button')].map(b=>b.innerText.trim()), modes:[...groups[1].querySelectorAll('button')].map(b=>b.innerText.trim()),
        choices: groups.length, billing: p.innerText.includes('可能产生费用'), flow: !!p.querySelector('.flow-picker') };})()`);
    assert.equal(expanded.choices, 2, '展开态应有处理范围与执行方式两组选项');
    assert.ok(expanded.scopes.some(label => label.includes('全项目')), `范围应含全项目，实际：${json(expanded.scopes)}`);
    assert.deepEqual(expanded.modes, ['直接执行', '先看方案']);
    assert.equal(expanded.billing, true, '「直接执行会真的发请求并可能计费」必须留在能改开关的地方');
    assert.equal(expanded.flow, true, '任务流程入口应跟着工具行一起收到弹层里');
    checks.push({ check: 'composer-expands-tools', ...expanded });

    // ===== 改执行方式，摘要跟着改 =====
    await js(`([...document.querySelectorAll('.chat-panel .composer-popover .composer-choices button')].find(node=>node.innerText.trim()==='先看方案')).click()`);
    await waitFor(`document.querySelector('.chat-panel .composer-summary')?.innerText.includes('先看方案')`);
    checks.push({ check: 'composer-summary-follows-choice', summary: await summaryText() });

    // 主操作要一眼可读：发送按钮被挤成两行时，第一次用的人连怎么发都看不出来。
    const send = await js<{ width: number; height: number; label: string }>(
      `(()=>{const b=document.querySelector('.chat-panel .send-button');const r=b.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height),label:b.innerText.trim()};})()`);
    assert.ok(!send.label.includes('\n'), `发送按钮的文字被折行：${json(send)}`);
    assert.ok(send.width >= 56, `发送按钮太窄，主操作读不出来：实际 ${send.width}px`);
    checks.push({ check: 'composer-send-button-legible', ...send });

    // ===== 类别在输入卡这一层就能看和改：不必先经过对话模型 =====
    // 以前类别只能靠助手调 set_project_classes 建，或进项目概览的模板对话框改；
    // 对话模型不可用时整条链断在这里，所以这里断言的是「输入卡里就能建类别并写清口径」。
    await js(`document.querySelector('.chat-panel .class-picker .model-picker-trigger').click()`);
    await waitFor(`!!document.querySelector('.class-picker .picker-popover')`);
    const classesBefore = await js<{ label: string; chips: string[] }>(`(()=>({label:document.querySelector('.chat-panel .class-picker .truncate')?.innerText.trim() ?? '',
      chips:[...document.querySelectorAll('.class-picker .class-chip span')].map(node=>node.innerText.trim())}))()`);
    const setValue = (selector: string, value: string) => js(`(()=>{const e=document.querySelector(${json(selector)});const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await setValue('.class-picker-add input', '手办');
    await js(`([...document.querySelectorAll('.class-picker-add button')].find(node=>node.innerText.trim()==='添加')).click()`);
    await waitFor(`[...document.querySelectorAll('.class-picker .class-chip span')].some(node=>node.innerText.trim()==='手办')`);
    const rules = '只要画面中间那个小手办，不要框旁边的大号毛绒公仔。';
    await setValue('.class-picker textarea', rules);
    await js(`([...document.querySelectorAll('.class-picker .picker-foot button')].find(node=>node.innerText.trim()==='保存')).click()`);
    await waitFor(`!document.querySelector('.class-picker .picker-popover')`);
    const savedLabel = await js<string>(`document.querySelector('.chat-panel .class-picker .truncate')?.innerText.trim() ?? ''`);
    assert.ok(savedLabel.includes('手办'), `保存后输入卡上的类别应含手办，实际：${savedLabel}`);
    // 重新打开读回：类别与标注要求都要真的落到项目上，而不是只改了弹层里的副本。
    await js(`document.querySelector('.chat-panel .class-picker .model-picker-trigger').click()`);
    await waitFor(`!!document.querySelector('.class-picker .picker-popover')`);
    const reopened = await js<{ chips: string[]; rules: string }>(`(()=>({chips:[...document.querySelectorAll('.class-picker .class-chip span')].map(node=>node.innerText.trim()),
      rules:document.querySelector('.class-picker textarea')?.value ?? ''}))()`);
    assert.ok(reopened.chips.includes('手办'), `重新打开应仍在，实际：${json(reopened.chips)}`);
    assert.equal(reopened.rules, rules, '标注要求应写回项目的标注规则里');
    checks.push({ check: 'class-picker-manages-classes', classesBefore, savedLabel, reopened });
    await js(`document.querySelector('.chat-panel .class-picker .model-picker-trigger').click()`);
    await waitFor(`!document.querySelector('.class-picker .picker-popover')`);

    // 输入卡是本次改动的主战场，等页面稳定后留一张图核对排版。
    await waitFor(`getComputedStyle(document.querySelector('.chat-panel .composer')).opacity==='1'`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
