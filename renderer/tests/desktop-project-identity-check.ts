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
    await button('导入图片');
    // 项目必须由用户确认归属：导入前先过确认框。同名项目会默认落在「选择已有项目」上，一并覆盖。
    await button('导入并继续');
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
  }
  /** 回到欢迎页：新对话把界面交回欢迎页，由描述建好项目后再开会话。 */
  async function toWelcome() {
    await js(`[...document.querySelectorAll('.sidebar-scroll .nav-item')].find(b=>b.innerText.trim()==='新对话').click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
  }
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    for (const [index, source] of sources.entries()) await copyFile(path.resolve(source), paths[index]);

    // ===== 首次导入：建立项目 =====
    await importFolder();
    const created = (await api<Array<{ id: string; name: string; assetCount: number }>>('project.list')).find(item => item.name === batch);
    assert.ok(created, `导入应建立名为 ${batch} 的项目`);
    const first = await api<{ total: number }>('asset.list', { projectId: created!.id, limit: 100 });
    assert.equal(first.total, 2, '首次导入应有 2 张素材');

    // ===== 新建项目时直接填类别与标注要求 =====
    // 这条链原先要在对话里让助手调 set_project_classes 才能建类别，对话模型不可用时整条断掉；
    // 现在断言的是「命名 + 类别 + 标注要求」一次落盘，且写进的是项目自己的模板。
    await js(`document.querySelector('.sidebar-group-more[aria-label="新建项目"]').click()`);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('要标注的类别')`);
    // 名字不与本次批次同名：后面「侧栏项目行显示素材数」按批次名匹配，不能被这个草稿项目抢先命中。
    const draftName = `手办草稿-${Date.now()}`;
    const draftRules = '只要画面中间那个小手办，不要框旁边的大号毛绒公仔。';
    const setField = (selector: string, value: string) => js(`(()=>{const e=${dialog}.querySelector(${json(selector)});const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await setField('input[placeholder="给项目起个名字"]', draftName);
    await setField('input[placeholder="例如：手办、车辆、行人"]', '手办、公仔');
    await setField('textarea', draftRules);
    await button('创建项目', dialog);
    // 等确认框自己关掉：此时「建项目 → 落类别 → 写标注规则 → 取回项目」这一串才算跑完。
    // 只等 .chat-panel textarea 会立刻命中上一个项目的会话页，拿到的就是还没写完的数据。
    await waitFor(`!document.querySelector('dialog[open]')`);
    await waitFor(`[...document.querySelectorAll('.sidebar-project')].some(g=>g.innerText.includes(${json(draftName)}))`);
    const drafts = await api<Array<{ id: string; name: string }>>('project.list');
    const draft = drafts.find(item => item.name === draftName);
    assert.ok(draft, `新建项目应出现在列表里，实际：${json(drafts.map(item => item.name))}`);
    const drafted = await api<{ classes: Array<{ name: string }>; settings: Record<string, unknown> }>('project.open', { projectId: draft!.id });
    assert.deepEqual(drafted.classes.map(item => item.name), ['手办', '公仔'], `确认框里填的类别应落到项目上，实际：${json(drafted.classes)}`);
    assert.equal(drafted.settings.rules, draftRules, `确认框里填的标注要求应写进项目的标注规则；实际 settings=${json(drafted.settings)}，弹框提示=${await js<string>(`${dialog}?.querySelector('.inline-error')?.innerText ?? '(无)'`)}`);
    checks.push({ check: 'new-project-takes-classes-and-rules', classes: drafted.classes.map(item => item.name), rules: drafted.settings.rules });
    await toWelcome();
    // 项目计数在下面「重复导入不再新建项目」里比较，必须在这批新建动作之后再取。
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
    await waitFor(`document.querySelector('.composer-hint')?.innerText.includes('新建项目')`, 10000);
    const newHint = await js<string>(`document.querySelector('.composer-hint').innerText`);
    assert.ok(newHint.includes('换一个全新的描述'), `新建时也应写出项目名，实际：${newHint}`);
    checks.push({ check: 'home-shows-destination', reuse: reuseHint.replace(/\s+/g, ' '), create: newHint.replace(/\s+/g, ' ') });

    // ===== 记住落点：勾过一次之后，下次默认停在这个项目 =====
    // 用另一批素材（建议名与已有项目都不同）走一遍，才不会把「同名自动并入」误当成本次的「记住了」。
    const nameOf = async (text: string) => { const dir = path.join(fixtures, text); await mkdir(dir, { recursive: true }); await copyFile(path.resolve(sources[0]), path.join(dir, 'shot.png')); await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'directory', paths: [dir] }])); return dir; };
    await toWelcome();
    await nameOf(`${batch}-first`);
    await button('导入图片文件夹');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('新建项目')`);
    await button('选择已有项目', dialog);
    await waitFor(`!!${dialog}.querySelector('select')`);
    await js(`(()=>{const e=${dialog}.querySelector('select');e.value=${json(created!.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await js(`(()=>{const l=[...${dialog}.querySelectorAll('.checkbox-row')].find(node=>node.innerText.includes('以后欢迎页的素材默认进这个项目'));if(!l)throw new Error('确认框应给出记住落点选项');l.querySelector('input').click();})()`);
    await button('导入并继续');
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    const remembered = (await api<{ defaultProjectId?: string }>('settings.get')).defaultProjectId;
    assert.equal(remembered, created!.id, `勾选后应把落点写进设置，实际：${json(remembered)}`);
    checks.push({ check: 'remember-project-destination', defaultProjectId: remembered });

    // 再开一次，素材来自第三个文件夹：默认必须停在记住的项目上，而不是「新建项目」。
    await toWelcome();
    await nameOf(`${batch}-second`);
    await button('导入图片文件夹');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('选择已有项目')`);
    const reopened = await js<{ mode: string; selected: string; checked: boolean }>(`(()=>{const d=${dialog};
      const box=[...d.querySelectorAll('.checkbox-row')].find(node=>node.innerText.includes('以后欢迎页的素材默认进这个项目'));
      return { mode: d.querySelector('select') ? 'existing' : 'create', selected: d.querySelector('select')?.value ?? '', checked: !!box?.querySelector('input')?.checked };})()`);
    assert.equal(reopened.mode, 'existing', '记住落点后应默认停在「选择已有项目」');
    assert.equal(reopened.selected, created!.id, `默认应选中记住的项目，实际：${json(reopened)}`);
    assert.equal(reopened.checked, true, '再次打开时勾选应保持');
    checks.push({ check: 'remembered-destination-default', ...reopened });
    await button('取消', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
