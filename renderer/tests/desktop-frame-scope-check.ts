import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 视频帧与数据集版本的关系验收（D-1 决定维持硬规则）。
 *
 * 走查结论是：抽帧素材「导得出去、生成不了数据集版本」，而界面上这个差异没有任何说明——
 * 用户只有推进到「生成版本」才会看到 `assets: 0`，无法判断是自己操作错了还是规则如此。
 * 本次验收断言：
 * 1. 抽帧素材真正入库的那一刻就说清可用范围（能导出、不进数据集版本、以及原因）；
 * 2. 数据集版本预检把这一类排除渲染成中文原因，而不是 `form_video_frame 4`；
 * 3. 原因旁边给出真实出路「改用数据导出」，点击后落到导出面板。
 *
 * 夹具视频由 ffmpeg 生成在 `.qa/media-samples/vtest.avi`（768×576 / 10 fps / 795 帧），
 * 抽帧密度改成每 20 秒一帧，把帧数压到 4 张，让整条链路能在一次运行内跑完。
 */
export async function checkDesktopFrameScope(window: BrowserWindow, output: string): Promise<void> {
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '视频帧范围验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  const batch = `frames-${Date.now()}`;
  const fixtures = path.join(userData, 'fixtures', batch);
  await mkdir(fixtures, { recursive: true });
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  const dialogCss = 'dialog[open]';
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`等待界面超时：${expression}（当前弹窗文本：${await js<string>(`${dialog}?${dialog}.innerText.slice(0,500):'(无弹窗)'`)}）`);
  }
  async function button(text: string, scope = 'document') {
    await waitFor(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
    await js(`([...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)})).click()`);
  }
  async function select(selector: string, value: string) {
    await waitFor(`!!document.querySelector(${json(selector)})`);
    await js(`(()=>{const e=document.querySelector(${json(selector)});e.value=${json(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function fill(selector: string, value: string) {
    await waitFor(`!!document.querySelector(${json(selector)})`);
    await js(`(()=>{const e=document.querySelector(${json(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector(${json(selector)}).value===${json(value)}`);
  }
  try {
    window.show();
    await waitFor(`!!document.querySelector('.chat-suggestions')&&!document.querySelector('.connection-banner')`);
    const source = path.resolve('.qa/media-samples/vtest.avi');
    const video = path.join(fixtures, 'vtest.avi');
    await copyFile(source, video);
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'video', paths: [video] }]));

    // ===== 真实入口：欢迎页「选择视频抽帧」→ 面板里把密度调成每 20 秒一帧，控制帧数 =====
    await button('选择视频抽帧');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('768 × 576')`, 60000);
    await select('[aria-label="视频采样密度"]', 'custom');
    await select('[aria-label="视频采样方式"]', 'interval');
    await fill('[aria-label="视频采样值"]', '20');
    await new Promise(resolve => setTimeout(resolve, 600));
    await button('开始抽帧', dialog);
    const projects = await api<Array<{ id: string; name: string }>>('project.list');
    const project = projects.find(item => item.name === batch);
    assert.ok(project, `抽帧应建立名为 ${batch} 的项目，实际：${json(projects.map(item => item.name))}`);
    await waitFor(`window.autoLabel.request('media.job.list',{projectId:${json(project!.id)},limit:50}).then(r=>r.items.some(j=>j.status==='completed'&&j.stage==='ready'&&j.artifactCommitted&&!j.assetsCommitted))`, 120000);
    const job = (await api<{ items: Array<{ id: string; completedFrames?: number }> }>('media.job.list', { projectId: project!.id, limit: 50 })).items[0];
    checks.push({ check: 'frames-extracted', jobId: job.id, projectId: project!.id });

    // ===== 入库那一刻的告知：能导出、不进数据集版本、原因 =====
    await js(`[...document.querySelectorAll('.sidebar-bottom .nav-item')].find(b=>b.innerText.trim()==='任务').click()`);
    await waitFor(`!!document.querySelector('.task-kind-tabs')`);
    await button('素材任务');
    await waitFor(`!!document.querySelector('.media-job-list>button')`);
    await js(`[...document.querySelectorAll('.media-job-list>button')].find(b=>b.innerText.includes('vtest')).click()`);
    await waitFor(`!!document.querySelector('.media-job-detail')`);
    await button('将抽帧导入项目');
    await waitFor(`window.autoLabel.request('media.job.get',{jobId:${json(job.id)}}).then(j=>j.assetsCommitted)`, 120000);
    await waitFor(`document.querySelector('.media-job-detail')?.innerText.includes('不会进入「数据集版本」')`, 30000);
    const detailText = await js<string>(`document.querySelector('.media-job-detail').innerText`);
    assert.ok(detailText.includes('数据导出'), `入库告知应写明可以走导出，实际：${detailText.slice(0, 500)}`);
    assert.ok(detailText.includes('同一个视频抽出的所有帧属于同一个来源组'), `入库告知应给出原因，实际：${detailText.slice(0, 500)}`);
    const imported = await api<{ total: number }>('asset.list', { projectId: project!.id, limit: 100 });
    assert.ok(imported.total > 0, '抽帧素材应真的落库');
    checks.push({ check: 'import-states-usable-scope', assets: imported.total, noticeVisible: true });

    // ===== 数据集版本预检：中文原因 + 真实出路，不出现原始码 =====
    await js(`[...document.querySelectorAll('.sidebar-project')].find(g=>g.innerText.includes(${json(batch)})).querySelector('[title="项目概览"]').click()`);
    await waitFor(`!!document.querySelector('.page-overview')`);
    await button('数据集版本');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('数据集版本')`);
    await button('新建版本', dialog);
    // 未标注素材会被标注范围先挡掉；第三档把它放进来，才真正走到视频帧这条硬规则上。
    await select(`${dialogCss} select`, 'all');
    await button('检查数据源', dialog);
    await waitFor(`${dialog}.innerText.includes('遗漏范围')`, 40000);
    const preflightText = await js<string>(`${dialog}.innerText`);
    assert.ok(preflightText.includes('视频抽帧素材'), `预检应给出中文原因，实际：${preflightText.slice(0, 600)}`);
    assert.equal(/\bform_video_frame\b|annotation_scope_excluded/.test(preflightText), false, `预检泄漏了原始原因码：${preflightText.slice(0, 600)}`);
    assert.ok(preflightText.includes('同一个来源组'), '应说明来源组为什么不能拆');
    assert.ok(await js<boolean>(`[...${dialog}.querySelectorAll('button')].some(b=>b.innerText.trim()==='改用数据导出')`), '这一类原因应给出「改用数据导出」的出路');
    await button('改用数据导出', dialog);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('导出前检查')`, 40000);
    checks.push({ check: 'dataset-preflight-video-frame-reason', reasonReadable: true, rawCodesHidden: true, exportExitWorks: true });
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
