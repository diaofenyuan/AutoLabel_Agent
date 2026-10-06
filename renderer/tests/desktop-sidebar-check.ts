import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/**
 * 侧栏可读性验收。
 *
 * 走查结论是：侧栏里项目名被截成一个字（「城…」「旋…」），同名项目之间根本分不出来——
 * 根因是项目行永久预留了 84px 给悬浮操作，而操作本来就是悬浮才出现的。
 * 本次验收断言：
 * 1. 侧栏宽度够放下一列中文项目名；
 * 2. 项目名的可显示宽度足够认出名字，而不是两三个字就省略号；
 * 3. 悬浮时操作按钮仍然直接可达（不改成收进「…」菜单）。
 */
export async function checkDesktopSidebar(window: BrowserWindow, output: string): Promise<void> {
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const navigationChecks: Record<string, unknown>[] = [];
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
    const initialSidebar = await js<{ title: string; actions: string[]; recentLabel: string; recentRows: number; projectButton: boolean }>(`(()=>({
      title:document.querySelector('.sidebar-empty strong')?.innerText.trim()??'',
      actions:[...document.querySelectorAll('.sidebar-empty button')].map(node=>node.innerText.trim()),
      recentLabel:document.querySelector('.sidebar-recent .sidebar-group-title')?.innerText.trim()??'',
      recentRows:document.querySelectorAll('.sidebar-recent .sidebar-session').length,
      projectButton:!!document.querySelector('.sidebar-group-more[aria-label="新建项目"]')}))()`);
    assert.equal(initialSidebar.title, '从一个项目开始', '空项目状态应给出明确的起步说明');
    assert.deepEqual(initialSidebar.actions, ['新建项目', '试用示例项目'], '空状态提供新建和试用两条清晰入口');
    assert.equal(initialSidebar.recentLabel, '最近对话', '最近对话分组在空项目时仍可见');
    assert.equal(initialSidebar.projectButton, true, '项目列表标题仍提供常驻的新建入口');
    const navigationStates = await js<Record<string, boolean>>(`(()=>Object.fromEntries([...document.querySelectorAll('#app-sidebar .nav-item')].map(node=>[node.innerText.trim(),node.classList.contains('selected')])))()`);
    assert.equal(navigationStates['新对话'], true, `当前新对话入口必须显示选中态：${JSON.stringify(navigationStates)}`);
    assert.equal(navigationStates['任务'], false, '未打开的任务入口不应显示选中态');
    assert.equal(navigationStates['设置'], false, '未打开的设置入口不应显示选中态');
    navigationChecks.push({ check: 'sidebar-navigation-selected-state', navigationStates });
    await js(`([...document.querySelectorAll('#app-sidebar .nav-item')].find(node=>node.innerText.trim()==='任务')).click()`);
    await waitFor(`!!document.querySelector('.tasks-page')`);
    assert.equal(await js<boolean>(`[...document.querySelectorAll('#app-sidebar .nav-item')].find(node=>node.innerText.trim()==='任务')?.classList.contains('selected')`), true, '进入任务页后任务入口必须显示选中态');
    await js(`([...document.querySelectorAll('#app-sidebar .nav-item')].find(node=>node.innerText.trim()==='设置')).click()`);
    await waitFor(`!!document.querySelector('.settings-page')`);
    assert.equal(await js<boolean>(`[...document.querySelectorAll('#app-sidebar .nav-item')].find(node=>node.innerText.trim()==='设置')?.classList.contains('selected')`), true, '进入设置页后设置入口必须显示选中态');
    await js(`([...document.querySelectorAll('#app-sidebar .nav-item')].find(node=>node.innerText.trim()==='新对话')).click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
    assert.equal(await js<boolean>(`[...document.querySelectorAll('#app-sidebar .nav-item')].find(node=>node.innerText.trim()==='新对话')?.classList.contains('selected')`), true, '返回新对话后新对话入口必须显示选中态');
    navigationChecks.push({ check: 'sidebar-navigation-selected-state-after-clicks', task: true, settings: true, chat: true });
    await writeFile(output.replace(/\.json$/, '-empty.png'), (await window.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.sidebar-empty-primary').click()`);
    await waitFor(`!!document.querySelector('dialog[open] input[placeholder="给项目起个名字"]')`);
    await js(`([...document.querySelectorAll('dialog[open] button')].find(node=>node.innerText.trim()==='取消')).click()`);
    await waitFor(`!document.querySelector('dialog[open]')`);
    await js(`document.querySelector('.sidebar-empty-secondary').click()`);
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    await waitFor(`!!document.querySelector('.sidebar-project .sidebar-row-title')`);
    // 选中行常驻显示操作按钮，本来就需要预留宽度；这里量的是平时占多数的未选中行，
    // 也正是「项目名被截成一个字」发生时的那一行。
    const longName = '城市场景与更多补充说明的第二批';
    await js(`window.autoLabel.request('project.create',{name:${json(longName)},taskType:'detect'})`);
    await new Promise<void>(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await waitFor(`[...document.querySelectorAll('.sidebar-project .sidebar-row-title')].some(node=>node.innerText.trim()===${json(longName)})`);
    await waitFor(`!!document.querySelector('.sidebar-project:not(.selected) .sidebar-row-title')`);

    // ===== 静止态：名字能认出多少字 =====
    const resting = await js<{ sidebar: number; titleWidth: number; name: string; shown: number; selected: { width: number; name: string } }>(`(()=>{
      const side=document.querySelector('.sidebar').getBoundingClientRect();
      const estimate=(title)=>{const box=title.getBoundingClientRect();const size=Number(getComputedStyle(title).fontSize.replace('px',''));
        let used=0,shown=0;for(const ch of title.innerText.trim()){const w=/[\\u4e00-\\u9fa5\\uff00-\\uffef]/.test(ch)?size:size*0.55;if(used+w>box.width+1)break;used+=w;shown++;}
        return {box,shown};};
      const title=document.querySelector('.sidebar-project:not(.selected) .sidebar-row-title');
      const resting=estimate(title);
      const selectedTitle=document.querySelector('.sidebar-project.selected .sidebar-row-title');
      return {sidebar:Math.round(side.width),titleWidth:Math.round(resting.box.width),name:title.innerText.trim(),shown:resting.shown,
        selected:selectedTitle?{width:Math.round(selectedTitle.getBoundingClientRect().width),name:selectedTitle.innerText.trim()}:{width:0,name:''}};
    })()`);
    assert.ok(resting.sidebar >= 236, `侧栏太窄，放不下项目名：实际 ${resting.sidebar}px`);
    assert.ok(resting.titleWidth >= 84, `未选中项目名的可显示宽度不足，只能认出 ${resting.shown} 个字（${resting.titleWidth}px）：${resting.name}`);
    assert.ok(resting.shown >= 5, `项目名至少要能认出 5 个字，实际 ${resting.shown} 个：${resting.name}`);

    // ===== 预留宽度的规则：静止时不预留，操作真的显示出来时才预留 =====
    // 悬浮态没法用合成事件触发（:hover 由真实指针决定），但选中态走的是同一条规则，可以据此断言。
    // 先把示例项目打开，让侧栏里同时存在「选中」与「未选中」两种行。
    await js(`([...document.querySelectorAll('.sidebar-project .sidebar-row')].find(node=>node.innerText.includes('城市场景'))).click()`);
    await waitFor(`!!document.querySelector('.sidebar-project.selected .sidebar-row')`);
    const padding = await js<{ resting: string; selected: string; buttons: number }>(`(()=>{
      const resting=document.querySelector('.sidebar-project:not(.selected) .sidebar-row');
      const selected=document.querySelector('.sidebar-project.selected .sidebar-row');
      const actions=document.querySelector('.sidebar-project.selected .sidebar-actions');
      return { resting:getComputedStyle(resting).paddingRight, selected:getComputedStyle(selected).paddingRight, buttons:actions.querySelectorAll('button').length };})()`);
    assert.equal(padding.resting, '10px', `静止的项目行不该预留操作宽度，实际：${padding.resting}`);
    assert.ok(parseInt(padding.selected || '0', 10) >= 35, `更多操作入口显示时应预留其按钮宽度，实际：${padding.selected}`);
    assert.equal(padding.buttons, 1, `项目行只保留一个低频操作入口，实际 ${padding.buttons} 个`);
    await js(`document.querySelector('.sidebar-project.selected [aria-label^="项目操作 "]').click()`);
    await waitFor(`!!document.querySelector('.sidebar-menu[role="menu"][aria-label^="城市场景与更多补充说明的第二批"]')`);
    const projectMenuItems = await js<string[]>(`[...document.querySelectorAll('.sidebar-menu[role="menu"] [role="menuitem"]')].map(item=>item.innerText.trim())`);
    assert.deepEqual(projectMenuItems, ['项目概览', '重命名', '删除项目…'], '项目低频操作应收在明确命名的更多菜单中');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await waitFor(`!document.querySelector('.sidebar-menu[role="menu"][aria-label^="城市场景与更多补充说明的第二批"]') && document.querySelector('.sidebar-project.selected [aria-label^="项目操作 "]')?.getAttribute('aria-expanded')==='false'`);

    // ===== 会话的上下文属于项目：从别的项目点开一条会话时，必须先把项目切过去 =====
    // 会话行在每个项目分组下都会出现，点它却只换会话不换项目的话，助手会拿另一个项目的素材回答。
    const projectRow = (needle: string) => `[...document.querySelectorAll('.sidebar-project')].find(row=>row.querySelector('.sidebar-row-title')?.innerText.trim().includes(${json(needle)}))`;
    let crossProject = { before: '', sessionTitle: '', clicked: false };
    let afterSwitch = { project: '', sessionSelected: false, panel: false };
    await js(`${projectRow('人工示例')}?.querySelector('.sidebar-row')?.click()`);
    await waitFor(`document.querySelector('.sidebar-project.selected .sidebar-row-title')?.innerText.trim().includes('人工示例')`);
    await waitFor(`!!document.querySelector('.sidebar-recent .sidebar-session')`);
    // 先切到另一个项目，再从「最近对话」打开示例项目的会话：上下文必须随会话一起切换。
    await js(`${projectRow('第二批')}?.querySelector('.sidebar-row')?.click()`);
    await waitFor(`document.querySelector('.sidebar-project.selected .sidebar-row-title')?.innerText.trim().includes('第二批')`);
    crossProject = await js<{ before: string; sessionTitle: string; clicked: boolean }>(`(()=>{
      const session=[...document.querySelectorAll('.sidebar-recent .sidebar-session')].find(node=>node.querySelector('.sidebar-session-owner')?.innerText.trim().includes('人工示例'));
      const row=session?.querySelector('.sidebar-row');
      const before=document.querySelector('.sidebar-project.selected .sidebar-row-title')?.innerText.trim()??'';
      row?.click();
      return {before,sessionTitle:session?.querySelector('.sidebar-row-title')?.innerText.trim()??'',clicked:!!row};})()`);
    await waitFor(`document.querySelector('.sidebar-project.selected .sidebar-row-title')?.innerText.trim().includes('人工示例') && !!document.querySelector('.chat-panel')`);
    afterSwitch = await js<{ project: string; sessionSelected: boolean; panel: boolean }>(`(()=>{
      const session=document.querySelector('.sidebar-recent .sidebar-session.selected');
      return {project:document.querySelector('.sidebar-project.selected .sidebar-row-title')?.innerText.trim()??'',
        sessionSelected:!!session,panel:!!document.querySelector('.chat-panel')};})()`);
    assert.ok(crossProject.clicked, `最近对话里应有属于示例项目的会话：${JSON.stringify(crossProject)}`);
    assert.ok(afterSwitch.project.includes('人工示例'), `点开别的项目的历史会话后，当前项目应切到会话所属项目，实际是「${afterSwitch.project}」`);
    assert.ok(afterSwitch.sessionSelected && afterSwitch.panel, `被点开的会话应成为当前会话并显示对话页：${JSON.stringify(afterSwitch)}`);
    const sessionPresentation = await js<{ recent: number; ownerLabels: number; detachedRows: number }>(`(()=>{
      const rows=[...document.querySelectorAll('.sidebar-recent .sidebar-session')];
      return {recent:rows.length,ownerLabels:rows.filter(node=>!!node.querySelector('.sidebar-session-owner')?.innerText.trim()).length,
        detachedRows:rows.filter(node=>!node.closest('.sidebar-project-group')).length};})()`);
    assert.ok(sessionPresentation.recent > 0, '有历史会话时应在「最近对话」中列出');
    assert.equal(sessionPresentation.ownerLabels, sessionPresentation.recent, '最近对话应为每条会话显示所属项目');
    assert.equal(sessionPresentation.detachedRows, sessionPresentation.recent, '会话应独立于项目列表呈现，避免重复显示');

    // 侧栏搜索只找项目/会话；顶栏 Ctrl+K 快速跳转只找页面，避免两个入口打开同一个页面列表。
    await js(`document.querySelector('.sidebar-top [aria-label="搜索项目和会话"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open] input[aria-label="搜索项目和会话"]')`);
    await js(`(()=>{const e=document.querySelector('dialog[open] input[aria-label="搜索项目和会话"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(longName)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`[...document.querySelectorAll('.sidebar-search-results button')].some(button=>button.innerText.includes(${json(longName)}))`);
    const projectSearch = await js<{ project: boolean; pageOnly: boolean }>(`(()=>({
      project:[...document.querySelectorAll('.sidebar-search-results button')].some(button=>button.innerText.includes(${json(longName)})),
      pageOnly:[...document.querySelectorAll('.sidebar-search-results button')].some(button=>button.innerText.trim()==='任务')}))()`);
    assert.deepEqual(projectSearch, { project: true, pageOnly: false }, '侧栏搜索应定位到项目，不混入页面命令');
    await js(`document.querySelector('dialog[open] [aria-label="关闭弹窗"]').click()`);
    await waitFor(`!document.querySelector('dialog[open]')`);
    await js(`document.querySelector('.command-trigger').click()`);
    await waitFor(`!!document.querySelector('dialog[open] input[placeholder="搜索页面…"]')`);
    await js(`(()=>{const e=document.querySelector('dialog[open] input[placeholder="搜索页面…"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'任务');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelectorAll('.command-list>button').length===1`);
    const jumpSearch = await js<{ page: string; count: number }>(`(()=>({page:document.querySelector('.command-list>button')?.innerText.trim()??'',count:document.querySelectorAll('.command-list>button').length}))()`);
    assert.deepEqual(jumpSearch, { page: '任务', count: 1 }, '快速跳转应只返回页面命令');
    await js(`document.querySelector('dialog[open] [aria-label="关闭弹窗"]').click()`);
    await waitFor(`!document.querySelector('dialog[open]')`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());

    // 移动端抽屉打开时，背景应退出焦点与辅助技术树；抽屉内的关闭按钮负责恢复原有焦点路径。
    const originalSize = window.getSize();
    const debuggerWasAttached = window.webContents.debugger.isAttached();
    let drawerModal: Record<string, unknown>;
    try {
      // 桌面验收窗口有 1100px 的最小宽度，使用 Chromium 设备指标模拟移动视口，避免改动产品窗口约束。
      if (!debuggerWasAttached) window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 700, height: 800, deviceScaleFactor: 1, mobile: false });
      await waitFor(`innerWidth<=760 && !!document.querySelector('.breadcrumb [aria-label="展开侧栏"]')`);
      await js(`document.querySelector('.breadcrumb [aria-label="展开侧栏"]').click()`);
      await waitFor(`document.querySelector('#app-sidebar')?.getAttribute('aria-modal')==='true' && document.querySelector('.app-main')?.hasAttribute('inert')`);
      await waitFor(`document.querySelector('#app-sidebar')?.contains(document.activeElement)`);
      await writeFile(output.replace(/\.json$/, '-mobile.png'), (await window.webContents.capturePage()).toPNG());
      const opened = await js<{ role: string | null; modal: string | null; mainInert: boolean; closeButton: boolean; focusEntered: boolean }>(`(()=>{
        const sidebar=document.querySelector('#app-sidebar');
        return {role:sidebar?.getAttribute('role')??null,modal:sidebar?.getAttribute('aria-modal')??null,
          mainInert:!!document.querySelector('.app-main')?.hasAttribute('inert'),closeButton:!!sidebar?.querySelector('[aria-label="关闭侧栏"]'),focusEntered:sidebar?.contains(document.activeElement)??false};})()`);
      const focusLoop = await js<{ count: number; shiftTabWraps: boolean; tabWraps: boolean }>(`(()=>{
        const sidebar=document.querySelector('#app-sidebar');
        const focusable=[...sidebar.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')]
          .filter(element=>element.getClientRects().length>0);
        const first=focusable[0],last=focusable.at(-1);
        first.focus();
        const backwards=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});window.dispatchEvent(backwards);
        const shiftTabWraps=document.activeElement===last&&backwards.defaultPrevented;
        last.focus();
        const forwards=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});window.dispatchEvent(forwards);
        return {count:focusable.length,shiftTabWraps,tabWraps:document.activeElement===first&&forwards.defaultPrevented};})()`);
      assert.ok(focusLoop.count > 1 && focusLoop.shiftTabWraps && focusLoop.tabWraps, `移动抽屉应让 Tab/Shift+Tab 在可聚焦控件间循环：${JSON.stringify(focusLoop)}`);
      await js(`document.querySelector('#app-sidebar [aria-label="关闭侧栏"]').click()`);
      await waitFor(`document.querySelector('.app-shell')?.classList.contains('sidebar-collapsed') && !document.querySelector('.app-main')?.hasAttribute('inert')`);
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const closed = await js<{ mainRestored: boolean; focusReturned: boolean }>(`(()=>({
        mainRestored:!document.querySelector('.app-main')?.hasAttribute('inert'),
        focusReturned:document.activeElement?.getAttribute('aria-label')==='展开侧栏'}))()`);
      drawerModal = { ...opened, ...focusLoop, ...closed };
      assert.deepEqual(drawerModal, { role: 'dialog', modal: 'true', mainInert: true, closeButton: true, focusEntered: true, count: focusLoop.count, shiftTabWraps: true, tabWraps: true, mainRestored: true, focusReturned: true }, '移动抽屉应隔离背景、约束 Tab 焦点循环，并在关闭后恢复背景与触发器焦点');
    } finally {
      await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      if (!debuggerWasAttached && window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.setSize(originalSize[0], originalSize[1]);
    }
    await writeFile(output, json({ checks: [...navigationChecks,
      { check: 'sidebar-name-readable', ...resting, actionButtons: padding.buttons, padding },
      { check: 'project-actions-in-more-menu', items: projectMenuItems },
      { check: 'sidebar-search-and-page-jump-are-distinct', projectSearch, jumpSearch },
      { check: 'session-opens-its-own-project', ...crossProject, ...afterSwitch, ...sessionPresentation },
      { check: 'mobile-drawer-modal-semantics', ...drawerModal! },
    ], passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks: [], passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
