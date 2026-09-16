import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 目录导入验收。
 *
 * 走查结论是：能力早在引擎与授权层就绪（`asset.import` 接受 directory、引擎递归收集），界面却没有入口，
 * 用户导入一个含 10 张图的文件夹只能「进目录 → 全选 → 打开」。而引擎的目录扫描只收 jpg/jpeg/png，
 * 按拖入白名单放开会静默少收素材。本次验收断言：
 * 1. 欢迎页有「导入图片文件夹」与「选择视频文件夹」两个入口，且都走真实授权链路；
 * 2. 图片文件夹一次导入完成，文件夹里的 webp 与 txt 不会入库；
 * 3. 目录扫描把「有多少文件用不上」如实算出来（界面据此说明，不是猜）；
 * 4. 视频文件夹先列候选清单再逐个发起抽帧，不一次起一堆任务。
 *
 * 拖入白名单的收紧由 desktop/security.test.ts 的一致性断言守住：那里比较的是同一份常量与引擎正则，
 * 比在这里模拟拖放事件更直接，也不依赖合成指针事件的活性。
 *
 * 夹具取自 `.qa/media-samples/`（该目录被 gitignore）：sample-1.jpg / sample-2.jpg / sample.webp 与 vtest.avi
 * 由 ffmpeg 生成，生成命令见 desktop-frame-scope-check.ts 的说明。
 */
export async function checkDesktopDirectoryImport(window: BrowserWindow, output: string): Promise<void> {
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '目录导入验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  const batch = `folder-${Date.now()}`;
  const imageFolder = path.join(userData, 'fixtures', `${batch}-images`);
  const videoFolder = path.join(userData, 'fixtures', `${batch}-videos`);
  await mkdir(imageFolder, { recursive: true });
  await mkdir(videoFolder, { recursive: true });
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js<T>(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}（当前弹窗文本：${await js<string>(`${dialog}?${dialog}.innerText.slice(0,400):'(无弹窗)'`)}）`);
  }
  async function button(text: string, scope = 'document') {
    await waitFor(`[...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
    await js(`([...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)})).click()`);
  }
  try {
    window.show();
    await waitFor(`!!document.querySelector('.chat-suggestions')&&!document.querySelector('.connection-banner')`);
    // 文件夹里混入非支持格式：2 张真 JPEG + 1 个真 WEBP + 1 个文本文件。
    await copyFile(path.resolve('.qa/media-samples/sample-1.jpg'), path.join(imageFolder, 'a.jpg'));
    await copyFile(path.resolve('.qa/media-samples/sample-2.jpg'), path.join(imageFolder, 'b.jpg'));
    await copyFile(path.resolve('.qa/media-samples/sample.webp'), path.join(imageFolder, 'c.webp'));
    await writeFile(path.join(imageFolder, 'README.txt'), '不是图片');
    await copyFile(path.resolve('.qa/media-samples/vtest.avi'), path.join(videoFolder, 'clip-1.avi'));
    await copyFile(path.resolve('.qa/media-samples/vtest.avi'), path.join(videoFolder, 'clip-2.avi'));

    // 入口必须在欢迎页可见：能力早就有了，缺的一直是入口。
    const suggestions = await js<string[]>(`[...document.querySelectorAll('.chat-suggestions button')].map(b=>b.innerText.trim())`);
    for (const label of ['导入图片文件夹', '选择视频文件夹']) assert.ok(suggestions.some(text => text.includes(label)), `欢迎页缺少「${label}」入口，实际：${json(suggestions)}`);

    // ===== 图片文件夹：一次导入完成，非支持格式不入库 =====
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'directory', paths: [imageFolder] }]));
    await button('导入图片文件夹');
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    const projectName = path.basename(imageFolder);
    const created = (await api<Array<{ id: string; name: string }>>('project.list')).find(item => item.name === projectName);
    assert.ok(created, `按文件夹名应建立项目「${projectName}」，实际：${json((await api<Array<{ name: string }>>('project.list')).map(item => item.name))}`);
    const listed = await api<{ items: Array<{ name: string }>; total: number }>('asset.list', { projectId: created!.id, limit: 100 });
    assert.equal(listed.total, 2, `只应导入 2 张支持的图片，实际 ${listed.total} 张：${json(listed.items.map(item => item.name))}`);
    assert.deepEqual(listed.items.map(item => item.name).sort(), ['a.jpg', 'b.jpg'], 'webp 与 txt 不应入库');

    // ===== 目录扫描必须如实报出用不上的文件数 =====
    const scan = await js<{ files: string[]; unsupported: number; truncated: boolean }>(
      `window.autoLabel.listDirectory({ path: ${json(imageFolder)}, kind: 'images' })`);
    assert.equal(scan.files.length, 2, `扫描应找到 2 张支持的图片，实际：${json(scan.files)}`);
    assert.equal(scan.unsupported, 2, `扫描应报出 2 个用不上的文件（webp + txt），实际 ${scan.unsupported}`);
    assert.equal(scan.truncated, false);
    // 提示是播报型的，会被紧随其后的自动发送（本环境未配置模型时会报错）顶掉，因此只记录是否捕到。
    const notice = await js<string>(`document.querySelector('.toast')?.innerText ?? ''`);
    checks.push({ check: 'image-folder-import', assets: listed.total, unsupported: scan.unsupported, noticeCaptured: notice.includes('不是 JPG') });

    // ===== 拖入契约：拒绝要带原因，超量要说上限与本次数量，不抛内部错误码 =====
    const notAnImage = path.join(imageFolder, 'README.txt');
    const webp = path.join(imageFolder, 'c.webp');
    const grantedRun = await js<{ granted: string[]; rejected: Array<{ name: string; reason: string }>; overLimit?: { limit: number; received: number } }>(
      `window.autoLabel.grantDroppedFiles(${json([path.join(imageFolder, 'a.jpg'), notAnImage, webp, videoFolder])})`);
    assert.equal(grantedRun.granted.length, 2, `单张图片与文件夹都应被接受，实际：${json(grantedRun.granted)}`);
    const reasons = Object.fromEntries(grantedRun.rejected.map(item => [item.name, item.reason]));
    assert.equal(reasons['README.txt'], 'unsupported_extension', `txt 应给出扩展名原因，实际：${json(grantedRun.rejected)}`);
    assert.equal(reasons['c.webp'], 'unsupported_extension', `webp 不在引擎能力内，应被拒绝，实际：${json(grantedRun.rejected)}`);
    assert.equal(grantedRun.overLimit, undefined, '未超量时不应回落上限信息');
    const overLimit = await js<{ granted: string[]; overLimit?: { limit: number; received: number } }>(
      `window.autoLabel.grantDroppedFiles(Array.from({length:501},(_,i)=>'C:/tmp/f'+i+'.jpg'))`);
    assert.equal(overLimit.granted.length, 0, '超量时不应放行任何路径');
    assert.deepEqual(overLimit.overLimit, { limit: 500, received: 501 }, `超量应回落上限与本次数量，实际：${json(overLimit.overLimit)}`);
    checks.push({ check: 'drop-contract', declared: grantedRun.granted.length, extensionReasons: 2, overLimit: overLimit.overLimit });

    // ===== 视频文件夹：先列候选，再逐个发起 =====
    await js(`[...document.querySelectorAll('.sidebar-scroll .nav-item')].find(b=>b.innerText.trim()==='新对话').click()`);
    await waitFor(`!!document.querySelector('.chat-suggestions')`);
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'directory', paths: [videoFolder] }]));
    await button('选择视频文件夹');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('选择要抽帧的视频')`);
    const rows = await js<number>(`${dialog}.querySelectorAll('.board-row').length`);
    assert.equal(rows, 2, `视频文件夹应列出 2 个候选，实际 ${rows}`);
    const pickerText = await js<string>(`${dialog}.innerText`);
    assert.ok(pickerText.includes('一次处理一个'), `候选清单应说明逐个处理，实际：${pickerText.slice(0, 300)}`);
    await button('抽帧', dialog);
    // 抽帧面板必须真的打开，而不是点完没反应。
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('768 × 576')`, 60000);
    checks.push({ check: 'video-folder-picker', candidates: rows, sequential: true, panelOpened: true });
    await writeFile(output, json({ checks, passed: true }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
