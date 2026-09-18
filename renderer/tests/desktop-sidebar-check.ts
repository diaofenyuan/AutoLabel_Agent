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
    await js(`([...document.querySelectorAll('.onboarding-lane button')].find(node=>node.innerText.trim()==='载入示例项目')).click()`);
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
    assert.ok(parseInt(padding.selected || '0', 10) >= 80, `操作显示出来时应预留宽度，实际：${padding.selected}`);
    assert.ok(padding.buttons >= 3, `项目行应保留直接可达的操作按钮，实际 ${padding.buttons} 个`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks: [{ check: 'sidebar-name-readable', ...resting, actionButtons: padding.buttons, padding }], passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks: [], passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
