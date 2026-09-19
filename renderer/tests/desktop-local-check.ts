import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { InputResult, LocalModel, LocalRuntimeState } from '../../shared/inference';
import { gotoWelcome, gotoSettings, openPythonPicker } from './desktop-navigation';

/**
 * 本地推理链路验收。
 *
 * 覆盖：解释器确认、模型登记与加载（观察后端与设备）、类别映射，以及两轮真实本地推理——
 * 第一轮断言「零 API 请求、来源为本地、姿势关键点齐全」，第二轮断言同输入复用（0 请求）。
 * 旧的「本地预标注流程单步」路径随流程编排页移除，改为直接经 local.run.create 发起；
 * 「固定产物视图 / 来源任务弹窗」是流程编排时代的界面，不再覆盖。
 *
 * 运行前提：需要 `.qa/models/yolo11n-pose.pt`、`.qa/models/bus.jpg` 与本机可用的 ultralytics 环境
 * （`.qa/` 不入库）。缺少夹具时会在第一步 copyFile 就失败，与产品行为无关。
 */
export async function checkDesktopLocal(window: BrowserWindow, output: string): Promise<void> {
  const checks: unknown[] = [], json = JSON.stringify;
  const userData = process.env.AUTOLABEL_TEST_USER_DATA;
  assert.ok(userData, '本地模型验收必须指定隔离数据目录');
  const fixtures = path.join(userData, 'fixtures'); await mkdir(fixtures, { recursive: true });
  const basePython = process.env.AUTOLABEL_TEST_PYTHON ?? 'C:/Users/zhy23/AppData/Local/Programs/Python/Python311/python.exe';
  const environment = path.join(fixtures, 'python-env'), pythonPath = path.join(environment, 'Scripts', 'python.exe');
  const modelPath = path.join(fixtures, 'yolo11n-pose.pt'), imagePath = path.join(fixtures, 'bus.jpg');
  const keypointNames = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = <T = any>(command: string, payload: unknown = {}): Promise<T> => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  async function wait(expression: string, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 80)); } throw new Error(`本地推理界面等待超时：${expression}`); }
  async function click(selector: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`document.querySelector(${json(selector)}).click()`); }
  async function button(label: string, scope = 'document') { await wait(`!!${scope}&&[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}&&!b.disabled).click()`); }
  async function fill(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async function select(selector: string, value: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`(()=>{const e=document.querySelector(${json(selector)});if(![...e.options].some(o=>o.value===${json(value)}))throw new Error('实际返回的选项不存在');e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async function queue(kind: string, file: string) { await writeFile(path.join(userData!, 'dialog-fixtures.json'), json([{ kind, paths: [file] }])); }
  async function capture(suffix: string, selector: string) { await js(`document.activeElement?.blur();document.querySelector(${json(selector)}).scrollIntoView({block:'center',behavior:'instant'})`); await new Promise(r => setTimeout(r, 350)); await writeFile(output.replace(/\.json$/, suffix), (await window.webContents.capturePage()).toPNG()); }
  async function node(label: string) { await js(`[...document.querySelectorAll('.flow-node')].find(b=>b.innerText.includes(${json(label)})).click()`); await wait(`document.querySelector('.flow-inspector h2')?.innerText.includes(${json(label)})`); }
  async function completed(id: string) {
    await wait(`window.autoLabel.request('flow.get',{flowRunId:${json(id)}}).then(r=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(r.status))`, 60000);
    const run = await api('flow.get', { flowRunId: id }); assert.equal(run.status, 'completed', json(run)); return run;
  }
  window.setContentSize(1440, 940); window.show();
  try {
    if (process.env.AUTOLABEL_LOCAL_DISPLAY_ONLY === '1') {
      await wait(`!!document.querySelector('.nav-item')&&!document.querySelector('.connection-banner')`); await click('.nav-item:nth-child(4)'); await button('标注任务'); await click('.run-list .run-row'); await button('查看输入与结果', "document.querySelector('.sample-table')");
      await wait(`document.querySelector('.actual-input-preview img')?.complete&&document.querySelector('.actual-input-preview img')?.naturalWidth>0&&document.querySelectorAll('.actual-input-preview svg circle').length>0`);
      const layout = await js(`(()=>{const img=document.querySelector('.actual-input-preview img'),svg=document.querySelector('.actual-input-preview svg'),header=document.querySelector('dialog[open] .modal-inner>header'),a=img.getBoundingClientRect(),b=svg.getBoundingClientRect(),h=header.getBoundingClientRect();return {width:a.width,height:a.height,aspect:a.width/a.height,naturalAspect:img.naturalWidth/img.naturalHeight,overlayWidth:b.width,overlayHeight:b.height,overlayX:b.x-a.x,overlayY:b.y-a.y,headerTop:h.top,headerBottom:h.bottom,viewportHeight:innerHeight,circles:svg.querySelectorAll('circle').length}})()`);
      assert.ok(layout.height <= 480); assert.ok(Math.abs(layout.aspect-layout.naturalAspect) < .001); assert.ok(Math.abs(layout.width-layout.overlayWidth) < 1); assert.ok(Math.abs(layout.height-layout.overlayHeight) < 1); assert.ok(Math.abs(layout.overlayX) < 1); assert.ok(Math.abs(layout.overlayY) < 1); assert.ok(layout.headerTop >= 0 && layout.headerBottom < layout.viewportHeight);
      await capture('-pose-result.png', 'dialog[open] .modal-inner>header');
      await writeFile(output, json({ passed: true, mode: 'local-pose-display-only', readOnly: true, newInferenceRuns: 0, layout })); return;
    }
    // 对话框验收严格限制在 fixtures；真实虚拟环境继承现有依赖，不扩大选择器授权。
    await copyFile(path.resolve('.qa/models/yolo11n-pose.pt'), modelPath); await copyFile(path.resolve('.qa/models/bus.jpg'), imagePath);
    await promisify(execFile)(basePython, ['-m', 'venv', '--system-site-packages', '--without-pip', environment], { windowsHide: true });
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const name = `Pose 本地验收-${Date.now()}`;
    const project = await api('project.create', { name, taskType: 'pose', classes: [{ id: 'person', name: '行人', color: '#477b93' }] });
    await api('project.update', { projectId: project.id, settings: { keypointNames } });
    await new Promise<void>(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await wait(`!!document.querySelector('.sidebar')&&!document.querySelector('.connection-banner')`); await gotoWelcome({ js, wait });
    // 素材必须经界面导入：路径授权只认用户选择；导入后进项目会话，应用层才拿得到素材。
    await queue('images', imagePath);
    const clicked = await js<boolean>(`(()=>{const b=[...document.querySelectorAll('.onboarding-lane button')].find(x=>x.innerText.trim()==='导入图片');if(!b)return false;b.click();return true;})()`); assert.ok(clicked, '欢迎页找不到「导入图片」入口');
    const prompt = "document.querySelector('dialog[open]')"; await button('选择已有项目', prompt);
    const picked = await js<boolean>(`(()=>{const e=${prompt}.querySelector('select');if(!e)return false;e.value=${json(project.id)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`); assert.ok(picked, '项目确认框里没有可选的已有项目');
    await button('导入并继续', prompt); await wait(`!!document.querySelector('.chat-panel textarea')`);
    const assets = await api('asset.list', { projectId: project.id, limit: 100 }); assert.equal(assets.total, 1);
    const assetId = assets.items[0].id;
    await api('annotation.save', { assetId, baseVersion: 0, confirm: false, annotations: [{ id: 'protected-manual-pose', type: 'pose', classId: 'person', bbox: { x: 10, y: 10, width: 40, height: 80 }, keypoints: keypointNames.map(name => ({ name, x: 0, y: 0, visibility: 0 })) }] });
    const original = await api('asset.get', { assetId });

    await gotoSettings({ js, wait }, '本地推理');
    await wait(`!!document.querySelector('.local-runtime-settings')&&[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='重新检测环境'&&!b.disabled)`);
    await queue('python', pythonPath); await openPythonPicker({ js, wait }); await button('选择 Python 解释器');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('解释器配置：已配置')`);
    await button('重新检测环境');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('环境检测通过')&&[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='重新检测环境'&&!b.disabled)`, 60000);
    const runtime = await api<LocalRuntimeState>('local.runtime.get'); assert.equal(runtime.available, true); assert.ok(runtime.devices.some(d => d.id === 'cpu'));
    assert.equal(await js(`document.querySelector('.local-runtime-diagnostics').open`), false);
    for (const value of [runtime.onnxruntimeVersion, runtime.numpyVersion, runtime.opencvVersion].filter(Boolean)) assert.ok(await js(`document.querySelector('.local-runtime-diagnostics').textContent.includes(${json(value)})`));
    checks.push({ check: 'native-runtime-configure-and-probe', pythonVersion: runtime.pythonVersion, ultralyticsVersion: runtime.ultralyticsVersion, torchVersion: runtime.torchVersion, onnxruntimeVersion: runtime.onnxruntimeVersion, numpyVersion: runtime.numpyVersion, opencvVersion: runtime.opencvVersion, diagnosticsCollapsed: true });

    await gotoSettings({ js, wait }, '软件 AI 配置'); await button('本地模型'); await button('登记本地模型');
    await fill('[aria-label="本地模型名称"]', 'YOLO11 Pose 验收'); await select('[aria-label="本地模型任务类型"]', 'pose'); await queue('model', modelPath); await button('选择模型文件', dialog); await button('保存本地模型', dialog);
    await wait(`!document.querySelector('dialog[open]')&&!!document.querySelector('.local-model-detail h3')`);
    const registered = await api<{ items: LocalModel[]; total: number }>('local.model.list', { taskType: 'pose', limit: 50, offset: 0 }); assert.equal(registered.total, 1); const model = registered.items[0];
    await select('[aria-label="本地模型加载设备"]', 'cpu'); await button('加载模型并读取类别');
    await wait(`!!document.querySelector('.local-model-detail .local-load-result')`, 60000);
    assert.ok(await js(`document.querySelector('.local-load-result').innerText.includes('请求设备：cpu')`));
    const loadedRuntime = await api<LocalRuntimeState>('local.runtime.get'), loadedSlot = loadedRuntime.slots.find(s => s.device === 'cpu' && s.modelId === model.id && s.modelVersion === model.version); assert.ok(loadedSlot);
    const loadedBackend = loadedSlot.observedBackend;
    assert.ok(await js(`document.querySelector('.local-load-result').innerText.includes(${json(loadedBackend?.kind === 'pytorch' ? `PyTorch · ${loadedBackend.device}` : loadedBackend?.kind === 'onnxruntime' ? 'ONNX Runtime' : '引擎未报告')})`));
    const classes = await js<Array<{ id: string; name: string }>>(`[...document.querySelectorAll('.local-class-list>div')].map(e=>({id:e.querySelector('span').innerText,name:e.querySelector('strong').innerText}))`); assert.ok(classes.length > 0); assert.ok(classes.some(c => c.name === 'person'));
    await capture('-model.png', '.local-model-detail');
    checks.push({ check: 'native-model-register-load', modelId: model.id, actualVersion: model.version, requestedDevice: 'cpu', observedBackend: loadedBackend ?? null, classes });

    // ---- 本地推理：直接经 local.run.create 跑一次，再用同一输入复跑一次验证「输入结果复用」 ----
    // 旧路径经由流程编排页的「本地预标注」单步执行，该页已移除；本地推理本身仍在（local.run.create）。
    // 类别映射是必填项：引擎要求逐一列出模型全部类别（忽略也要显式写 null），不能替用户猜。
    const localParameters = { projectId: project.id, assetIds: [assetId], modelId: model.id, modelVersion: model.version, device: 'cpu', failurePolicy: 'continue' as const, classMap: { '0': 'person' } };
    const firstRun = await api<{ id: string }>('local.run.create', localParameters);
    await wait(`window.autoLabel.request('run.get',{runId:${json(firstRun.id)}}).then(r=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(r.status))`, 60000);
    const first = await api<any>('run.get', { runId: firstRun.id }); assert.equal(first.status, 'completed', json(first)); assert.equal(first.kind, 'local'); assert.equal(first.modelId, model.id); assert.equal(first.modelVersion, model.version); assert.equal(first.device, 'cpu'); assert.equal(first.statistics.requestsUsed, 0); assert.equal(first.statistics.reused, 0); assert.equal(first.statistics.succeeded, 1);
    for (const field of ['baselineTotal', 'baselineCompleted', 'inputTotal', 'inputCompleted']) assert.equal(first.statistics[field], 1, field);
    assert.equal(first.samples.length, 1); const firstSample = first.samples[0]; assert.ok(firstSample.inputId); assert.ok(firstSample.resultId);
    const firstResult = await api<any>('run.result.get', { resultId: firstSample.resultId }); assert.equal(firstResult.source, 'local'); assert.equal(firstResult.status, 'succeeded'); assert.ok(firstResult.annotations?.length); assert.equal(firstResult.requiresGeometryReview, false);
    for (const a of firstResult.annotations) { assert.equal(a.type, 'pose'); assert.equal(a.keypoints?.length, keypointNames.length); assert.equal(a.classId, 'person'); }
    checks.push({ check: 'native-pose-single-run', runId: first.id, inputId: firstSample.inputId, resultId: firstSample.resultId, objects: firstResult.annotations.length, keypointsPerObject: keypointNames.length, statistics: first.statistics });

    const secondRun = await api<{ id: string }>('local.run.create', localParameters);
    await wait(`window.autoLabel.request('run.get',{runId:${json(secondRun.id)}}).then(r=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(r.status))`, 60000);
    const second = await api<any>('run.get', { runId: secondRun.id }); assert.equal(second.status, 'completed', json(second)); assert.equal(second.statistics.requestsUsed, 0); assert.equal(second.statistics.succeeded, 1); assert.equal(second.statistics.reused, 1);
    const secondSample = second.samples[0], source = secondSample.inputReusedFrom; assert.equal(secondSample.reused, true); assert.ok(source);
    assert.equal(source.source, 'local'); assert.equal(source.sourceResultId, firstResult.id); assert.equal(source.sourceRunId, first.id); assert.equal(source.sourceInputId, firstResult.inputId); assert.equal(source.sourceModelVersion, model.version); assert.equal(source.sourceModelId, model.id);
    const secondResult = await api<any>('run.result.get', { resultId: secondSample.resultId }); assert.notEqual(secondResult.id, firstResult.id); assert.equal(secondResult.source, 'reuse'); assert.deepEqual(secondResult.provenance.reusedFrom, source);
    checks.push({ check: 'same-configuration-local-input-reuse', runId: second.id, resultId: secondResult.id, source, statistics: second.statistics });
    const after = await api('asset.get', { assetId }); assert.equal(after.version, original.version); assert.deepEqual(after.annotations, original.annotations); assert.equal(after.status, original.status); assert.equal(after.source, original.source);
    await writeFile(output, json({ passed: true, mode: 'local-pose-ui', projectId: project.id, newApiRequests: 0, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'local-pose-ui', checks, error: e instanceof Error ? e.message : String(e), body: await js('document.body.innerText') })); throw e; }
}
