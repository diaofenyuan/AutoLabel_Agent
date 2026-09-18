import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkDesktopQuality } from './desktop-quality-check';
import { checkDesktopRerun } from './desktop-rerun-check';
import { checkDesktopFive } from './desktop-five-check';
import { checkDesktopResources } from './desktop-resource-check';
import { checkDesktopPagination } from './desktop-pagination-check';
import { checkDesktopStorage } from './desktop-storage-check';
import { checkDesktopFlow } from './desktop-flow-check';
import { checkDesktopReuse } from './desktop-reuse-check';
import { checkDesktopLocal } from './desktop-local-check';
import { checkDesktopMedia } from './desktop-media-check';
import { checkDesktopEditing } from './desktop-editing-check';
import { checkDesktopProviderDelete } from './desktop-provider-delete-check';
import { checkDesktopUpdateUi } from './desktop-update-ui-check';
import { checkDesktopRunControls } from './desktop-run-control-check';
import { checkDesktopReason } from './desktop-reason-check';
import { checkDesktopAnnotate } from './desktop-annotate-check';
import { checkDesktopUnknownRetry } from './desktop-unknown-retry-check';
import { checkDesktopFrameScope } from './desktop-frame-scope-check';
import { checkDesktopProjectIdentity } from './desktop-project-identity-check';
import { checkDesktopDirectoryImport } from './desktop-directory-import-check';
import { checkDesktopOnboarding } from './desktop-onboarding-check';
import { checkDesktopAiPreset } from './desktop-ai-preset-check';
import { checkDesktopComposer } from './desktop-composer-check';
import { checkDesktopSettings } from './desktop-settings-check';

// 只在桌面显式验收入口运行；所有文件夹、对话框选择及破坏性夹具均限制在独立测试目录。
export async function checkDesktopManual(window:BrowserWindow, output:string):Promise<void> {
  if(process.env.AUTOLABEL_ONBOARDING_UI_CHECK==='1')return checkDesktopOnboarding(window,output);
  if(process.env.AUTOLABEL_AI_PRESET_UI_CHECK==='1')return checkDesktopAiPreset(window,output);
  if(process.env.AUTOLABEL_COMPOSER_UI_CHECK==='1')return checkDesktopComposer(window,output);
  if(process.env.AUTOLABEL_SETTINGS_UI_CHECK==='1')return checkDesktopSettings(window,output);
  if(process.env.AUTOLABEL_DIRECTORY_IMPORT_UI_CHECK==='1')return checkDesktopDirectoryImport(window,output);
  if(process.env.AUTOLABEL_PROJECT_IDENTITY_UI_CHECK==='1')return checkDesktopProjectIdentity(window,output);
  if(process.env.AUTOLABEL_FRAME_SCOPE_UI_CHECK==='1')return checkDesktopFrameScope(window,output);
  if(process.env.AUTOLABEL_UNKNOWN_RETRY_UI_CHECK==='1')return checkDesktopUnknownRetry(window,output);
  if(process.env.AUTOLABEL_ANNOTATE_UI_CHECK==='1')return checkDesktopAnnotate(window,output);
  if(process.env.AUTOLABEL_REASON_UI_CHECK==='1')return checkDesktopReason(window,output);
  if(process.env.AUTOLABEL_PROVIDER_DELETE_UI_CHECK==='1')return checkDesktopProviderDelete(window,output);
  if(process.env.AUTOLABEL_EDITING_UI_CHECK==='1')return checkDesktopEditing(window,output);
  if(process.env.AUTOLABEL_MEDIA_UI_CHECK==='1')return checkDesktopMedia(window,output);
  if(process.env.AUTOLABEL_LOCAL_UI_CHECK==='1')return checkDesktopLocal(window,output);
  if(process.env.AUTOLABEL_REUSE_UI_CHECK==='1')return checkDesktopReuse(window,output);
  if(process.env.AUTOLABEL_FLOW_UI_CHECK==='1')return checkDesktopFlow(window,output);
  if(process.env.AUTOLABEL_STORAGE_UI_CHECK==='1')return checkDesktopStorage(window,output);
  if(process.env.AUTOLABEL_PAGINATION_UI_CHECK==='1')return checkDesktopPagination(window,output);
  if(process.env.AUTOLABEL_RESOURCE_UI_CHECK==='1')return checkDesktopResources(window,output);
  if(process.env.AUTOLABEL_FIVE_UI_CHECK==='1')return checkDesktopFive(window,output);
  if(process.env.AUTOLABEL_RERUN_UI_CHECK==='1')return checkDesktopRerun(window,output);
  if(process.env.AUTOLABEL_QUALITY_UI_CHECK==='1')return checkDesktopQuality(window,output);
  if(process.env.AUTOLABEL_UPDATE_UI_CHECK==='1')return checkDesktopUpdateUi(window,output);
  if(process.env.AUTOLABEL_RUN_CONTROL_UI_CHECK==='1')return checkDesktopRunControls(window,output);
  const userData=path.join(path.dirname(output),'manual-check-user-data');
  const fixtures=path.join(userData,'fixtures');await mkdir(fixtures,{recursive:true});
  const checks:Record<string,unknown>[]=[];
  const js=<T=unknown>(code:string):Promise<T>=>window.webContents.executeJavaScript(code);
  const json=JSON.stringify;
  async function waitFor(expression:string){const end=Date.now()+12000;while(Date.now()<end){if(await js(expression))return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`等待界面超时：${expression}`);}
  async function button(text:string,scope='document'){await waitFor(`!!${scope} && [...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);await js(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)});b.click()})()`);}
  const dialog="document.querySelector('dialog[open]')";
  const api=<T=any>(command:string,payload:unknown={}):Promise<T>=>js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  async function select(selector:string,value:string){await js(`(()=>{const e=document.querySelector(${json(selector)});if(!e)throw new Error('选择框不存在');e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
  async function fill(selector:string,value:string){await js(`(()=>{const e=document.querySelector(${json(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await waitFor(`document.querySelector(${json(selector)}).value===${json(value)}`);}
  async function checkbox(text:string){await js(`(()=>{const l=[...${dialog}.querySelectorAll('label')].find(l=>l.innerText.includes(${json(text)}));if(!l)throw new Error('确认项不存在');l.querySelector('input').click();})()`);}
  async function queue(entry:unknown){await writeFile(path.join(userData,'dialog-fixtures.json'),json([entry]));}
  async function more(tab:string){await js(`document.querySelector('[aria-label="更多素材操作"]').click()`);await waitFor(`!!document.querySelector('.action-tabs')`);await button(tab,dialog);}
  async function close(){await button('关闭',dialog);await waitFor(`!document.querySelector('dialog[open]')`);}
  async function waitIdle(){await waitFor(`!!${dialog} && [...${dialog}.querySelectorAll('button')].some(b=>b.innerText.trim()==='关闭'&&!b.disabled)`);}
  window.show();
  try {
    await waitFor(`!!document.querySelector('.onboarding-lanes button')&&!document.querySelector('.skeleton-list')&&!document.querySelector('.connection-banner')`);
    await button('打开示例');await waitFor(`!!document.querySelector('[aria-label="对象x"]')`);
    const assetId=await js<string>(`new URL(document.querySelector('.annotation-canvas image').getAttribute('href')).pathname.slice(1)`);
    let saved=await api('asset.get',{assetId});const initialX=saved.annotations[0].bbox.x;const initialVersion=saved.version;
    await fill('[aria-label="对象x"]',String(initialX+5));await more('版本记录');
    assert.equal((await api('asset.get',{assetId})).draft[0].bbox.x,initialX+5);
    await checkbox('我确认丢弃');await button('丢弃草稿',dialog);await waitFor(`window.autoLabel.request('asset.get',{assetId:${json(assetId)}}).then(a=>!a.draft)`);await waitIdle();await close();
    await waitFor(`Number(document.querySelector('[aria-label="对象x"]').value)===${initialX}`);
    checks.push({check:'draft-discard',version:initialVersion,restoredX:initialX});

    const labelPath=path.join(fixtures,`explicit-pair-${Date.now()}.txt`);await writeFile(labelPath,'0 0.5 0.5 0.2 0.2\n');
    await more('导入标签');await queue({kind:'labels',paths:[labelPath]});await button('选择 TXT 标签文件',dialog);await waitFor(`!!document.querySelector('.label-pair select')`);
    assert.equal(await js(`document.querySelector('.label-pair select').value`),'');
    assert.equal(await js(`[...${dialog}.querySelectorAll('button')].find(b=>b.innerText.trim()==='导入为候选').disabled`),true);
    await select('.label-pair select',assetId);await select('.asset-action-body>.field select','baseline');await checkbox('已核对文件、坐标和类别');await button('导入为候选',dialog);
    await waitFor(`window.autoLabel.request('asset.get',{assetId:${json(assetId)}}).then(a=>a.version>${initialVersion}&&a.source==='imported_yolo')`);await waitIdle();
    saved=await api('asset.get',{assetId});assert.equal(saved.annotations.length,1);assert.equal(saved.status,'candidate');assert.ok(!saved.draft);assert.ok(Math.abs(saved.annotations[0].bbox.x-saved.width*.4)<1e-6);
    await writeFile(output.replace(/\.json$/,'-labels.png'),(await window.webContents.capturePage()).toPNG());
    await close();await waitFor(`Number(document.querySelector('[aria-label="对象x"]').value)===${Math.round(saved.width*.4*100)/100}`);
    checks.push({check:'explicit-label-import',version:saved.version,source:saved.source,objects:saved.annotations.length});

    await fill('[aria-label="对象x"]',String(saved.annotations[0].bbox.x+1));await more('效果图');
    const png=path.join(fixtures,`overlay-${Date.now()}.png`);await queue({kind:'save',path:png});await button('选择位置并保存效果图',dialog);await waitFor(`!!document.querySelector('.operation-result')`);await waitIdle();
    const pngData=await readFile(png);assert.equal(pngData.subarray(1,4).toString(),'PNG');assert.equal(pngData.readUInt32BE(16),saved.width);assert.equal(pngData.readUInt32BE(20),saved.height);
    await select('.asset-action-body>.field:nth-of-type(2) select','jpeg');
    const jpg=path.join(fixtures,`overlay-${Date.now()}.jpg`);await queue({kind:'save',path:jpg});await button('选择位置并保存效果图',dialog);await waitIdle();
    const jpgData=await readFile(jpg);assert.equal(jpgData.readUInt16BE(0),0xffd8);const afterOverlay=await api('asset.get',{assetId});assert.equal(afterOverlay.version,saved.version);assert.ok(afterOverlay.draft);
    checks.push({check:'saved-version-overlays',version:saved.version,png:true,jpeg:true,draftExcluded:true});
    await close();

    const source=path.resolve(saved.metadata.sourcePath);const relative=path.relative(userData,source);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'源文件必须属于独立测试目录');
    const candidates=path.join(fixtures,`relocate-${Date.now()}`);await mkdir(candidates);const original=await readFile(source);
    await rename(source,path.join(fixtures,`held-${Date.now()}.png`));const matching=path.join(candidates,saved.name),duplicate=path.join(candidates,'duplicate.png');await writeFile(matching,original);await writeFile(duplicate,original);
    await more('文件位置');await button('检查文件位置',dialog);await waitFor(`document.querySelector('.location-list')?.innerText.includes('文件失联')`);await waitIdle();
    await queue({kind:'directory',paths:[candidates]});await button('选择目录并重定位',dialog);await waitIdle();await waitFor(`document.querySelector('.operation-issues')?.innerText.includes('relocate_ambiguous')`);
    await unlink(duplicate);await writeFile(matching,Buffer.concat([original,Buffer.from('changed')]));await queue({kind:'directory',paths:[candidates]});await button('选择目录并重定位',dialog);await waitIdle();await waitFor(`document.querySelector('.operation-issues')?.innerText.includes('relocate_content_changed')`);
    await writeFile(matching,original);await queue({kind:'directory',paths:[candidates]});await button('选择目录并重定位',dialog);await waitIdle();await waitFor(`document.querySelector('.location-list')?.innerText.includes('原素材：完整')`);
    const recovered=await api('asset.get',{assetId});assert.equal(recovered.version,saved.version);assert.equal(recovered.draft[0].bbox.x,saved.annotations[0].bbox.x+1);checks.push({check:'relocate',missing:true,ambiguousRejected:true,sameNameChangedRejected:true,restored:true,draftPreserved:true});await close();
    await waitFor(`Number(document.querySelector('[aria-label="对象x"]').value)===${Math.round((saved.annotations[0].bbox.x+1)*100)/100}`);

    const exportParent=path.join(fixtures,`exports-${Date.now()}`);await mkdir(exportParent);
    const projectId=saved.projectId;
    async function createExport(){await js(`document.querySelector('[aria-label="导出数据集"]').click()`);await waitFor(`!!document.querySelector('.export-tabs')`);await queue({kind:'directory',paths:[exportParent]});await button('选择',dialog);await waitFor(`!${dialog}.innerText.includes('正在读取项目与标注')`);await button('导出数据集',dialog);await waitIdle();await waitFor(`${dialog}.innerText.includes('导出状态：已完成')`);const list=await api<any[]>('export.list',{projectId});await close();return list.find(r=>r.path.startsWith(exportParent))!;}
    const first=await createExport();assert.ok(first.manifestHash);
    await fill('[aria-label="对象x"]',String(saved.annotations[0].bbox.x+20));await button('保存',"document.querySelector('.editor-actionbar')");await waitFor(`window.autoLabel.request('asset.get',{assetId:${json(assetId)}}).then(a=>a.version>${saved.version})`);
    const second=await createExport();assert.notEqual(first.id,second.id);
    await js(`document.querySelector('[aria-label="导出数据集"]').click()`);await waitFor(`!!document.querySelector('.export-tabs')`);await button('历史与复现',dialog);await waitFor(`!!document.querySelector('.form-stack>.field select')`);
    await select('.form-stack>.field select',first.id);await select('.operation-section .field select',second.id);await button('比较固定清单',dialog);await waitFor(`!!document.querySelector('.export-difference')`);assert.ok((await js<string>(`document.querySelector('.export-difference').innerText`)).includes('标注版本'));
    await queue({kind:'directory',paths:[exportParent]});await button('选择',dialog);await button('校验并生成新副本',dialog);await waitIdle();await waitFor(`${dialog}.innerText.includes('导出状态：已完成')`);
    const list=await api<any[]>('export.list',{projectId});const reproduced=list.find(r=>r.sourceExportId===first.id)!;assert.ok(reproduced);const originalManifest=JSON.parse(await readFile(path.join(first.path,'manifest.json'),'utf8'));const reproducedManifest=JSON.parse(await readFile(path.join(reproduced.path,'manifest.json'),'utf8'));assert.deepEqual(reproducedManifest.assets,originalManifest.assets);
    checks.push({check:'fixed-export-history',changedVersionVisible:true,reproducedFixedSource:true,currentEditsExcluded:true});await close();
    await js(`document.querySelectorAll('.nav-item')[6].click()`);await waitFor(`!!document.querySelector('.settings-tabs')`);await button('应用更新');await waitFor(`!!document.querySelector('.update-status')&&!document.querySelector('.update-status').innerText.includes('正在读取桌面更新状态')`);
    assert.equal((await api('update.status')).state,'unconfigured');assert.equal(await js(`[...document.querySelectorAll('.update-actions button')].find(b=>b.innerText.trim()==='下载更新').disabled`),true);assert.equal(await js(`document.querySelectorAll('.download-progress progress').length`),0);
    checks.push({check:'unconfigured-update',nativeState:true,downloadDisabled:true,noSyntheticProgress:true});
    await writeFile(output,json({checks,passed:true}));
  } catch(error) {await writeFile(output.replace(/\.json$/,'-failure.png'),(await window.webContents.capturePage()).toPNG());await writeFile(output,json({checks,passed:false,error:error instanceof Error?error.message:String(error),body:await js(`document.body.innerText`)}));throw error;}
}
