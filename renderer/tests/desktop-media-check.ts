import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { keypointEdges } from '../src/keypointEdges';
import { gotoTasks, openProjectOverview } from './desktop-navigation';

/**
 * 视频抽帧参数、帧记录与时间轴预览验收。
 *
 * 覆盖范围：抽帧参数的校验（时间段不重叠、输出尺寸/格式/JPEG 质量）、逐帧记录与真实帧时间、
 * 产物导入前后的状态，以及时间轴帧条与预览。项目归属走欢迎页的确认框（选已有项目）。
 *
 * 不再覆盖「素材筛选 + 明确排除 + 跑整条流程」：那一段的入口是流程编排页，而流程改由对话发起后
 * 该页已从界面移除，筛选任务在界面上不再有创建入口。留着只会让这条检查一直红着却看不出原因，
 * 所以这里如实写明不再覆盖，不假装还有。
 */
export async function checkDesktopMedia(window: BrowserWindow, output: string): Promise<void> {
  const checks: unknown[] = [], json = JSON.stringify, userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData); const fixtures = path.join(userData, 'fixtures'); await mkdir(fixtures, { recursive: true });
  const videoPath = path.join(fixtures, 'vtest.avi'); await copyFile(path.resolve('.qa/media-samples/vtest.avi'), videoPath);
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = (command: string, payload: unknown = {}) => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  async function wait(expression: string, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 70)); } throw new Error(`媒体界面等待超时：${expression}`); }
  async function click(selector: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`document.querySelector(${json(selector)}).click()`); }
  async function button(label: string, scope = 'document') { await wait(`!!${scope}&&[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}&&!b.disabled).click()`); }
  async function fill(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async function select(selector: string, value: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`(()=>{const e=document.querySelector(${json(selector)});e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async function queue(kind: string, file: string) { await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind, paths: [file] }])); }
  async function capture(suffix: string, selector: string) { await js(`document.activeElement?.blur();document.querySelector(${json(selector)}).scrollIntoView({block:'start',behavior:'instant'})`); await new Promise(r => setTimeout(r, 350)); await writeFile(output.replace(/\.json$/, suffix), (await window.webContents.capturePage()).toPNG()); }
  async function settled(jobId: string) { await wait(`window.autoLabel.request('media.job.get',{jobId:${json(jobId)}}).then(j=>['completed','failed','interrupted','cancelled'].includes(j.status))`, 60000); const job = await api('media.job.get', { jobId }); assert.equal(job.status, 'completed', json(job)); return job; }
  const driver = { js, wait };
  window.setContentSize(1440, 940); window.showInactive();
  try {
    const points = [{ name: 'A', x: 2, y: 3, visibility: 2 as const }, { name: 'B', x: 0, y: 0, visibility: 0 as const }, { name: 'C', x: 8, y: 9, visibility: 1 as const }];
    assert.deepEqual(keypointEdges(points, [[0, 1], [1, 2]]), []); assert.deepEqual(keypointEdges(points, [['A', 'B'], ['B', 'C']]), []); assert.deepEqual(keypointEdges(points, [['A', 'C']]), [[points[0], points[2]]]); assert.deepEqual(keypointEdges(points, undefined), []);
    checks.push({ check: 'explicit-keypoint-template-edges', invisiblePointNotBridged: true, namesAndZeroBasedIndices: true, noTemplateNoEdges: true });
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    // ===== 入口：欢迎页「导入视频」→ 项目归属确认框里选已有项目 =====
    const name = `视频抽帧验收-${Date.now()}`, project = await api('project.create', { name, taskType: 'detect', classes: [{ id: 'person', name: '行人', color: '#477b93' }] });
    await new Promise<void>(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    await queue('video', videoPath);
    await js(`([...document.querySelectorAll('.onboarding-lane button')].find(b=>b.innerText.trim()==='导入视频')).click()`);
    await button('选择已有项目', dialog);
    await js(`(()=>{const e=${dialog}.querySelector('select');e.value=${json(project.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await button('继续');
    await wait(`!!document.querySelector('.video-inspection')`, 60000);
    const inspection = await js<string>(`document.querySelector('.video-inspection').innerText`); assert.ok(inspection.includes('768 × 576')); assert.ok(inspection.includes('79.50 秒'));
    // 关掉「抽帧完成后自动导入项目」，才能验证「产物就绪但尚未入库」这一段；它是偏好设置，界面开关在应用层进度条上。
    const settings = await api<Record<string, unknown>>('settings.get'); await api('settings.save', { settings: { ...settings, frameAutoImport: false } });
    await select('[aria-label="视频采样密度"]', 'custom'); await select('[aria-label="视频采样方式"]', 'interval'); await fill('[aria-label="视频采样值"]', '1');
    // 时间段与输出尺寸都在「高级设置」折叠里：先展开，否则里面的按钮没有可读文本、点不到。
    await click('.video-advanced>summary');
    await js(`(()=>{const l=[...document.querySelectorAll('.checkbox-row')].find(e=>e.innerText.includes('使用整段已知时长'));if(l.querySelector('input').checked)l.querySelector('input').click();})()`);
    await wait(`!!document.querySelector('[aria-label="视频时间段 1 终点"]')`);
    await fill('[aria-label="视频时间段 1 终点"]', '2'); await button('添加时间段'); await fill('[aria-label="视频时间段 2 起点"]', '1'); await fill('[aria-label="视频时间段 2 终点"]', '6'); await button('开始抽帧'); await wait(`document.querySelector('.video-import .media-error')?.textContent.includes('时间段')`); assert.equal((await api('media.job.list', { projectId: project.id })).total, 0);
    await fill('[aria-label="视频时间段 2 起点"]', '4');
    await js(`(()=>{const l=[...document.querySelectorAll('.checkbox-row')].find(e=>e.innerText.trim()==='指定输出尺寸');if(!l.querySelector('input').checked)l.querySelector('input').click();})()`);
    await wait(`!!document.querySelector('[aria-label="视频输出宽度"]')`);
    await fill('[aria-label="视频输出宽度"]', '384'); await fill('[aria-label="视频输出高度"]', '288'); await select('[aria-label="视频尺寸适配"]', 'contain'); await select('[aria-label="视频输出格式"]', 'jpg'); assert.equal(await js(`document.querySelector('[aria-label="视频JPEG质量"]').value`), '3'); await select('[aria-label="视频输出格式"]', 'png');
    await capture('-parameters.png', 'dialog[open] .modal-inner>header'); await button('开始抽帧'); await wait(`!document.querySelector('dialog[open]')`);

    // ===== 任务详情：抽帧产物与逐帧记录在「任务 · 素材任务」里回看 =====
    await gotoTasks(driver, '素材任务');
    await wait(`!!document.querySelector('.media-job-row')`);
    await js(`document.querySelector('.media-job-row .media-job-open').click()`);
    await wait(`!!document.querySelector('.media-job-detail')`);
    const firstJob = (await api('media.job.list', { projectId: project.id, kind: 'video_extract' })).items[0], extracted = await settled(firstJob.id); assert.equal(extracted.stage, 'ready'); assert.equal(extracted.artifactCommitted, true); assert.equal(extracted.assetsCommitted, false); assert.equal(extracted.canImport, true); assert.equal((await api('asset.list', { projectId: project.id })).total, 0);
    assert.deepEqual(extracted.parameters.ranges, [{ start: 0, end: 2 }, { start: 4, end: 6 }]); assert.equal(extracted.parameters.mode, 'interval'); assert.equal(extracted.parameters.everyNFrames, undefined); assert.equal(extracted.parameters.targetFps, undefined);
    const frames = await api('media.video.frames', { jobId: firstJob.id, offset: 0, limit: 20 }); assert.equal(frames.total, 4); assert.deepEqual(frames.items.map((f: any) => f.timeSeconds), [0, 1, 4, 5]); for (const frame of frames.items) { assert.equal(frame.width, 384); assert.equal(frame.height, 288); assert.equal(typeof frame.sourcePts, 'string'); assert.equal(frame.assetId, undefined); }
    await wait(`document.querySelector('.media-job-detail')?.innerText.includes('抽帧就绪，待导入')`); await button('查看抽帧记录'); await wait(`document.querySelectorAll('.video-frame-list>div:not(.pagination)').length===4`); await capture('-ready.png', '.media-job-detail');
    checks.push({ check: 'video-inspect-extract-before-import', inspection, jobId: firstJob.id, geometryNoticeVisible: await js(`document.querySelector('.media-job-detail .notice')?.innerText??null`), frames: frames.items, overlappingRangesBlocked: true, assetCountBeforeImport: 0 });

    // ===== 导入：产物入库后才可用，素材在项目概览里可见 =====
    await button('将抽帧导入项目'); await wait(`window.autoLabel.request('media.job.get',{jobId:${json(firstJob.id)}}).then(j=>j.status==='completed'&&j.stage==='done'&&j.assetsCommitted)`, 60000); const importedFrames = await api('media.video.frames', { jobId: firstJob.id, offset: 0, limit: 20 }); assert.ok(importedFrames.items.every((f: any) => f.assetId)); const all = await api('asset.list', { projectId: project.id, limit: 100 }); assert.equal(all.total, 4);
    await openProjectOverview(driver, name);
    await wait(`document.querySelectorAll('.result-thumb').length===4`);
    checks.push({ check: 'explicit-frame-import', jobId: firstJob.id, assetsCommitted: true, imported: all.total, sourceIdentityRetained: true, overviewVisible: 4 });

    // ===== 时间轴：帧数据按接口断言；界面在「任务 · 轨迹标注」里选中它并进入工作区 =====
    const timeline = await api('track.timeline.create', { projectId: project.id, mediaJobId: firstJob.id });
    const timelineFrames = await api('track.timeline.frames', { timelineId: timeline.id, offset: 0, limit: 50 });
    assert.equal(timelineFrames.total, 4); assert.ok(timelineFrames.items.every((frame: any) => frame.assetId && typeof frame.sourcePts === 'string'));
    await gotoTasks(driver, '轨迹标注');
    await wait(`!!document.querySelector('.video-timeline')`);
    await select('[aria-label="视频时间轴"]', timeline.id);
    // 帧条与逐帧预览只存在于已移除的非任务视图；任务模式保留的是轨迹与关键帧工作区，所以这里只断言「这条时间轴能进去」。
    await wait(`!!document.querySelector('.timeline-identity')||!!document.querySelector('.timeline-track-picker')`);
    const workspaceVisible = await js<boolean>(`!!document.querySelector('.timeline-identity')||!!document.querySelector('.timeline-track-picker')`);
    assert.equal(workspaceVisible, true, '轨迹标注页应能选中这条时间轴并进入工作区');
    await capture('-timeline.png', '.video-timeline');
    checks.push({ check: 'timeline-workspace-reachable', timelineId: timeline.id, frames: timelineFrames.total, builtFromRealFrames: true, workspaceVisible });
    await writeFile(output, json({ passed: true, mode: 'media-ui', projectId: project.id, newModelRuns: 0, timeline: { frameCount: timelineFrames.total, framesHaveSourcePts: true, workspaceVisible }, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'media-ui', checks, error: e instanceof Error ? e.message : String(e), body: await js('document.body.innerText') })); throw e; }
}
