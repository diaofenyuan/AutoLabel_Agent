import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { LocalModel, LocalRuntimeState } from '../../shared/inference';
import type { ModelLibraryState } from '../../shared/model-library';
import { deriveClassMap } from '../../shared/vocabulary';
import { gotoSettings, gotoWelcome, openPythonPicker, openSelectedProjectOverview, waitForIdle } from './desktop-navigation';

interface ProjectRow { id: string; name: string; classes: Array<{ id: string; name: string }> }
interface AssetRow { id: string; version: number; status: string; annotations: Array<{ id: string; classId: string; type: string }> }
interface RunRow { id: string; status: string; kind: string; statistics: Record<string, number>; samples: Array<{ resultId: string; assetId: string; status: string; errorCode?: string; message?: string }> }
interface ResultRow { source: string; status: string; annotations: Array<{ classId: string; type: string }>; rawResult: Record<string, unknown> | null; provenance: Record<string, unknown> }
interface EvaluationSchemeRow { id: string; runKind?: string; averageImageMs?: number; cost?: { basis?: string }; metrics: { scorableSamples?: number } }

/**
 * 对话内一键标注（零配置路径）验收。
 *
 * 这一条验的是「不花钱能不能走完标注」，所以全程不配置任何 API Key：
 * 1. 欢迎页给出「用内置模型标注（无需 API Key）」的出口，且落在模型库所在的设置页；
 * 2. 输入卡的「内置模型」入口选中后**只把提示词写进输入框**——不执行、不发送、不产生任何请求；
 * 3. 未命中项目类别的类别名在预览里明确显示为「忽略」，不静默丢弃（deriveClassMap 的硬要求）；
 * 4. 用启用出来的内置 YOLO-World 走完真实标注：候选框出现、素材状态为 candidate、零 API 请求；
 * 5. 已有人工标注的素材被 protectedHuman 保护：候选只落版本，当前状态与版本都不动；
 * 6. 反例：类别名不在内置词表且本机没有 CLIP 编码器时，必须报 vocabulary_encoder_missing，绝不联网；
 * 7. 省钱对比：本机跑出的候选能进同一张指标对比表，成本一栏写 ¥0，并带实测单张耗时。
 *
 * 前置：本机 Python 3.10–3.12 且已装 ultralytics（AUTOLABEL_TEST_PYTHON 可指定），
 * 以及 `.qa/models/bus.jpg` 夹具（不入库，缺了会在导入那一步明确失败）。
 */
export async function checkDesktopLocalAnnotate(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [], json = JSON.stringify;
  const userData = process.env.AUTOLABEL_TEST_USER_DATA;
  assert.ok(userData, '对话内标注验收必须指定隔离数据目录');
  const basePython = process.env.AUTOLABEL_TEST_PYTHON ?? 'C:/Users/zhy23/AppData/Local/Programs/Python/Python311/python.exe';
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = <T = any>(command: string, payload: unknown = {}): Promise<T> => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const driver = { js, wait };
  async function wait(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  async function button(label: string, scope = 'document') {
    // scope 是「可求值表达式」而不是 CSS 选择器：它被直接拼进 `[...${scope}.querySelectorAll(...)]`。
    await wait(`[...${scope}.querySelectorAll('button')].some(node=>node.innerText.trim()===${json(label)}&&!node.disabled)`);
    await js(`([...${scope}.querySelectorAll('button')].find(node=>node.innerText.trim()===${json(label)}&&!node.disabled)).click()`);
  }
  const textareaValue = (scope: string) => js<string>(`document.querySelector(${json(scope + ' textarea')})?.value ?? ''`);
  const cardScope = `document.querySelector('.model-card[data-model="yolov8s-worldv2"]')`;
  try {
    assert.ok(await stat(basePython).then(() => true).catch(() => false), `本机缺少可用的 Python：${basePython}`);
    window.setContentSize(1440, 940); window.show();
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);

    // ===== 1. 未配置云接口时，第 3 条路上要有「用内置模型标注」的出口 =====
    const lanes = await js<string[]>(`[...document.querySelectorAll('.onboarding-lane')].map(node=>node.innerText)`);
    assert.equal(lanes.length, 3, `首屏应是三条上手路径，实际 ${lanes.length} 条`);
    assert.ok(lanes[2].includes('用内置模型标注（无需 API Key）'), `第 3 条路缺少内置模型出口：${lanes[2]}`);
    await js(`([...([...document.querySelectorAll('.onboarding-lane')][2].querySelectorAll('button'))].find(node=>node.innerText.includes('用内置模型标注'))).click()`);
    await wait(`document.querySelector('.settings-tabs button.selected')?.innerText.trim()==='软件 AI 配置'`);
    checks.push({ check: 'lane-offers-builtin-model', landed: '软件 AI 配置' });

    // ===== 2. 一键启用内置 YOLO-World + 准备解释器（都不经文件选择器） =====
    await js(`([...document.querySelectorAll('.model-kind-tabs button')].find(node=>node.innerText.trim()==='模型库')).click()`);
    await wait(`!!document.querySelector('.model-card[data-model="yolov8s-worldv2"]')`);
    const library = await api<ModelLibraryState>('model.library.status');
    const world = library.entries.find(entry => entry.id === 'yolov8s-worldv2')!;
    assert.equal(world.openVocabulary, true, 'YOLO-World 应标记为开放词汇');
    if (world.state !== 'ready') { await button('启用（需要时先下载）', cardScope); await wait(`document.querySelector('.model-card[data-model="yolov8s-worldv2"]')?.dataset.enabled==='yes'`, 180000); }
    else { await button('启用', cardScope); await wait(`document.querySelector('.model-card[data-model="yolov8s-worldv2"]')?.dataset.enabled==='yes'`, 120000); }
    const registered = (await api<{ items: LocalModel[] }>('local.model.list', { offset: 0, limit: 500 })).items.find(item => item.catalogId === 'yolov8s-worldv2')!;
    assert.ok(registered, '启用后应能在本地模型里找到');
    assert.equal(registered.openVocabulary, true, '登记记录必须带上开放词汇标记，否则引擎不会接受 textClasses');
    checks.push({ check: 'builtin-model-enabled', modelId: registered.id, version: registered.version, origin: registered.origin, openVocabulary: registered.openVocabulary });

    const fixtures = path.join(userData!, 'fixtures'), environment = path.join(fixtures, 'python-env'), pythonPath = path.join(environment, 'Scripts', 'python.exe');
    await mkdir(fixtures, { recursive: true });
    await promisify(execFile)(basePython, ['-m', 'venv', '--system-site-packages', '--without-pip', environment], { windowsHide: true });
    await writeFile(path.join(userData!, 'dialog-fixtures.json'), json([{ kind: 'python', paths: [pythonPath] }]));
    await gotoSettings(driver, '本地推理');
    await wait(`!!document.querySelector('.local-runtime-settings')`);
    await openPythonPicker(driver);
    await button('选择 Python 解释器');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('解释器配置：已配置')`);
    await button('重新检测环境');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('环境检测通过')`, 120000);
    const runtime = await api<LocalRuntimeState>('local.runtime.get');
    assert.equal(runtime.available, true, '本机环境未检测通过，后面无法推理');
    checks.push({ check: 'runtime-ready', ultralytics: runtime.ultralyticsVersion, torch: runtime.torchVersion });

    // ===== 3. 载入示例项目（零配置路径的第一条路），并先人工确认一条标注 =====
    await gotoWelcome(driver);
    await button('载入示例项目', 'document.querySelector(".onboarding-lane")');
    await wait(`!!document.querySelector('.chat-panel textarea')`);
    await waitForIdle(driver);
    // project.list 返回的是数组本身（不是 {items}），与 asset.list 的分页形状不同。
    const project = (await api<ProjectRow[]>('project.list', {})).find(item => item.name.includes('城市场景'))!;
    assert.ok(project, '示例项目应已载入');
    const assets = await api<{ items: AssetRow[] }>('asset.list', { projectId: project.id, limit: 10 });
    const assetId = assets.items[0].id;

    // ===== 4. 输入卡的「内置模型」入口：只填输入框，不执行、不发送 =====
    // 会话页的模型入口在「范围与执行方式」弹层里，先展开那一层。
    await js(`document.querySelector('.chat-panel .composer-summary').click()`);
    await wait(`!!document.querySelector('.chat-panel .composer-popover .local-model-picker')`);
    await js(`document.querySelector('.chat-panel .composer-popover .local-model-picker button').click()`);
    await wait(`!!document.querySelector('.local-model-menu')`);
    // 清单是点开时才异步加载的：等它真的回来，不要在半渲染状态下断言。
    await wait(`document.querySelectorAll('.local-model-option').length>0||[...document.querySelectorAll('.local-model-menu .muted.tiny')].some(node=>node.innerText.includes('还没有')||node.innerText.includes('尚未'))`, 30000);
    const options = await js<string[]>(`[...document.querySelectorAll('.local-model-option strong')].map(node=>node.innerText.trim())`);
    assert.ok(options.some(name => name.includes('YOLO-World')), `入口里应列出已启用的内置模型，实际：${json(options)}`);
    await js(`([...document.querySelectorAll('.local-model-option')].find(node=>node.innerText.includes('YOLO-World'))).click()`);
    await wait(`!!document.querySelector('.local-model-terms input')`);
    // 三个词各走一条路：「行人」精确匹配项目类别名，「轿车」经同义词表对上「车辆」，「消防车」谁都对不上。
    await js(`(()=>{const e=document.querySelector('.local-model-terms input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'行人 / 轿车 / 消防车');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(`document.querySelector('.local-model-map')?.innerText.includes('消防车')`);
    // 类别映射预览：能对上的按同义词标出，对不上的必须显示「忽略」。
    const previewText = await js<string>(`document.querySelector('.local-model-map').innerText`);
    assert.ok(previewText.includes('忽略'), `未命中的类别名必须显示为忽略：${previewText}`);
    assert.ok(previewText.includes('按同义词对上'), `中文类别名应经同义词表对上项目类别：${previewText}`);
    const derived = deriveClassMap(['行人', '轿车', '消防车'], project.classes);
    assert.equal(derived.unmatched, 1, '消防车不应被猜成某个项目类别');
    assert.equal(derived.classMap['0'], 'person'); assert.equal(derived.classMap['1'], 'vehicle'); assert.equal(derived.classMap['2'], null);
    assert.equal(derived.entries[1].reason, 'alias', '「轿车」应按同义词对上「车辆」');
    const requestsBefore = await api<unknown[]>('run.list', { projectId: project.id });
    await button('填进输入框', 'document.querySelector(".local-model-terms")');
    await wait(`!document.querySelector('.local-model-menu')`);
    const filled = await textareaValue('.chat-panel');
    assert.ok(filled.includes('YOLO-World') && filled.includes('行人'), `提示词应写进输入框：${filled}`);
    const requestsAfter = await api<unknown[]>('run.list', { projectId: project.id });
    assert.equal(requestsAfter.length, requestsBefore.length, '选中模型只写提示词，不应产生任何运行或请求');
    assert.equal(await js<boolean>(`!!document.querySelector('.chat-panel .send-button')&&document.querySelector('.chat-panel textarea').value.length>0`), true);
    checks.push({ check: 'picker-fills-input-only', prompt: filled.slice(0, 80), runsBefore: requestsBefore.length, runsAfter: requestsAfter.length,
      preview: previewText.replace(/\s+/g, ' ').slice(0, 160), derived });

    // ===== 5. 走完真实标注：候选框出现、状态为 candidate、零 API 请求 =====
    // 示例项目自带的那张图有人工预置标注，会被 protectedHuman 保护（候选只落版本、不改当前状态），
    // 所以这里再导入一张没有任何标注的图，用它验证「标注出现 → 状态转 candidate」。
    const busSource = path.resolve('.qa/models/bus.jpg'), busPath = path.join(fixtures, 'bus.jpg');
    await copyFile(busSource, busPath);
    await writeFile(path.join(userData!, 'dialog-fixtures.json'), json([{ kind: 'images', paths: [busPath] }]));
    const chosen = await js<string[]>(`window.autoLabel.chooseFiles({kind:'images'})`);
    const imported = await api<{ assetIds: string[] }>('asset.import', { projectId: project.id, paths: chosen });
    const freshId = imported.assetIds[0];
    assert.ok(freshId, '新素材应已导入');
    assert.equal((await api<AssetRow>('asset.get', { assetId: freshId })).status, 'unlabeled', '新导入的素材应无标注');

    // 正向用内置词表能覆盖的类别名（行人→person、轿车→car），全程不联网、不需要 CLIP 编码器。
    const builtinTerms = ['行人', '轿车'];
    const builtinMap = deriveClassMap(builtinTerms, project.classes);
    assert.equal(builtinMap.unmatched, 0, `这两个词应都能在内置词表里对上：${json(builtinMap.entries)}`);
    await api('local.model.load', { modelId: registered.id, modelVersion: registered.version, device: 'cpu', timeoutMs: 300000 });
    const run = await api<RunRow>('local.run.create',
      { projectId: project.id, assetIds: [freshId], modelId: registered.id, modelVersion: registered.version, device: 'cpu',
        textClasses: builtinTerms, classMap: builtinMap.classMap, confidence: 0.2, timeoutMs: 300000, forceRerun: true });
    await wait(`window.autoLabel.request('run.get',{runId:${json(run.id)}}).then(item=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(item.status))`, 180000);
    const finished = await api<RunRow>('run.get', { runId: run.id });
    assert.equal(finished.status, 'completed', json(finished));
    assert.equal(finished.kind, 'local');
    assert.equal(finished.statistics.requestsUsed, 0, '本机标注不得产生 API 请求');
    // resultId 只有在运行结束后才有值：创建响应里的样本还是 null，不能拿它去查结果。
    const result = await api<ResultRow>('run.result.get', { resultId: finished.samples[0].resultId });
    assert.equal(result.source, 'local'); assert.equal(result.status, 'succeeded');
    assert.ok(result.annotations.length > 0, `候选标注不应为空：${json(result)}`);
    assert.ok(result.annotations.every(item => ['person', 'vehicle'].includes(item.classId)), `候选只应落在已映射的类别上：${json(result.annotations.map(item => item.classId))}`);
    // 词表来源写在 worker 返回体里（provenance 是引擎自己拼的，不带这个字段）。
    // builtin 与 cache 都算通过：缓存目录在 <存储根>/models/vocab，开发态各次验收共用同一存储根，
    // 上一轮写下的缓存这一轮命中正是「不重复编码」的证据；出现 encoded 才说明真的动了编码器。
    const source = String(result.rawResult?.vocabularySource ?? '');
    assert.ok(['builtin', 'cache'].includes(source), `词表来源应是内置词表或缓存，实际：${source}`);
    const after = await api<AssetRow>('asset.get', { assetId: freshId });
    assert.equal(after.status, 'candidate', `候选框应让素材进入 candidate，实际：${after.status}`);
    assert.equal(after.annotations.length, result.annotations.length, '候选标注应成为素材的当前标注');
    checks.push({ check: 'local-annotate-end-to-end', runId: run.id, annotations: result.annotations.length,
      classes: [...new Set(result.annotations.map(item => item.classId))], assetStatus: after.status, vocabularySource: source });

    // ===== 5a. 受保护的人工标注不被覆盖：示例项目那张自带预置标注的图也跑一次 =====
    const guardedBefore = await api<AssetRow>('asset.get', { assetId });
    const guardedRun = await api<RunRow>('local.run.create',
      { projectId: project.id, assetIds: [assetId], modelId: registered.id, modelVersion: registered.version, device: 'cpu',
        textClasses: builtinTerms, classMap: builtinMap.classMap, confidence: 0.2, timeoutMs: 300000, forceRerun: true });
    await wait(`window.autoLabel.request('run.get',{runId:${json(guardedRun.id)}}).then(item=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(item.status))`, 180000);
    const guardedAfter = await api<AssetRow>('asset.get', { assetId });
    assert.equal(guardedAfter.version, guardedBefore.version, '已有人工标注的素材版本不能被候选推进');
    assert.equal(guardedAfter.status, guardedBefore.status, '已有人工标注的素材状态不能被候选改写');
    assert.ok(guardedAfter.annotations.length === guardedBefore.annotations.length, '人工标注的数量不能因候选写入而变化');
    // 候选并没有被丢掉：它作为 source='local' 的版本落在历史里，用户随时能查。
    const history = await api<Array<{ source: string; version: number }>>('annotation.history', { assetId });
    assert.ok(history.some(item => item.source === 'local'), `候选应作为本地版本留在历史里，实际来源：${json(history.map(item => item.source))}`);
    checks.push({ check: 'protected-human-not-overwritten', assetId, version: guardedAfter.version, status: guardedAfter.status,
      historySources: [...new Set(history.map(item => item.source))], runId: guardedRun.id });

    // ===== 5b. 画布上真的看得到候选框：概览 → 那张新导入的素材 → 标注视图 =====
    // 反例（未命中词表）挪到这一步之后：它跑在同一张素材上，插在中间会把刚验证过的候选改掉。
    // 按素材标识点它自己，不靠缩略图顺序——顺序一变就会去查另一张图，断言就失去意义。
    await openSelectedProjectOverview(driver);
    await wait(`[...document.querySelectorAll('.result-thumb')].some(node=>(node.querySelector('img')?.src ?? '').includes(${json(freshId)}))`, 30000);
    await js(`([...document.querySelectorAll('.result-thumb')].find(node=>(node.querySelector('img')?.src ?? '').includes(${json(freshId)}))).click()`);
    await wait(`[...document.querySelectorAll('dialog[open] button')].some(node=>node.innerText.trim()==='编辑标注'&&!node.disabled)`, 30000);
    await js(`([...document.querySelectorAll('dialog[open] button')].find(node=>node.innerText.trim()==='编辑标注')).click()`);
    await wait(`!!document.querySelector('.quality-image img')`);
    await wait(`(()=>{const img=document.querySelector('.quality-image img');return !!img&&img.complete&&img.naturalWidth>0;})()`);
    // 按对象元素数断言，不依赖 svg 的 aria-label（只读态下它是画布标题而不是「素材标注画布」）。
    const canvas = await js<{ objects: number; labels: string[]; canvases: number; dialog: string; images: number }>(`({
      objects: document.querySelectorAll('[data-quality-object]').length,
      labels: [...document.querySelectorAll('svg')].map(node=>node.getAttribute('aria-label') ?? ''),
      canvases: document.querySelectorAll('.quality-canvas').length,
      images: document.querySelectorAll('.quality-image img').length,
      dialog: document.querySelector('dialog[open]')?.innerText.slice(0, 240) ?? '(没有打开的对话框)',
    })`);
    assert.ok(canvas.objects > 0, `画布上应出现候选框，DOM 快照：${json(canvas)}`);
    assert.equal(canvas.objects, result.annotations.length, `画布对象数应与本次候选一致，快照：${json(canvas)}`);
    checks.push({ check: 'candidate-boxes-visible', ...canvas });
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());

    // ===== 5c. 反例一：内置词表没覆盖的【中文】类别名必须明确拒绝 =====
    // CLIP 只认英文：把中文名编码出来的是无意义的向量，以前会静默返回近乎空的框；
    // 现在必须报 vocabulary_term_needs_english，而且不能建议「下载编码器」（下载了也没用）。
    const novel = deriveClassMap(['行人', '消防车'], project.classes);
    const novelRun = await api<RunRow>('local.run.create',
      { projectId: project.id, assetIds: [freshId], modelId: registered.id, modelVersion: registered.version, device: 'cpu',
        textClasses: ['行人', '消防车'], classMap: novel.classMap, confidence: 0.2, timeoutMs: 300000, forceRerun: true });
    await wait(`window.autoLabel.request('run.get',{runId:${json(novelRun.id)}}).then(item=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(item.status))`, 180000);
    const novelFinished = await api<RunRow>('run.get', { runId: novelRun.id });
    const rejected = novelFinished.samples.find(sample => sample.errorCode === 'vocabulary_term_needs_english');
    assert.ok(rejected, `未命中内置词表的中文类别名必须报 vocabulary_term_needs_english，实际：${json(novelFinished.samples)}`);
    assert.equal(novelFinished.statistics.requestsUsed, 0, '失败的本机推理也不应产生 API 请求');
    checks.push({ check: 'novel-term-needs-english', code: rejected.errorCode, message: rejected.message });

    // ===== 5c-2. 反例二：英文新词在没有编码器时才轮得到 vocabulary_encoder_missing =====
    const englishNovel = await api<RunRow>('local.run.create',
      { projectId: project.id, assetIds: [freshId], modelId: registered.id, modelVersion: registered.version, device: 'cpu',
        textClasses: ['spaceship'], classMap: { 0: null }, confidence: 0.2, timeoutMs: 300000, forceRerun: true });
    await wait(`window.autoLabel.request('run.get',{runId:${json(englishNovel.id)}}).then(item=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(item.status))`, 180000);
    const englishFinished = await api<RunRow>('run.get', { runId: englishNovel.id });
    const needsEncoder = englishFinished.samples.find(sample => sample.errorCode === 'vocabulary_encoder_missing');
    assert.ok(needsEncoder, `英文新词在没有编码器时应报 vocabulary_encoder_missing，实际：${json(englishFinished.samples)}`);
    checks.push({ check: 'novel-term-needs-encoder', code: needsEncoder.errorCode, message: needsEncoder.message });

    // ===== 5d. 省钱对比：本机运行与云端运行进同一张指标表，本地行必须显示 ¥0 =====
    // 用示例项目自带的那张图 + 5a 的本机运行：它已经被既有质量验收证明与评测链路兼容。
    const setName = `本机对比-${Date.now()}`;
    const set = await api<{ id: string; revision: number }>('evaluationSet.create', { projectId: project.id, name: setName, assetIds: [assetId] });
    const truth = await api<{ truthVersion: number }>('evaluationSet.saveTruth', { setId: set.id, assetId, baseTruthVersion: 0, source: 'manual',
      annotations: [
        // 示例图是 1586×992，两个真值框都在图内：一个与预置标注位置一致，另一个刻意错开。
        { id: 'truth-car-1', classId: 'vehicle', type: 'detect', bbox: { x: 221, y: 483, width: 537, height: 350 } },
        { id: 'truth-car-2', classId: 'vehicle', type: 'detect', bbox: { x: 60, y: 60, width: 120, height: 120 } },
      ] });
    assert.ok(truth.truthVersion >= 1, '独立答案应已保存');
    // 保存真值会推进评测集 revision：发布必须用当前这一份，不能用创建时那份。
    const current = await api<{ revision: number }>('evaluationSet.get', { setId: set.id });
    // 发布返回的就是新版本对象本身（它的 id 即 setVersionId），不是「带 publishedVersions 的评测集」。
    const published = await api<{ id: string; version: number; truthObjectCount: number }>('evaluationSet.publish', { setId: set.id, baseSetRevision: current.revision });
    assert.equal(published.truthObjectCount, 2, '发布版本应冻结两条独立真值');
    const setVersionId = published.id;

    const parameters = { setVersionId, schemes: [{ runId: guardedRun.id, name: '内置模型方案' }], match: { iouThreshold: 0.5, poseNormalization: 'image_diagonal' as const } };
    // 先预检：本机方案的输入一致性（项目、模板、素材内容）必须过，否则评测只会给一个笼统的 mismatch。
    const preflight = await api<{ canEvaluate: boolean; issues: Array<{ code: string; message: string; assetId?: string | null }>; pairedComparableSamples: number }>('evaluation.preflight', parameters);
    if (!preflight.canEvaluate) {
      // 只报「不一致」没法定位：把两侧真正参与比对的原始字段摊出来。
      const frozen = await api<{ assets: Array<Record<string, unknown>> }>('evaluationSet.get', { setId: set.id, versionId: setVersionId });
      const live = await api<{ metadata?: Record<string, unknown>; contentHash?: string }>('asset.get', { assetId });
      assert.equal(preflight.canEvaluate, true, `本机方案预检未通过：${json(preflight.issues)}\n冻结素材：${json(frozen.assets[0])}\n当前素材元数据：${json(live.metadata)}\n当前素材哈希：${live.contentHash}`);
    }
    const evaluation = await api<{ id: string; schemes: EvaluationSchemeRow[]; pairedComparableSamples: number }>('evaluation.create', parameters);
    const scheme = evaluation.schemes[0];
    // 关键断言：本机跑出来的候选能被评测读到（这正是「只取 source='api'」卡住的地方）。
    assert.ok(scheme.metrics.scorableSamples >= 1, `本机候选应能参与评测，实际可计算 ${scheme.metrics.scorableSamples} 张`);
    assert.equal(scheme.runKind, 'local', `方案应标明本机运行，实际：${scheme.runKind}`);
    assert.equal(scheme.cost?.basis, 'local_machine', `本机方案的成本口径应是本机推理，实际：${json(scheme.cost)}`);
    assert.ok(scheme.averageImageMs && scheme.averageImageMs > 0, `本机方案应带实测单张耗时，实际：${scheme.averageImageMs}`);
    const results = await api<{ items: Array<{ candidateSource?: string; imageElapsedMs?: number }> }>('evaluation.results', { evaluationId: evaluation.id, limit: 10 });
    assert.equal(results.items[0].candidateSource, 'local', '逐图结果应标明候选来自本机');
    checks.push({ check: 'local-run-enters-comparison', evaluationId: evaluation.id, scorable: scheme.metrics.scorableSamples,
      paired: evaluation.pairedComparableSamples, cost: scheme.cost, averageImageMs: scheme.averageImageMs, candidateSource: results.items[0].candidateSource });

    // 表里那一行：本机方案必须写 ¥0，而不是「币种未定 0」。
    await js(`[...document.querySelectorAll('.nav-item')].find(node=>node.innerText.trim()==='任务').click()`);
    await wait(`!!document.querySelector('.task-kind-tabs')`, 30000);
    await button('评测与复核');
    await wait(`!!document.querySelector('.quality-body')`);
    await button('已有运行对比', "document.querySelector('.quality-body')");
    // 「已保存评测」是评测面板内部那一组标签里的按钮，用全局限定按文字找，别去猜是第几个 .tabs。
    await button('已保存评测');
    // 等那一份评测真的出现在下拉里（列表是异步读回来的），再选中它——不按元素顺序猜。
    await wait(`[...document.querySelectorAll('.quality-body select')].some(node=>[...node.options].some(option=>option.value===${json(evaluation.id)}))`, 30000);
    await js(`(()=>{const select=[...document.querySelectorAll('.quality-body select')].find(node=>[...node.options].some(option=>option.value===${json(evaluation.id)}));` +
      `select.value=${json(evaluation.id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`!!document.querySelector('.quality-table')`, 30000);
    const tableText = await js<string>(`document.querySelector('.quality-table').innerText`);
    assert.ok(tableText.includes('成本 / 单张耗时'), `指标表应有成本与耗时行：${tableText.slice(0, 200)}`);
    assert.ok(tableText.includes('¥0'), `本机方案的这一格必须写 ¥0：${tableText.slice(0, 400)}`);
    assert.ok(!tableText.includes('币种未定'), '本机方案不能被显示成「币种未定」的未知金额');
    checks.push({ check: 'cost-row-shows-free', header: tableText.split('\n').slice(0, 3).join(' / '), hasZero: tableText.includes('¥0'),
      costRow: tableText.split('\n').find(line => line.includes('ms/张')) ?? '' });
    await writeFile(output.replace(/\.json$/, '-cost.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: true, mode: 'local-annotate-ui', newApiRequests: 0 }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    // 「Script failed to execute」本身不说明是哪一行，堆栈才是能定位的那一半。
    await writeFile(output, json({ checks, passed: false, mode: 'local-annotate-ui',
      error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join(' | ') : '',
      body: await js(`document.body.innerText`) }));
    throw error;
  }
}
