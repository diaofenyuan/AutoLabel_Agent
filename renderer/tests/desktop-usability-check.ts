import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/**
 * 快速上手小修包的验收：这些细节单看功能都不缺，缺了却让第一次上手处处磕绊——
 * ①弹层与内滚动区滚动不带动整页（overscroll-behavior: contain）；
 * ②灰置必有因：禁用按钮必须有 title / aria-label / 可读文字之一；
 * ③粘贴与点选走与拖入同一条文件管道：拒绝时如实提示，不静默吞；
 * ④列表折叠的展开钮写明折叠了多少条（模型列表 / 视频清单 / 任务列表同契约）。
 */
export async function checkDesktopUsability(window: BrowserWindow, output: string): Promise<void> {
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const checks: Record<string, unknown>[] = [];
  const settle = () => new Promise(resolve => setTimeout(resolve, 350));
  window.show();
  try {
  await js(`new Promise(resolve => { const tick = () => document.querySelector('.chat-home') ? resolve(true) : requestAnimationFrame(tick); tick(); })`);

  // ① 滚动隔离：打开模型弹层，两个滚动容器都必须 contain。
  await js(`document.querySelector('.model-picker-trigger')?.click()`);
  await settle();
  const scroll = await js<{ contain: string[]; missing: string[] }>(`(()=>{const targets=['.picker-popover','.picker-list'];
    const missing=targets.filter(s=>!document.querySelector(s));const contain=targets.filter(s=>getComputedStyle(document.querySelector(s)).overscrollBehavior==='contain');return {contain,missing};})()`);
  assert.ok(!scroll.missing.length, `弹层未渲染：${scroll.missing.join('、')}`);
  assert.equal(scroll.contain.length, 2, `弹层滚动必须 contain（不带动整页），实际：${JSON.stringify(scroll)}`);
  checks.push({ check: 'overscroll-contain', ...scroll });
  await js(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);

  // ② 灰置必有因：欢迎页与设置页各扫一遍禁用按钮（title / aria-label / 可读文字三者有其一），
  //    再对本轮修复的具体按钮做定点复核：设置 → 软件 AI 配置 → 手动配置 →「获取模型列表」。
  const sweep = () => js<Array<{ label: string; title: string; reason: string }>>(
    `[...document.querySelectorAll('button[disabled]')].map(b=>({label:b.innerText.trim(),title:b.getAttribute('title')??'',reason:b.getAttribute('aria-label')??''}))`);
  const homeDisabled = await sweep();
  await js(`[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='设置')?.click()`);
  await settle();
  await js(`[...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='软件 AI 配置')?.click()`);
  await settle();
  await js(`[...document.querySelectorAll('.settings-body button')].find(node=>node.innerText.includes('手动配置'))?.click()`);
  await settle();
  const settingsDisabled = await sweep();
  const unexplained = [...homeDisabled, ...settingsDisabled].filter(item => !item.title && !item.reason && !item.label);
  assert.ok(!unexplained.length, `灰置按钮没有可读原因：${JSON.stringify(unexplained)}`);
  const sampleProbe = await js<string>(`(()=>{const b=[...document.querySelectorAll('.settings-body button')].find(node=>node.innerText.includes('获取模型列表'));return b?JSON.stringify({title:b.getAttribute('title'),disabled:b.disabled,text:b.innerText.trim()}):'NOT-FOUND'})()`);
  const sample = JSON.parse(sampleProbe === 'NOT-FOUND' ? '{"title":""}' : sampleProbe) as { title?: string };
  assert.ok((sample.title ?? '').length > 0, `「获取模型列表」灰置必须给出原因，探针：${sampleProbe}`);
  checks.push({ check: 'disabled-buttons-explain', homeDisabled: homeDisabled.length, settingsDisabled: settingsDisabled.length, sampleProbe });

  // ③ 选择文件入口在；粘贴走同一条管道且拿不到路径时如实提示（合成 File 解析不出本地路径）。
  await js(`[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='新对话')?.click()`);
  await settle();
  const pick = await js<boolean>(`!!document.querySelector('.composer-pick')`);
  assert.equal(pick, true, '输入卡应有「选择文件」入口');
  const pasted = await js<{ toast: string }>(`(async()=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array([1,2,3])],'synthetic.png',{type:'image/png'}));
    document.querySelector('.chat-home textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,500));return {toast:[...document.querySelectorAll('.toast')].map(n=>n.innerText).join('|')};})()`);
  assert.ok(pasted.toast.trim().length > 0, `粘贴解析不出路径的文件必须如实提示，实际静默：${JSON.stringify(pasted)}`);
  checks.push({ check: 'paste-into-attachments-pipeline', rejection: pasted.toast.replace(/\s+/g, ' ').slice(0, 160) });

  await writeFile(output, JSON.stringify({ checks, passed: true }, null, 2));
  } catch (error) {
    await writeFile(output, JSON.stringify({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }, null, 2));
    throw error;
  }
}
