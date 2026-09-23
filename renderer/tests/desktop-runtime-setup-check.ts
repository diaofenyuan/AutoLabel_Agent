import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { LocalRuntimeState } from '../../shared/inference';
import { RUNTIME_DEPENDENCIES, type RuntimeSetupState } from '../../shared/runtime-setup';
import { gotoSettings, openPythonPicker } from './desktop-navigation';

/**
 * 一键准备本地推理环境验收。
 *
 * 两个场景共用一套界面路径，靠 AUTOLABEL_RUNTIME_SETUP_OFFLINE 切换：
 * - 默认（--runtime-setup）：干净数据目录里点「一键准备」，从国内镜像真实安装一轮，
 *   完成后必须 `local.runtime.get.available === true` 并带上 ultralytics / torch 版本，
 *   环境目录里要有 autolabel-env.json 记录到底装了什么；
 * - 断网/镜像不可达（--runtime-setup-offline）：先手动配好一个可用解释器，再让镜像地址指向不可达主机。
 *   失败必须说清楚原因，且**不能**动用户原有的解释器配置——这条是「一次失败的安装不该毁掉已有环境」。
 *
 * 前置：本机需要有 Python 3.10–3.12（AUTOLABEL_TEST_PYTHON 可指定），默认场景会真实下载约 300 MB。
 */
export async function checkDesktopRuntimeSetup(window: BrowserWindow, output: string): Promise<void> {
  const offline = process.env.AUTOLABEL_RUNTIME_SETUP_OFFLINE === '1';
  const mode = offline ? 'runtime-setup-offline-ui' : 'runtime-setup-ui';
  const checks: Record<string, unknown>[] = [];
  const js = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const json = JSON.stringify;
  const userData = process.env.AUTOLABEL_TEST_USER_DATA;
  assert.ok(userData, '本地环境准备验收必须指定隔离数据目录');
  const basePython = process.env.AUTOLABEL_TEST_PYTHON ?? 'C:/Users/zhy23/AppData/Local/Programs/Python/Python311/python.exe';
  async function waitFor(expression: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js<boolean>(`(async()=>{try{return !!(await (${expression}))}catch(e){return false}})()`)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`等待界面超时：${expression}`);
  }
  const api = <T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const setup = () => api<RuntimeSetupState & { record: Record<string, unknown> | null }>('local.runtime.setup.get');
  const runtime = () => api<LocalRuntimeState>('local.runtime.get');
  const phase = () => js<string>(`document.querySelector('.runtime-setup')?.dataset.phase ?? ''`);
  try {
    assert.ok(await stat(basePython).then(() => true).catch(() => false), `本机缺少可用的 Python：${basePython}`);
    window.show();
    await waitFor(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.connection-banner')`);
    await gotoSettings({ js, wait: waitFor }, '本地推理');
    await waitFor(`!!document.querySelector('.local-runtime-settings')`);

    // ===== 主入口必须在最显眼处，手动选解释器折在「高级」里 =====
    const entry = await js<{ primary: string; pickerVisible: boolean; advancedLabel: string }>(`(()=>{
      const settings = document.querySelector('.local-runtime-settings');
      const primary = [...settings.querySelectorAll('.actions button')].map(node=>node.innerText.trim()).find(text=>text.includes('一键准备')) ?? '';
      return { primary, pickerVisible: [...settings.querySelectorAll('button')].some(node=>node.innerText.trim()==='选择 Python 解释器'&&node.offsetParent),
        advancedLabel: settings.querySelector('.local-runtime-advanced-toggle')?.innerText.trim() ?? '' };
    })()`);
    assert.ok(entry.primary.includes('一键准备'), `本地推理页缺少「一键准备」主入口：${json(entry)}`);
    assert.equal(entry.pickerVisible, false, '手动选解释器默认应折进「高级」');
    assert.ok(entry.advancedLabel.includes('高级'), `缺少「高级」折叠入口：${entry.advancedLabel}`);
    await openPythonPicker({ js, wait: waitFor });
    assert.equal(await js<boolean>(`[...document.querySelectorAll('.local-runtime-settings button')].some(node=>node.innerText.trim()==='选择 Python 解释器'&&node.offsetParent)`), true, '展开「高级」后必须能手动选解释器');
    checks.push({ check: 'prepare-entry-and-advanced-toggle', primary: entry.primary, advanced: entry.advancedLabel });

    if (offline) {
      // 失败注入必须落在全新存储根：共享存储根里若已有上一轮真实装好的 python-env，
      // 一键准备会「复用已有环境」、pip 对已满足的固定版本直接成功，负例永远等不到 failed（历史红的根因）。
      const forcedRoot = process.env.AUTOLABEL_TEST_STORAGE_ROOT;
      assert.ok(forcedRoot, '离线负例必须显式指定隔离存储根（AUTOLABEL_TEST_STORAGE_ROOT）');
      await rm(forcedRoot!, { recursive: true, force: true });
      // ===== 先有一个能用的解释器，再验证失败的安装不会把它冲掉 =====
      const fixtures = path.join(userData!, 'fixtures'), environment = path.join(fixtures, 'python-env'), pythonPath = path.join(environment, 'Scripts', 'python.exe');
      await mkdir(fixtures, { recursive: true });
      await promisify(execFile)(basePython, ['-m', 'venv', '--system-site-packages', '--without-pip', environment], { windowsHide: true });
      await writeFile(path.join(userData!, 'dialog-fixtures.json'), json([{ kind: 'python', paths: [pythonPath] }]));
      await js(`([...document.querySelectorAll('.local-runtime-settings .advanced-fields button')].find(node=>node.innerText.trim()==='选择 Python 解释器')).click()`);
      await waitFor(`document.querySelector('.local-runtime-summary')?.innerText.includes('解释器配置：已配置')`);
      // 检测一次，让「原有环境是可用的」成为实测结论，而不是只看配置字段。
      await js(`([...document.querySelectorAll('.local-runtime-settings button')].find(node=>node.innerText.trim()==='重新检测环境'&&!node.disabled)).click()`);
      await waitFor(`document.querySelector('.local-runtime-summary')?.innerText.includes('环境检测通过')`, 90000);
      const before = await api<LocalRuntimeState>('local.runtime.get');
      assert.equal(before.configured, true, '前置条件不满足：手动解释器没有配置成功');
      assert.equal(before.available, true, '前置条件不满足：原有环境检测未通过');

      await js(`([...document.querySelectorAll('.local-runtime-settings .actions button')].find(node=>node.innerText.includes('一键准备'))).click()`);
      await waitFor(`document.querySelector('.runtime-setup')?.dataset.phase==='failed'`, 300000);
      const failed = await setup();
      assert.equal(failed.phase, 'failed');
      assert.match(failed.message, /安装|网络|镜像/, `失败原因应说明是装不上还是别的问题：${failed.message}`);
      assert.ok(failed.log.length > 0, '失败时必须留下安装输出，便于定位');
      assert.ok(await js<boolean>(`document.querySelector('.runtime-setup')?.className.includes('failed')`), '失败状态要在界面上标出来');
      const after = await api<LocalRuntimeState>('local.runtime.get');
      assert.equal(after.configured, true, '失败的安装不能清掉原有的解释器配置');
      assert.equal(after.available, true, '原有环境必须仍然可用');
      checks.push({ check: 'offline-failure-keeps-existing', code: failed.error?.code ?? '', message: failed.message, logLines: failed.log.length,
        configuredBefore: before.configured, configuredAfter: after.configured, availableAfter: after.available });
      await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
      await writeFile(output, json({ checks, passed: true, mode }));
      return;
    }

    // ===== 干净数据目录：一键准备必须真的装出一套可用环境 =====
    assert.equal((await setup()).phase, 'idle', '干净数据目录里不应已经有准备记录');
    await js(`([...document.querySelectorAll('.local-runtime-settings .actions button')].find(node=>node.innerText.includes('一键准备'))).click()`);
    await waitFor(`!!document.querySelector('.runtime-setup')`, 20000);
    // 真实安装要几分钟：先确认界面确实进入安装阶段，再等结果。
    await waitFor(`['creating','installing','verifying','configuring','ready'].includes(document.querySelector('.runtime-setup')?.dataset.phase??'')`, 120000);
    await waitFor(`document.querySelector('.runtime-setup')?.dataset.phase==='ready'`, 1500000);
    const ready = await setup();
    const detected = await runtime();
    assert.equal(detected.available, true, `一键准备完成后环境仍不可用：${json(detected.issue)}`);
    assert.equal(detected.configured, true, '一键准备完成后解释器应已配置');
    assert.ok(detected.ultralyticsVersion, '缺少 ultralytics 版本');
    assert.ok(detected.torchVersion, '缺少 torch 版本');
    assert.ok(await stat(path.join(ready.environment!, 'Scripts', 'python.exe')).then(() => true).catch(() => false), '环境目录里没有解释器');
    const record = JSON.parse(await readFile(path.join(ready.environment!, 'autolabel-env.json'), 'utf8')) as { dependencies: Array<{ name: string; version: string }>; indexUrl: string };
    for (const dependency of RUNTIME_DEPENDENCIES) {
      const installed = record.dependencies.find(item => item.name === dependency.name);
      assert.ok(installed, `环境记录里缺少 ${dependency.name}`);
      assert.equal(installed.version.split('+')[0], dependency.version, `${dependency.name} 装成的版本与固定版本不一致`);
    }
    const shown = await js<string>(`document.querySelector('.runtime-setup')?.innerText ?? ''`);
    assert.ok(shown.includes(detected.torchVersion) || shown.includes(record.dependencies.find(item => item.name === 'torch')!.version), '界面应显示实际装成的版本');
    checks.push({ check: 'prepare-installs-usable-environment', environment: ready.environment, indexUrl: record.indexUrl,
      ultralyticsVersion: detected.ultralyticsVersion, torchVersion: detected.torchVersion, pythonVersion: detected.pythonVersion,
      dependencies: record.dependencies });
    await writeFile(output.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
    // 准备完之后，前面「启用并按需下载」的模型必须能直接加载——这是这两步合起来的意义。
    await writeFile(output, json({ checks, passed: true, mode }));
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG());
    await writeFile(output, json({ checks, passed: false, mode, error: error instanceof Error ? error.message : String(error),
      setup: await setup().catch(() => null), body: await js(`document.body.innerText`) }));
    throw error;
  }
}
