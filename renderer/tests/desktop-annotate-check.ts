import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 素材人工标注验收。
 *
 * 走查结论是「本版本没有人工标注工作台」，复核后收窄为「画布存在且已在轨迹标注链路使用，
 * 但没有接到普通素材的预览页上，且界面仍在宣传不存在的快捷键」。本次验收断言：
 * 1. 素材预览里有「编辑标注」入口，且落到的就是可写画布（`.quality-canvas.editable`）；
 * 2. 项目还没有类别时入口不可用，并给出可读原因而不是静默失败；
 * 3. 画布上的改动经「保存」写入正式标注：版本号递增、状态变为「人工修改」、重新打开可见；
 * 4. 「保存并确认」把状态推进到「已确认」，与候选 → 正式标注的既有语义一致；
 * 5. 帮助与设置里不再宣传不可用的快捷键（V/H、B/O、Ctrl+S、Ctrl+Z、工作台）。
 *
 * 画框手势不在这里模拟：画布的 `setPointerCapture` 要求指针真实处于活动状态，合成事件会抛
 * NotFoundError，断言会变成测试自身的问题。几何绘制是既有能力，本验收聚焦「入口 + 写入落库」这条新链路。
 */
export async function checkDesktopAnnotate(window: BrowserWindow, output: string): Promise<void> {
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '人工标注验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  const batch = `annotate-${Date.now()}`;
  const fixtures = path.join(userData, 'fixtures', batch);
  await mkdir(fixtures, { recursive: true });
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: unknown = {}): Promise<T> => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  /** fill / select 走的是 CSS 选择器（不是 JS 表达式），弹窗内定位统一用这个前缀。 */
  const dialogCss = 'dialog[open]';
  async function waitFor(expression: string, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      // 表达式可能因为元素还没渲染而抛错（例如读 null 的 value）。这类情况按「还没好」处理，
      // 否则会变成一条不带上下文的 "Script failed to execute"。
      // 必须 await 求值结果：直接 `!!(表达式)` 会把返回 Promise 的表达式判成恒真，等于没等。
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}（当前弹窗文本：${await js<string>(`${dialog}?${dialog}.innerText.slice(0,400):'(无弹窗)'`)}）`);
  }
  async function button(text: string, scope = 'document') {
    await waitFor(`!!${scope} && [...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
    await js(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)});b.click()})()`);
  }
  const enabled = (text: string, scope = dialog) => js<boolean>(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
  /** select 走原生 setter + change，React 的受控选择框才认这次改动。 */
  async function select(selector: string, value: string) {
    await waitFor(`!!document.querySelector(${json(selector)})`);
    await js(`(()=>{const e=document.querySelector(${json(selector)});e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  // 注入前先等元素出现：上一步点击触发的 React 重渲染与下一次注入是两个往返，直接注入会抢在重渲染前面。
  async function fill(selector: string, value: string) {
    await waitFor(`!!document.querySelector(${json(selector)})`);
    await js(`(()=>{const e=document.querySelector(${json(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector(${json(selector)}).value===${json(value)}`);
  }
  async function openAsset(name: string) {
    await js(`[...document.querySelectorAll('.result-thumb')].find(b=>b.innerText.includes(${json(name)})).click()`);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('编辑标注')`);
  }
  const checks: Record<string, unknown>[] = [];
  window.show();
  try {
    await waitFor(`!!document.querySelector('.chat-suggestions')&&!document.querySelector('.connection-banner')`);
    const sources = ['renderer/design/codex-flow.png', 'renderer/design/codex-projects.png'];
    for (const [index, source] of sources.entries()) await copyFile(path.resolve(source), path.join(fixtures, `figure-${index + 1}.png`));
    const paths = sources.map((_, index) => path.join(fixtures, `figure-${index + 1}.png`));
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'images', paths }]));
    await button('导入图片开始标注');
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    const created = (await api<Array<{ id: string; name: string }>>('project.list')).find(item => item.name === batch);
    assert.ok(created, `欢迎页导入应建立名为 ${batch} 的项目`);
    const projectId = created!.id;

    await js(`[...document.querySelectorAll('.sidebar-project')].find(g=>g.innerText.includes(${json(batch)})).querySelector('[title="项目概览"]').click()`);
    await waitFor(`!!document.querySelector('.page-overview')&&!!document.querySelector('.result-thumb')`);

    // ===== 无类别时：入口存在但明确不可用，并说清去哪加类别 =====
    await openAsset('figure-1');
    assert.equal(await enabled('编辑标注'), false, '项目没有类别时不应能进入编辑');
    const blockedText = await js<string>(`${dialog}.innerText`);
    assert.ok(blockedText.includes('类别与点位模板'), `无类别时应指向真实入口，实际：${blockedText.slice(0, 300)}`);
    assert.ok(!blockedText.includes('工作台'), `预览文案不应再提工作台，实际：${blockedText.slice(0, 300)}`);
    checks.push({ check: 'annotate-entry-blocked-without-classes', pointsToTemplate: true });
    await button('关闭', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);

    // 走真实入口建类别，而不是直接用接口绕过去。
    await button('类别与点位模板');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('类别与点位模板')`);
    await button('添加类别', dialog);
    await fill(`${dialogCss} [aria-label="类别1名称"]`, '粉色手办');
    await button('保存模板', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    const project = (await api<Array<{ id: string; classes: Array<{ id: string; name: string }> }>>('project.list')).find(item => item.id === projectId)!;
    const classId = project.classes.find(item => item.name === '粉色手办')?.id;
    assert.ok(classId, '类别应真的写进项目');
    checks.push({ check: 'class-created-from-real-entry', classId });

    // 先在引擎里放一个对象，再验证「画布读得到 + 画布改得动 + 保存落库」。
    const listed = await api<{ items: Array<{ id: string; name: string; version: number }> }>('asset.list', { projectId, limit: 100 });
    const target = listed.items.find(item => item.name.startsWith('figure-1'))!;
    await api('annotation.save', { assetId: target.id, baseVersion: target.version, confirm: false,
      annotations: [{ id: 'annotate-fixture', type: 'detect', classId, bbox: { x: 40, y: 40, width: 120, height: 90 } }] });
    const seeded = await api<{ version: number; status: string }>('asset.get', { assetId: target.id });
    assert.equal(seeded.status, 'modified', '未确认的保存应记为人工修改');

    // ===== 画布可写 + 保存落库 =====
    await openAsset('figure-1');
    await button('编辑标注', dialog);
    await waitFor(`!!document.querySelector('.asset-annotator .quality-canvas.editable')`);
    assert.ok(await js<boolean>(`[...document.querySelectorAll('.asset-annotator button')].some(b=>b.innerText.includes('绘制标注框'))`), '编辑态应提供绘制工具');
    assert.ok(await js<boolean>(`!!document.querySelector('.asset-annotator .truth-properties')`), '编辑态应显示几何与类别控件');
    // 选中已有对象 → 改 X → 保存。走下拉与数字输入而不是模拟拖动：不依赖真实指针活动状态。
    await waitFor(`!!document.querySelector('.asset-annotator .truth-properties select option[value="annotate-fixture"]')`);
    await select('.asset-annotator .truth-properties select', 'annotate-fixture');
    await waitFor(`!!document.querySelector('.asset-annotator [aria-label="标注对象x"]')`);
    await fill('.asset-annotator [aria-label="标注对象x"]', '77');
    assert.equal(await enabled('保存'), true, '有改动后「保存」应可用');
    await button('保存', dialog);
    await waitFor(`window.autoLabel.request('asset.get',{assetId:${json(target.id)}}).then(a=>a.version>${seeded.version})`);
    const saved = await api<{ version: number; status: string; annotations: Array<{ bbox: { x: number } }> }>('asset.get', { assetId: target.id });
    assert.equal(saved.status, 'modified', '「保存」应写入人工修改');
    assert.equal(saved.annotations[0].bbox.x, 77, '画布上的改动应真的写进正式标注');
    checks.push({ check: 'annotate-save-writes-annotation', version: saved.version, status: saved.status, x: saved.annotations[0].bbox.x });

    // 「保存并确认」把状态推进到已确认；再改一次才对得上后面的版本比对。
    await js(`document.querySelector('.asset-annotator [aria-label="标注对象x"]').focus()`);
    await fill('.asset-annotator [aria-label="标注对象x"]', '91');
    await button('保存并确认', dialog);
    await waitFor(`window.autoLabel.request('asset.get',{assetId:${json(target.id)}}).then(a=>a.status==='confirmed')`);
    const confirmed = await api<{ version: number; annotations: Array<{ bbox: { x: number } }> }>('asset.get', { assetId: target.id });
    assert.equal(confirmed.annotations[0].bbox.x, 91, '确认保存也应写入几何改动');
    checks.push({ check: 'annotate-save-and-confirm', version: confirmed.version, status: 'confirmed' });
    await button('关闭', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);

    // 重新打开：进入编辑态即选中首个对象，几何必须是刚保存的那份，版本记录里也查得到。
    await openAsset('figure-1');
    await button('编辑标注', dialog);
    await waitFor(`!!document.querySelector('.asset-annotator [aria-label="标注对象x"]')`);
    assert.equal(await js<string>(`document.querySelector('.asset-annotator [aria-label="标注对象x"]').value`), '91', '重新打开应看到已保存的几何');
    await button('关闭', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    const history = await api<Array<{ version: number }>>('annotation.history', { assetId: target.id });
    assert.ok(history.length >= 3 && history[0].version === confirmed.version, `标注历史应能查到新版本，实际：${JSON.stringify(history.map(v => v.version))}`);
    checks.push({ check: 'annotate-reopen-visible', historyVersions: history.length });

    // ===== 文案一致性：不再宣传不可用的快捷键 =====
    await js(`[...document.querySelectorAll('.topbar-actions button')].find(b=>b.getAttribute('aria-label')==='快捷键与帮助').click()`);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('快捷键与帮助')`);
    const helpText = await js<string>(`${dialog}.innerText`);
    for (const ghost of ['工作台', 'V / H', 'B / O / S / P / C', 'Ctrl + S', 'Ctrl + Z']) {
      assert.ok(!helpText.includes(ghost), `帮助弹窗仍在宣传不存在的「${ghost}」，实际：${helpText.slice(0, 400)}`);
    }
    assert.ok(helpText.includes('编辑标注'), '帮助弹窗应指向真实的人工标注入口');
    // 帮助弹窗只有图标关闭按钮，没有文字「关闭」。
    await js(`document.querySelector('dialog[open] button[aria-label="关闭弹窗"]').click()`);
    await waitFor(`!document.querySelector('dialog[open]')`);

    await js(`[...document.querySelectorAll('.sidebar-bottom .nav-item')].find(b=>b.innerText.trim()==='设置').click()`);
    await waitFor(`!!document.querySelector('.settings-tabs')`);
    await js(`[...document.querySelectorAll('.settings-tabs button')].find(b=>b.innerText.trim()==='快捷键').click()`);
    await waitFor(`!!document.querySelector('.settings-body')`);
    const settingsText = await js<string>(`document.querySelector('.settings-body').innerText`);
    for (const ghost of ['标注工作台', 'V / H', 'Ctrl + S', 'Ctrl + Z']) {
      assert.ok(!settingsText.includes(ghost), `设置页仍在宣传不存在的「${ghost}」，实际：${settingsText.slice(0, 400)}`);
    }
    checks.push({ check: 'shortcut-copy-matches-capability', helpGhosts: 0, settingsGhosts: 0 });

    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
