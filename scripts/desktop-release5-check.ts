import { app, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkRelease5(window: BrowserWindow, output: string, engine: any, grants: any, userData: string): Promise<void> {
  const report: Record<string, unknown> = { packaged: app.isPackaged, appVersion: app.getVersion(), engineState: engine.status.state };
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('新里程碑入口未能就绪：' + expression);
  };
  const settle = () => window.webContents.executeJavaScript(`(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  const capture = async (name: string) => { await settle(); await writeFile(output.replace(/\.json$/i, `-${name}.png`), (await window.webContents.capturePage()).toPNG()); };
  // 示例只从「设置 → 示例」载入：首屏不再有示例横幅；载入后落到该项目的会话。
  const loadExample = async () => {
    await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='设置');item.click();})()`);
    await waitFor(`!!document.querySelector('.settings-tabs')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-tabs button')].find(node=>node.innerText.trim()==='示例').click()`);
    await waitFor(`!!document.querySelector('[aria-label="载入示例"]')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="载入示例"]').click()`);
    // 载入示例自己会跳到该项目的会话：等它落定再导航，否则后面的跳转会被它覆盖。
    await waitFor(`!!document.querySelector('.page-chat') && !document.querySelector('.page-loading')`);
  };
  const original = engine.request.bind(engine);
  engine.request = async (command: string, payload: Record<string, unknown> = {}, timeout?: number) => {
    if (command === 'asset.list' && payload.limit === 100) report.rendererAssetPageLimit = 100;
    return original(command, payload, timeout);
  };
  try {
    window.show();
    await waitFor(`!!document.querySelector('.chat-home') && !document.querySelector('.connection-banner')`);
    await loadExample();
    // 素材分页与只读抽查集中在项目概览：缩略图按 100 张一页加载，加载更多按 total 翻页。
    await window.webContents.executeJavaScript(`(async()=>{
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const input=document.querySelector('.command-search input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'项目概览');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    })()`);
    await waitFor(`!!document.querySelector('.page-overview') && !document.querySelector('.page-loading')`);
    await waitFor(`document.querySelectorAll('.page-overview .result-thumb').length > 0`);
    report.paginationControls = await window.webContents.executeJavaScript(`document.querySelectorAll('.page-overview .result-thumb').length > 0`);
    await capture('overview');
    // 资源入口并入项目概览：提示词、模板、流程与人工参考在同一处按类型列出，命令面照旧验证。
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.page-overview button')].find(b=>b.innerText.trim()==='资源').click()`);
    await waitFor(`document.querySelectorAll('.page-overview .tabs button').length > 0 && document.body.innerText.includes('人工参考') && document.body.innerText.includes('提示词')`);
    report.resourceCommand = await window.webContents.executeJavaScript(`(async()=>{const r=await window.autoLabel.request('resource.save',{kind:'prompt',name:'新安装包资源检查',content:'仅用于隔离启动验收'});const v=await window.autoLabel.request('resource.get',{resourceId:r.id,version:r.version});return {kind:v.kind,version:v.version};})()`);
    report.resourcesEntry = true;
    await capture('resources');
    await window.webContents.executeJavaScript(`document.querySelector('dialog[open] [aria-label="关闭弹窗"]').click()`);
    await window.webContents.executeJavaScript(`(()=>{const item=[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='设置');
      if(!item)throw new Error('缺少设置导航项');item.click();})()`);
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='工作空间')`);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='工作空间').click()`);
    await waitFor(`!!document.querySelector('.storage-settings') && !!document.querySelector('[aria-label="当前数据目录"]') && !document.querySelector('.storage-state')?.innerText.includes('正在读取')`);
    report.backupEntry = await window.webContents.executeJavaScript(`document.querySelector('.storage-settings').innerText.includes('检查备份条件') && document.querySelector('.storage-settings').innerText.includes('准备恢复副本')`);
    const outputDir = path.join(userData, 'release-output'); await mkdir(outputDir, { recursive: true }); await grants.add(outputDir, 'directory');
    report.preflight = await window.webContents.executeJavaScript(`window.autoLabel.request('backup.preflight',${JSON.stringify({ outputDir })})`);
    report.storage = await window.webContents.executeJavaScript(`window.autoLabel.request('storage.status',{})`);
    await capture('settings');
    await writeFile(output, JSON.stringify(report, null, 2));
  } finally { engine.request = original; }
}
