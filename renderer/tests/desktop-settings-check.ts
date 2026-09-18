import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/**
 * 设置页分层验收。
 *
 * 走查结论是：设置页一进来就是十二个标签，第一次用的人在其中找不到「该改哪一个」，
 * 而其中六项（工作空间、对话记录、执行与预算、视频工具、示例、诊断）平时几乎不会打开。本次验收断言：
 * 1. 默认只显示六个常用区块，「高级设置」是开关不是区块；
 * 2. 深链落到高级区块（侧栏「对话记录设置…」）时自动展开并选中它，不把人送到看不见的地方；
 * 3. 收起高级设置时不会停在已经藏起来的区块上——那会是一个空白的设置页；
 * 4. 再展开时十二个区块一个不少。
 */
export async function checkDesktopSettings(window: BrowserWindow, output: string): Promise<void> {
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
  /** 只数区块标签：末尾的「高级设置」是开关，不算一个区块。 */
  const tabLabels = () => js<string[]>(`[...document.querySelectorAll('.settings-tabs button:not(.settings-advanced-toggle)')].map(node=>node.innerText.trim())`);
  const selectedTab = () => js<string>(`document.querySelector('.settings-tabs button.selected')?.innerText.trim() ?? ''`);
  const advancedOpen = () => js<boolean>(`!!document.querySelector('.settings-advanced-toggle.selected')`);
  /** 区块自己的读写进行中会禁用整个标签栏（防止带着未保存状态离开），点开关前要先等它空下来。 */
  async function clickAdvancedToggle() {
    await waitFor(`document.querySelector('.settings-advanced-toggle')&&!document.querySelector('.settings-advanced-toggle').disabled`);
    await js(`document.querySelector('.settings-advanced-toggle').click()`);
  }
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    // ===== 深链：侧栏「对话记录设置…」必须落到对话记录，而且高级区已经展开 =====
    await js(`document.querySelector('.sidebar-group-head [aria-label="会话管理"]').click()`);
    await waitFor(`!!document.querySelector('.sidebar-menu [role=menuitem]')`);
    await js(`([...document.querySelectorAll('.sidebar-menu [role=menuitem]')].find(node=>node.innerText.includes('对话记录设置'))).click()`);
    await waitFor(`!!document.querySelector('.settings-tabs')&&!!document.querySelector('.settings-body')`);
    assert.equal(await advancedOpen(), true, '深链落到高级区块时应自动展开高级设置');
    const deepLinkSelected = await selectedTab();
    assert.equal(deepLinkSelected, '对话记录', `深链应选中对话记录，实际：${deepLinkSelected}`);
    const deepLinkTabs = await tabLabels();
    assert.ok(deepLinkTabs.includes('对话记录'), '展开后对话记录应在可见标签里');

    // ===== 收起：只剩六个常用区块，且不会停在藏起来的区块上 =====
    await clickAdvancedToggle();
    await waitFor(`[...document.querySelectorAll('.settings-tabs button:not(.settings-advanced-toggle)')].length===6`);
    const basicTabs = await tabLabels();
    assert.deepEqual(basicTabs, ['外观', '软件 AI 配置', '存储位置', '本地推理', '快捷键', '应用更新'], `常用区块清单变了：${json(basicTabs)}`);
    const afterCollapse = await selectedTab();
    assert.ok(basicTabs.includes(afterCollapse), `收起后停在了不可见的区块上：${afterCollapse}`);

    // ===== 再展开：十二个区块都回来 =====
    await clickAdvancedToggle();
    await waitFor(`[...document.querySelectorAll('.settings-tabs button:not(.settings-advanced-toggle)')].length===12`);
    const allTabs = await tabLabels();
    assert.equal(await advancedOpen(), true);
    await waitFor(`getComputedStyle(document.querySelector('.settings-body')).opacity==='1'`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({
      checks: [{ check: 'settings-layered-tabs', basic: basicTabs.length, all: allTabs.length, deepLinkTabs: deepLinkTabs.length, deepLinkSelected, afterCollapse }], passed: true,
    }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks: [], passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
