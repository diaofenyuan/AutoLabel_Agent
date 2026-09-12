import { nativeImage, type BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkDesktopPagination(window: BrowserWindow, output: string): Promise<void> {
  const checks: unknown[] = [], json = JSON.stringify;
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = (command: string, payload: unknown = {}) => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const userData = path.join(path.dirname(output), 'manual-check-user-data');
  const fixtures = path.join(userData, 'fixtures', `pagination-${Date.now()}`);
  await mkdir(fixtures, { recursive: true });
  async function wait(expression: string) { const end = Date.now() + 15000; while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`分页等待超时：${expression}`); }
  async function button(label: string, scope = 'document') { await wait(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}).click()`); }
  async function click(selector: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`document.querySelector(${json(selector)}).click()`); }
  async function fill(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async function select(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  const dialog = "document.querySelector('dialog[open]')";
  async function close() { await button('关闭', dialog); await wait(`!document.querySelector('dialog[open]')`); }
  async function queue(entry: unknown) { await writeFile(path.join(userData, 'dialog-fixtures.json'), json([entry])); }
  window.show();
  try {
    await wait(`!!window.autoLabel&&!document.querySelector('.connection-banner')&&!document.querySelector('.skeleton-list')`);
    const name = `分页验收-${Date.now()}`;
    const project = await api('project.create', { name, taskType: 'detect', classes: [{ id: 'target', name: '目标', color: '#437fe5' }] });
    window.webContents.reload();
    await wait(`!!document.querySelector('.project-row')&&document.body.innerText.includes(${json(name)})`);
    await js(`[...document.querySelectorAll('.project-row')].find(e=>e.innerText.includes(${json(name)})).click()`);
    await wait(`!!document.querySelector('.workbench')`);
    // 不使用模型结果：101 张不同纯色图片仅验证真实导入、分页和范围传递。
    const paths: string[] = [];
    for (let i = 0; i < 101; i++) {
      const pixels = Buffer.alloc(64 * 48 * 4);
      for (let at = 0; at < pixels.length; at += 4) { pixels[at] = 60 + i; pixels[at + 1] = 120; pixels[at + 2] = 220; pixels[at + 3] = 255; }
      const file = path.join(fixtures, `page-${String(i + 1).padStart(3, '0')}.png`);
      await writeFile(file, nativeImage.createFromBitmap(pixels, { width: 64, height: 48 }).toPNG()); paths.push(file);
    }
    await queue({ kind: 'images', paths }); await button('导入图片');
    await wait(`document.querySelector('.asset-pagination')?.innerText.includes('共 101 张')&&document.querySelectorAll('.thumbnail').length===100`);
    const all = await api('asset.list', { projectId: project.id, limit: 500 }); assert.equal(all.total, 101);
    const first = all.items[0], last = all.items[100], boundary = all.items[99];
    await api('annotation.save', { assetId: first.id, baseVersion: 0, annotations: [{ id: 'manual-box', type: 'detect', classId: 'target', bbox: { x: 5, y: 5, width: 20, height: 20 } }], confirm: false });
    await click('.nav-item'); await wait(`!!document.querySelector('.project-row')`);
    await js(`[...document.querySelectorAll('.project-row')].find(e=>e.innerText.includes(${json(name)})).click()`);
    await wait(`!!document.querySelector('[aria-label="对象x"]')`);
    await click(`[aria-label="勾选图片 ${first.name}"]`); await fill('[aria-label="对象x"]', '9');
    await click('[aria-label="下一页素材"]');
    await wait(`document.querySelector('.asset-pagination')?.innerText.includes('第 101–101 张')&&document.querySelectorAll('.thumbnail').length===1`);
    let stored = await api('asset.get', { assetId: first.id }); assert.equal(stored.version, 1); assert.equal(stored.draft[0].bbox.x, 9);
    await click(`[aria-label="勾选图片 ${last.name}"]`);
    assert.ok((await js<string>(`document.querySelector('.asset-pagination').innerText`)).includes('已勾选 2 张（跨页）'));
    await click('[aria-label="上一页素材"]'); await wait(`document.querySelector('[aria-label="对象x"]')?.value==='9'`);
    await click(`[aria-label="打开图片 ${boundary.name}"]`); await wait(`document.querySelector('.thumbnail.selected')?.innerText===${json(boundary.name)}`);
    await button('确认并下一张'); await wait(`document.querySelector('.asset-pagination')?.innerText.includes('第 101–101 张')`);
    assert.equal((await api('asset.get', { assetId: boundary.id })).status, 'confirmed');
    await click('[aria-label="上一张图片"]'); await wait(`document.querySelector('.thumbnail.selected')?.innerText===${json(boundary.name)}`);
    assert.equal(await js(`document.querySelectorAll('.thumbnail').length`), 100);
    checks.push({ check: 'bounded-browse', total: 101, pageSize: 100, draftRestored: true, confirmAcrossPage: true, previousAcrossPage: true, selectedAcrossPages: 2 });

    // 单图定位走真实 asset.get；事件只作为入口触发，不伪造素材或引擎返回值。
    window.webContents.send('autolabel:agent-event', { type: 'agent.open_asset', payload: { assetId: last.id } });
    await wait(`!!document.querySelector('.focused-asset-note')&&document.querySelector('.annotation-canvas image')?.getAttribute('href').endsWith(${json(last.id)})`);
    assert.equal(await js(`document.querySelectorAll('.thumbnail').length`), 100);
    assert.ok((await js<string>(`document.querySelector('.asset-pagination').innerText`)).includes('已勾选 2 张'));
    await button('返回当前页'); await wait(`!document.querySelector('.focused-asset-note')`);
    checks.push({ check: 'off-page-single-asset', fixedPageUnchanged: true, usesNativeAssetGet: true });

    await click('[aria-label="导出数据集"]'); await wait(`!!document.querySelector('[aria-label="导出范围"]')`);
    async function count(scope: string, expected: number) { await select('[aria-label="导出范围"]', scope); await wait(`!!document.querySelector('.preflight pre')&&JSON.parse(document.querySelector('.preflight pre').textContent).assets===${expected}`); }
    await count('project', 101); await count('page', 100); await count('selected', 2);
    // 所选两张保存明确空答案/人工框，范围外未标注图片不应阻塞所选导出。
    await api('annotation.save', { assetId: last.id, baseVersion: 0, annotations: [], confirm: true });
    await close(); await click('[aria-label="导出数据集"]'); await count('selected', 2);
    const exportParent = path.join(fixtures, 'exports'); await mkdir(exportParent);
    await queue({ kind: 'directory', paths: [exportParent] }); await button('选择', dialog); await button('导出数据集', dialog);
    await wait(`${dialog}.innerText.includes('导出状态：已完成')`);
    const records = await api('export.list', { projectId: project.id }); assert.equal(records[0].assetCount, 2);
    await close(); await button('清空勾选'); await click('[aria-label="导出数据集"]'); await select('[aria-label="导出范围"]', 'selected');
    await wait(`${dialog}.innerText.includes('当前范围为空')`);
    assert.equal(await js(`[...${dialog}.querySelectorAll('button')].find(b=>b.innerText.trim()==='导出数据集').disabled`), true);
    await close(); checks.push({ check: 'explicit-export-scope', projectPreflight: 101, pagePreflight: 100, selectedPreflight: 2, exported: 2, emptySelectionBlocked: true });
    await js(`document.querySelector('[aria-label="素材页码"]').focus()`); await fill('[aria-label="素材页码"]', '2'); await button('跳转'); await wait(`document.querySelector('.asset-pagination')?.innerText.includes('第 101–101 张')`);
    await js(`document.activeElement?.blur()`); await new Promise(r => setTimeout(r, 350));
    await writeFile(output.replace(/\.json$/, '-pagination.png'), (await window.webContents.capturePage()).toPNG());
    await click('[aria-label="上一页素材"]'); await wait(`document.querySelector('[aria-label="对象x"]')?.value==='9'`);
    await click('[aria-label="检测框 · B"]');
    const point = await js<{ x: number; y: number }>(`(()=>{const b=document.querySelector('.annotation-canvas').getBoundingClientRect();return {x:Math.round(b.left+b.width*.75),y:Math.round(b.top+b.height*.5)}})()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await click('[aria-label="下一页素材"]');
    await wait(`document.querySelector('.toast.error')?.innerText.includes('已保留当前图片')`);
    assert.ok((await js<string>(`document.querySelector('.asset-pagination').innerText`)).includes('第 1–100 张'));
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    checks.push({ check: 'unfinished-gesture-guard', stayedOnOriginalPage: true });
    await writeFile(output, json({ passed: true, mode: 'pagination-ui', newModelCalls: 0, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'pagination-ui', checks, error: e instanceof Error ? e.message : String(e), body: await js(`document.body.innerText`) })); throw e; }
}
