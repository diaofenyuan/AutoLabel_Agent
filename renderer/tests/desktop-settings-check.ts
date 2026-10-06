import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/**
 * 设置页标签验收。
 *
 * 走查结论是：折叠开关本身成了多余的两次点击——深链落到「对话记录」时用户还要先展开才能确认位置，
 * 找「示例」也要先展开。取消折叠后十二个区块常显，本次验收断言：
 * 1. 标签栏固定十二个区块，没有折叠开关；
 * 2. 常用项在前、低频项在后，但后者同样直接可点；
 * 3. 深链落到低频区块（侧栏「对话记录设置…」）时该标签本来就在，不需要任何展开动作。
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
  const tabLabels = () => js<string[]>(`[...document.querySelectorAll('.settings-tabs button')].map(node=>node.innerText.trim())`);
  const selectedTab = () => js<string>(`document.querySelector('.settings-tabs button.selected')?.innerText.trim() ?? ''`);
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    // ===== 深链：侧栏「对话记录设置…」直接落到对话记录，标签本来就可见 =====
    await js(`document.querySelector('.sidebar-group-head [aria-label="会话管理"]').click()`);
    await waitFor(`!!document.querySelector('.sidebar-menu [role=menuitem]')`);
    await js(`([...document.querySelectorAll('.sidebar-menu [role=menuitem]')].find(node=>node.innerText.includes('对话记录设置'))).click()`);
    await waitFor(`!!document.querySelector('.settings-tabs')&&!!document.querySelector('.settings-body')`);
    const deepLinkSelected = await selectedTab();
    assert.equal(deepLinkSelected, '对话记录', `深链应选中对话记录，实际：${deepLinkSelected}`);

    // ===== 标签栏：十二个区块常显，没有折叠开关 =====
    const allTabs = await tabLabels();
    assert.deepEqual(allTabs, ['外观', '软件 AI 配置', '存储位置', '本地推理', '快捷键', '应用更新', '工作空间', '对话记录', '执行与预算', '视频工具', '示例', '诊断'], `设置页区块清单变了：${json(allTabs)}`);
    assert.equal(await js<boolean>(`!!document.querySelector('.settings-advanced-toggle')`), false, '不应再存在「高级设置」折叠开关');

    // ===== 低频区块同样直接可点 =====
    // 等待与点击必须放在同一段轮询里：对话记录区块还在异步加载，会把整条标签栏禁用，
    // 分成两次执行时点击正好落在禁用窗口内，点了没反应也看不出原因。
    await waitFor(`(()=>{const node=[...document.querySelectorAll('.settings-tabs button')].find(n=>n.innerText.trim()==='示例'&&!n.disabled);
      if(!node)return false;node.click();return true;})()`);
    await waitFor(`document.querySelector('.settings-tabs button.selected')?.innerText.trim()==='示例'`);
    await waitFor(`!!document.querySelector('[aria-label="载入示例"]')`);
    await waitFor(`getComputedStyle(document.querySelector('.settings-body')).opacity==='1'`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({
      checks: [{ check: 'settings-flat-tabs', all: allTabs.length, deepLinkSelected, sampleReachable: true }], passed: true,
    }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks: [], passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
