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

    // ===== 回归：切到「执行与预算」后默认并发数必须真的可改 =====
    // 曾经有个只泄漏不复位的 busy：某个子区块卸载时没把 busy 交还给设置页，settingsBusy 因此常驻 true，
    // 于是「保存设置」一直灰着、并发输入框的 onChange 被静默丢弃——用户改多少都没反应，
    // 且不会报任何错。这里从「对话记录」切到「执行与预算」（训练产物区块随标签卸载）后直接验证可编辑性。
    await waitFor(`(()=>{const node=[...document.querySelectorAll('.settings-tabs button')].find(n=>n.innerText.trim()==='执行与预算'&&!n.disabled);
      if(!node)return false;node.click();return true;})()`);
    await waitFor(`document.querySelector('.settings-tabs button.selected')?.innerText.trim()==='执行与预算'`);
    await waitFor(`!!document.querySelector('input[aria-label="默认并发数"]')`);
    // 保存按钮恢复可用，且并发输入框不是 disabled。
    await waitFor(`(()=>{const save=[...document.querySelectorAll('.settings-head button')].find(n=>n.innerText.includes('保存设置'));
      const input=document.querySelector('input[aria-label="默认并发数"]');
      return !!save&&!save.disabled&&!!input&&!input.disabled;})()`);
    // 真改一次值：受控输入框必须回显新值，证明 onChange 真的被接收、没有被静默丢弃。
    const concurrencyEdited = await js<string>(`(()=>{const input=document.querySelector('input[aria-label="默认并发数"]');
      if(!input)return '';
      const before=input.value;const next=String(Number(before)===12?13:12);
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(input,next);input.dispatchEvent(new Event('input',{bubbles:true}));
      return input.value;})()`);
    assert.notEqual(concurrencyEdited, '', '并发输入框应存在且可编辑');
    await waitFor(`(()=>{const input=document.querySelector('input[aria-label="默认并发数"]');
      return !!input&&input.value===${JSON.stringify(concurrencyEdited)};})()`);

    // ===== 回归：标签栏与侧栏导航必须始终可用 =====
    // 真实故障是「一点进执行与预算，整页就动不了」：子区块的 busy 没复位，而设置页又把 settingsBusy
    // 算进标签栏的 disabled 与离开守卫，于是标签点不动、侧栏也跳不回，卸载清理永远等不到，
    // 变成自锁死循环。这里断言：进入执行与预算后标签仍可点，且来回切换后保存按钮不会被锁死。
    await waitFor(`(()=>{const node=[...document.querySelectorAll('.settings-tabs button')].find(n=>n.innerText.trim()==='外观');
      if(!node||node.disabled)return false;node.click();return true;})()`, '设置页标签不应因子区块忙碌而全部禁用');
    await waitFor(`document.querySelector('.settings-tabs button.selected')?.innerText.trim()==='外观'`);
    await waitFor(`(()=>{const node=[...document.querySelectorAll('.settings-tabs button')].find(n=>n.innerText.trim()==='执行与预算'&&!n.disabled);
      if(!node)return false;node.click();return true;})()`);
    await waitFor(`(()=>{const save=[...document.querySelectorAll('.settings-head button')].find(n=>n.innerText.includes('保存设置'));
      return document.querySelector('.settings-tabs button.selected')?.innerText.trim()==='执行与预算'&&!!save&&!save.disabled;})()`,
      '标签来回切换后「保存设置」不应被锁死');
    // 忙碌状态必须已经归位：训练产物区块读完目录后不该把 busy 永久留在 true。
    await waitFor(`(()=>{const save=[...document.querySelectorAll('.settings-head button')].find(n=>n.innerText.includes('保存设置'));
      const refresh=[...document.querySelectorAll('.settings-body button')].find(n=>n.innerText.includes('刷新'));
      return !!save&&!save.disabled&&(!refresh||!refresh.disabled);})()`,
      '训练产物区块的忙碌状态应已复位，不能锁死设置页');

    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({
      checks: [{ check: 'settings-flat-tabs', all: allTabs.length, deepLinkSelected, sampleReachable: true },
        { check: 'settings-concurrency-editable', value: concurrencyEdited }],
      passed: true,
    }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks: [], passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
