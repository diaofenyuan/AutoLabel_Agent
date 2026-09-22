import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/**
 * 首屏上手路径验收。
 *
 * 走查结论是：欢迎页只剩标题与一排导入按钮，第一次打开的人不知道先做什么；
 * 唯一不需要 API Key 的示例项目还被收在设置里，于是「能不能用」在第一步就被卡住。
 * 本次验收断言：
 * 1. 首屏按顺序给出三条路（先试一下 / 导入我的素材 / 让 AI 自动标注）；
 * 2. 四个导入入口在首屏直接可见，不再藏在折叠菜单里；
 * 3.「载入示例项目」不经过设置页就能走通，落在一个确有素材的项目会话里；
 * 4. 未配置接口时第 3 条路给出通往「设置 · 软件 AI 配置」的入口。
 */
export async function checkDesktopOnboarding(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  /** 只在指定卡片内找按钮：三条路都可能有同名动作，作用域写死才不会被别的卡片接走。 */
  async function laneButton(lane: number, text: string) {
    await waitFor(`[...document.querySelectorAll('.onboarding-lane')][${lane}]?.querySelectorAll('button')`, 10000);
    const found = await js<boolean>(`(()=>{const b=[...document.querySelectorAll('.onboarding-lane')][${lane}]?.querySelectorAll('button');
      return [...(b??[])].some(node=>node.innerText.trim()===${json(text)}&&!node.disabled);})()`);
    assert.ok(found, `第 ${lane + 1} 条路上找不到可点的「${text}」`);
    await js(`([...[...document.querySelectorAll('.onboarding-lane')][${lane}].querySelectorAll('button')].find(node=>node.innerText.trim()===${json(text)})).click()`);
  }
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    // ===== 三条路：顺序与文案都要写清楚 =====
    const lanes = await js<Array<{ title: string; note: string; buttons: string[] }>>(
      `[...document.querySelectorAll('.onboarding-lane')].map(lane=>({title:lane.querySelector('h2').innerText.trim(),note:lane.querySelector('p').innerText.trim(),buttons:[...lane.querySelectorAll('button')].map(node=>node.innerText.trim())}))`);
    assert.equal(lanes.length, 3, `首屏应有三条路，实际 ${lanes.length} 条`);
    assert.deepEqual(lanes.map(lane => lane.title), ['先试一下', '导入我的素材', '让 AI 自动标注']);
    // 第 1 条必须讲明不需要配置：这是它排在第一位的前提。
    assert.ok(lanes[0].note.includes('不用配置'), `第 1 条路应说明不需要配置，实际：${lanes[0].note}`);
    for (const label of ['导入图片', '导入图片文件夹', '导入视频', '导入视频文件夹']) {
      assert.ok(lanes[1].buttons.includes(label), `第 2 条路缺少「${label}」入口，实际：${json(lanes[1].buttons)}`);
    }
    assert.ok(lanes[2].buttons.includes('配置 AI'), `未配置接口时第 3 条路应给出配置入口，实际：${json(lanes[2].buttons)}`);
    checks.push({ check: 'home-shows-three-lanes', titles: lanes.map(lane => lane.title), imports: lanes[1].buttons });
    // 首屏是本次改动的主战场，在这里留一张图：三条路的排版结论不能只看 DOM。
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());

    // 主操作必须一眼可读：首屏的发送按钮被挤成两行时，第一次用的人连怎么发都看不出来。
    const send = await js<{ width: number; height: number; label: string }>(
      `(()=>{const b=document.querySelector('.chat-home .send-button');const r=b.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height),label:b.innerText.trim()};})()`);
    assert.ok(!send.label.includes('\n'), `发送按钮的文字被折行：${json(send)}`);
    assert.ok(send.width >= 56, `发送按钮太窄，主操作读不出来：实际 ${send.width}px`);
    checks.push({ check: 'home-send-button-legible', ...send });

    // ===== 示例项目：不经过设置页就能走通 =====
    const before = (await api<Array<{ id: string }>>('project.list')).length;
    await laneButton(0, '载入示例项目');
    await waitFor(`!!document.querySelector('.page-chat .chat-panel textarea')`);
    const projects = await api<Array<{ id: string; name: string; assetCount: number }>>('project.list');
    assert.ok(projects.length > before, '载入示例应新建一个项目');
    const example = [...projects].sort((a, b) => b.assetCount - a.assetCount)[0];
    assert.ok(example.assetCount > 0, `示例项目应带素材，实际 ${example.assetCount} 张`);
    checks.push({ check: 'home-loads-example', project: example.name, assets: example.assetCount });

    // ===== 第 3 条路指向设置里的软件 AI 配置 =====
    await js(`[...document.querySelectorAll('.sidebar-scroll .nav-item')].find(node=>node.innerText.trim()==='新对话').click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
    await laneButton(2, '配置 AI');
    await waitFor(`!!document.querySelector('.settings-tabs')&&document.querySelector('.settings-page')`);
    const section = await js<string>(`document.querySelector('.settings-tabs button.selected')?.innerText.trim() ?? ''`);
    assert.equal(section, '软件 AI 配置', `第 3 条路应落到软件 AI 配置，实际落在「${section}」`);
    checks.push({ check: 'ai-lane-opens-settings', section });

    // ===== 「用内置模型标注」必须直落「模型库」页签，而不是停在「在线接口」表单上等人自己找 =====
    await js(`[...document.querySelectorAll('.sidebar-scroll .nav-item')].find(node=>node.innerText.trim()==='新对话').click()`);
    await waitFor(`!!document.querySelector('.onboarding-lanes')`);
    await laneButton(2, '用内置模型标注（无需 API Key）');
    await waitFor(`!!document.querySelector('.settings-body')`);
    const library = await js<{ tab: string; copy: string }>(`(()=>{const body=document.querySelector('.settings-body');
      const tab=[...body.querySelectorAll('.tabs button')].find(node=>node.classList.contains('selected'))?.innerText.trim()??'';
      return {tab, copy:body.innerText.replace(/\\s+/g,' ').slice(0,400)}})()`);
    assert.equal(library.tab, '模型库', `「用内置模型标注」应直落模型库页签，实际落在「${library.tab}」`);
    assert.ok(library.copy.includes('模型'), `落点应是模型库内容，实际：${library.copy}`);
    checks.push({ check: 'builtin-lane-opens-model-library', tab: library.tab });
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
