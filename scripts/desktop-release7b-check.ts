import { app, type BrowserWindow } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function checkRelease7b(window: BrowserWindow, output: string, engine: any): Promise<void> {
  assert.equal(app.isPackaged, true);
  const js = (code: string) => window.webContents.executeJavaScript(code);
  const api = (command: string, payload: Record<string, unknown> = {}) => js(`window.autoLabel.request(${JSON.stringify(command)},${JSON.stringify(payload)})`);
  const wait = async (expression: string) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error('7B 页面未就绪：' + expression);
  };
  const button = async (label: string, scope = 'document') => {
    await wait(`!!${scope}&&[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${JSON.stringify(label)}&&!b.disabled)`);
    await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)}&&!b.disabled).click()`);
  };
  const capture = async (suffix: string, selector: string) => {
    await js(`document.activeElement?.blur();document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start',behavior:'instant'})`);
    await new Promise(resolve => setTimeout(resolve, 350));
    await writeFile(output.replace(/\.json$/, suffix), (await window.webContents.capturePage()).toPNG());
  };
  window.setContentSize(1440, 940); window.showInactive();
  await wait(`!!document.querySelector('.getting-started')&&!document.querySelector('.connection-banner')`);
  const diagnostics = await engine.request('diagnostics.get'), runtime = await api('media.runtime.get'), local = await api('local.runtime.get');
  assert.equal(diagnostics.databaseVersion, 5); assert.equal(runtime.configured, true); assert.equal(runtime.busy, false);
  assert.equal(local.configured, false); assert.equal(local.workerAvailable, true);
  const toolVersions: Record<string, string> = {};
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const { stdout } = await promisify(execFile)(path.join(process.resourcesPath, 'media-tools', `${tool}.exe`), ['-version'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    const version = stdout.split(/\r?\n/)[0]; assert.ok(new RegExp(`^${tool} version 8\\.1\\.1(?:[-+ ]|$)`).test(version)); toolVersions[tool] = version;
  }
  for (const filename of ['LICENSE', 'README.txt', 'source.json']) assert.ok((await stat(path.join(process.resourcesPath, 'third-party/ffmpeg', filename))).isFile());
  const report: Record<string, unknown> = { packaged: app.isPackaged, appVersion: app.getVersion(), engineState: engine.status.state, databaseVersion: diagnostics.databaseVersion,
    runtime, localRuntime: local, toolVersions, bundledThirdParty: JSON.parse(await readFile(path.join(process.resourcesPath, 'third-party/ffmpeg/source.json'), 'utf8')) };
  if (process.env.AUTOLABEL_RELEASE_MEDIA_DISPLAY !== '1') {
    assert.equal((await api('media.job.list')).total, 0);
    await js(`document.querySelectorAll('.nav-item')[6].click()`);
    await button('视频工具');
    await wait(`document.querySelector('.media-runtime-settings')?.innerText.includes('FFmpeg：已配置')&&document.querySelector('.media-runtime-settings')?.innerText.includes('FFprobe：已配置')`);
    await capture('.png', '.media-runtime-settings'); report.passed = true;
    await writeFile(output, JSON.stringify(report, null, 2)); return;
  }
  // 只显示已经验收的媒体结果；副本没有执行授权，不再生成抽帧、筛选或模型任务。
  const project = (await api('project.list')).find((item: any) => item.name.startsWith('视频与筛选验收-')); assert.ok(project);
  const audit = async () => {
    const jobs = await api('media.job.list', { projectId: project.id }), flows = await api('flow.list', { projectId: project.id }), runs = await api('run.list');
    const assets = await api('asset.list', { projectId: project.id }); const versions = [];
    for (const asset of assets.items) { const value = await api('asset.get', { assetId: asset.id }); versions.push({ id: value.id, version: value.version, annotations: value.annotations }); }
    return { jobs: jobs.items.map((item: any) => item.id).sort(), flows: flows.items.map((item: any) => item.id).sort(), runs: runs.map((item: any) => item.id).sort(), assets: versions.sort((a, b) => a.id.localeCompare(b.id)) };
  };
  const before = await audit(); assert.equal(before.assets.length, 4); assert.equal(before.runs.length, 0);
  const jobs = await api('media.job.list', { projectId: project.id }), video = jobs.items.find((item: any) => item.kind === 'video_extract'), screening = jobs.items.find((item: any) => item.kind === 'image_screening');
  const frames = await api('media.video.frames', { jobId: video.id, limit: 20 });
  assert.equal(frames.total, 4); assert.deepEqual(frames.items.map((item: any) => item.timeSeconds), [0, 1, 4, 5]);
  assert.ok(frames.items.every((item: any) => item.assetId && typeof item.sourcePts === 'string' && item.width === 384 && item.height === 288));
  const plan = await api('media.screening.result', { jobId: screening.id, section: 'items', limit: 20 });
  assert.equal(plan.summary.status, 'incomplete'); assert.equal(plan.summary.nearCheck.unexaminedContentPairs, 6);
  await js(`[...document.querySelectorAll('.project-row')].find(e=>e.innerText.includes(${JSON.stringify(project.name)})).click()`);
  await wait(`!!document.querySelector('.workbench')`);
  const assetPreview = await js(`new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('已导入帧不可读'));image.src='autolabel-media://asset/${frames.items[0].assetId}';})`);
  assert.deepEqual(assetPreview, { width: 384, height: 288 });
  await js(`document.querySelectorAll('.nav-item')[3].click()`); await button('素材任务');
  await wait(`!!document.querySelector('.media-job-list>button')`);
  await js(`[...document.querySelectorAll('.media-job-list>button')].find(b=>b.innerText.includes('素材筛选分析')).click()`);
  await wait(`!!document.querySelector('.screening-results')`);
  for (const section of ['精确重复', '近重复候选', '来源跨分区', '逐图分析']) {
    await button(section, "document.querySelector('.screening-section-tabs')");
    await wait(`!!document.querySelector('.screening-results')&&!document.querySelector('.screening-results').innerText.includes('正在读取已保存的分析结果')`);
  }
  await capture('-screening.png', '.screening-summary');
  await js(`document.querySelectorAll('.nav-item')[2].click()`); await button('运行记录');
  await wait(`!!document.querySelector('.flow-run-list>button')`); await js(`document.querySelector('.flow-run-list>button').click()`);
  await wait(`!!document.querySelector('.flow-run-detail h3')`); await button('查看固定产物');
  await wait(`!!document.querySelector('.flow-artifact-table')`);
  assert.equal(await js(`document.querySelector('.flow-artifact-view').innerText.includes('按明确选择排除')`), true);
  await capture('-filter-output.png', '.flow-artifact-view');
  const flow = await api('flow.get', { flowRunId: before.flows[0] }), artifact = await api('flow.artifact', { artifactId: flow.steps[0].outputArtifactId });
  assert.equal(artifact.items.filter((item: any) => item.outcome === 'included').length, 3); assert.equal(artifact.items.filter((item: any) => item.outcome === 'excluded').length, 1);
  const after = await audit(); assert.deepEqual(after, before);
  Object.assign(report, { passed: true, readOnly: true, newExtractionJobs: 0, newModelRuns: 0, newFlowRuns: 0, before, after, assetPreview, frames: frames.items,
    screeningSummary: plan.summary, filter: { included: 3, excluded: 1, projectAssetsPreserved: 4, manualVersionsPreserved: true } });
  await writeFile(output, JSON.stringify(report, null, 2));
}
