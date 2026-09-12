import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { InputResult, LocalModel, LocalRuntimeState } from '../../shared/inference';

// 项目和人工版本仅作为隔离夹具；环境配置、模型加载及两轮推理均走真实桌面操作。
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
    await wait(`!!document.querySelector('.getting-started')&&!document.querySelector('.connection-banner')`);
    const name = `Pose 本地验收-${Date.now()}`;
    const project = await api('project.create', { name, taskType: 'pose', classes: [{ id: 'person', name: '行人', color: '#477b93' }] });
    await api('project.update', { projectId: project.id, settings: { keypointNames } });
    await new Promise<void>(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await wait(`!!document.querySelector('.project-row')&&document.body.innerText.includes(${json(name)})`);
    await js(`[...document.querySelectorAll('.project-row')].find(e=>e.innerText.includes(${json(name)})).click()`);
    await wait(`!!document.querySelector('.workbench')`); await queue('images', imagePath); await button('导入图片');
    await wait(`!!document.querySelector('.annotation-canvas image')`);
    const assets = await api('asset.list', { projectId: project.id, limit: 100 }); assert.equal(assets.total, 1);
    const assetId = assets.items[0].id;
    await api('annotation.save', { assetId, baseVersion: 0, confirm: false, annotations: [{ id: 'protected-manual-pose', type: 'pose', classId: 'person', bbox: { x: 10, y: 10, width: 40, height: 80 }, keypoints: keypointNames.map(name => ({ name, x: 0, y: 0, visibility: 0 })) }] });
    const original = await api('asset.get', { assetId });

    await click('.nav-item:nth-child(7)'); await button('本地推理');
    await wait(`!!document.querySelector('.local-runtime-settings')&&[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='重新检测环境'&&!b.disabled)`);
    await queue('python', pythonPath); await button('选择 Python 解释器');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('解释器配置：已配置')`);
    await button('重新检测环境');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('环境检测通过')&&[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='重新检测环境'&&!b.disabled)`, 60000);
    const runtime = await api<LocalRuntimeState>('local.runtime.get'); assert.equal(runtime.available, true); assert.ok(runtime.devices.some(d => d.id === 'cpu'));
    assert.equal(await js(`document.querySelector('.local-runtime-diagnostics').open`), false);
    for (const value of [runtime.onnxruntimeVersion, runtime.numpyVersion, runtime.opencvVersion].filter(Boolean)) assert.ok(await js(`document.querySelector('.local-runtime-diagnostics').textContent.includes(${json(value)})`));
    checks.push({ check: 'native-runtime-configure-and-probe', pythonVersion: runtime.pythonVersion, ultralyticsVersion: runtime.ultralyticsVersion, torchVersion: runtime.torchVersion, onnxruntimeVersion: runtime.onnxruntimeVersion, numpyVersion: runtime.numpyVersion, opencvVersion: runtime.opencvVersion, diagnosticsCollapsed: true });

    await click('.nav-item:nth-child(6)'); await button('本地模型'); await button('登记本地模型');
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

    await click('.nav-item:nth-child(3)'); await wait(`document.querySelectorAll('.flow-node').length===4`);
    for (const label of ['导入素材', 'API 标注', '检查与复核', '数据集导出']) { await node(label); await click('[aria-label="移除步骤"]'); }
    await button('添加步骤'); await wait(`!!${dialog}`); await js(`[...${dialog}.querySelectorAll('button')].find(b=>b.innerText.includes('本地预标注')).click()`);
    await wait(`!!document.querySelector('.local-step-parameters')`); assert.equal(await js(`document.querySelector('[aria-label="启用当前步骤"]').checked`), true);
    await select('[aria-label="步骤本地模型"]', model.id); await select('[aria-label="步骤本地设备"]', 'cpu'); await button('加载模型并配置类别');
    await wait(`!!document.querySelector('.local-class-mapping select')`, 60000);
    for (const c of classes) await select(`[aria-label="本地类别 ${c.id} 映射"]`, c.name === 'person' ? json('person') : 'null');
    await wait(`document.querySelector('.local-step-parameters')?.innerText.includes('尚有 0 类待处理')`);
    await click('.local-step-parameters .reuse-policy>summary'); assert.equal(await js(`document.querySelector('[aria-label="允许复用已有输入结果"]').checked`), true); assert.equal(await js(`document.querySelector('[aria-label="强制重新执行本地模型"]').checked`), false);
    await select('[aria-label="流程执行方式"]', 'single'); await fill('[aria-label="流程名称"]', name); await button('保存流程');
    await wait(`!document.querySelector('.page-heading').innerText.includes('放弃流程修改')`); await button('预检当前流程'); await wait(`!!document.querySelector('.flow-preflight')`);
    assert.ok(await js(`document.querySelector('.flow-preflight').innerText.includes('预检通过')`), await js('document.body.innerText')); await button('执行当前单步');
    await wait(`!!document.querySelector('.flow-run-detail h3')`); const first = await completed((await api('flow.list', { projectId: project.id })).items[0].id), firstStep = first.steps.find((s: any) => s.kind === 'local');
    const firstChild = await api('run.get', { runId: firstStep.childRunId });
    assert.equal(firstChild.kind, 'local'); assert.equal(firstChild.modelId, model.id); assert.equal(firstChild.modelVersion, model.version); assert.equal(firstChild.device, 'cpu'); assert.equal(firstChild.statistics.requestsUsed, 0); assert.equal(firstChild.statistics.reused, 0);
    for (const field of ['baselineTotal', 'baselineCompleted', 'inputTotal', 'inputCompleted']) assert.equal(firstChild.statistics[field], 1, field);
    assert.equal(firstChild.samples.length, 1); const firstSample = firstChild.samples[0]; assert.ok(firstSample.inputId); assert.ok(firstSample.resultId);
    const firstResult = await api<InputResult>('run.result.get', { resultId: firstSample.resultId }); assert.equal(firstResult.source, 'local'); assert.equal(firstResult.status, 'succeeded'); assert.ok(firstResult.annotations?.length); assert.equal(firstResult.requiresGeometryReview, false);
    for (const a of firstResult.annotations!) { assert.equal(a.type, 'pose'); assert.equal(a.keypoints?.length, keypointNames.length); assert.equal(a.classId, 'person'); }
    checks.push({ check: 'native-pose-single-step', flowRunId: first.id, childRunId: firstChild.id, inputId: firstSample.inputId, resultId: firstSample.resultId, objects: firstResult.annotations!.length, keypointsPerObject: keypointNames.length, statistics: firstChild.statistics });

    await button('查看固定产物'); await wait(`!!document.querySelector('.flow-artifact-view .artifact-input-action')`); await button('查看输入与结果', "document.querySelector('.flow-artifact-view')");
    await wait(`document.querySelector('.actual-input-preview img')?.complete&&document.querySelector('.actual-input-preview img')?.naturalWidth>0&&document.querySelectorAll('.actual-input-preview svg circle').length>0`);
    const image = await js<{ src: string; width: number; height: number; circles: number }>(`(()=>{const e=document.querySelector('.actual-input-preview img');return {src:e.src,width:e.naturalWidth,height:e.naturalHeight,circles:document.querySelectorAll('.actual-input-preview svg circle').length}})()`);
    assert.equal(image.src, `autolabel-media://input/${encodeURIComponent(firstResult.inputId)}`); assert.equal(image.width, original.width); assert.equal(image.height, original.height);
    assert.equal(image.circles, firstResult.annotations!.flatMap(a => a.keypoints ?? []).filter(p => p.visibility > 0).length); await capture('-pose-result.png', '.model-input-result'); await click('dialog[open] [aria-label="关闭弹窗"]');
    checks.push({ check: 'actual-input-and-validated-pose-overlay', ...image });

    await button('从指定步骤重跑'); await wait(`!!${dialog}.querySelector('.rerun-reuse-policy')`); await button('创建重跑修订', dialog);
    await wait(`!document.querySelector('dialog[open]')&&document.querySelector('.flow-run-detail h3')?.innerText.includes('修订 2')`);
    const second = await completed((await api('flow.list', { projectId: project.id })).items[0].id), secondStep = second.steps.find((s: any) => s.kind === 'local'), secondChild = await api('run.get', { runId: secondStep.childRunId });
    assert.equal(second.sourceFlowRunId, first.id); assert.equal(second.statistics.requestsUsed, 0); assert.equal(secondChild.statistics.succeeded, 1); assert.equal(secondChild.statistics.reused, 1); assert.equal(secondChild.statistics.requestsUsed, 0);
    const secondSample = secondChild.samples[0], source = secondSample.inputReusedFrom; assert.equal(secondSample.reused, true); assert.equal(source.source, 'local'); assert.equal(source.sourceResultId, firstResult.id); assert.equal(source.sourceRunId, firstChild.id); assert.equal(source.sourceInputId, firstResult.inputId); assert.equal(source.sourceModelVersion, model.version); assert.equal(source.sourceModelId, model.id); assert.equal(source.sourceObservedBackend.kind, 'pytorch'); assert.equal(source.sourceObservedBackend.device, 'cpu'); assert.equal(source.sourceAttemptId, undefined);
    const secondResult = await api<InputResult>('run.result.get', { resultId: secondSample.resultId }); assert.notEqual(secondResult.id, firstResult.id); assert.equal(secondResult.source, 'reuse'); assert.deepEqual(secondResult.provenance.reusedFrom, source);
    await button('查看固定产物'); await wait(`!!document.querySelector('.flow-artifact-view .input-reuse-source')`); await click('.flow-artifact-view .input-reuse-source>summary'); await button('打开来源任务');
    await wait(`!!document.querySelector('.reuse-source-run')`); assert.ok(await js(`document.querySelector('.reuse-source-run').textContent.includes(${json(firstChild.id)})&&document.querySelector('.reuse-source-run').textContent.includes(${json(firstResult.id)})&&document.querySelector('.reuse-source-run').innerText.includes('模型固定版本 ${model.version}')`)); await button('关闭来源任务');
    await capture('-reuse-source.png', '.flow-artifact-view');
    await click('.nav-item:nth-child(4)'); await button('标注任务'); await click('.run-list .run-row'); await wait(`document.querySelector('.sample-table')?.innerText.includes('输入结果复用（0 次 API 请求）')`); await click('.sample-table .input-reuse-source>summary'); await wait(`document.querySelector('.sample-table .input-reuse-source dd')?.innerText.length>0`); await capture('-task-reuse.png', '.sample-table');
    const after = await api('asset.get', { assetId }); assert.equal(after.version, original.version); assert.deepEqual(after.annotations, original.annotations); assert.equal(after.status, original.status); assert.equal(after.source, original.source);
    checks.push({ check: 'same-configuration-local-input-reuse', flowRunId: second.id, childRunId: secondChild.id, resultId: secondResult.id, source, statistics: secondChild.statistics, protectedManualVersionUnchanged: true });
    await writeFile(output, json({ passed: true, mode: 'local-pose-ui', projectId: project.id, newApiRequests: firstChild.statistics.requestsUsed + secondChild.statistics.requestsUsed, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'local-pose-ui', checks, error: e instanceof Error ? e.message : String(e), body: await js('document.body.innerText') })); throw e; }
}
