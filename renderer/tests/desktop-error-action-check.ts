import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/**
 * 阻塞提示的「下一步」验收。
 *
 * 走查结论是：卡住人的提示只有一句话，用户得自己去找该改哪里——「请先在设置里选择对话接口与对话模型」
 * 落在哪一页、哪一区块，全靠猜。本次验收断言：
 * 1. 未配置模型时发送，提示上带「去配置」，点一下直接落在设置 · 软件 AI 配置；
 * 2. 普通成功提示不带按钮，不会因为多了一个出口而变味。
 */
export async function checkDesktopErrorAction(window: BrowserWindow, output: string): Promise<void> {
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
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    // 进入会话：示例项目不会自动发第一条消息，正好停在空会话上。
    await js(`([...document.querySelectorAll('.onboarding-lane button')].find(node=>node.innerText.trim()==='载入示例项目')).click()`);
    await waitFor(`!!document.querySelector('.toast')`);

    // ===== 普通提示不带出口 =====
    const plain = await js<{ text: string; hasAction: boolean; role: string | null; live: string | null }>(`(()=>{const t=document.querySelector('.toast');return {text:t?.innerText.trim()??'',hasAction:!!t?.querySelector('.toast-action'),role:t?.getAttribute('role')??null,live:t?.getAttribute('aria-live')??null};})()`);
    assert.ok(plain.text.includes('示例项目已载入'), `载入示例应给出普通提示，实际：${json(plain)}`);
    assert.equal(plain.hasAction, false, '普通成功提示不该出现出口按钮');
    assert.equal(plain.role, 'status', '普通提示应以状态消息播报');
    assert.equal(plain.live, 'polite', '普通提示不应打断当前读屏内容');
    await js(`document.querySelector('.toast [aria-label="关闭提示"]').click()`);
    await waitFor(`!document.querySelector('.toast')`);
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);

    // ===== 未配置模型时发送：提示必须带出口，并且真的把人送到 =====
    await js(`(()=>{const e=document.querySelector('.chat-panel textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'把这些图里的车辆框出来');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.chat-panel textarea')?.value.length>0`);
    await js(`document.querySelector('.chat-panel .send-button').click()`);
    await waitFor(`!!document.querySelector('.toast-action')`);
    const blocked = await js<{ message: string; action: string; role: string | null; live: string | null }>(`(()=>{const t=document.querySelector('.toast');return {message:t.innerText.trim(),action:t.querySelector('.toast-action').innerText.trim(),role:t.getAttribute('role'),live:t.getAttribute('aria-live')};})()`);
    assert.ok(blocked.message.includes('对话模型') || blocked.message.includes('接口'), `提示应说清缺什么，实际：${blocked.message}`);
    assert.equal(blocked.action, '去配置');
    assert.equal(blocked.role, 'alert', '阻断错误应作为警报播报');
    assert.equal(blocked.live, 'assertive', '阻断错误应及时打断读屏播报');

    await js(`document.querySelector('.toast-action').click()`);
    await waitFor(`!document.querySelector('.toast')`);
    await waitFor(`!!document.querySelector('.settings-tabs')&&!!document.querySelector('.settings-body')`);
    const landed = await js<{ page: string; tab: string }>(`(()=>({ page: location.hash, tab: document.querySelector('.settings-tabs button.selected')?.innerText.trim() ?? '' }))()`);
    assert.equal(landed.page, '#settings', `应落在设置页，实际：${landed.page}`);
    assert.equal(landed.tab, '软件 AI 配置', `应落在软件 AI 配置，实际：${landed.tab}`);
    await waitFor(`getComputedStyle(document.querySelector('.settings-body')).opacity==='1'`);

    // ===== 行内错误组件的默认语义 =====
    await js(`([...document.querySelectorAll('.ai-settings .section-toolbar button')].find(node=>node.innerText.includes('添加接口'))).click()`);
    await waitFor(`!!document.querySelector('.provider-form')`);
    await js(`([...document.querySelectorAll('.provider-form .advanced-toggle')].find(node=>node.innerText.includes('手动配置'))).click()`);
    await waitFor(`[...document.querySelectorAll('.provider-form .advanced-toggle')].some(node=>node.innerText.includes('高级请求配置'))`);
    await js(`([...document.querySelectorAll('.provider-form .advanced-toggle')].find(node=>node.innerText.includes('高级请求配置'))).click()`);
    await waitFor(`document.querySelectorAll('.provider-form textarea.code').length===2`);
    await js(`(()=>{const form=document.querySelector('.provider-form');const fields=form.querySelectorAll('input');
      const set=(node,value)=>{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')?.set;setter?.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));};
      set(fields[0],'Smoke 接口');set(form.querySelector('input[type="url"]'),'https://example.invalid/v1');
      set(form.querySelector('textarea.code'),'{');form.querySelector('button[type="submit"]').click();})()`);
    await waitFor(`!!document.querySelector('.provider-form .inline-error')`);
    const inlineError = await js<{ role: string | null; live: string | null; classes: string[] }>(`(()=>{const error=document.querySelector('.provider-form .inline-error');return {role:error?.getAttribute('role')??null,live:error?.getAttribute('aria-live')??null,classes:[...(error?.classList??[])]};})()`);
    assert.equal(inlineError.role, 'alert', `默认行内错误应使用 alert 语义：${json(inlineError)}`);
    assert.equal(inlineError.live, 'assertive', `默认行内错误应立即播报：${json(inlineError)}`);
    assert.ok(inlineError.classes.includes('inline-error-error'), `错误 tone 应保留基础样式并带语义类：${json(inlineError)}`);

    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({
      checks: [{ check: 'blocked-notice-has-next-step', message: blocked.message, action: blocked.action, landed, plainToastText: plain.text, plainRole: plain.role, plainLive: plain.live, blockedRole: blocked.role, blockedLive: blocked.live },
        { check: 'inline-error-default-semantics', ...inlineError }], passed: true,
    }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks: [], passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
