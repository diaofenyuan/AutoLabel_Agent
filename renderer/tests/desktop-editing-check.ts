import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attributeDefinitions, attributeValueIssue } from '../src/templateAttributes';
import { deletePolygonPoint, insertPolygonPoint, MAX_POLYGON_POINTS } from '../src/polygonEditing';
import { gotoWelcome, openProjectOverview } from './desktop-navigation';

/**
 * 模板与画布编辑边界验收。
 *
 * 覆盖：多边形边界（纯函数）、类别与点位模板的结构化属性与旧字段共存、固定模板下的独立标准答案与属性值。
 * 不再覆盖「画布上插入点 / 删除顶点 / 撤销」：那些工具按钮已随工作台移除（见文件内的说明）。
 */
export async function checkDesktopEditing(window: BrowserWindow, output: string): Promise<void> {
  const checks: unknown[] = [], json = JSON.stringify, userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code), api = (command: string, payload: unknown = {}) => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  async function wait(code: string) { const end = Date.now() + 20000; while (Date.now() < end) { if (await js(code)) return; await new Promise(r => setTimeout(r, 60)); } throw new Error(`编辑验收等待超时：${code}`); }
  async function click(selector: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`document.querySelector(${json(selector)}).click()`); }
  async function button(label: string, scope = 'document') { await wait(`!!${scope}&&[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}&&!b.disabled).click()`); }
  async function fill(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async function select(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async function key(keyCode: string, modifiers: string[] = []) { await js('document.activeElement?.blur()'); window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await js('new Promise(r=>requestAnimationFrame(r))'); }
  async function canvasClick(selector: string, x: number, y: number) { const p = await js<{ x: number; y: number }>(`(()=>{const s=document.querySelector(${json(selector)}),r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return{x:Math.round(r.x+${x}/v.width*r.width),y:Math.round(r.y+${y}/v.height*r.height)}})()`); window.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 }); await js('new Promise(r=>requestAnimationFrame(r))'); }
  async function capture(suffix: string, selector: string) { await js(`document.activeElement?.blur();document.querySelector(${json(selector)}).scrollIntoView({block:'start',behavior:'instant'})`); await new Promise(r => setTimeout(r, 250)); await writeFile(output.replace(/\.json$/, suffix), (await window.webContents.capturePage()).toPNG()); }
  window.setContentSize(1440, 940); window.showInactive();
  try {
    if (process.env.AUTOLABEL_EDITING_DISPLAY_ONLY === '1') {
      await wait(`!!document.querySelector('.nav-item')&&!document.querySelector('.connection-banner')`); await click('.nav-item:nth-child(1)'); await wait(`!!document.querySelector('.project-row')`); await click('.project-row'); await wait(`!!document.querySelector('.workbench')`); await button('类别与点位模板'); await click('.template-section>summary');
      assert.equal(await js(`document.querySelectorAll('.attribute-definition').length`), 4); assert.equal(await js(`document.querySelectorAll('.attribute-definition-heading input[type="checkbox"]').length`), 4); await capture('-template.png', 'dialog[open] .template-section');
      await writeFile(output, json({ passed: true, mode: 'editing-display-only', writes: 0, attributeTypes: 4 })); return;
    }
    const square = [{ x: 200, y: 200 }, { x: 600, y: 200 }, { x: 600, y: 500 }, { x: 200, y: 500 }];
    assert.equal(insertPolygonPoint(square, 3)!.length, 5); assert.deepEqual(insertPolygonPoint(square, 3)![4], { x: 200, y: 350 }); assert.equal(deletePolygonPoint(square.slice(0, 3), 0), null); assert.equal(insertPolygonPoint(Array(MAX_POLYGON_POINTS).fill({ x: 0, y: 0 }), 0), null);
    assert.equal(attributeDefinitions({ explanation: 'legacy' }), null); assert.equal(attributeValueIssue({ id: 'n', name: '数量', type: 'number', required: true, min: 0 }, 0), null); assert.equal(attributeValueIssue({ id: 'b', name: '遮挡', type: 'boolean', required: true }, false), null); assert.ok(attributeValueIssue({ id: 't', name: '说明', type: 'text', required: true }, '  ')); assert.ok(attributeValueIssue({ id: 's', name: '选项', type: 'select', required: false, options: ['甲'] }, '乙'));
    checks.push({ check: 'editor-boundaries', polygonMin: 3, polygonMax: 4096, closingEdge: true, falseAndZeroValid: true, legacyUntouched: true });
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const name = `7C 编辑验收-${Date.now()}`, project = await api('project.create', { name, taskType: 'segment', classes: [{ id: 'vehicle', name: '车辆', color: '#477b93' }] });
    const legacy = { description: '保留旧属性说明', nested: [1, { visible: true }] }, rules = { boundary: '贴合可见轮廓', preserve: [1, 2] };
    await api('project.update', { projectId: project.id, settings: { attributes: legacy, rules, occlusionRules: '遮挡部分需要注明', blurRules: '不确定时留待复核' } });
    const fixtures = path.join(userData, 'fixtures'); await mkdir(fixtures, { recursive: true }); const picture = path.join(fixtures, 'editing.png'); await copyFile(path.resolve('renderer/public/example-street.png'), picture);
    // ---- 模板：结构化属性与旧字段共存 ----
    await new Promise<void>(r => { window.webContents.once('did-finish-load', r); window.webContents.reload(); }); await wait(`!!document.querySelector('.sidebar')&&!document.querySelector('.connection-banner')`); await gotoWelcome({ js, wait });
    await openProjectOverview({ js, wait }, name);
    await button('类别与点位模板'); await button('保存模板'); await wait(`!document.querySelector('dialog[open]')`); let savedProject = await api('project.open', { projectId: project.id }); assert.deepEqual(savedProject.settings.attributes, legacy); assert.deepEqual(savedProject.settings.rules, rules);
    await button('类别与点位模板'); await click('.template-section>summary'); await button('用结构化属性替换此说明');
    for (const [i, type, label] of [[1, 'number', '数量'], [2, 'boolean', '遮挡'], [3, 'text', '描述'], [4, 'select', '情况']] as const) { await button('添加属性'); await fill(`[aria-label="属性定义${i}名称"]`, label); await select(`[aria-label="属性定义${i}类型"]`, type); if (i <= 2) await click(`[aria-label="属性定义${i}必填"]`); if (type === 'select') await fill(`[aria-label="属性定义${i}选项"]`, '正常\n模糊'); }
    await capture('-template.png', 'dialog[open] .template-section'); await button('保存模板'); await wait(`!document.querySelector('dialog[open]')`); savedProject = await api('project.open', { projectId: project.id }); const defs = savedProject.settings.attributes.definitions;
    assert.equal(defs.length, 4); assert.deepEqual(savedProject.settings.rules, rules);
    checks.push({ check: 'template-structured-attributes', definitions: defs.length, legacyRulesPreserved: true });
    // ---- 答案集：素材必须经界面导入（路径授权只认用户选择），进项目会话让应用层拿到素材 ----
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'images', paths: [picture] }]));
    await gotoWelcome({ js, wait });
    const clicked = await js<boolean>(`(()=>{const b=[...document.querySelectorAll('.onboarding-lane button')].find(x=>x.innerText.trim()==='导入图片');if(!b)return false;b.click();return true;})()`); assert.ok(clicked, '欢迎页找不到「导入图片」入口');
    const prompt = "document.querySelector('dialog[open]')"; await button('选择已有项目', prompt);
    const picked = await js<boolean>(`(()=>{const e=${prompt}.querySelector('select');if(!e)return false;e.value=${json(project.id)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`); assert.ok(picked, '项目确认框里没有可选的已有项目');
    await button('导入并继续', prompt); await wait(`!!document.querySelector('.chat-panel textarea')`);
    await openProjectOverview({ js, wait }, name); await button('标准答案集'); await button('新建标准答案集'); await fill('dialog[open] .field input', '固定模板标准'); await click('dialog[open] .quality-asset-picks input'); await button('创建独立答案集'); await wait(`!!document.querySelector('.truth-asset-list button')`); await click('.truth-asset-list button'); await wait(`!!document.querySelector('.truth-editor img')&&document.querySelector('.truth-editor img').complete`);
    await button('绘制标准多边形'); for (const p of square) await canvasClick('svg[aria-label="独立标准答案画布"]', p.x, p.y); await button('完成标准多边形'); await wait(`document.querySelectorAll('[data-quality-vertex]').length===4`);
    // 插入点与删除顶点依赖的画布工具按钮已随工作台移除，这里改成断言模板属性在真值编辑器里可用。
    await fill('.truth-properties [aria-label="属性 数量"]', '0'); await select('.truth-properties [aria-label="属性 遮挡"]', 'false'); await click('.truth-savebar input'); await button('保存独立标准答案'); await wait(`!document.querySelector('.truth-savebar input').checked`); await capture('-truth.png', '.truth-editor');
    checks.push({ check: 'fixed-template-truth-editor', independentPolygon: true, templateAttributesVisible: true });
    assert.equal((await api('run.list')).length, 0); await writeFile(output, json({ passed: true, mode: 'editing-ui', newModelRuns: 0, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, checks, error: e instanceof Error ? e.message : String(e), body: await js('document.body.innerText') })); throw e; }
}
