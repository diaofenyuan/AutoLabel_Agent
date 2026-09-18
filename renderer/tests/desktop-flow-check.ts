import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkDesktopFlow(window: BrowserWindow, output: string): Promise<void> {
  const checks: unknown[] = [], json = JSON.stringify;
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = (command: string, payload: unknown = {}) => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!, fixtures = path.join(userData, 'fixtures'); await mkdir(fixtures, { recursive: true });
  const dialog = "document.querySelector('dialog[open]')";
  async function wait(expression: string) { const end = Date.now() + 18000; while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 60)); } throw new Error(`流程等待超时：${expression}`); }
  async function button(label: string, scope = 'document') { await wait(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}).click()`); }
  async function click(selector: string) { await wait(`!!document.querySelector(${json(selector)})&&!document.querySelector(${json(selector)}).disabled`); await js(`document.querySelector(${json(selector)}).click()`); }
  async function fill(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async function select(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async function node(label: string) { await js(`[...document.querySelectorAll('.flow-node')].find(b=>b.innerText.includes(${json(label)})).click()`); await wait(`document.querySelector('.flow-inspector h2')?.innerText.includes(${json(label)})`); }
  async function capture(suffix: string, selector: string) { await js(`document.activeElement?.blur();document.querySelector(${json(selector)}).scrollIntoView({block:'center',behavior:'instant'})`); await new Promise(r => setTimeout(r, 350)); await writeFile(output.replace(/\.json$/, suffix), (await window.webContents.capturePage()).toPNG()); }
  async function queue(kind: string, file: string) { await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind, paths: [file] }])); }
  window.setContentSize(1440, 940); window.show();
  try {
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.skeleton-list')&&!document.querySelector('.connection-banner')`);
    await button('打开示例'); await wait(`!!document.querySelector('.annotation-canvas image')`);
    const assetId = await js<string>(`new URL(document.querySelector('.annotation-canvas image').getAttribute('href')).pathname.slice(1)`), asset = await api('asset.get', { assetId });
    await click('.nav-item:nth-child(3)'); await wait(`!!document.querySelector('[aria-label="流程输入范围"]')`);
    if (process.env.AUTOLABEL_FLOW_PREVIEW_ONLY === '1') {
      await wait(`document.body.innerText.includes('当前引擎不支持流程执行')`);
      assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='运行完整流程').disabled`), true);
      const layout = await js(`(()=>{const stage=document.querySelector('.flow-stage').getBoundingClientRect();return {width:innerWidth,height:innerHeight,toolbarHeight:document.querySelector('.flow-input-panel').getBoundingClientRect().height,visibleNodes:[...document.querySelectorAll('.flow-node')].filter(n=>{const r=n.getBoundingClientRect();return r.top>=stage.top&&r.bottom<=Math.min(stage.bottom,innerHeight)}).length,optionsCollapsed:!document.querySelector('.flow-run-options').open,diagnosticsCollapsed:!document.querySelector('.flow-capability-notice details').open}})()`);
      assert.equal(layout.visibleNodes, 4); assert.ok(layout.toolbarHeight < 125); assert.equal(layout.optionsCollapsed, true); assert.equal(layout.diagnosticsCollapsed, true);
      await capture('-editor.png', '.flow-input-panel');
      await writeFile(output, json({ passed: true, mode: 'flow-preview', availableEngine: false, executionBlocked: true, layout, newModelCalls: 0 })); return;
    }
    if (process.env.AUTOLABEL_TRANSFORM_PLAN_ONLY === '1') {
      await button('添加步骤'); await wait(`!!${dialog}`); await js(`[...${dialog}.querySelectorAll('button')].find(b=>b.innerText.includes('图像处理')).click()`);
      await wait(`!!document.querySelector('.transform-editor')`);
      assert.equal(await js(`document.querySelector('[aria-label="启用当前步骤"]').disabled`), true); assert.equal(await js(`document.querySelector('[aria-label="启用当前步骤"]').checked`), false);
      await select('[aria-label="新增图像操作"]', 'crop'); await button('添加操作'); await fill('[aria-label="操作 1 x"]', '10'); await fill('[aria-label="操作 1 y"]', '20');
      await fill('[aria-label="操作 1 width"]', '20001'); await wait(`document.querySelector('.transform-parameter-issues')?.innerText.includes('20000')`); await fill('[aria-label="操作 1 width"]', '20000'); await fill('[aria-label="操作 1 height"]', '3000'); await wait(`document.querySelector('.transform-parameter-issues')?.innerText.includes('4000 万')`); await fill('[aria-label="操作 1 width"]', '640'); await fill('[aria-label="操作 1 height"]', '640');
      await select('[aria-label="新增图像操作"]', 'resize'); await button('添加操作'); await select('[aria-label="操作 2 fit"]', 'stretch');
      await select('[aria-label="新增图像操作"]', 'tile'); await button('添加操作'); await fill('[aria-label="操作 3 width"]', '320'); await fill('[aria-label="操作 3 height"]', '320'); await fill('[aria-label="操作 3 overlapX"]', '320'); await wait(`document.querySelector('.transform-parameter-issues')?.innerText.includes('重叠量')`); await fill('[aria-label="操作 3 overlapX"]', '32');
      assert.equal(await js(`document.querySelector('[aria-label="新增图像操作"] option[value="tile"]').disabled`), true);
      await click('[aria-label="操作 3 上移"]'); await wait(`document.querySelectorAll('.transform-operation-toggle')[1].innerText.includes('切片')`); await click('[aria-label="移除操作 2"]');
      assert.equal(await js(`document.querySelector('[aria-label="新增图像操作"] option[value="tile"]').disabled`), false); await select('[aria-label="新增图像操作"]', 'tile'); await button('添加操作'); await fill('[aria-label="操作 3 width"]', '320'); await fill('[aria-label="操作 3 height"]', '320'); await fill('[aria-label="操作 3 overlapX"]', '32');
      await click('.transform-background>summary'); await fill('[aria-label="图像处理背景色"]', '#ffffff'); await button('保存流程'); await wait(`!document.querySelector('.page-heading').innerText.includes('放弃流程修改')`);
      const savedProject = await api('project.open', { projectId: asset.projectId }), transform = savedProject.settings.flow.steps.find((s: any) => s.kind === 'transform');
      assert.equal(transform.enabled, false); assert.deepEqual(transform.parameters.operations.map((op: any) => op.kind), ['crop', 'resize', 'tile']); assert.equal(transform.parameters.operations[1].fit, 'stretch'); assert.equal(transform.parameters.operations[2].overlapX, 32); assert.equal(transform.parameters.background, '#ffffff');
      assert.equal((await api('flow.list', { projectId: asset.projectId })).total, 0); await js(`document.querySelector('.transform-background').open=false;document.querySelector('.flow-inspector').scrollTop=0`); await capture('-editor.png', '.flow-inspector');
      await writeFile(output, json({ passed: true, mode: 'transform-plan-ui', newModelCalls: 0, planSavedDisabled: true, operationOrder: transform.parameters.operations.map((op: any) => op.kind), sizeAndOverlapWarnings: true, oneTileGuard: true, executionUnavailable: true })); return;
    }
    if (process.env.AUTOLABEL_LOCAL_PREVIEW_ONLY === '1') {
      await button('添加步骤'); await wait(`!!${dialog}`); await js(`[...${dialog}.querySelectorAll('button')].find(b=>b.innerText.includes('本地预标注')).click()`); await wait(`!!document.querySelector('.local-step-parameters .local-error')`);
      assert.equal(await js(`document.querySelector('[aria-label="启用当前步骤"]').disabled`), true); assert.equal(await js(`document.querySelector('[aria-label="启用当前步骤"]').checked`), false); assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='加载模型并配置类别').disabled`), true);
      await button('保存流程'); await wait(`!document.querySelector('.page-heading').innerText.includes('放弃流程修改')`); const plan = (await api('project.open', { projectId: asset.projectId })).settings.flow.steps.find((s: any) => s.kind === 'local'); assert.equal(plan.enabled, false); assert.deepEqual(plan.parameters.classMap, {});
      await click('.nav-item:nth-child(6)'); await button('本地模型'); await wait(`!!document.querySelector('.local-models .local-error')`); assert.ok(await js(`document.querySelector('.local-models').innerText.includes('本地环境尚未确认可用')`)); await capture('-models.png', '.local-models');
      await click('.nav-item:nth-child(7)'); await button('本地推理'); await wait(`!!document.querySelector('.local-runtime-settings .local-error')`); assert.ok(await js(`document.querySelector('.local-runtime-summary').innerText.includes('环境状态未确认')`)); await capture('-environment.png', '.local-runtime-settings');
      await writeFile(output, json({ passed: true, mode: 'local-preview-ui', newModelCalls: 0, localPlanSavedDisabled: true, runtimeNotFaked: true, loadBlockedWithoutRuntime: true })); return;
    }
    await button('预检当前流程'); await wait(`!!document.querySelector('.flow-preflight')`);
    assert.ok((await js<string>(`document.querySelector('.flow-preflight').innerText`)).includes('预检尚未通过'));
    assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='运行完整流程').disabled`), true);
    const missingIssues = await js<number>(`document.querySelectorAll('.flow-issue.error').length`); assert.ok(missingIssues >= 2);
    checks.push({ check: 'native-preflight-missing-configuration', errors: missingIssues, noRunCreated: (await api('flow.list', { projectId: asset.projectId })).total === 0 });

    // 通过真实节点编辑建立人工素材筛选、等待复核和固定版本导出，不伪造流程返回值。
    await node('导入素材'); await click('[aria-label="移除步骤"]'); await node('API 标注'); await click('[aria-label="移除步骤"]');
    await button('添加步骤'); await wait(`!!${dialog}`);
    await js(`[...${dialog}.querySelectorAll('button')].find(b=>b.innerText.includes('素材筛选')).click()`);
    await wait(`!document.querySelector('dialog[open]')&&document.querySelector('.flow-inspector h2')?.innerText.includes('素材筛选')`);
    await click('[aria-label="步骤上移"]'); await wait(`document.querySelectorAll('.flow-node')[1].innerText.includes('素材筛选')`); await click('[aria-label="步骤上移"]'); await wait(`document.querySelector('.flow-node').innerText.includes('素材筛选')`);
    await fill('[aria-label="minWidth"]', '1'); const flowName = `人工复核导出-${Date.now()}`; await fill('[aria-label="流程名称"]', flowName);
    await node('数据集导出'); const exportDir = path.join(fixtures, 'flow-exports'); await mkdir(exportDir); await queue('directory', exportDir); await button('选择流程导出目录'); await wait(`document.querySelector('[aria-label="流程导出目录"]').value===${json(exportDir)}`);
    await button('保存流程'); await wait(`!document.querySelector('.page-heading').innerText.includes('放弃流程修改')`);
    await button('预检当前流程'); await wait(`document.querySelector('.flow-preflight')?.innerText.includes('预检通过')`); await capture('-preflight.png', '.flow-input-panel');
    await button('运行完整流程'); await wait(`!!document.querySelector('.flow-run-detail')&&document.body.innerText.includes('人工检查完毕，继续流程')`);
    let run = (await api('flow.list', { projectId: asset.projectId })).items.find((r: any) => r.name === flowName); assert.ok(run);
    run = await api('flow.get', { flowRunId: run.id }); const sourceId = run.id, reviewStep = run.steps.find((s: any) => s.kind === 'review'), filterStep = run.steps.find((s: any) => s.kind === 'filter');
    assert.equal(run.status, 'needs_attention'); assert.equal((await api('asset.get', { assetId })).version, asset.version);
    await capture('-review-wait.png', '.flow-review-wait');
    await button('人工检查完毕，继续流程'); await wait(`window.autoLabel.request('flow.get',{flowRunId:${json(sourceId)}}).then(r=>r.status==='completed')`);
    assert.equal((await api('asset.get', { assetId })).status, asset.status);
    run = await api('flow.get', { flowRunId: sourceId }); const outputArtifact = await api('flow.artifact', { artifactId: run.steps.find((s: any) => s.kind === 'export').outputArtifactId });
    assert.ok(outputArtifact.exportId); const record = (await api('export.list', { projectId: asset.projectId })).find((r: any) => r.id === outputArtifact.exportId); assert.ok(record); assert.equal(record.assetCount, 1);
    const manifest = JSON.parse(await readFile(path.join(record.path, 'manifest.json'), 'utf8')); assert.equal(manifest.assets.length, 1);
    checks.push({ check: 'filter-review-export', fixedInput: 1, pausedForHuman: true, releaseDidNotConfirmLabels: true, actualExport: record.id });

    await button('从指定步骤重跑'); await select('[aria-label="重跑起点"]', reviewStep.stepId); await wait(`${dialog}.innerText.includes('旧运行保持不变')`); await button('创建重跑修订', dialog);
    await wait(`!document.querySelector('dialog[open]')&&document.querySelector('.flow-run-detail')?.innerText.includes('人工检查完毕，继续流程')`);
    const newer = (await api('flow.list', { projectId: asset.projectId })).items.find((r: any) => r.sourceFlowRunId === sourceId); assert.ok(newer);
    const newRun = await api('flow.get', { flowRunId: newer.id }); assert.equal(newRun.steps.find((s: any) => s.kind === 'filter').outputArtifactId, filterStep.outputArtifactId);
    assert.equal((await api('flow.get', { flowRunId: sourceId })).status, 'completed'); await button('人工检查完毕，继续流程');
    await wait(`window.autoLabel.request('flow.get',{flowRunId:${json(newer.id)}}).then(r=>r.status==='completed')`);
    checks.push({ check: 'rerun-downstream', upstreamArtifactReused: true, sourceSnapshotPreserved: true, explicitHumanReleaseAgain: true });

    await button('编辑流程'); await node('检查与复核'); await select('[aria-label="流程执行方式"]', 'single'); await button('预检当前流程'); await wait(`document.querySelector('.workflow-page>.inline-error')?.innerText.includes('非首步单独执行')`);
    await select('[aria-label="流程输入范围"]', 'artifact'); await wait(`!!document.querySelector('.flow-artifact-picker select')&&!document.querySelector('.flow-artifact-picker select').disabled`); await select('.flow-artifact-picker select', sourceId);
    await wait(`!!document.querySelector('[aria-label="固定输入产物"]')&&!document.querySelector('[aria-label="固定输入产物"]').disabled`); await select('[aria-label="固定输入产物"]', filterStep.outputArtifactId);
    await button('预检当前流程'); await wait(`document.querySelector('.flow-preflight')?.innerText.includes('预检通过')`); await button('执行当前单步');
    await wait(`document.querySelector('.flow-run-detail')?.innerText.includes('人工检查完毕，继续流程')`); await button('人工检查完毕，继续流程');
    await click('.nav-item:nth-child(4)'); await wait(`!!document.querySelector('.task-kind-tabs')&&!!document.querySelector('.flow-run-list')`); assert.ok((await js<number>(`document.querySelectorAll('.flow-run-list>button').length`)) >= 3);
    checks.push({ check: 'single-step-and-task-entry', missingArtifactBlocked: true, explicitArtifactAccepted: true, flowTasksVisible: true });
    await writeFile(output, json({ passed: true, mode: 'flow-ui', newModelCalls: 0, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'flow-ui', checks, error: e instanceof Error ? e.message : String(e), body: await js(`document.body.innerText`) })); throw e; }
}
