import type { BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

/** 临时诊断：Electron 是 GUI 子系统程序，stdout 不进控制台，阶段日志只能落盘。 */
function stage(message: string): void {
  const target = process.env.AUTOLABEL_STAGE_LOG;
  if (!target) return;
  try { appendFileSync(target, `${new Date().toISOString()} ${message}\n`); } catch { /* 诊断失败不影响运行 */ }
}

export async function checkDesktopConnection(window: BrowserWindow, output: string, control: { stop: () => Promise<void>; restart: () => Promise<unknown> }): Promise<void> {
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('连接状态界面未在预期时间完成变化');
  };
  window.show();
  stage('conn:shown');
  await waitFor(`!!document.querySelector('.connection .status-dot.ready') && !document.querySelector('.connection-banner')`);
  stage('conn:ready');
  const before = await window.webContents.executeJavaScript(`({ready:!!document.querySelector('.connection .status-dot.ready'),banner:!!document.querySelector('.connection-banner')})`);
  stage('conn:before-captured');
  await control.stop();
  stage('conn:stopped');
  await waitFor(`!!document.querySelector('.connection-banner') && document.querySelector('.connection-banner').innerText.includes('重新连接')`);
  stage('conn:banner');
  const disconnected = await window.webContents.executeJavaScript(`(()=>{const banner=document.querySelector('.connection-banner');const button=[...banner.querySelectorAll('button')].find(b=>b.innerText.trim()==='重新连接');return {visible:!!banner,role:banner.getAttribute('role'),busy:banner.getAttribute('aria-busy'),buttonEnabled:!!button&&!button.disabled,message:banner.innerText.trim()}})()`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(output.replace(/\.json$/i, '-disconnected.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('.connection-banner button').click()`);
  await waitFor(`!!document.querySelector('.connection .status-dot.ready') && !document.querySelector('.connection-banner')`);
  const restored = await window.webContents.executeJavaScript(`({ready:!!document.querySelector('.connection .status-dot.ready'),banner:!!document.querySelector('.connection-banner')})`);
  await writeFile(output.replace(/\.json$/i, '.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(output, JSON.stringify({ before, disconnected, restored, engineRestarted: true }, null, 2));
}

// 固定的桌面验收流程，仅由显式测试启动参数调用，不接受界面传入脚本。
export async function checkDesktopUi(window: BrowserWindow, output: string): Promise<void> {
  const folder = path.join(path.dirname(output), 'ui-screens'); await mkdir(folder, { recursive: true });
  const pages = ['chat', 'workbench', 'workflow', 'tasks', 'resources', 'models', 'training', 'settings'];
  const results: Record<string, unknown>[] = [];
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('桌面界面未在预期时间完成加载');
  };
  const settle = async () => window.webContents.executeJavaScript(`(async()=>{
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  })()`);
  window.show();
  await waitFor(`!!document.querySelector('.getting-started button') && !document.querySelector('.skeleton-list')`);
  await waitFor(`!!document.querySelector('.connection .status-dot.ready') && !document.querySelector('.connection-banner')`);
  for (let i = 0; i < pages.length; i++) {
    if (i === 0) {
      const palette = await window.webContents.executeJavaScript(`(async()=>{
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const dialog=document.querySelector('dialog[open]');
        const trigger=!!document.querySelector('.command-trigger');
        const entries=[...document.querySelectorAll('.command-list button')].map(button=>button.textContent?.trim()??'');
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {trigger,opened:!!dialog,entries,keyboardClosed:!document.querySelector('dialog[open]')};
      })()`);
      if (!palette.trigger || !palette.opened || !palette.keyboardClosed || !palette.entries.includes('设置')) throw new Error('快速跳转命令面板未通过桌面检查');
      results.push({ check: 'command-palette', ...palette });
    }
    if (i === 1) {
      await window.webContents.executeJavaScript(`document.querySelector('.getting-started button').click()`);
      await waitFor(`!!document.querySelector('.annotation-canvas image') && !document.querySelector('.image-failure')`);
      const image = await window.webContents.executeJavaScript(`new Promise(resolve=>{
        const source=document.querySelector('.annotation-canvas image').getAttribute('href');
        const img=new Image();img.onload=()=>resolve({loaded:true,width:img.naturalWidth,height:img.naturalHeight,source});img.onerror=()=>resolve({loaded:false});img.src=source;
      })`);
      if (!image.loaded || !image.source.startsWith('autolabel-media://asset/')) throw new Error('手工示例未通过真实桌面素材协议加载');
      results.push({ check: 'manual-example', ...image });
      await waitFor(`!!document.querySelector('[aria-label="对象x"]')`);
      const selected = await window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label="对象x"]');const rect=input.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2),value:Number(input.value)}})()`);
      const assetId = new URL(image.source).pathname.slice(1);
      const original = await window.webContents.executeJavaScript(`window.autoLabel.request('asset.get',{assetId:${JSON.stringify(assetId)}})`);
      const expectedX = selected.value + 7;
      window.webContents.sendInputEvent({ type: 'mouseDown', x: selected.x, y: selected.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: selected.x, y: selected.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      await window.webContents.insertText(String(expectedX));
      await waitFor(`Number(document.querySelector('[aria-label="对象x"]').value)===${expectedX}`);
      const save = await window.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('.editor-actionbar button')].find(b=>b.innerText.trim()==='保存');const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      window.webContents.sendInputEvent({ type: 'mouseDown', x: save.x, y: save.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: save.x, y: save.y, button: 'left', clickCount: 1 });
      await waitFor(`window.autoLabel.request('asset.get',{assetId:${JSON.stringify(assetId)}}).then(a=>a.version>${original.version}&&a.annotations[0].bbox.x===${expectedX})`);
      results.push({ check: 'manual-edit', assetId, originalX: selected.value, expectedX, originalVersion: original.version });
    } else {
      await window.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[${i}].click()`);
    }
    await waitFor(`!!document.querySelector('.page-${pages[i]}') && !document.querySelector('.page-loading')`);
    await settle();
    const view = await window.webContents.executeJavaScript(`({page:${JSON.stringify(pages[i])},bodyLength:document.querySelector('.page').innerText.length,
      error:document.querySelector('.toast.error')?.innerText??null,canvasObjects:document.querySelectorAll('.annotation-shape').length,
      heading:document.querySelector('.page h1,.page h2')?.textContent??null,bridge:!!window.autoLabel})`);
    results.push(view);
    await writeFile(path.join(folder, `${i + 1}-${pages[i]}.png`), (await window.webContents.capturePage()).toPNG());
    if (pages[i] === 'settings') {
      const darkTheme = await window.webContents.executeJavaScript(`(async()=>{
        const buttons=[...document.querySelectorAll('button')];
        const button=buttons.find(item=>item.innerText.trim()==='深色');
        if (!button) return {found:false,active:false,darkSelected:false,lightSelected:false};
        button.click();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const light=buttons.find(item=>item.innerText.trim()==='浅色');
        return {found:true,active:document.documentElement.dataset.theme==='dark',darkSelected:button.classList.contains('selected'),lightSelected:!!light&&light.classList.contains('selected')};
      })()`);
      if (!darkTheme.found || !darkTheme.active || !darkTheme.darkSelected || darkTheme.lightSelected) throw new Error('深色主题未通过桌面 UI 检查');
      await writeFile(path.join(folder, '8-settings-dark.png'), (await window.webContents.capturePage()).toPNG());
      const save = await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('button')].find(item=>item.innerText.trim()==='保存设置')?.click())()`);
      await new Promise(resolve=>setTimeout(resolve, 180));
      const darkPages: Record<string, unknown>[] = [];
      for (let darkIndex = 0; darkIndex < pages.length; darkIndex++) {
        await window.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[${darkIndex}].click()`);
        await waitFor(`!!document.querySelector('.page-${pages[darkIndex]}') && !document.querySelector('.page-loading')`);
        await settle();
        const darkPage = await window.webContents.executeJavaScript(`({page:${JSON.stringify(pages[darkIndex])},theme:document.documentElement.dataset.theme,error:document.querySelector('.toast.error')?.innerText??null,bodyLength:document.querySelector('.page').innerText.length})`);
        if (darkPage.theme !== 'dark' || darkPage.error) throw new Error(`深色主题页面检查失败：${pages[darkIndex]}`);
        darkPages.push(darkPage);
        await writeFile(path.join(folder, `dark-${darkIndex + 1}-${pages[darkIndex]}.png`), (await window.webContents.capturePage()).toPNG());
      }
      results.push({check:'dark-theme', ...darkTheme, saved:save===undefined, pages:darkPages});
    }
  }
  // 主导航之外的页签也必须保持同一套层级、过渡和错误边界，避免只验收首页空态。
  const secondary: Record<string, unknown>[] = [];
  const openPage = async (index: number) => {
    await window.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[${index}].click()`);
    await waitFor(`!!document.querySelector('.page-${pages[index]}') && !document.querySelector('.page-loading')`);
    await settle();
  };
  const captureSecondary = async (name: string, view: string) => {
    const state = await window.webContents.executeJavaScript(`({view:${JSON.stringify(view)},bodyLength:document.querySelector('.page').innerText.length,error:document.querySelector('.toast.error')?.innerText??null})`);
    if (state.error || state.bodyLength <= 40) throw new Error(`二级界面检查失败：${view}`);
    secondary.push(state);
    await writeFile(path.join(folder, name), (await window.webContents.capturePage()).toPNG());
  };
  await openPage(2);
  await window.webContents.executeJavaScript(`document.querySelectorAll('.flow-view-tabs button')[1]?.click()`);
  await waitFor(`!!document.querySelector('.flow-runs')`);
  await settle();
  await captureSecondary('secondary-workflow-runs.png', 'workflow-runs');
  await openPage(3);
  for (const [index, label] of ['标注任务', '素材任务', '轨迹标注'].entries()) {
    await window.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('.task-kind-tabs button')].find(item=>item.innerText.trim()===${JSON.stringify(label)});if(b&&!b.disabled)b.click()})()`);
    await waitFor(`!!document.querySelector('.page-tasks') && !document.querySelector('.page-loading')`);
    await settle();
    await captureSecondary(`secondary-tasks-${index + 1}.png`, `tasks-${label}`);
  }
  await openPage(4);
  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.resources-page button')].find(item=>item.innerText.trim()==='新建资源')?.click())()`);
  await waitFor(`!!document.querySelector('.resource-editor')`);
  await settle();
  await captureSecondary('secondary-resource-editor.png', 'resource-editor');
  await window.webContents.executeJavaScript(`document.querySelector('.resource-editor button')?.click()`);
  await openPage(5);
  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.model-kind-tabs button')].find(item=>item.innerText.trim()==='本地模型')?.click())()`);
  await waitFor(`!!document.querySelector('.local-models')`);
  await settle();
  await captureSecondary('secondary-models-local.png', 'models-local');
  await openPage(7);
  for (const [index, label] of ['工作空间', '本地推理', '视频工具', '快捷键', '应用更新', '诊断'].entries()) {
    await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.settings-tabs button')].find(item=>item.innerText.trim()===${JSON.stringify(label)})?.click())()`);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await settle();
    await captureSecondary(`secondary-settings-${index + 1}.png`, `settings-${label}`);
  }
  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.settings-tabs button')].find(item=>item.innerText.trim()==='外观')?.click())()`);
  await waitFor(`!!document.querySelector('[aria-label="减少动画"]')`);
  const reducedMotion = await window.webContents.executeJavaScript(`(async()=>{
    const toggle=document.querySelector('[aria-label="减少动画"]');
    const before=document.documentElement.dataset.reducedMotion;
    toggle.click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const page=document.querySelector('.settings-body');
    const enabled={root:document.documentElement.dataset.reducedMotion,checked:toggle.getAttribute('aria-checked'),animationDuration:page?getComputedStyle(page).animationDuration:null};
    toggle.click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const disabled={root:document.documentElement.dataset.reducedMotion,checked:toggle.getAttribute('aria-checked')};
    return {before,enabled,disabled};
  })()`);
  if (reducedMotion.enabled.root !== 'true' || reducedMotion.enabled.checked !== 'true' || reducedMotion.disabled.root !== 'false' || reducedMotion.disabled.checked !== 'false') throw new Error('减少动画开关未正确控制页面动画');
  results.push({check:'reduced-motion', ...reducedMotion});
  // R5 项目删除：必须给出影响清单与名称确认，名称不符时不得继续到删除选项。
  const removal = await window.webContents.executeJavaScript(`(async()=>{
    const button=[...document.querySelectorAll('button[title="删除项目…"]')][0];
    if(!button)return {opened:false};
    button.click();
    await new Promise(resolve=>setTimeout(resolve,600));
    const dialog=document.querySelector('dialog[open]');
    if(!dialog)return {opened:false};
    const tabs=[...dialog.querySelectorAll('.tabs button')].map(node=>({label:node.innerText.trim(),disabled:node.disabled}));
    const counts=dialog.querySelector('.deletion-counts')?.innerText.trim()??'';
    const managed=dialog.innerText.includes('受管文件占用');
    const next=[...dialog.querySelectorAll('button')].find(node=>node.innerText.trim()==='下一步：输入项目名');
    next?.click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const input=dialog.querySelector('[aria-label="确认项目名称"]');
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    const submit=()=>[...dialog.querySelectorAll('button')].find(node=>node.innerText.trim()==='下一步：删除选项');
    setter.call(input,'错误的项目名'); input.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const mismatched=!!submit()?.disabled;
    return {opened:true,tabs,counts:counts.split('\\n').slice(0,3),managed,mismatched};
  })()`);
  if (!removal.opened || removal.tabs?.length !== 3 || removal.tabs.some((tab: { label: string }, index: number) => !tab.label.startsWith(`${index + 1}. `))) throw new Error('项目删除弹窗步骤不完整');
  if (!removal.managed || !removal.counts?.length) throw new Error('项目删除弹窗缺少影响清单');
  if (!removal.mismatched) throw new Error('项目名称不符时不应允许进入删除选项');
  results.push({check:'project-deletion', ...removal});
  await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('dialog[open]');
    [...(dialog?.querySelectorAll('button')??[])].find(node=>node.innerText.trim()==='取消'||node.innerText.trim()==='上一步')?.click();})()`);
  await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('dialog[open]');
    [...(dialog?.querySelectorAll('button')??[])].find(node=>node.innerText.trim()==='取消')?.click();})()`);
  await waitFor(`!document.querySelector('dialog[open]')`);
  results.push({ check: 'secondary-ui', views: secondary });
  await writeFile(output, JSON.stringify({ pages: results, screenshots: folder }, null, 2));
}

export async function checkPersistedUiEdit(window: BrowserWindow, output: string): Promise<void> {
  const report = JSON.parse(await readFile(output, 'utf8'));
  const edited = report.pages.find((item: { check?: string }) => item.check === 'manual-edit');
  if (!edited) throw new Error('缺少表单保存记录');
  const asset = await window.webContents.executeJavaScript(`window.autoLabel.request('asset.get',{assetId:${JSON.stringify(edited.assetId)}})`);
  if (asset.annotations[0].bbox.x !== edited.expectedX || asset.version <= edited.originalVersion) throw new Error('应用重启后未恢复已保存坐标');
  report.restartPersistence = { restored: true, assetId: asset.id, x: asset.annotations[0].bbox.x, version: asset.version };
  await writeFile(output, JSON.stringify(report, null, 2));
}

export async function checkPackagedRelease(window: BrowserWindow, output: string, metadata: Record<string, unknown>): Promise<void> {
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('新包功能入口未能完成启动');
  };
  window.show();
  await waitFor(`!!document.querySelector('.getting-started button') && !document.querySelector('.connection-banner')`);
  await window.webContents.executeJavaScript(`document.querySelector('.getting-started button').click()`);
  await waitFor(`!!document.querySelector('.annotation-canvas image')`);
  await window.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[3].click()`);
  await waitFor(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='评测与复核')`);
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='评测与复核').click()`);
  await waitFor(`!!document.querySelector('.quality-body') && document.querySelector('.quality-body').innerText.includes('固定图片真实重跑')`);
  const result = await window.webContents.executeJavaScript(`(async()=>{
    const api=window.autoLabel;
    const provider=await api.request('provider.save',{name:'安装包启动检查',baseUrl:'https://example.invalid/v1',protocol:'chat-completions',model:'release-check',
      pricing:{model:'release-check',currency:'USD',inputPerMillion:10,cachedInputPerMillion:5,outputPerMillion:20}});
    const estimate=await api.request('budget.estimate',{providerId:provider.id,model:'release-check',requests:1,inputTokensPerRequest:100,cachedInputTokensPerRequest:20,outputTokensPerRequest:20});
    await api.request('budget.update',{budgetScopeId:'release-check',maxRequests:1});
    const budget=await api.request('budget.get',{budgetScopeId:'release-check'});
    let rerunRegistered=false;
    try{await api.request('evaluation.rerun.get',{comparisonId:'release-check-missing'});}catch(e){rerunRegistered=e.message.includes('[not_found]');}
    return {estimate,budget,rerunRegistered,newPage:document.querySelector('.quality-body').innerText.includes('固定图片真实重跑'),title:document.title};
  })()`);
  await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await writeFile(output.replace(/\.json$/i, '.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(output, JSON.stringify({ ...metadata, ...result }, null, 2));
}

/**
 * 训练页界面检查：空态、真实数据集快照、向导步骤与诚实状态。
 * 数据集由主进程用真实引擎生成（示例项目 → 导出版本 → 训练快照），不伪造训练成功或进度。
 */
export async function checkTrainingUi(window: BrowserWindow, output: string, hooks: { prepareDataset: () => Promise<Record<string, unknown>> }): Promise<void> {
  const folder = path.join(path.dirname(output), 'training-ui');
  await mkdir(folder, { recursive: true });
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('训练界面未在预期时间完成变化');
  };
  const settle = async () => window.webContents.executeJavaScript(`(async()=>{
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  })()`);
  // 界面只在挂载时读 hash，导航一律用侧栏入口点击，避免出现“改了 hash 但页面没换”的假通过。
  const visit = async (label: string, selector: string) => {
    await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim().includes(${JSON.stringify(label)}));
      if(!item)throw new Error('缺少导航项：'+${JSON.stringify(label)});item.click();})()`);
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.page-loading')`);
    await settle();
  };
  const run = async (): Promise<void> => {
  window.show();
  await waitFor(`!!document.querySelector('.connection .status-dot.ready') && !document.querySelector('.connection-banner')`);

  await visit('模型训练', '.training-page');
  const empty = await window.webContents.executeJavaScript(`({
    runtime:document.querySelector('.training-runtime')?.innerText.trim()??'',
    jobs:document.querySelector('.training-page')?.innerText.includes('尚无训练任务')??false,
    datasets:document.querySelector('.training-page')?.innerText.includes('尚无训练数据集')??false,
    error:document.querySelector('.toast.error')?.innerText??null})`);
  if (empty.error) throw new Error(`训练页出现错误提示：${empty.error}`);
  // 环境区块必须给出真实探测结果或明确原因，不允许空着装作可用。
  if (!empty.runtime || !/训练环境/.test(empty.runtime)) throw new Error('训练页缺少训练环境区块');
  if (!/可用|不可用|缺少|失败|尚未|未配置/.test(empty.runtime)) throw new Error(`训练环境区块没有可判断的状态说明：${empty.runtime.slice(0, 120)}`);
  if (!empty.jobs || !empty.datasets) throw new Error('训练页缺少空态说明');

  // 真实数据：示例项目 → 固定导出版本 → 不可变训练快照。
  const dataset = await hooks.prepareDataset();
  const snapshotHash = String(dataset.snapshotHash ?? '');
  if (!snapshotHash) throw new Error('训练数据集未生成快照指纹');
  await visit('标注工作台', '.page-workbench');
  await visit('模型训练', '.training-page');
  // 快照列表由引擎异步返回，先等首张卡片出现再比对，避免把加载时序判成内容缺失。
  await waitFor(`!!document.querySelector('.training-card')`);
  const card = await window.webContents.executeJavaScript(`(()=>{const node=document.querySelector('.training-card');
    return node?{text:node.innerText,showsSnapshot:node.innerText.includes(${JSON.stringify(snapshotHash.slice(0, 12))})}:null})()`);
  if (!card?.showsSnapshot) throw new Error(`训练页没有显示真实数据集快照（期望 ${snapshotHash.slice(0, 12)}；实际 ${card?.text ?? '无卡片'}）`);

  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.training-page button')].find(b=>b.innerText.trim()==='新建训练')?.click())()`);
  await waitFor(`!!document.querySelector('.training-wizard')`);
  await settle();
  const wizard = await window.webContents.executeJavaScript(`(()=>{const button=label=>[...document.querySelectorAll('.training-wizard button')].find(b=>b.innerText.trim()===label);
    return {tabs:[...document.querySelectorAll('.training-wizard .tabs button')].map(b=>({label:b.innerText.trim(),disabled:b.disabled,selected:b.getAttribute('aria-selected')})),
      sources:[...document.querySelectorAll('.training-sources button')].map(b=>b.innerText.trim()),
      createDisabled:!!button('创建数据集快照')?.disabled,submitVisible:!!button('提交训练')};})()`);
  if (wizard.tabs.length !== 3 || wizard.tabs.some((tab: { label: string }, index: number) => !tab.label.startsWith(`${index + 1}. `))) throw new Error('训练向导步骤标签不完整');
  if (!wizard.tabs[2].disabled) throw new Error('未创建数据集时不应开放确认提交步骤');
  if (wizard.tabs[0].selected !== 'true') throw new Error('训练向导未默认停在数据源步骤');
  if (wizard.sources.length !== 3 || !wizard.sources.some((text: string) => text.includes('本地已标注数据集')) || !wizard.sources.some((text: string) => text.includes('AI 标注结果')) || !wizard.sources.some((text: string) => text.includes('数据集版本'))) throw new Error('训练向导缺少数据来源选项');
  if (!wizard.createDisabled) throw new Error('未选择目录时不应允许创建数据集快照');
  if (wizard.submitVisible) throw new Error('未创建数据集时不应出现提交训练入口');
  // 数据集版本来源：必须提供版本选择，且未选版本时不得允许创建快照。
  const versionSource = await window.webContents.executeJavaScript(`(async()=>{
    const button=[...document.querySelectorAll('.training-sources button')].find(node=>node.innerText.includes('数据集版本'));
    button.click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const select=document.querySelector('[aria-label="数据集版本"]');
    const create=[...document.querySelectorAll('.training-wizard button')].find(node=>node.innerText.trim()==='创建数据集快照');
    return {selected:!!select,disabled:!!create?.disabled};})()`);
  if (!versionSource.selected || !versionSource.disabled) throw new Error('数据集版本来源缺少版本选择，或未选版本时允许创建快照');

  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.training-sources button')].find(b=>b.innerText.includes('AI 标注结果'))?.click())()`);
  await waitFor(`!!document.querySelector('[aria-label="导出版本"]')`);
  const exported = await window.webContents.executeJavaScript(`({
    hasExport:!!document.querySelector('[aria-label="导出版本"]'),hasScope:!!document.querySelector('[aria-label="标注来源"]'),
    hasRatio:!!document.querySelector('[aria-label="训练集比例"]'),
    hasGenerate:[...document.querySelectorAll('.training-wizard button')].some(b=>b.innerText.includes('按当前项目标注生成导出版本'))})`);
  if (!exported.hasExport || !exported.hasScope || !exported.hasRatio || !exported.hasGenerate) throw new Error('导出版本来源缺少必要选项');
  await writeFile(path.join(folder, '1-training-wizard.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.training-wizard button')].find(b=>b.innerText.trim()==='取消')?.click())()`);
  await waitFor(`!document.querySelector('.training-wizard')`);

  await window.webContents.executeJavaScript(`document.documentElement.dataset.theme='dark'`);
  await settle();
  const dark = await window.webContents.executeJavaScript(`({theme:document.documentElement.dataset.theme,error:document.querySelector('.toast.error')?.innerText??null,pageLength:document.querySelector('.page').innerText.length})`);
  await writeFile(path.join(folder, '2-training-dark.png'), (await window.webContents.capturePage()).toPNG());
  if (dark.theme !== 'dark' || dark.error || dark.pageLength <= 40) throw new Error('训练页深色视图检查失败');

  await writeFile(output, JSON.stringify({ passed: true, runtime: empty.runtime, dataset: { id: dataset.id, status: dataset.status, snapshotHash }, wizard, exported, dark }, null, 2));
  };
  try { await run(); }
  catch (error) {
    // 失败时留下截图与实际页面文本，便于区分界面问题与验收脚本问题。
    await writeFile(path.join(folder, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    const pageText = await window.webContents.executeJavaScript(`document.querySelector('.page')?.innerText?.slice(0,4000)??''`);
    await writeFile(output, JSON.stringify({ passed: false, message: error instanceof Error ? error.message : String(error), pageText }, null, 2));
    throw error;
  }
}
