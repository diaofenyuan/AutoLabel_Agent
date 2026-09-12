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
  const original = engine.request.bind(engine);
  engine.request = async (command: string, payload: Record<string, unknown> = {}, timeout?: number) => {
    if (command === 'asset.list' && payload.limit === 100) report.rendererAssetPageLimit = 100;
    return original(command, payload, timeout);
  };
  try {
    window.show();
    await waitFor(`!!document.querySelector('.getting-started button') && !document.querySelector('.connection-banner')`);
    await window.webContents.executeJavaScript(`document.querySelector('.getting-started button').click()`);
    await waitFor(`!!document.querySelector('.annotation-canvas image') && !!document.querySelector('[aria-label="素材页码"]')`);
    report.paginationControls = await window.webContents.executeJavaScript(`!!document.querySelector('[aria-label="上一页素材"]') && !!document.querySelector('[aria-label="下一页素材"]')`);
    await capture('workbench');
    await window.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[4].click()`);
    await waitFor(`document.body.innerText.includes('人工参考') && document.body.innerText.includes('提示词')`);
    report.resourceCommand = await window.webContents.executeJavaScript(`(async()=>{const r=await window.autoLabel.request('resource.save',{kind:'prompt',name:'新安装包资源检查',content:'仅用于隔离启动验收'});const v=await window.autoLabel.request('resource.get',{resourceId:r.id,version:r.version});return {kind:v.kind,version:v.version};})()`);
    report.resourcesEntry = true;
    await capture('resources');
    await window.webContents.executeJavaScript(`document.querySelectorAll('.nav-item')[6].click()`);
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
