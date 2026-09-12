import assert from 'node:assert/strict';
import type { BrowserWindow } from 'electron';

/** 使用真实桌面 IPC 验收删除确认、后端删除和列表刷新；不发送模型请求。 */
export async function checkDesktopProviderDelete(window: BrowserWindow, output: string): Promise<void> {
  const json = JSON.stringify, js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = (command: string, payload: unknown = {}) => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  async function wait(expression: string) { const end = Date.now() + 18000; while (Date.now() < end) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`模型中心删除验收等待超时：${expression}`); }
  async function button(label: string, scope = 'document') { await wait(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}&&!b.disabled).click()`); }
  const name = `删除反馈验收-${Date.now()}`;
  window.showInactive();
  try {
    await wait(`!!window.autoLabel&&!document.querySelector('.connection-banner')`);
    const provider = await api<{ id: string }>('provider.save', { name, baseUrl: 'http://127.0.0.1:9/v1', protocol: 'chat-completions', model: 'no-request' });
    await api('credential.set', { providerId: provider.id, key: 'delete-ui-fixture' });
    await new Promise<void>(resolve => { window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload(); });
    await wait(`!!document.querySelector('.nav-item')`);
    await js(`document.querySelectorAll('.nav-item')[5].click()`);
    await wait(`!!document.querySelector('.provider-list')&&document.body.innerText.includes(${json(name)})`);
    await js(`[...document.querySelectorAll('.provider-list button')].find(b=>b.innerText.includes(${json(name)})).click()`);
    await button('删除接口');
    await wait(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog[open]').innerText.includes('清理桌面内存中的凭据')`);
    await new Promise(resolve => setTimeout(resolve, 120));
    const fs = await import('node:fs/promises');
    await fs.writeFile(output.replace(/\.json$/, '-confirm.png'), (await window.webContents.capturePage()).toPNG());
    await button('确认删除', 'document.querySelector(\'dialog[open]\')');
    await wait(`window.autoLabel.request('provider.list',{}).then(ps=>!ps.some(p=>p.id===${json(provider.id)}))`);
    assert.equal((await api('provider.list')).some((item: { id: string }) => item.id === provider.id), false);
    await wait(`!document.querySelector('dialog[open]')&&document.body.innerText.includes('接口已删除，关联凭据已清理。')`);
    await fs.writeFile(output.replace(/\.json$/, '-deleted.png'), (await window.webContents.capturePage()).toPNG());
    const result = { passed: true, mode: 'provider-delete-ui', modelRequests: 0, deleted: true, credentialClearedFeedback: true };
    await fs.writeFile(output, JSON.stringify(result));
  } catch (error) {
    const fs = await import('node:fs/promises'); await fs.writeFile(output, JSON.stringify({ passed: false, mode: 'provider-delete-ui', error: error instanceof Error ? error.message : String(error) })); throw error;
  }
}
