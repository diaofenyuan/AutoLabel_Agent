import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 数据集版本 / 导出的原因呈现验收。
 *
 * 这一条链路原本是「只报数量不报内容」：未标注素材被静默排除，界面只写「存在 N 个阻断问题」，
 * 并把 `annotation_scope_excluded`、`asset_unlabeled` 这类原始原因码直接摆给用户。本次验收断言：
 * 1. 问题明细以引擎返回的中文说明列出，并带可兑现的直达动作；
 * 2. 遗漏范围给出中文原因与张数；
 * 3. 界面与 toast 文本里都不再出现任何下划线风格的原因码。
 *
 * 夹具落在隔离 userData 的 fixtures 子目录内，只代替系统选择器，不代替路径授权或引擎；
 * 项目通过欢迎页「导入图片开始标注」真实建立，验证的是用户实际会走的那条入口。
 */
export async function checkDesktopReason(window: BrowserWindow, output: string): Promise<void> {
  // 夹具队列由主进程的 DialogFixtures 从真实 userData 读取，必须写到同一目录而不是输出文件所在目录。
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  assert.ok(userData, '原因呈现验收需要隔离的 AUTOLABEL_TEST_USER_DATA');
  // 每次运行使用独立子目录：项目名取自文件夹名，独立目录才能让本次运行的项目名唯一、便于定位。
  const batch = `reason-${Date.now()}`;
  const fixtures = path.join(userData, 'fixtures', batch);
  await mkdir(fixtures, { recursive: true });
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const api = <T = any>(command: string, payload: unknown = {}): Promise<T> => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const dialog = "document.querySelector('dialog[open]')";
  async function waitFor(expression: string, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error(`等待界面超时：${expression}（当前弹窗文本：${await js<string>(`${dialog}?${dialog}.innerText.slice(0,400):'(无弹窗)'`)}）`);
  }
  async function button(text: string, scope = 'document') {
    await waitFor(`!!${scope} && [...${scope}.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(text)}&&!b.disabled)`);
    await js(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(text)});b.click()})()`);
  }
  /** 原因码必须从用户可见文本里消失：界面与 toast 一起扫描。 */
  const CODE_PATTERN = /\b(annotation_scope_excluded|annotation_scope_confirmed_only|form_video_frame|form_derived|form_overlay_rendering|explicit_exclude|empty_label_excluded|empty_label_limit_exceeded|class_excluded|class_not_included|size_excluded|source_group_excluded|time_excluded|sampled_out|near_duplicate_folded|asset_unlabeled|classes_empty|export_empty|media_missing|dataset_version_blocked)\b/;
  /** 证据截图：先滚到预检区域再截整屏。按元素矩形截图会受弹窗滚动与重渲染影响截到中间态。 */
  async function capturePreflight(file: string, inner: string) {
    const target = `document.querySelector(${json(`dialog[open] ${inner}`)})`;
    await waitFor(`!!${target}&&!document.querySelector('dialog[open] .inline-loading')&&${target}.innerText.includes('需要先处理')`, 25000);
    await js(`${target}.scrollIntoView({block:'end'})`);
    await new Promise(resolve => setTimeout(resolve, 320));
    await writeFile(file, (await window.webContents.capturePage()).toPNG());
  }
  const checks: Record<string, unknown>[] = [];
  window.show();
  try {
    await waitFor(`!!document.querySelector('.chat-suggestions')&&!document.querySelector('.connection-banner')`);
    // 三张内容互不相同的图：引擎按内容指纹去重，同一张图复制三次只会入库一张。
    const sources = ['renderer/design/codex-flow.png', 'renderer/design/codex-projects.png', 'renderer/design/codex-settings.png'];
    for (const [index, source] of sources.entries()) await copyFile(path.resolve(source), path.join(fixtures, `frame-${index + 1}.png`));
    await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind: 'images', paths: sources.map((_, index) => path.join(fixtures, `frame-${index + 1}.png`)) }]));
    // 真实入口：欢迎页「导入图片开始标注」→ 按文件夹名建项目 → 3 张素材入库（未标注、项目无类别）。
    await button('导入图片开始标注');
    await waitFor(`!!document.querySelector('.chat-panel textarea')`);
    const created = (await api<Array<{ id: string; name: string; assetCount: number }>>('project.list')).find(item => item.name === batch);
    assert.ok(created, `欢迎页导入应建立名为 ${batch} 的项目`);
    const listed = await api('asset.list', { projectId: created!.id, limit: 100 });
    assert.equal(listed.total, 3, '应导入 3 张素材');
    assert.ok(listed.items.every((asset: { status: string }) => asset.status === 'unlabeled'), '素材应为未标注状态');
    checks.push({ check: 'unlabeled-project-created', projectId: created!.id, assets: listed.total });

    await js(`[...document.querySelectorAll('.sidebar-project')].find(g=>g.innerText.includes(${json(batch)})).querySelector('[title="项目概览"]').click()`);
    await waitFor(`!!document.querySelector('.page-overview')&&!!document.querySelector('.overview-card')`);

    // ===== 数据集版本：预检必须给出可读明细 + 中文遗漏范围 =====
    await button('数据集版本');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('版本列表')`);
    await button('新建版本', dialog);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('标注范围')`);
    await button('检查数据源', dialog);
    await waitFor(`!!${dialog}.querySelector('.reason-issues')`);
    const versionText = await js<string>(`${dialog}.innerText`);
    assert.ok(versionText.includes('没有可导出的素材'), `预检应列出「没有可导出的素材」明细，实际：${versionText.slice(0, 400)}`);
    assert.ok(versionText.includes('项目尚未定义类别'), `预检应列出「项目尚未定义类别」明细，实际：${versionText.slice(0, 400)}`);
    assert.ok(versionText.includes('尚未生成正式标注'), `遗漏范围应给出中文原因，实际：${versionText.slice(0, 400)}`);
    assert.ok(!versionText.includes('个阻断问题'), '不应再出现「存在 N 个阻断问题」这类只报数量的写法');
    const versionLeak = CODE_PATTERN.exec(versionText);
    assert.equal(versionLeak, null, `数据集版本界面泄漏了原因码：${versionLeak?.[0]}`);
    await capturePreflight(output.replace(/\.json$/, '-version-panel.png'), '.version-preview');
    // 直达动作必须能兑现：点击后真的落到类别模板弹窗，而不是点了没反应。
    await button('打开类别与点位模板', dialog);
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('类别与点位模板')`);
    assert.ok(await js<boolean>(`[...${dialog}.querySelectorAll('button')].some(b=>b.innerText.trim()==='添加类别')`), '「打开类别与点位模板」应落到真实模板入口');
    await button('取消', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    checks.push({ check: 'dataset-version-preflight', readableIssues: 2, reasonLabels: true, rawCodesHidden: true, directActionWorks: true });

    // ===== 导出：同一批素材的问题按原因合并，仍不出现原始码 =====
    await button('导出');
    await waitFor(`!!${dialog}&&${dialog}.innerText.includes('导出前检查')`);
    await waitFor(`!!${dialog}.querySelector('.reason-issues')`, 25000);
    const exportText = await js<string>(`${dialog}.innerText`);
    assert.ok(exportText.includes('项目尚未定义类别'), `导出预检应列出「项目尚未定义类别」，实际：${exportText.slice(0, 400)}`);
    assert.ok(exportText.includes('素材尚未生成正式标注'), `导出预检应列出未标注素材说明，实际：${exportText.slice(0, 400)}`);
    assert.ok(exportText.includes('（3 张）'), `同原因应按张数合并成一行，实际：${exportText.slice(0, 400)}`);
    const exportLeak = CODE_PATTERN.exec(exportText);
    assert.equal(exportLeak, null, `导出界面泄漏了原因码：${exportLeak?.[0]}`);
    await capturePreflight(output.replace(/\.json$/, '-export-panel.png'), '.preflight');
    await button('关闭', dialog);
    await waitFor(`!document.querySelector('dialog[open]')`);
    checks.push({ check: 'export-preflight', groupedByReason: true, rawCodesHidden: true });

    // ===== toast：错误提示同样不得带出原始码 =====
    const toast = await js<string>(`document.querySelector('.toast')?.innerText??''`);
    const toastLeak = CODE_PATTERN.exec(toast);
    assert.equal(toastLeak, null, `toast 泄漏了原因码：${toastLeak?.[0]}（${toast}）`);
    checks.push({ check: 'toast-without-raw-code', text: toast });

    await writeFile(output, json({ passed: true, mode: 'reason-presentation', checks }, null, 2));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ passed: false, checks, error: error instanceof Error ? error.message : String(error), body: await js('document.body.innerText') }, null, 2));
    throw error;
  }
}
