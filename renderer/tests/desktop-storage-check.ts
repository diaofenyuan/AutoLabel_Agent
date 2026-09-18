import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkDesktopStorage(window: BrowserWindow, output: string): Promise<void> {
  const checks: unknown[] = [], json = JSON.stringify;
  const js = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = (command: string, payload: unknown = {}) => js(`window.autoLabel.request(${json(command)},${json(payload)})`);
  const userData = process.env.AUTOLABEL_TEST_USER_DATA!;
  const fixtures = path.join(userData, 'fixtures'); await mkdir(fixtures, { recursive: true });
  async function wait(expression: string) { const end = Date.now() + 18000; while (Date.now() < end) { try { if (await js(expression)) return; } catch { /* 切换目录时页面会重新加载，只重试读取界面。 */ } await new Promise(r => setTimeout(r, 50)); } throw new Error(`存储界面等待超时：${expression}`); }
  async function button(label: string) { await wait(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()===${json(label)}&&!b.disabled)`); await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${json(label)}).click()`); }
  async function fill(selector: string, value: string) { await js(`(()=>{const e=document.querySelector(${json(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${json(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async function queue(kind: string, file: string) { await writeFile(path.join(userData, 'dialog-fixtures.json'), json([{ kind, paths: [file] }])); }
  async function workspace() { await js(`document.querySelectorAll('.nav-item')[6].click()`); await wait(`!!document.querySelector('.settings-tabs')`); await button('工作空间'); await wait(`!!document.querySelector('.storage-data-dir')&&!document.querySelector('.storage-data-dir').innerText.includes('正在读取')`); }
  async function capture(suffix: string, selector: string) { await js(`document.activeElement?.blur();document.querySelector(${json(selector)}).scrollIntoView({block:'center',behavior:'instant'})`); await new Promise(r => setTimeout(r, 350)); await writeFile(output.replace(/\.json$/, suffix), (await window.webContents.capturePage()).toPNG()); }
  function inside(child: string, parent: string) { const relative = path.relative(parent, child); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
  window.show();
  try {
    await wait(`!!document.querySelector('.onboarding-lanes')&&!document.querySelector('.skeleton-list')&&!document.querySelector('.connection-banner')`);
    const initial = await api('storage.status'); assert.ok(inside(initial.dataDir, userData), '只能迁移当前独立测试目录');
    await button('打开示例'); await wait(`!!document.querySelector('[aria-label="对象x"]')`);
    const assetId = await js<string>(`new URL(document.querySelector('.annotation-canvas image').getAttribute('href')).pathname.slice(1)`);
    const original = await api('asset.get', { assetId }); const draftX = original.annotations[0].bbox.x + 3;
    await fill('[aria-label="对象x"]', String(draftX));
    const provider = await api('provider.save', { name: '存储隔离验收', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'chat-completions', model: 'no-request' });
    await api('credential.set', { providerId: provider.id, key: 'storage-ui-fixture-key' });
    await workspace(); assert.equal((await api('asset.get', { assetId })).draft[0].bbox.x, draftX);
    assert.equal(await js(`document.querySelector('.storage-data-dir').innerText`), initial.dataDir);
    const backupDir = path.join(fixtures, 'backups'); await mkdir(backupDir);
    await button('外观'); await button('深色'); await wait(`document.documentElement.dataset.theme==='dark'`); await button('工作空间');
    await button('选择备份目录'); await wait(`document.querySelector('.storage-error')?.innerText.includes('设置尚未保存')`);
    await button('保存设置'); await button('外观'); await button('浅色'); await wait(`document.documentElement.dataset.theme==='light'`); await button('保存设置'); await button('工作空间');
    await queue('directory', backupDir); await button('选择备份目录'); await wait(`document.querySelector('[aria-label="备份保存目录"]').value===${json(backupDir)}`);
    await button('检查备份条件'); await wait(`document.querySelector('.storage-settings').innerText.includes('预检通过')`);
    await button('保存本地备份'); await wait(`!!document.querySelector('[aria-label="已保存备份文件"]')`);
    const backupPath = await js<string>(`document.querySelector('[aria-label="已保存备份文件"]').innerText`); assert.ok(inside(backupPath, backupDir)); assert.ok((await stat(backupPath)).size > 0);
    checks.push({ check: 'native-backup', realDataDir: true, savedDraftIncluded: true, unsavedSettingsGuard: true, archiveWritten: true });

    const invalid = path.join(fixtures, 'invalid.zip'); await writeFile(invalid, 'not a backup');
    await queue('backup', invalid); await button('选择备份文件'); await button('检查备份文件'); await wait(`!!document.querySelector('.storage-error')`);
    assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='准备恢复副本').disabled`), true);
    await queue('backup', backupPath); await button('选择备份文件'); await button('检查备份文件'); await wait(`document.querySelector('.storage-settings').innerText.includes('备份创建于')`);
    const restoredParent = path.join(fixtures, 'restored'); await mkdir(restoredParent);
    await queue('directory', restoredParent); await button('选择恢复目录'); await button('准备恢复副本'); await wait(`!!document.querySelector('.storage-activation')`);
    assert.equal((await api('storage.status')).dataDir, initial.dataDir);
    await wait(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='切换到恢复副本'&&!b.disabled)`);
    await capture('-prepared.png', '.storage-activation');
    await button('切换到恢复副本');
    await wait(`!!document.querySelector('.project-row')&&!document.querySelector('.storage-settings')`);
    let status = await api('storage.status'); assert.ok(inside(status.dataDir, restoredParent));
    assert.ok((await stat(path.join(initial.dataDir, 'autolabel.db'))).isFile());
    assert.equal((await api('provider.list')).find((p: any) => p.id === provider.id).hasCredential, false);
    assert.equal((await api('asset.get', { assetId })).draft[0].bbox.x, draftX);
    checks.push({ check: 'external-restore', invalidArchiveBlocked: true, prepareDidNotSwitch: true, explicitActivationButton: true, newDataDirActive: true, originalRetained: true, credentialRebindRequired: true, savedDraftRestored: true });

    await api('credential.set', { providerId: provider.id, key: 'storage-ui-rebound-fixture' });
    await workspace();
    const migrationParent = path.join(fixtures, 'migrated'); await mkdir(migrationParent);
    await queue('directory', migrationParent); await button('选择迁移目录');
    await wait(`document.querySelector('[aria-label="迁移目标父目录"]').value===${json(migrationParent)}`);
    await button('复制并切换');
    await wait(`!!document.querySelector('.project-row')&&!document.querySelector('.storage-settings')`);
    const migrated = await api('storage.status'); assert.ok(inside(migrated.dataDir, migrationParent)); assert.ok((await stat(path.join(status.dataDir, 'autolabel.db'))).isFile());
    assert.equal((await api('provider.list')).find((p: any) => p.id === provider.id).hasCredential, true);
    assert.equal((await api('asset.get', { assetId })).draft[0].bbox.x, draftX);
    await workspace(); await capture('-workspace.png', '.storage-data-dir');
    checks.push({ check: 'local-migration', currentCredentialsPreserved: true, originalRetained: true, migratedDraftReadable: true });
    await js(`document.querySelectorAll('.nav-item')[4].click()`); await wait(`!!document.querySelector('.resources-page')`); await button('新建资源');
    await fill('[aria-label="资源名称"]', '未保存导航保护');
    await wait(`document.querySelector('.resource-editor')?.innerText.includes('存在未保存编辑')`);
    assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存人工参考').disabled`), true);
    await js(`document.querySelectorAll('.nav-item')[6].click()`); await wait(`document.querySelector('.toast.error')?.innerText.includes('资源内容尚未保存')`);
    assert.equal(await js(`document.querySelector('[aria-label="资源名称"]').value`), '未保存导航保护');
    await button('放弃编辑并收起'); await js(`document.querySelectorAll('.nav-item')[6].click()`); await wait(`!!document.querySelector('.settings-tabs')`);
    checks.push({ check: 'resource-unsaved-guard', sidebarBlocked: true, referenceButtonDisabled: true, explicitDiscardAllowsNavigation: true });
    await writeFile(output, json({ passed: true, mode: 'storage-ui', newModelCalls: 0, checks }));
  } catch (e) { await writeFile(output.replace(/\.json$/, '-failure.png'), (await window.webContents.capturePage()).toPNG()); await writeFile(output, json({ passed: false, mode: 'storage-ui', checks, error: e instanceof Error ? e.message : String(e), body: await js(`document.body.innerText`) })); throw e; }
}
