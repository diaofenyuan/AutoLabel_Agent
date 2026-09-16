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
  await waitFor(`!!document.querySelector('.sidebar-status .status-dot.ready') && !document.querySelector('.connection-banner')`);
  stage('conn:ready');
  const before = await window.webContents.executeJavaScript(`({ready:!!document.querySelector('.sidebar-status .status-dot.ready'),banner:!!document.querySelector('.connection-banner')})`);
  stage('conn:before-captured');
  await control.stop();
  stage('conn:stopped');
  await waitFor(`!!document.querySelector('.connection-banner') && document.querySelector('.connection-banner').innerText.includes('重新连接')`);
  stage('conn:banner');
  const disconnected = await window.webContents.executeJavaScript(`(()=>{const banner=document.querySelector('.connection-banner');const button=[...banner.querySelectorAll('button')].find(b=>b.innerText.trim()==='重新连接');return {visible:!!banner,role:banner.getAttribute('role'),busy:banner.getAttribute('aria-busy'),buttonEnabled:!!button&&!button.disabled,message:banner.innerText.trim()}})()`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(output.replace(/\.json$/i, '-disconnected.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('.connection-banner button').click()`);
  await waitFor(`!!document.querySelector('.sidebar-status .status-dot.ready') && !document.querySelector('.connection-banner')`);
  const restored = await window.webContents.executeJavaScript(`({ready:!!document.querySelector('.sidebar-status .status-dot.ready'),banner:!!document.querySelector('.connection-banner')})`);
  await writeFile(output.replace(/\.json$/i, '.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(output, JSON.stringify({ before, disconnected, restored, engineRestarted: true }, null, 2));
}

// 固定的桌面验收流程，仅由显式测试启动参数调用，不接受界面传入脚本。
export async function checkDesktopUi(window: BrowserWindow, output: string): Promise<void> {
  const folder = path.join(path.dirname(output), 'ui-screens'); await mkdir(folder, { recursive: true });
  // 主导航收敛为对话 / 任务 / 设置三项；其余视图走快速跳转进入，脚本不再绑定侧栏次序。
  const pages = ['chat', 'tasks', 'settings'];
  const pageLabels: Record<string, string> = { chat: '对话', tasks: '任务', settings: '设置' };
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
  // 示例只从「设置 → 示例」载入：首屏不再有示例引导，脚本统一走这个入口，避免依赖已删除的横幅按钮。
  const loadExample = async () => {
    await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='设置');
      if(!item)throw new Error('缺少设置导航项');item.click();})()`);
    await waitFor(`!!document.querySelector('.settings-tabs')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='示例').click()`);
    await waitFor(`!!document.querySelector('[aria-label="载入示例"]')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="载入示例"]').click()`);
    // 载入示例自己会把界面带到该项目的会话：必须等它落定再导航，否则后面的跳转会被它覆盖。
    await waitFor(`!!document.querySelector('.page-chat') && !document.querySelector('.page-loading')`);
    await settle();
  };
  /** 用快速跳转打开任意视图：主导航之外的页面同样可达，也不会被侧栏次序变化带崩。 */
  const openPage = async (label: string, page: string) => {
    await window.webContents.executeJavaScript(`(async()=>{
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const input=document.querySelector('.command-search input');
      if(!input)throw new Error('快速跳转未打开');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(label)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    })()`);
    await waitFor(`!!document.querySelector('.page-${page}') && !document.querySelector('.page-loading')`);
    await settle();
  };
  const samplePage = async (page: string) => window.webContents.executeJavaScript(`({page:${JSON.stringify(page)},
    bodyLength:document.querySelector('.page').innerText.length,error:document.querySelector('.toast.error')?.innerText??null,
    canvasObjects:document.querySelectorAll('.annotation-shape').length,heading:document.querySelector('.page h1,.page h2')?.textContent??null,bridge:!!window.autoLabel})`);
  window.show();
  await waitFor(`!!document.querySelector('.chat-home') && !document.querySelector('.skeleton-list')`);
  stage('ui:home');
  await waitFor(`!!document.querySelector('.sidebar-status .status-dot.ready') && !document.querySelector('.connection-banner')`);
  stage('ui:engine-ready');
  const palette = await window.webContents.executeJavaScript(`(async()=>{
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const dialog=document.querySelector('dialog[open]');
        const trigger=!!document.querySelector('.command-trigger');
        const entries=[...document.querySelectorAll('.command-list button')].map(button=>button.textContent?.trim()??'');
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const closed=!document.querySelector('dialog[open]');
        // 键盘选择会跳到第二项，回到欢迎页再做后面的页面检查。
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const back=document.querySelector('.command-search input');
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(back,'对话');
        back.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
        return {trigger,opened:!!dialog,entries,keyboardClosed:closed};
      })()`);
  if (!palette.trigger || !palette.opened || !palette.keyboardClosed || !palette.entries.includes('设置')) throw new Error('快速跳转命令面板未通过桌面检查');
  if (!palette.entries.includes('对话') || !palette.entries.includes('任务')) throw new Error(`主导航未收敛为对话 / 任务 / 设置：${palette.entries.join('、')}`);
  results.push({ check: 'command-palette', ...palette });
  stage('ui:palette');
  await openPage('对话', 'chat');
  await loadExample();
  stage('ui:example-loaded');
  // 示例载入后直接落在该项目的会话：工作台已退场，素材与标注在对话与项目概览里查看。
  await waitFor(`!!document.querySelector('.chat-panel') && !document.querySelector('.page-loading')`);
  const example = await window.webContents.executeJavaScript(`(async()=>{
    const projects=await window.autoLabel.request('project.list');
    const project=projects[0];
    const assets=await window.autoLabel.request('asset.list',{projectId:project.id,limit:1});
    const asset=assets.items[0];
    const image=await new Promise(resolve=>{const node=new Image();node.onload=()=>resolve({loaded:true,width:node.naturalWidth,height:node.naturalHeight});node.onerror=()=>resolve({loaded:false,width:0,height:0});node.src=asset.thumbnailUrl||asset.mediaUrl;});
    return {projectId:project.id,assetId:asset.id,assetCount:assets.total,mediaUrl:asset.mediaUrl,image};
  })()`);
  if (!example.image.loaded || !String(example.mediaUrl).startsWith('autolabel-media://asset/')) throw new Error(`手工示例未通过真实桌面素材协议加载：${JSON.stringify(example)}`);
  results.push({ check: 'manual-example', ...example });
  // 只读抽查走项目概览：缩略图同样通过真实媒体协议渲染。
  await openPage('项目概览', 'overview');
  await waitFor(`!!document.querySelector('.overview-card') && !document.querySelector('.page-loading')`);
  await settle();
  results.push(await samplePage('overview'));
  stage('ui:example-visible');
  for (let i = 0; i < pages.length; i++) {
    await openPage(pageLabels[pages[i]], pages[i]);
    stage(`ui:page-${pages[i]}`);
    const view = await samplePage(pages[i]);
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
      // 深色主题覆盖三项主导航与项目概览，页面清单变化时不必再改这段。
      for (const darkPageName of [...pages, 'overview']) {
        await openPage(pageLabels[darkPageName] ?? '项目概览', darkPageName);
        await settle();
        const darkPage = await window.webContents.executeJavaScript(`({page:${JSON.stringify(darkPageName)},theme:document.documentElement.dataset.theme,error:document.querySelector('.toast.error')?.innerText??null,bodyLength:document.querySelector('.page').innerText.length})`);
        if (darkPage.theme !== 'dark' || darkPage.error) throw new Error(`深色主题页面检查失败：${darkPageName}`);
        darkPages.push(darkPage);
        await writeFile(path.join(folder, `dark-${darkPageName}.png`), (await window.webContents.capturePage()).toPNG());
      }
      results.push({check:'dark-theme', ...darkTheme, saved:save===undefined, pages:darkPages});
      stage('ui:dark-theme');
    }
  }
  // 主导航之内的页签也必须保持同一套层级、过渡和错误边界，避免只验收首页空态。
  const secondary: Record<string, unknown>[] = [];
  const captureSecondary = async (name: string, view: string) => {
    const state = await window.webContents.executeJavaScript(`({view:${JSON.stringify(view)},bodyLength:document.querySelector('.page').innerText.length,error:document.querySelector('.toast.error')?.innerText??null})`);
    if (state.error || state.bodyLength <= 40) throw new Error(`二级界面检查失败：${view}`);
    secondary.push(state);
    await writeFile(path.join(folder, name), (await window.webContents.capturePage()).toPNG());
  };
  await openPage(pageLabels.tasks, 'tasks');
  for (const [index, label] of ['自动流程', '标注任务', '素材任务', '模型训练', '数据导出', '轨迹标注'].entries()) {
    await window.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('.task-kind-tabs button')].find(item=>item.innerText.trim()===${JSON.stringify(label)});if(b&&!b.disabled)b.click()})()`);
    await waitFor(`!!document.querySelector('.page-tasks') && !document.querySelector('.page-loading')`);
    await settle();
    await captureSecondary(`secondary-tasks-${index + 1}.png`, `tasks-${label}`);
  }
  // 项目概览不占导航位，由项目入口与快速跳转进入；这里走快速跳转验证它能独立打开并渲染出数据面卡片。
  await openPage('项目概览', 'overview');
  await waitFor(`!!document.querySelector('.page-overview') && document.querySelectorAll('.overview-card').length === 3 && !document.querySelector('.page-loading')`);
  await settle();
  await captureSecondary('secondary-overview.png', 'overview');
  await openPage(pageLabels.settings, 'settings');
  for (const [index, label] of ['工作空间', '本地推理', '视频工具', '示例', '快捷键', '应用更新', '诊断'].entries()) {
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
  stage('ui:secondary');
  await writeFile(output, JSON.stringify({ pages: results, screenshots: folder }, null, 2));
}

export async function checkPersistedUiEdit(window: BrowserWindow, output: string): Promise<void> {
  const report = JSON.parse(await readFile(output, 'utf8'));
  const example = report.pages.find((item: { check?: string }) => item.check === 'manual-example');
  if (!example) throw new Error('缺少示例载入记录');
  // 工作台退场后不再有画布编辑，重启持久化改为核对数据面：示例素材、项目与会话在重启后仍然可读。
  const state = await window.webContents.executeJavaScript(`(async()=>{
    const asset=await window.autoLabel.request('asset.get',{assetId:${JSON.stringify(example.assetId)}});
    const projects=await window.autoLabel.request('project.list');
    const history=await window.autoLabel.request('chat.history.list',{});
    return {assetId:asset.id,version:asset.version,annotations:asset.annotations.length,projects:projects.length,sessions:history.sessions.length};
  })()`);
  if (state.assetId !== example.assetId) throw new Error('应用重启后示例素材丢失');
  if (!state.projects) throw new Error('应用重启后项目列表为空');
  if (!state.sessions) throw new Error('应用重启后没有恢复任何会话');
  report.restartPersistence = { restored: true, ...state };
  await writeFile(output, JSON.stringify(report, null, 2));
}

export async function checkPackagedRelease(window: BrowserWindow, output: string, metadata: Record<string, unknown>): Promise<void> {
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('新包功能入口未能完成启动');
  };
  window.show();
  await waitFor(`!!document.querySelector('.chat-home') && !document.querySelector('.connection-banner')`);
  // 示例入口在「设置 → 示例」，与界面一致，不再依赖首屏横幅。
  await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='设置');
    if(!item)throw new Error('缺少设置导航项');item.click();})()`);
  await waitFor(`!!document.querySelector('.settings-tabs')`);
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='示例').click()`);
  await waitFor(`!!document.querySelector('[aria-label="载入示例"]')`);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="载入示例"]').click()`);
  await waitFor(`!!document.querySelector('.chat-panel') && !document.querySelector('.page-loading')`);
  await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='任务');
    if(!item)throw new Error('缺少任务导航项');item.click();})()`);
  await waitFor(`!!document.querySelector('.page-tasks') && !document.querySelector('.page-loading')`);
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
 * 训练能力检查：训练改由对话发起，界面只保留只读看板。
 * 数据集快照由主进程用真实引擎生成（示例项目 → 数据集版本 → 训练快照），不伪造训练成功或进度。
 */
export async function checkTrainingUi(window: BrowserWindow, output: string, hooks: { prepareDataset: () => Promise<Record<string, unknown>> }): Promise<void> {
  const folder = path.join(path.dirname(output), 'training-ui');
  await mkdir(folder, { recursive: true });
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('模型训练看板未在预期时间完成变化');
  };
  const settle = async () => window.webContents.executeJavaScript(`(async()=>{
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  })()`);
  const run = async (): Promise<void> => {
  window.show();
  await waitFor(`!!document.querySelector('.sidebar-status .status-dot.ready') && !document.querySelector('.connection-banner')`);

  // 训练只在任务看板里回看：页签必须能打开，且看板本身不提供任何建任务入口。
  await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='任务');
    if(!item)throw new Error('缺少任务导航项');item.click();})()`);
  await waitFor(`!!document.querySelector('.page-tasks') && !document.querySelector('.page-loading')`);
  await window.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('.task-kind-tabs button')].find(item=>item.innerText.trim()==='模型训练');
    if(!b||b.disabled)throw new Error('缺少模型训练页签');b.click();})()`);
  await waitFor(`!!document.querySelector('.page-tasks') && !document.querySelector('.page-loading')`);
  await settle();
  const board = await window.webContents.executeJavaScript(`({
    readOnly: !['新建训练','提交训练','创建数据集快照'].some(label=>[...document.querySelectorAll('.page-tasks button')].some(b=>b.innerText.trim()===label)),
    hint: document.querySelector('.task-kind-note')?.innerText??'',
    error: document.querySelector('.toast.error')?.innerText??null})`);
  if (board.error) throw new Error(`模型训练看板出现错误提示：${board.error}`);
  if (!board.readOnly) throw new Error('模型训练看板仍提供建任务入口，与只读看板约定不符');
  if (!/对话/.test(board.hint)) throw new Error(`模型训练看板没有说明发起方式：${board.hint}`);

  // 真实数据：示例项目 → 数据集版本 → 不可变训练快照，再由引擎侧确认它真的可读。
  const dataset = await hooks.prepareDataset();
  const snapshotHash = String(dataset.snapshotHash ?? '');
  if (!snapshotHash) throw new Error('训练数据集未生成快照指纹');
  const listed = await window.webContents.executeJavaScript(`(async()=>{
    const page=await window.autoLabel.request('training.dataset.list',{limit:100});
    const found=page.items.find(item=>item.id===${JSON.stringify(String(dataset.id ?? ''))});
    return {total:page.total,status:found?.status??null,snapshotHash:found?.snapshotHash??null};})()`);
  if (listed.snapshotHash !== snapshotHash) throw new Error(`训练快照没有出现在引擎数据里（期望 ${snapshotHash.slice(0, 12)}；实际 ${listed.snapshotHash ?? '无'}）`);
  await writeFile(path.join(folder, '1-training-board.png'), (await window.webContents.capturePage()).toPNG());

  await window.webContents.executeJavaScript(`document.documentElement.dataset.theme='dark'`);
  await settle();
  const dark = await window.webContents.executeJavaScript(`({theme:document.documentElement.dataset.theme,error:document.querySelector('.toast.error')?.innerText??null,pageLength:document.querySelector('.page').innerText.length})`);
  await writeFile(path.join(folder, '2-training-dark.png'), (await window.webContents.capturePage()).toPNG());
  if (dark.theme !== 'dark' || dark.error || dark.pageLength <= 40) throw new Error('模型训练看板深色视图检查失败');

  await writeFile(output, JSON.stringify({ passed: true, readOnly: true, hint: board.hint, dataset: { id: dataset.id, status: dataset.status, snapshotHash, total: listed.total }, dark }, null, 2));
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
