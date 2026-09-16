import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 项目身份与上下文错位验收。
 *
 * 走查里最伤的一条是「素材明明导进来了，助手却坚持说没有」：重复拖入同一批素材会生成两个
 * 外观完全一致的项目，助手落在空的那个上。本次验收断言：
 * 1. 同一批素材重复导入不再产生同名项目，而是并入已有项目，且重复素材按内容指纹仍只有一份；
 * 2. 首页输入框在发送前就写出落点（新建哪个项目 / 并入哪个项目）；
 * 3. 侧栏项目行带素材数，同名项目可以直接区分。
 */
export async function checkDesktopProjectIdentity(window: BrowserWindow, output: string): Promise<void> {
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '项目身份验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  const batch = `identity-${Date.now()}`;
  const fixtures = path.join(userData, 'fixtures', batch);
  await mkdir(fixtures, { recursive: true });
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}（当前弹窗文本：${await js<string>(`${dialog}?${dialog}.innerText.slice(0,300):'(无弹窗)'`)}）`);
  }
  async function button(text: string, scope = 'document') {
    await waitFor(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
    await js(`([...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)})).click()`);
  }
  const projectCount = async () => (await api<Array<{ id: string }>>('project.list')).length;
  const sources = ['renderer/design/codex-flow.png', 'renderer/design/codex-projects.png'];
  const paths = sources.map((_, index) => path.join(fixtures, `shot-${index + 1}.png`));
  async function importFolder() {
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'images', paths }]));
    await button('导入图片开始标注');
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
  }
  /** 回到欢迎页：新对话把界面交回欢迎页，由描述建好项目后再开会话。 */
  async function toWelcome() {
    await js(`[...document.querySelectorAll('.sidebar-scroll .nav-item')].find(b=>b.innerText.trim()==='新对话').click()`);
    await waitFor(`!!document.querySelector('.chat-suggestions')`);
  }
  try {
    window.show();
    await waitFor(`!!document.querySelector('.chat-suggestions')&&!document.querySelector('.connection-banner')`);
    for (const [index, source] of sources.entries()) await copyFile(path.resolve(source), paths[index]);

    // ===== 首次导入：建立项目 =====
    await importFolder();
    const created = (await api<Array<{ id: string; name: string; assetCount: number }>>('project.list')).find(item => item.name === batch);
    assert.ok(created, `导入应建立名为 ${batch} 的项目`);
    const first = await api<{ total: number }>('asset.list', { projectId: created!.id, limit: 100 });
    assert.equal(first.total, 2, '首次导入应有 2 张素材');
    const countBefore = await projectCount();

    // 侧栏项目行必须带素材数：同名项目靠它区分。
    await toWelcome();
    await waitFor(`[...document.querySelectorAll('.sidebar-project')].some(g=>g.innerText.includes(${json(batch)}))`);
    const projectRow = await js<string>(`[...document.querySelectorAll('.sidebar-project')].find(g=>g.innerText.includes(${json(batch)})).innerText`);
    assert.ok(projectRow.includes('2 张'), `侧栏项目行应显示素材数，实际：${projectRow}`);
    checks.push({ check: 'sidebar-shows-asset-count', row: projectRow.replace(/\s+/g, ' ') });

    // ===== 重复导入同一批素材：必须并入而不是新建 =====
    await importFolder();
    // 提示那一格会被紧随其后的自动发送（本环境未配置模型时会报错）顶掉，所以这里只记录它是否出现过，
    // 复用分支的实质证据用项目数、素材数与会话标题来断言。
    const reuseNotice = await js<string>(`document.querySelector('.toast')?.innerText ?? ''`);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await projectCount(), countBefore, '重复导入同一批素材不应再新建项目');
    const projects = await api<Array<{ id: string; name: string; assetCount: number }>>('project.list');
    assert.equal(projects.filter(item => item.name === batch).length, 1, `同名项目只应存在一个，实际：${json(projects.map(item => item.name))}`);
    const after = await api<{ total: number }>('asset.list', { projectId: created!.id, limit: 100 });
    assert.equal(after.total, 2, `重复导入不应重复入库，实际 ${after.total} 张`);
    // 复用分支必须知道自己跳过了多少：会话标题写的是「之前已经导入过」，而不是照抄「刚导入了 N 张」。
    const sessions = await api<{ sessions: Array<{ title: string }> }>('chat.history.list', { projectId: created!.id });
    assert.ok(sessions.sessions.some(session => session.title.includes('已经导入过')), `复用时应当说明素材已存在，实际会话：${json(sessions.sessions.map(session => session.title))}`);
    checks.push({ check: 'duplicate-import-reuses-project', projects: projects.length, assets: after.total, reuseNotice: reuseNotice.includes('并入同名项目') || sessions.sessions.some(session => session.title.includes('已经导入过')) });

    // ===== 发送前的落点提示：并入 / 新建都要写出来 =====
    await toWelcome();
    await js(`(()=>{const e=document.querySelector('.chat-home textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${json(batch)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.composer-hint')?.innerText.includes('并入已有项目')`, 10000);
    const reuseHint = await js<string>(`document.querySelector('.composer-hint').innerText`);
    assert.ok(reuseHint.includes(batch), `落点提示应写出项目名，实际：${reuseHint}`);
    await js(`(()=>{const e=document.querySelector('.chat-home textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'换一个全新的描述');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.composer-hint')?.innerText.includes('将新建项目')`, 10000);
    const newHint = await js<string>(`document.querySelector('.composer-hint').innerText`);
    assert.ok(newHint.includes('换一个全新的描述'), `新建时也应写出项目名，实际：${newHint}`);
    checks.push({ check: 'home-shows-destination', reuse: reuseHint.replace(/\s+/g, ' '), create: newHint.replace(/\s+/g, ' ') });
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
