import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelLibraryState } from '../../shared/model-library';
import { gotoSettings } from './desktop-navigation';

/**
 * 模型库验收。
 *
 * 这一页要回答的是「不花钱能不能标」：软件自带哪些模型、多大、现在能不能用。
 * 因此断言的是界面与主进程报的状态逐条一致，而不是「有没有渲染出卡片」：
 * 1. 界面列出的模型与 `model.library.status` 的目录完全对应（数量、标识、状态一一对上）；
 * 2. 随安装包提供的权重必须真的就绪——这是「装完就能用」的底线，缺了就提示先跑 check:models；
 * 3. 未就绪的模型必须给出原因，不能只显示一个灰掉的条目；
 * 4. 内容不对的文件要当场显示成「需要修复」：这里会造一份大小不对的同名文件，
 *    看界面是否如实改口，验证完把这次造的文件删干净（不进用户真实下载目录的其它位置）。
 */
export async function checkDesktopModelLibrary(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  const status = () => js<ModelLibraryState>(`window.autoLabel.request('model.library.status')`);
  const refresh = () => js(`([...document.querySelectorAll('.model-library .section-toolbar button')].find(node=>node.innerText.includes('刷新模型库'))).click()`);
  const cards = () => js<Array<{ id: string; state: string; badge: string; hint: string }>>(
    `[...document.querySelectorAll('.model-library .model-card')].map(node=>({ id: node.dataset.model, state: node.dataset.state,
       badge: node.querySelector('.model-card-state')?.innerText.trim() ?? '', hint: node.querySelector('.model-card-hint')?.innerText.trim() ?? '' }))`);
  /** 造一份大小不对的同名文件，用来验证「内容不对就是不可用」。返回清理函数。 */
  async function plantBrokenCopy(modelsRoot: string, entry: ModelLibraryState['entries'][number]): Promise<() => Promise<void>> {
    const directory = path.join(modelsRoot, entry.id, entry.sha256.slice(0, 12));
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, entry.fileName);
    const existed = await stat(file).then(() => true).catch(() => false);
    if (existed) return async () => undefined;
    await writeFile(file, 'autolabel-model-library-check');
    return async () => { await rm(path.join(modelsRoot, entry.id), { recursive: true, force: true }); };
  }
  try {
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    await gotoSettings({ js, wait: waitFor }, '软件 AI 配置');
    await waitFor(`!!document.querySelector('.model-kind-tabs')`);
    const tabs = await js<string[]>(`[...document.querySelectorAll('.model-kind-tabs button')].map(node=>node.innerText.trim())`);
    assert.deepEqual(tabs, ['在线接口', '本地模型', '模型库'], `软件 AI 配置应有三个分区，实际：${json(tabs)}`);
    await js(`([...document.querySelectorAll('.model-kind-tabs button')].find(node=>node.innerText.trim()==='模型库')).click()`);
    await waitFor(`!!document.querySelector('.model-library .model-card')`);

    // ===== 界面列出的模型必须与主进程报告的目录逐条对上 =====
    const reported = await status();
    const listed = await cards();
    assert.equal(listed.length, reported.entries.length, `界面列出了 ${listed.length} 个模型，目录里有 ${reported.entries.length} 个`);
    const label = { ready: '已就绪', missing: '未就绪', corrupt: '需要修复' } as const;
    for (const entry of reported.entries) {
      const card = listed.find(item => item.id === entry.id);
      assert.ok(card, `界面缺少模型：${entry.id}`);
      assert.equal(card.state, entry.state, `${entry.id} 的界面状态与主进程不一致`);
      assert.equal(card.badge, label[entry.state], `${entry.id} 的状态文案不对：${card.badge}`);
    }
    // 体积与「随安装包提供」的分组信息要能看见，用户才知道占不占空间、要不要联网。
    const summary = await js<string>(`document.querySelector('.model-library-summary').innerText`);
    assert.ok(summary.includes(`已就绪 ${reported.ready} / ${reported.total}`), `摘要没有如实写出就绪数量：${summary}`);
    assert.ok(summary.includes('内置'), `摘要应说明内置权重体积：${summary}`);
    const facts = await js<string[]>(`[...document.querySelectorAll('.model-library .model-card')].flatMap(node=>[...node.querySelectorAll('.model-card-facts li')].map(item=>item.innerText.trim()))`);
    for (const entry of reported.entries) {
      assert.ok(facts.includes(`${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB`), `界面没有列出 ${entry.id} 的体积`);
    }
    checks.push({ check: 'catalog-matches-desktop', models: listed.length, ready: reported.ready, total: reported.total, summary });

    // ===== 随安装包提供的权重必须真的就绪 =====
    const bundled = reported.entries.filter(entry => entry.tier === 'bundled');
    const missingBundled = bundled.filter(entry => entry.state !== 'ready').map(entry => `${entry.id}（${entry.message ?? ''}）`);
    assert.deepEqual(missingBundled, [], `内置权重未就绪：${missingBundled.join('、')}；请先执行 npm run check:models`);
    // ===== 未就绪的必须给出原因，不允许只显示一个灰条目 =====
    const silent = reported.entries.filter(entry => entry.state !== 'ready' && !listed.find(item => item.id === entry.id)?.hint).map(entry => entry.id);
    assert.deepEqual(silent, [], `这些模型未就绪却没有说明原因：${silent.join('、')}`);
    checks.push({ check: 'bundled-ready-and-reasons-shown', bundled: bundled.length, bundledReady: bundled.filter(entry => entry.state === 'ready').length });
    checks.push({ check: 'not-ready-explain', entries: listed.filter(item => item.state !== 'ready').map(item => ({ id: item.id, badge: item.badge, hint: item.hint })) });

    await waitFor(`getComputedStyle(document.querySelector('.settings-body')).opacity==='1'`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());

    // ===== 内容不对的文件必须当场显示成「需要修复」 =====
    const target = reported.entries.find(entry => entry.tier === 'download' && entry.state === 'missing');
    if (target) {
      const cleanup = await plantBrokenCopy(reported.modelsRoot, target);
      try {
        await refresh();
        await waitFor(`document.querySelector('.model-card[data-model=${json(target.id)}]')?.dataset.state==='corrupt'`);
        const broken = (await cards()).find(item => item.id === target.id)!;
        assert.equal(broken.badge, '需要修复');
        assert.ok(broken.hint.includes('大小'), `损坏提示应说明差在哪：${broken.hint}`);
        checks.push({ check: 'broken-file-reported', model: target.id, badge: broken.badge, hint: broken.hint });
      } finally { await cleanup(); }
      const restored = await status();
      assert.equal(restored.entries.find(entry => entry.id === target.id)?.state, 'missing', '验收造出来的文件必须被清理干净');
      await refresh();
      await waitFor(`document.querySelector('.model-card[data-model=${json(target.id)}]')?.dataset.state==='missing'`);
      checks.push({ check: 'broken-file-cleaned', model: target.id });
    } else {
      checks.push({ check: 'broken-file-reported', skipped: '所有按需下载的模型都已就绪，未造损坏文件' });
    }
    await writeFile(output, json({ checks, passed: true, mode: 'model-library-ui' }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, mode: 'model-library-ui', error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
