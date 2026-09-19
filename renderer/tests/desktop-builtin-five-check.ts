import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { LocalModel, LocalRuntimeState } from '../../shared/inference';
import type { ModelLibraryState } from '../../shared/model-library';
import { gotoSettings, openPythonPicker } from './desktop-navigation';

/** 任务类型 → 内置模型目录标识。五个内置模型覆盖五类任务，全部随安装包提供，不需要下载。 */
const TASKS: Array<{ task: 'detect' | 'pose' | 'obb' | 'segment' | 'classify'; catalogId: string; name: string; expectObjects: boolean }> = [
  // bus.jpg 里有人和公交车：检测与关键点必然有目标；分类必然给一个结论；
  // 旋转框（DOTA 类别）与分割（COCO 类别）在这张图上可能一个都框不到——那不算失败，如实记录 0。
  { task: 'detect', catalogId: 'yolo11n', name: 'YOLO11n 通用检测', expectObjects: true },
  { task: 'pose', catalogId: 'yolo11n-pose', name: 'YOLO11n 关键点', expectObjects: true },
  { task: 'obb', catalogId: 'yolo11n-obb', name: 'YOLO11n 旋转框', expectObjects: false },
  { task: 'segment', catalogId: 'yolo11n-seg', name: 'YOLO11n 实例分割', expectObjects: false },
  { task: 'classify', catalogId: 'yolo11n-cls', name: 'YOLO11n 图像分类', expectObjects: true },
];

/**
 * 五类任务的内置模型路径验收。
 *
 * 已有 `check:five-ui` 覆盖「云端方案 + 人工真值 + 指标」；这一条只问一件事：
 * **每一个内置模型在自己那一类任务上，都能一键启用、载入、跑出候选**，全程本机、零接口。
 *
 * 类别映射按载入后读到的真实类别表生成：第一个类别映射到项目类别，其余显式忽略——
 * 引擎要求「每个模型类别都要有交代」，忽略也必须写出来，不能靠缺键糊过去。
 */
export async function checkDesktopBuiltinFive(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [], json = JSON.stringify;
  const userData = process.env.AUTOLABEL_TEST_USER_DATA;
  assert.ok(userData, '五类内置模型验收必须指定隔离数据目录');
  const basePython = process.env.AUTOLABEL_TEST_PYTHON ?? 'C:/Users/zhy23/AppData/Local/Programs/Python/Python311/python.exe';
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = <T = any>(command: string, payload: unknown = {}): Promise<T> => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  async function wait(expression: string, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  const button = async (label: string) => {
    await wait(`[...document.querySelectorAll('button')].some(node=>node.innerText.trim()===${json(label)}&&!node.disabled)`);
    await js(`([...document.querySelectorAll('button')].find(node=>node.innerText.trim()===${json(label)}&&!node.disabled)).click()`);
  };
  try {
    assert.ok(await stat(basePython).then(() => true).catch(() => false), `本机缺少可用的 Python：${basePython}`);
    window.setContentSize(1440, 940); window.show();
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    const fixtures = path.join(userData!, 'fixtures'), environment = path.join(fixtures, 'python-env'), pythonPath = path.join(environment, 'Scripts', 'python.exe');
    await mkdir(fixtures, { recursive: true });
    await promisify(execFile)(basePython, ['-m', 'venv', '--system-site-packages', '--without-pip', environment], { windowsHide: true });
    await writeFile(path.join(userData!, 'dialog-fixtures.json'), json([{ kind: 'python', paths: [pythonPath] }]));
    await gotoSettings({ js, wait }, '本地推理');
    await openPythonPicker({ js, wait });
    await button('选择 Python 解释器');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('解释器配置：已配置')`);
    await button('重新检测环境');
    await wait(`document.querySelector('.local-runtime-summary')?.innerText.includes('环境检测通过')`, 120000);
    assert.equal((await api<LocalRuntimeState>('local.runtime.get')).available, true, '本机环境未检测通过');

    const picture = path.join(fixtures, 'builtin-five.jpg');
    await copyFile(path.resolve('.qa/models/bus.jpg'), picture);
    for (const entry of TASKS) {
      const name = `内置五类 ${entry.task}-${Date.now()}`;
      const project = await api<{ id: string }>('project.create', { name, taskType: entry.task, classes: [{ id: 'target', name: '目标', color: '#477b93' }] });
      // 关键点模板必须与模型的 17 个 COCO 点位一一对应，否则引擎会以 keypoint_template_mismatch 拒绝。
      if (entry.task === 'pose') await api('project.update', { projectId: project.id, settings: { keypointNames: [
        'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
        'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'] } });
      // 素材必须经界面导入（路径只能来自用户选择），因此每次导入前写一份对话框夹具。
      await writeFile(path.join(userData!, 'dialog-fixtures.json'), json([{ kind: 'images', paths: [picture] }]));
      const chosen = await js<string[]>(`window.autoLabel.chooseFiles({kind:'images'})`);
      const imported = await api<{ assetIds: string[] }>('asset.import', { projectId: project.id, paths: chosen });
      const assetId = imported.assetIds[0];

      // 一键启用该任务对应的内置模型（全部随安装包提供，不该触发下载）。
      const library = await api<ModelLibraryState>('model.library.status');
      const target = library.entries.find(item => item.id === entry.catalogId)!;
      assert.ok(target, `模型库里没有 ${entry.catalogId}`);
      assert.equal(target.state, 'ready', `${entry.name} 应随安装包提供，实际 ${target.state}：${target.message ?? ''}`);
      const installed = await api<{ enabled: LocalModel | null }>('model.library.install', { catalogId: entry.catalogId });
      const model = installed.enabled ?? (await api<{ items: LocalModel[] }>('local.model.list', { offset: 0, limit: 500 })).items.find(item => item.catalogId === entry.catalogId)!;
      assert.ok(model, `${entry.catalogId} 启用后应能在本地模型里找到`);
      assert.equal(model.taskType, entry.task, `${entry.catalogId} 的任务类型应为 ${entry.task}`);

      // 载入并读出真实类别表，再按它生成「第一个映射、其余显式忽略」的完整映射。
      const loaded = await api<{ classes: Array<{ id: string; name: string }> }>('local.model.load', { modelId: model.id, modelVersion: model.version, device: 'cpu', timeoutMs: 300000 });
      assert.ok(loaded.classes.length >= 1, `${entry.catalogId} 应读出类别`);
      // 类别映射按载入后读到的真实类别表生成：检测类任务把第一个类别映射到项目类别、其余显式忽略
      // （引擎要求每个模型类别都有交代）；分类任务不同——它只输出一个结论，
      // 把没有映射到项目类别的 top-1 忽略掉会被判成 classification_excluded，所以整表都映射到同一个项目类别。
      const classMap = entry.task === 'classify'
        ? Object.fromEntries(loaded.classes.map(item => [item.id, 'target']))
        : Object.fromEntries(loaded.classes.map((item, index) => [item.id, index === 0 ? 'target' : null]));
      const run = await api<{ id: string; status: string; kind: string; statistics: Record<string, number>; samples: Array<{ resultId: string; status: string; errorCode?: string }> }>('local.run.create',
        { projectId: project.id, assetIds: [assetId], modelId: model.id, modelVersion: model.version, device: 'cpu', classMap, timeoutMs: 300000, forceRerun: true });
      await wait(`window.autoLabel.request('run.get',{runId:${json(run.id)}}).then(item=>['completed','completed_with_errors','failed','needs_attention','cancelled'].includes(item.status))`, 300000);
      const finished = await api<{ status: string; statistics: Record<string, number>; samples: Array<{ resultId: string; status: string; errorCode?: string; message?: string }> }>('run.get', { runId: run.id });
      // 终态即可：几何需要人工复核（needs_attention）是合法结果，不是失败；只有 failed / unknown 才算没跑通。
      assert.ok(['completed', 'completed_with_errors'].includes(finished.status), `${entry.task} 本机推理未跑通：${finished.status} ${json(finished.samples)}`);
      assert.equal(finished.statistics.requestsUsed, 0, '本机推理不得产生 API 请求');
      const sample = finished.samples[0];
      assert.ok(['succeeded', 'needs_attention'].includes(sample.status), `${entry.task} 样本状态异常：${json(sample)}`);
      const result = await api<{ source: string; status: string; annotations: Array<{ type: string }> }>('run.result.get', { resultId: sample.resultId });
      assert.equal(result.source, 'local', '结果来源应为本机');
      assert.ok(['succeeded', 'needs_attention'].includes(result.status), `${entry.task} 结果状态异常：${result.status}`);
      assert.ok(result.annotations.length >= (entry.expectObjects ? 1 : 0), `${entry.task} 应至少产出一个候选标注`);
      if (entry.task === 'classify') assert.equal(result.annotations.length, 1, '分类结果必须且只能有一个');
      const asset = await api<{ status: string }>('asset.get', { assetId });
      assert.equal(asset.status, 'candidate', `${entry.task} 的候选应写入素材`);
      checks.push({ task: entry.task, catalogId: entry.catalogId, modelId: model.id, classes: loaded.classes.length,
        expectObjects: entry.expectObjects, annotations: result.annotations.length, resultStatus: result.status,
        annotationTypes: [...new Set(result.annotations.map(item => item.type))], assetStatus: asset.status });
    }
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: true, mode: 'builtin-five-ui', newApiRequests: 0 }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, mode: 'builtin-five-ui', error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
