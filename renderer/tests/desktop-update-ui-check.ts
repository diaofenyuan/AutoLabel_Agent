import type { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const payload = Buffer.from('MZ-local-update-ui-fixture');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

// 使用本地回环清单驱动真实 renderer 状态，不调用服务商接口，也不执行安装器。
export async function checkDesktopUpdateUi(window: BrowserWindow, output: string): Promise<void> {
  let slow = false; let corrupt = false; let origin = '';
  const server: Server = createServer((req, res) => {
    if (req.url === '/manifest') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ schemaVersion: 1, appId: 'com.autolabel.assistant', platform: 'win32', arch: 'x64', version: '0.1.1',
        releaseNotes: '本地更新界面验收夹具', downloadUrl: `${origin}/package`, sha256: digest(payload), size: payload.length })); return;
    }
    if (req.url !== '/package') { res.writeHead(404); res.end(); return; }
    const body = corrupt ? Buffer.from('X'.repeat(payload.length)) : payload;
    res.setHeader('Content-Length', body.length);
    if (!slow) { res.end(body); return; }
    res.write(body.subarray(0, 2));
    const timer = setTimeout(() => res.end(body.subarray(2)), 1200);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const json = JSON.stringify;
  const wait = async (expression: string) => { const end = Date.now() + 12000; while (Date.now() < end) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`更新 UI 等待超时：${expression}`); };
  const click = async (text: string) => { await wait(`!![...document.querySelectorAll('.update-settings button')].find(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`); await js(`([...document.querySelectorAll('.update-settings button')].find(b=>b.innerText.trim()===${json(text)})).click()`); };
  const fill = async (value: string) => { await js(`(()=>{const e=document.querySelector('.update-settings input[type="url"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(`document.querySelector('.update-settings input[type="url"]').value===${json(value)}`); };
  const navigate = async () => { await js(`document.querySelectorAll('.nav-item')[6].click()`); await wait(`!!document.querySelector('.settings-tabs')`); await js(`([...document.querySelectorAll('.settings-tabs button')].find(b=>b.innerText.trim()==='应用更新')).click()`); await wait(`!!document.querySelector('.update-status')`); };
  const states: string[] = [];
  try {
    window.show(); await wait(`!!document.querySelector('.onboarding-lanes button')&&!document.querySelector('.connection-banner')`); await navigate();
    await fill(`${origin}/manifest`); await click('保存更新地址'); await wait(`document.querySelector('.update-status').dataset.state==='idle'`); await click('检查更新'); await wait(`document.querySelector('.update-status').dataset.state==='available'`); states.push('available');
    await click('下载更新'); await wait(`document.querySelector('.update-status').dataset.state==='ready'`); const readyProgress = await js<number>(`Number(document.querySelector('.download-progress progress')?.value||0)`); if (readyProgress !== payload.length) throw new Error('更新 UI 未显示完整实际字节进度'); states.push('ready');
    const installDisabled = await js<boolean>(`[...document.querySelectorAll('.update-status button')].find(b=>b.innerText.includes('退出并安装更新'))?.disabled===true`); if (!installDisabled) throw new Error('未确认安装前不应允许安装');
    await js(`document.querySelector('.update-status input[type="checkbox"]')?.click()`); await click('退出并安装更新'); await wait(`document.querySelector('.update-status .inline-error')?.innerText.includes('开发模式不执行安装')`); states.push('install-gate');
    slow = true; corrupt = false; await click('检查更新'); await wait(`document.querySelector('.update-status').dataset.state==='available'`); const download = js(`([...document.querySelectorAll('.update-status button')].find(b=>b.innerText.trim()==='下载更新')).click()`); await wait(`document.querySelector('.update-status').dataset.state==='downloading'&&Number(document.querySelector('.download-progress progress')?.value||0)>0`); await click('取消下载'); await download.catch(() => undefined); await wait(`document.querySelector('.update-status').dataset.state==='cancelled'`); states.push('cancelled');
    slow = false; corrupt = true; await click('检查更新'); await wait(`document.querySelector('.update-status').dataset.state==='available'`); await click('下载更新'); await wait(`document.querySelector('.update-status').dataset.state==='error'&&document.querySelector('.update-status .inline-error')?.innerText.includes('完整性校验失败')`); states.push('checksum-error');
    await writeFile(output, JSON.stringify({ passed: true, states, readyProgress, noSyntheticProgress: true, installGate: true }, null, 2));
  } catch (error) {
    await writeFile(output, JSON.stringify({ passed: false, states, error: error instanceof Error ? error.message : String(error), body: await js('document.body.innerText') }, null, 2)); throw error;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
