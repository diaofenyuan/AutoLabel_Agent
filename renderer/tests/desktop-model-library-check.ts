import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { LocalModel, LocalRuntimeState } from '../../shared/inference';
import type { ModelLibraryState } from '../../shared/model-library';
import { gotoSettings, openPythonPicker } from './desktop-navigation';

/**
 * 模型库验收。
 *
 * 这一页要回答的是「不花钱能不能标」：软件自带哪些模型、多大、现在能不能用，以及点一下能不能真的跑起来。
 * 断言分四段，每一段都对应一个会真实影响用户的行为：
 * 1. 界面列出的模型与 `model.library.status` 的目录逐条对应，随安装包提供的必须真的就绪；
 *    未就绪的必须给出原因（折叠起来也要能看到），不允许只显示一个灰条目；
 * 2. 内容不对的文件当场显示成「需要修复」——验收会造一份大小不对的同名文件，验完删干净；
 * 3. 点「启用」后：引擎里出现带 catalogId/origin 的登记记录，界面上标成已启用，并能用「本地模型」页
 *    选设备、加载、读出类别（这一步需要本机 Python 与 ultralytics，没装会在统计前明确报错）；
 * 4. 反向用例：把库内权重改一个字节后加载必须报 `local_model_changed`，不能静默用旧哈希；改回后恢复可用。
 */
export async function checkDesktopModelLibrary(window: BrowserWindow, output: string): Promise<void> {
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const userData = process.env.AUTOLABEL_TEST_USER_DATA;
  assert.ok(userData, '模型库验收必须指定隔离数据目录');
  // 选解释器必须经界面，而验收对话框只认隔离目录内的文件；因此用一个指向真实解释器的虚拟环境。
  const basePython = process.env.AUTOLABEL_TEST_PYTHON ?? 'C:/Users/zhy23/AppData/Local/Programs/Python/Python311/python.exe';
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  const api = <T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const status = () => api<ModelLibraryState>('model.library.status');
  const refresh = () => js(`([...document.querySelectorAll('.model-library .section-toolbar button')].find(node=>node.innerText.includes('刷新模型库'))).click()`);
  /** 折叠起来的卡片也要能读到原因，所以取 textContent 而不是 innerText。 */
  const cards = () => js<Array<{ id: string; state: string; badge: string; hint: string; enabled: string; folded: boolean }>>(
    `[...document.querySelectorAll('.model-library .model-card')].map(node=>({ id: node.dataset.model, state: node.dataset.state, enabled: node.dataset.enabled,
       badge: node.querySelector('.model-card-state')?.textContent.trim() ?? '', hint: node.querySelector('.model-card-hint')?.textContent.trim() ?? '',
       folded: !!node.closest('.model-library-more') }))`);
  const cardButton = async (catalogId: string, label: string) => {
    await waitFor(`[...document.querySelectorAll('.model-card[data-model=${json(catalogId)}] button')].some(node=>node.innerText.includes(${json(label)})&&!node.disabled)`);
    await js(`([...document.querySelectorAll('.model-card[data-model=${json(catalogId)}] button')].find(node=>node.innerText.includes(${json(label)})&&!node.disabled)).click()`);
  };
  /** 造一份大小不对的同名文件，用来验证「内容不对就是不可用」。返回清理函数。 */
  async function plantBrokenCopy(modelsRoot: string, entry: ModelLibraryState['entries'][number]): Promise<() => Promise<void>> {
    const directory = path.join(modelsRoot, entry.id, entry.sha256.slice(0, 12));
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, entry.fileName);
    if (await stat(file).then(() => true).catch(() => false)) return async () => undefined;
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

    // ===== 1. 界面列出的模型必须与主进程报告的目录逐条对上 =====
    const reported = await status();
    const listed = await cards();
    assert.equal(listed.length, reported.entries.length, `界面列出了 ${listed.length} 个模型，目录里有 ${reported.entries.length} 个`);
    const label = { ready: '已就绪', missing: '未就绪', corrupt: '需要修复' } as const;
    for (const entry of reported.entries) {
      const card = listed.find(item => item.id === entry.id);
      assert.ok(card, `界面缺少模型：${entry.id}`);
      assert.equal(card.state, entry.state, `${entry.id} 的界面状态与主进程不一致`);
      // 文本编码器只下载不登记，所以就绪时写「已下载」而不是「已启用」。
      const expected = card.enabled === 'yes' ? '已启用' : entry.taskType === null && entry.state === 'ready' ? '已下载' : label[entry.state];
      assert.equal(card.badge, expected, `${entry.id} 的状态文案不对：${card.badge}`);
    }
    const summary = await js<string>(`document.querySelector('.model-library-summary').innerText`);
    assert.ok(summary.includes(`已就绪 ${reported.ready} / ${reported.total}`), `摘要没有如实写出就绪数量：${summary}`);
    assert.ok(summary.includes('内置'), `摘要应说明内置权重体积：${summary}`);
    // 内置的必须直接可见；需要下载的默认收进「更多模型」，避免一屏全是没下载的东西。
    const bundled = reported.entries.filter(entry => entry.tier === 'bundled');
    assert.ok(listed.filter(item => bundled.some(entry => entry.id === item.id)).every(item => !item.folded), '随安装包提供的模型不应被折叠');
    const folded = listed.filter(item => item.folded);
    assert.ok(folded.every(item => item.state !== 'ready'), `已就绪的模型不该被折叠：${json(folded.map(item => item.id))}`);
    const moreLabel = await js<string>(`[...document.querySelectorAll('.model-library-more>summary')].map(node=>node.textContent.trim()).join('|')`);
    assert.ok(moreLabel.includes('更多模型（按需下载'), `按需下载的模型应折进一行入口：${moreLabel}`);
    const missingBundled = bundled.filter(entry => entry.state !== 'ready').map(entry => `${entry.id}（${entry.message ?? ''}）`);
    assert.deepEqual(missingBundled, [], `内置权重未就绪：${missingBundled.join('、')}；请先执行 npm run check:models`);
    const silent = reported.entries.filter(entry => entry.state !== 'ready' && !listed.find(item => item.id === entry.id)?.hint).map(entry => entry.id);
    assert.deepEqual(silent, [], `这些模型未就绪却没有说明原因：${silent.join('、')}`);
    checks.push({ check: 'catalog-matches-desktop', models: listed.length, ready: reported.ready, total: reported.total, bundled: bundled.length, folded: folded.length, summary });
    checks.push({ check: 'bundled-ready-and-reasons-shown', bundled: bundled.length, bundledReady: bundled.filter(entry => entry.state === 'ready').length });
    checks.push({ check: 'not-ready-explain', entries: listed.filter(item => item.state !== 'ready').map(item => ({ id: item.id, badge: item.badge, hint: item.hint, folded: item.folded })) });

    await waitFor(`getComputedStyle(document.querySelector('.settings-body')).opacity==='1'`);
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());

    // ===== 2. 内容不对的文件必须当场显示成「需要修复」 =====
    const damaged = reported.entries.find(entry => entry.tier === 'download' && entry.state === 'missing');
    if (damaged) {
      const cleanup = await plantBrokenCopy(reported.modelsRoot, damaged);
      try {
        await refresh();
        await waitFor(`document.querySelector('.model-card[data-model=${json(damaged.id)}]')?.dataset.state==='corrupt'`);
        const broken = (await cards()).find(item => item.id === damaged.id)!;
        assert.equal(broken.badge, '需要修复');
        assert.ok(broken.hint.includes('大小'), `损坏提示应说明差在哪：${broken.hint}`);
        checks.push({ check: 'broken-file-reported', model: damaged.id, badge: broken.badge, hint: broken.hint });
      } finally { await cleanup(); }
      assert.equal((await status()).entries.find(entry => entry.id === damaged.id)?.state, 'missing', '验收造出来的文件必须被清理干净');
      await refresh();
      await waitFor(`document.querySelector('.model-card[data-model=${json(damaged.id)}]')?.dataset.state==='missing'`);
      checks.push({ check: 'broken-file-cleaned', model: damaged.id });
    } else {
      checks.push({ check: 'broken-file-reported', skipped: '所有按需下载的模型都已就绪，未造损坏文件' });
    }

    // ===== 3. 一键启用：登记 + 授权 + 能读类别 =====
    assert.ok(await stat(basePython).then(() => true).catch(() => false),
      `本地推理验收需要本机 Python（${basePython}）；可用 AUTOLABEL_TEST_PYTHON 指定已装 ultralytics 的解释器`);
    const fixtures = path.join(userData!, 'fixtures'), environment = path.join(fixtures, 'python-env'), pythonPath = path.join(environment, 'Scripts', 'python.exe');
    await mkdir(fixtures, { recursive: true });
    await promisify(execFile)(basePython, ['-m', 'venv', '--system-site-packages', '--without-pip', environment], { windowsHide: true });
    const targetModel = bundled.find(entry => entry.taskType === 'detect')!;
    // 选解释器必须经界面：执行授权只认用户显式选择。
    await writeFile(path.join(userData!, 'dialog-fixtures.json'), json([{ kind: 'python', paths: [pythonPath] }]));
    await gotoSettings({ js, wait: waitFor }, '本地推理');
    await waitFor(`!!document.querySelector('.local-runtime-settings')&&[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='重新检测环境'&&!b.disabled)`);
    await openPythonPicker({ js, wait: waitFor });
    await js(`([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='选择 Python 解释器')).click()`);
    await waitFor(`document.querySelector('.local-runtime-summary')?.innerText.includes('解释器配置：已配置')`);
    await js(`([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='重新检测环境'&&!b.disabled)).click()`);
    await waitFor(`document.querySelector('.local-runtime-summary')?.innerText.includes('环境检测通过')`, 90000);
    const runtime = await api<LocalRuntimeState>('local.runtime.get');
    assert.equal(runtime.available, true, '本机 Python 环境未检测通过，后面无法验证加载');

    await gotoSettings({ js, wait: waitFor }, '软件 AI 配置');
    await js(`([...document.querySelectorAll('.model-kind-tabs button')].find(node=>node.innerText.trim()==='模型库')).click()`);
    await waitFor(`!!document.querySelector('.model-card[data-model=${json(targetModel.id)}] button')`);
    await cardButton(targetModel.id, '启用');
    await waitFor(`document.querySelector('.model-card[data-model=${json(targetModel.id)}]')?.dataset.enabled==='yes'`, 120000);
    const registered = await api<{ items: LocalModel[] }>('local.model.list', { offset: 0, limit: 500 });
    const enabledModel = registered.items.find(item => item.catalogId === targetModel.id)!;
    assert.ok(enabledModel, '启用后引擎里必须有带 catalogId 的登记记录');
    assert.equal(enabledModel.origin, 'builtin', `随安装包提供的模型来源应记作 builtin：${enabledModel.origin}`);
    assert.equal(enabledModel.modelHash, targetModel.sha256, '登记记录的哈希必须与目录一致');
    const enabledHint = await js<string>(`document.querySelector('.model-card[data-model=${json(targetModel.id)}] .model-card-enabled')?.textContent.trim() ?? ''`);
    assert.ok(enabledHint.includes(`版本 ${enabledModel.version}`), `界面没有标出已启用的版本：${enabledHint}`);
    checks.push({ check: 'enable-registers-and-authorizes', catalogId: targetModel.id, modelId: enabledModel.id, version: enabledModel.version, origin: enabledModel.origin, badge: enabledHint });
    await writeFile(output.replace(/\.json$/, '-enabled.png'), (await window.webContents.capturePage()).toPNG());

    // 到「本地模型」里选设备、加载、读类别——这一步证明启用出来的模型真的能跑。
    await js(`([...document.querySelectorAll('.model-kind-tabs button')].find(node=>node.innerText.trim()==='本地模型')).click()`);
    await waitFor(`[...document.querySelectorAll('.local-model-list>button')].some(node=>node.innerText.includes(${json(targetModel.name)}))`);
    await js(`([...document.querySelectorAll('.local-model-list>button')].find(node=>node.innerText.includes(${json(targetModel.name)}))).click()`);
    await js(`(()=>{const e=document.querySelector('[aria-label="本地模型加载设备"]');e.value='cpu';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await js(`([...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='加载模型并读取类别'&&!b.disabled)).click()`);
    await waitFor(`!!document.querySelector('.local-model-detail .local-load-result')`, 120000);
    const classes = await js<Array<{ id: string; name: string }>>(`[...document.querySelectorAll('.local-class-list>div')].map(node=>({ id: node.querySelector('span').innerText, name: node.querySelector('strong').innerText }))`);
    assert.ok(classes.length > 0, '加载后应读出模型类别');
    assert.ok(classes.some(item => item.name === 'person'), `COCO 类别里应有 person，实际：${json(classes.slice(0, 5))}`);
    const loadedRuntime = await api<LocalRuntimeState>('local.runtime.get');
    assert.ok(loadedRuntime.slots.some(slot => slot.modelId === enabledModel.id && slot.modelVersion === enabledModel.version), '加载后设备槽里应挂上这个模型版本');
    checks.push({ check: 'load-library-model', classes: classes.length, sample: classes.slice(0, 3).map(item => item.name), device: 'cpu' });
    await writeFile(output.replace(/\.json$/, '-loaded.png'), (await window.webContents.capturePage()).toPNG());

    // ===== 4. 反向用例：权重被改动后不许静默使用旧哈希 =====
    const libraryFile = path.join(process.cwd(), 'build', 'models', targetModel.fileName);
    const original = await readFile(libraryFile);
    const changed = Buffer.from(original); changed[1024] = changed[1024] ^ 0xff;
    const load = () => js<string>(`window.autoLabel.request('local.model.load',{modelId:${json(enabledModel.id)},modelVersion:${json(enabledModel.version)},device:'cpu'}).then(()=>'NO-ERROR').catch(error=>String(error.message))`);
    try {
      await writeFile(libraryFile, changed);
      const rejected = await load();
      assert.ok(rejected.includes('local_model_changed'), `改动权重后加载必须报 local_model_changed，实际：${rejected}`);
      checks.push({ check: 'changed-weights-rejected', message: rejected });
    } finally { await writeFile(libraryFile, original); }
    assert.equal(await load(), 'NO-ERROR', '还原权重后应恢复可用');
    checks.push({ check: 'restored-weights-load', restored: true });
    await writeFile(output, json({ checks, passed: true, mode: 'model-library-ui' }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, mode: 'model-library-ui', error: error instanceof Error ? error.message : String(error), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
