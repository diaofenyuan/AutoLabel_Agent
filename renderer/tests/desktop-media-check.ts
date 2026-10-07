import type { BrowserWindow } from 'electron';
import { net } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
  const api = async (command: string, payload: unknown = {}) => {
    const result = await js<{ ok: boolean; data?: any; error?: { message?: string; code?: string; details?: unknown } }>(
      `window.autoLabel.request(${json(command)},${json(payload)}).then(data=>({ok:true,data}),error=>({ok:false,error:{message:error?.message,code:error?.code,details:error?.details}}))`);
    if (!result.ok) throw new Error(`${command}：${JSON.stringify(result.error)}`);
    return result.data;
  };
  const dialog = "document.querySelector('dialog[open]')";
  async function wait(expression: string, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 70)); } throw new Error(`媒体界面等待超时：${expression}`); }
  async function click(selector: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`document.querySelector(${json(selector)}).click()`); }
  async function button(label: string, scope = 'document') { await wait(`!!${scope}&&[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}&&!b.disabled).click()`); }
  async function overviewMenuButton(label: string) { await click('.overview-more-actions summary'); await button(label, "document.querySelector('.overview-more-menu')"); }
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
    // 拖入即抽帧：面板直接带出推荐配方，主按钮就是「开始抽帧」，不用先选密度再开始。
    const defaultDensity = await js<string>(`document.querySelector('[aria-label="视频采样密度"]').value`);
    assert.equal(defaultDensity, 'scene', `抽帧面板应默认给「场景变化（推荐）」，实际 ${defaultDensity}`);
    assert.equal(await js<boolean>(`[...document.querySelectorAll('.modal-actions button')].some(b=>b.innerText.trim()==='开始抽帧'&&!b.disabled)`), true, '拖入视频后主按钮应直接可点「开始抽帧」');
    const initialEstimate = await js<string>(`document.querySelector('.video-scene-estimate')?.innerText??''`);
    const initialStorageEstimate = await js<string>(`document.querySelector('.video-output-estimate')?.innerText??''`);
    assert.match(initialEstimate, /最多约 80 个候选帧/, `场景采样要按视频时长显示候选帧上界：${initialEstimate}`);
    assert.match(initialStorageEstimate, /PNG/, `空间估算应说明当前输出格式：${initialStorageEstimate}`);
    checks.push({ check: 'video-drop-default-scene', defaultDensity, primaryReady: true, candidateEstimateVisible: true });
    // 关掉自动导入来实际检查手动入库路径，必须从当前表单操作，避免只改引擎偏好却让界面仍使用旧状态。
    const autoImportChecked = await js<boolean>(`[...document.querySelectorAll('.checkbox-row')].find(e=>e.innerText.includes('抽帧完成后自动导入项目'))?.querySelector('input')?.checked??false`);
    if (autoImportChecked) await js(`([...document.querySelectorAll('.checkbox-row')].find(e=>e.innerText.includes('抽帧完成后自动导入项目'))?.querySelector('input')?.click())`);
    await wait(`[...document.querySelectorAll('.checkbox-row')].find(e=>e.innerText.includes('抽帧完成后自动导入项目'))?.querySelector('input')?.checked===false`);
    await select('[aria-label="视频采样密度"]', 'custom'); await select('[aria-label="视频采样方式"]', 'interval'); await fill('[aria-label="视频采样值"]', '1');
    // 时间段与输出尺寸都在「高级设置」折叠里：先展开，否则里面的按钮没有可读文本、点不到。
    await click('.video-advanced>summary');
    await js(`(()=>{const l=[...document.querySelectorAll('.checkbox-row')].find(e=>e.innerText.includes('使用整段已知时长'));if(l.querySelector('input').checked)l.querySelector('input').click();})()`);
    await wait(`!!document.querySelector('[aria-label="视频时间段 1 终点"]')`);
    await fill('[aria-label="视频时间段 1 终点"]', '2'); await button('添加时间段'); await fill('[aria-label="视频时间段 2 起点"]', '1'); await fill('[aria-label="视频时间段 2 终点"]', '6');
    assert.equal(await js<boolean>(`!!document.querySelector('.video-output-estimate')`), false, '范围重叠时应隐藏空间估算，避免展示错误总量');
    await button('开始抽帧'); await wait(`document.querySelector('.video-import .media-error')?.textContent.includes('时间段')`); assert.equal((await api('media.job.list', { projectId: project.id })).total, 0);
    await fill('[aria-label="视频时间段 2 起点"]', '4');
    await js(`(()=>{const l=[...document.querySelectorAll('.checkbox-row')].find(e=>e.innerText.trim()==='指定输出尺寸');if(!l.querySelector('input').checked)l.querySelector('input').click();})()`);
    await wait(`!!document.querySelector('[aria-label="视频输出宽度"]')`);
    await fill('[aria-label="视频输出宽度"]', '384'); await fill('[aria-label="视频输出高度"]', '288'); await select('[aria-label="视频尺寸适配"]', 'contain'); await select('[aria-label="视频输出格式"]', 'jpg'); assert.equal(await js(`document.querySelector('[aria-label="视频JPEG质量"]').value`), '3'); await select('[aria-label="视频输出格式"]', 'png');
    await wait(`document.querySelector('.video-output-estimate')?.innerText.includes('4 帧 × 384 × 288，PNG')`);
    const partialEstimate = await js<string>(`document.querySelector('.video-output-estimate').innerText`);
    assert.match(partialEstimate, /产物空间粗估：约 .+–.+（4 帧 × 384 × 288，PNG）/);
    checks.push({ check: 'video-range-and-storage-estimate', selectedRanges: [{ start: 0, end: 2 }, { start: 4, end: 6 }], estimate: partialEstimate });
    await capture('-parameters.png', 'dialog[open] .modal-inner>header'); await button('开始抽帧'); await wait(`!document.querySelector('dialog[open]')`);

    // ===== 任务详情：抽帧产物与逐帧记录在「任务 · 素材任务」里回看 =====
    await gotoTasks(driver, '素材任务');
    await wait(`!!document.querySelector('.media-job-row')`);
    await js(`document.querySelector('.media-job-row .media-job-open').click()`);
    await wait(`!!document.querySelector('.media-job-detail')`);
    const firstJob = (await api('media.job.list', { projectId: project.id, kind: 'video_extract' })).items[0], extracted = await settled(firstJob.id); assert.equal(extracted.stage, 'ready'); assert.equal(extracted.artifactCommitted, true); assert.equal(extracted.assetsCommitted, false); assert.equal(extracted.canImport, true); assert.equal((await api('asset.list', { projectId: project.id })).total, 0);
    assert.deepEqual(extracted.parameters.ranges, [{ start: 0, end: 2 }, { start: 4, end: 6 }]); assert.equal(extracted.parameters.mode, 'interval'); assert.equal(extracted.parameters.everyNFrames, undefined); assert.equal(extracted.parameters.targetFps, undefined);
    const frames = await api('media.video.frames', { jobId: firstJob.id, offset: 0, limit: 20 }); assert.equal(frames.total, 4); assert.deepEqual(frames.items.map((f: any) => f.timeSeconds), [0, 1, 4, 5]); for (const frame of frames.items) { assert.equal(frame.width, 384); assert.equal(frame.height, 288); assert.equal(typeof frame.sourcePts, 'string'); assert.equal(frame.assetId, undefined); }
    await wait(`document.querySelector('.media-job-detail')?.innerText.includes('抽帧就绪，待导入')`); await wait(`document.querySelector('.frame-job-strip')?.innerText.includes('抽帧就绪，待导入')`, 8000); await button('查看抽帧记录'); await wait(`document.querySelectorAll('.video-frame-list>div:not(.pagination)').length===4`); await capture('-ready.png', '.media-job-detail');
    checks.push({ check: 'video-inspect-extract-before-import', inspection, jobId: firstJob.id, geometryNoticeVisible: await js(`document.querySelector('.media-job-detail .notice')?.innerText??null`), frames: frames.items, overlappingRangesBlocked: true, assetCountBeforeImport: 0 });

    // ===== 进度条手动导入：点击后立即进入忙碌态，重复点击不会并发提交 =====
    window.setContentSize(390, 844);
    await wait(`document.querySelector('.frame-job-strip')?.innerText.includes('抽帧就绪，待导入')`);
    assert.equal(await js<boolean>(`document.documentElement.scrollWidth<=window.innerWidth`), true, '窄屏进度条不得撑出页面宽度');
    await capture('-manual-import-mobile.png', '.frame-job-strip'); await button('立即导入素材');
    await wait(`!!document.querySelector('.frame-job-actions .button.primary[aria-busy="true"]')`);
    await js(`document.querySelector('.frame-job-actions .button.primary')?.click()`);
    assert.equal(await js<boolean>(`!!document.querySelector('.frame-job-actions .button.primary[aria-busy="true"]:disabled')`), true, '手动导入开始后按钮应显示忙碌并禁用重复点击');
    await wait(`window.autoLabel.request('media.job.get',{jobId:${json(firstJob.id)}}).then(j=>j.status==='completed'&&j.stage==='done'&&j.assetsCommitted)`, 60000);
    await wait(`document.querySelector('.frame-job-strip')?.innerText.includes('素材已入库，可以直接标注')`, 8000);
    window.setContentSize(1440, 940);
    const importedFrames = await api('media.video.frames', { jobId: firstJob.id, offset: 0, limit: 20 }); assert.ok(importedFrames.items.every((f: any) => f.assetId)); const all = await api('asset.list', { projectId: project.id, limit: 100 }); assert.equal(all.total, 4);
    await openProjectOverview(driver, name);
    await wait(`document.querySelectorAll('.result-thumb').length===4`);
    // ===== 缩略图：网格拉的是可重建的缩略图（<30KB），不是全尺寸 PNG；缓存删掉自动重建 =====
    const thumbs = await js<string[]>(`[...document.querySelectorAll('.result-thumb img')].map(img=>img.getAttribute('src'))`);
    assert.ok(thumbs.length === 4 && thumbs.every(src => src?.startsWith('autolabel-media://thumb/')), `网格应全部使用缩略图地址，实际：${json(thumbs)}`);
    const thumbResponse = await net.fetch(thumbs[0]);
    assert.ok(thumbResponse.ok, `缩略图应能直接取到，实际 ${thumbResponse.status}`);
    const thumbBytes = new Uint8Array(await thumbResponse.arrayBuffer());
    assert.ok(thumbBytes.length < 30 * 1024, `缩略图应小于 30KB，实际 ${thumbBytes.length} 字节`);
    const fullBytes = new Uint8Array(await (await net.fetch(thumbs[0].replace('/thumb/', '/asset/'))).arrayBuffer());
    assert.ok(fullBytes.length > thumbBytes.length, `全尺寸图必须明显大于缩略图（${fullBytes.length} vs ${thumbBytes.length}）`);
    const candidates = [path.join(userData, 'data', 'thumbnail-cache'), path.join(userData, 'thumbnail-cache')];
    let thumbnailCache = '';
    for (const candidate of candidates) if (await stat(candidate).catch(() => null)) thumbnailCache = candidate;
    assert.ok(thumbnailCache, `找不到缩略图缓存目录，实际试过：${json(candidates)}`);
    await rm(thumbnailCache, { recursive: true, force: true });
    assert.ok(!(await stat(thumbnailCache).catch(() => null)), '缩略图缓存应能整目录删除（可重建缓存）');
    const concurrentRebuilds = await Promise.all(Array.from({ length: 4 }, async () => {
      // 自定义媒体协议不接受查询串；复用同一地址即可真实覆盖同一缓存键的并发重建。
      const response = await net.fetch(thumbs[0]);
      assert.ok(response.ok, `并发重建缩略图应成功，实际 ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }));
    const rebuilt = concurrentRebuilds[0];
    assert.equal(rebuilt.length, thumbBytes.length, `删掉缓存后应按基准图重建出同样大小的缩略图（${rebuilt.length} vs ${thumbBytes.length}）`);
    assert.ok(concurrentRebuilds.every(bytes => Buffer.from(bytes).equals(Buffer.from(rebuilt))), '并发重建应返回相同的完整缩略图');
    checks.push({ check: 'thumbnail-served-and-rebuildable', thumbBytes: thumbBytes.length, fullBytes: fullBytes.length, rebuiltBytes: rebuilt.length, concurrentRebuilds: concurrentRebuilds.length });
    // 标准答案集入口：界面重构移除旧页面后它一直没有新落点，评测因此没法给新项目建真值；这里守一条「概览页能打开它」。
    await overviewMenuButton('标准答案集');
    await wait(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog[open]').innerText.includes('独立标准答案集')`);
    await capture('-truth-entry.png', 'dialog[open] .modal-inner');
    await js(`document.querySelector('dialog[open] [aria-label="关闭弹窗"]').click()`);
    await wait(`!document.querySelector('dialog[open]')`);
    checks.push({ check: 'truth-set-entry-reachable', openedFromOverview: true });
    checks.push({ check: 'explicit-frame-import', jobId: firstJob.id, assetsCommitted: true, imported: all.total, sourceIdentityRetained: true, overviewVisible: 4 });

    // ===== 时间轴：帧数据按接口断言；界面在「任务 · 轨迹标注」里选中它并进入工作区 =====
    const keyframeAsset = all.items[0];
    const seededAnnotation = { id: 'track-undo-fixture', type: 'detect', classId: 'person', bbox: { x: 12, y: 18, width: 80, height: 64 } };
    const savedAnnotation = await api('annotation.save', { assetId: keyframeAsset.id, baseVersion: keyframeAsset.version, annotations: [seededAnnotation], confirm: false });
    checks.push({ check: 'track-undo-seed-annotation', assetId: keyframeAsset.id, version: savedAnnotation.version });
    await gotoTasks(driver, '轨迹标注');
    await wait(`!!document.querySelector('.video-timeline')`);
    await wait(`!!document.querySelector('[aria-label="时间轴来源抽帧任务"] option[value="${firstJob.id}"]')`);
    await select('[aria-label="时间轴来源抽帧任务"]', firstJob.id);
    await button('建立时间轴');
    await wait(`!!document.querySelector('.timeline-workspace')`);
    const timelineId = await js<string>(`document.querySelector('[aria-label="视频时间轴"]').value`);
    assert.ok(timelineId, '从任务页建立时间轴后应自动进入该时间轴');
    const timeline = await api('track.timeline.get', { timelineId });
    checks.push({ check: 'track-undo-create-timeline-from-task-ui', timelineId: timeline.id, version: timeline.version });
    const timelineFrames = await api('track.timeline.frames', { timelineId: timeline.id, offset: 0, limit: 50 });
    assert.equal(timelineFrames.total, 4); assert.ok(timelineFrames.items.every((frame: any) => frame.assetId && typeof frame.sourcePts === 'string'));
    const keyframeSource = timelineFrames.items.find((frame: any) => frame.assetId === keyframeAsset.id);
    assert.ok(keyframeSource, '人工标注的素材应出现在固定时间轴中');
    await button('新建对象轨迹');
    await fill('[aria-label="新轨迹名称"]', '撤销重做验收轨迹');
    await select('[aria-label="新轨迹类别"]', 'person');
    await button('创建轨迹');
    await wait(`window.autoLabel.request('track.list',{timelineId:${JSON.stringify(timeline.id)},offset:0,limit:50,includeArchived:true}).then(r=>r.total>0)`);
    const tracks = await api('track.list', { timelineId: timeline.id, offset: 0, limit: 50, includeArchived: true });
    const track = tracks.items.find((item: any) => item.name === '撤销重做验收轨迹');
    assert.ok(track, '任务页创建轨迹后应显示在对象轨迹选择框中');
    checks.push({ check: 'track-undo-create-track-from-task-ui', trackId: track.id, version: track.version });
    const trackFrames = await api('track.timeline.frames', { timelineId: timeline.id, trackId: track.id, offset: 0, limit: 50 });
    checks.push({ check: 'track-undo-read-track-frames', count: trackFrames.total, first: trackFrames.items[0]?.frameId });
    // 从任务页完成建轴和建轨迹后，应直接看到同一条时间轴和真实帧编辑区。
    await wait(`!!document.querySelector('.timeline-identity')||!!document.querySelector('.timeline-track-picker')`);
    const workspaceVisible = await js<boolean>(`!!document.querySelector('.timeline-identity')||!!document.querySelector('.timeline-track-picker')`);
    assert.equal(workspaceVisible, true, '轨迹标注页应能从零完成建轴、建轨迹并进入工作区');
    await button('刷新时间轴');
    await wait(`!!document.querySelector('[aria-label="当前视频帧"]')`);
    await select('[aria-label="当前视频帧"]', keyframeSource.frameId);
    await button('将此帧设为关键帧');
    await wait(`!!document.querySelector('dialog[open] .track-keyframe-editor')&&!!document.querySelector('[aria-label="关键帧选中对象"]')`);
    checks.push({ check: 'track-keyframe-editor-opened' });
    await select('[aria-label="关键帧选中对象"]', seededAnnotation.id);
    await wait(`!!document.querySelector('[aria-label="关键帧对象x"]')`);
    checks.push({ check: 'track-keyframe-object-selected' });
    await fill('[aria-label="关键帧对象x"]', '77');
    await wait(`document.querySelector('[aria-label="关键帧对象x"]')?.value==='77'`);
    checks.push({ check: 'track-keyframe-geometry-edited', x: 77 });
    await button('撤销本次编辑', dialog);
    await wait(`document.querySelector('[aria-label="关键帧对象x"]')?.value==='12'`);
    checks.push({ check: 'track-keyframe-undo', x: 12 });
    assert.equal(await js<boolean>(`[...(document.querySelector('dialog[open]')?.querySelectorAll('button')??[])].some(b=>b.innerText.trim()==='重做本次编辑'&&!b.disabled)`), true, '撤销后应启用关键帧重做');
    await button('重做本次编辑', dialog);
    await wait(`document.querySelector('[aria-label="关键帧对象x"]')?.value==='77'`);
    checks.push({ check: 'track-keyframe-redo', x: 77 });
    checks.push({ check: 'track-keyframe-undo-redo-restores-geometry', originalX: 12, undoneX: 12, redoneX: 77 });
    await button('保存关键帧', dialog);
    await wait(`!document.querySelector('dialog[open]')`);
    const savedKey = await api('track.keyframe.list', { trackId: track.id, offset: 0, limit: 20 });
    assert.equal(savedKey.items.length, 1);
    assert.equal(savedKey.items[0].annotation.bbox.x, 77, '重做后的关键帧几何应正式保存');
    assert.ok(savedAnnotation.version > keyframeAsset.version, '撤销重做使用的标注已由引擎持久化');
    await capture('-timeline.png', '.video-timeline');
    checks.push({ check: 'timeline-workspace-reachable', timelineId: timeline.id, frames: timelineFrames.total, builtFromRealFrames: true, workspaceVisible, keyframeUndoRedoSavedX: savedKey.items[0].annotation.bbox.x });
    // ===== 场景变化抽帧：场景门控、首帧必留、最小间隔稀疏化（同一段真实视频上的确定性断言）=====
    async function sceneJob(sceneThreshold: number, minIntervalSeconds: number) {
      const job = await api<{ id: string }>('media.video.create', { projectId: project.id, sourcePath: videoPath,
        parameters: { mode: 'scene', sceneThreshold, minIntervalSeconds, ranges: [{ start: 0, end: 6 }], format: 'png' } });
      await settled(job.id);
      return await api('media.video.frames', { jobId: job.id, offset: 0, limit: 50 }) as { total: number; items: Array<{ timeSeconds: number }> };
    }
    const sceneNormal = await sceneJob(0.15, 0.5);
    const sceneTimes = sceneNormal.items.map(f => f.timeSeconds);
    assert.ok(sceneTimes.length >= 1, '场景变化抽帧至少保留首帧');
    assert.equal(sceneTimes[0], 0, `首帧必留，实际首帧 ${sceneTimes[0]}`);
    assert.ok(sceneTimes.every((t, i) => i === 0 || t > sceneTimes[i - 1]), `保留帧时间必须严格递增：${json(sceneTimes)}`);
    // 阈值提到 1.0：与上一张保留帧的灰度差异最大才 1.0，实际画面永远达不到 —— 只剩首帧，证明去重门真的在生效。
    const sceneGateOnly = await sceneJob(1, 0.5);
    assert.equal(sceneGateOnly.total, 1, `阈值 1.0 应只剩首帧，实际 ${sceneGateOnly.total} 帧：${json(sceneGateOnly.items.map(f => f.timeSeconds))}`);
    // 最小间隔稀疏化：间隔 2 秒时 6 秒窗口最多 3 帧，且相邻保留帧间隔 ≥ 2 秒。
    const sceneThinned = await sceneJob(0.05, 2);
    const thinnedTimes = sceneThinned.items.map(f => f.timeSeconds);
    assert.ok(thinnedTimes.length >= 1 && thinnedTimes.length <= 3, `最小间隔 2 秒时 6 秒窗口应为 1～3 帧，实际 ${thinnedTimes.length}`);
    assert.ok(thinnedTimes.every((t, i) => i === 0 || t - thinnedTimes[i - 1] >= 2 - 1e-6), `相邻保留帧必须间隔 ≥ 2 秒：${json(thinnedTimes)}`);
    checks.push({ check: 'scene-extraction', firstKept: sceneTimes[0] === 0, thresholdOneFrames: sceneGateOnly.total, normalFrames: sceneNormal.total, thinnedFrames: thinnedTimes.length, thinnedTimes });
    await writeFile(output, json({ passed: true, mode: 'media-ui', projectId: project.id, newModelRuns: 0, timeline: { frameCount: timelineFrames.total, framesHaveSourcePts: true, workspaceVisible }, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'media-ui', checks, error: e instanceof Error ? e.message : String(e), body: await js('document.body.innerText') })); throw e; }
}
