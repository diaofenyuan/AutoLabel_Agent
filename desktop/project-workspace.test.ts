import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from './chat-store';
import { UNASSIGNED_PROJECT_ID, detectLegacyChatLayout, migrateLegacyChatLayout, ProjectWorkspace } from './project-workspace';

/**
 * 迁移是升级路径上唯一一次「拿历史数据做结构变换」的环节，出错的代价是用户丢对话。
 * 这里的每条断言都对应一个真实风险：迁丢、迁重、来源不明时消失、以及重复执行。
 */
test('旧版扁平对话按项目迁入工作区，无归属会话进收容目录且源目录保留', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-migrate-'));
  const legacy = path.join(root, 'chats');
  const workspace = new ProjectWorkspace(() => root);
  try {
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'index.json'), '[]');
    await assert.equal(await detectLegacyChatLayout(legacy, workspace.base()), true);

    const result = await migrateLegacyChatLayout(legacy, workspace, async () => [
      { id: 'owned', projectId: 'project-a', messages: [{ role: 'user', content: 'A 的历史' }, { role: 'assistant', content: '答' }] },
      { id: 'orphan', messages: [{ role: 'user', content: '没有归属的历史' }] },
    ]);

    assert.equal(result.migrated, 1);
    assert.equal(result.unassigned, 1);
    assert.deepEqual(result.failures, []);

    // 消息完整落在对应项目目录下。
    const owned = await readFile(path.join(root, 'projects', 'project-a', 'chats', 'owned.jsonl'), 'utf8');
    assert.deepEqual(owned.trim().split('\n').map(line => JSON.parse(line).content), ['A 的历史', '答']);
    // 无归属的历史不能消失：进收容目录，仍然读得到。
    const orphan = await readFile(path.join(root, 'projects', UNASSIGNED_PROJECT_ID, 'chats', 'orphan.jsonl'), 'utf8');
    assert.match(orphan, /没有归属的历史/);

    // 源目录原样保留：迁移出错时用户的原始数据还在。
    assert.match(await readFile(path.join(legacy, 'index.json'), 'utf8'), /\[\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('已迁移或全新安装时跳过，不重复搬动数据', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-migrate-skip-'));
  const legacy = path.join(root, 'chats');
  const workspace = new ProjectWorkspace(() => root);
  try {
    // 全新安装：旧目录根本没有 index.json。
    assert.equal(await detectLegacyChatLayout(legacy, workspace.base()), false);
    assert.equal((await migrateLegacyChatLayout(legacy, workspace, async () => [])).skipped, true);

    // 有旧数据但已落过完成标记：不应再次搬运。
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'index.json'), '[]');
    await workspace.ensure('project-a');
    // 关键回归点：projects/ 已因正常业务建出来，但这不等于「旧数据已迁移」。
    assert.equal(await detectLegacyChatLayout(legacy, workspace.base()), true, '项目目录存在不应被当作迁移完成的证据');
    await migrateLegacyChatLayout(legacy, workspace, async () => []);
    assert.equal(await detectLegacyChatLayout(legacy, workspace.base()), false, '迁移完成后应落下标记，重复执行直接跳过');
    assert.equal((await migrateLegacyChatLayout(legacy, workspace, async () => [])).skipped, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('项目共享上下文可读写，损坏时退回空上下文而不是报错', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-project-context-'));
  const workspace = new ProjectWorkspace(() => root);
  try {
    // 首次读取：还没有上下文文件，按无默认值处理。
    assert.equal(await workspace.readContext('project-a'), undefined);

    const written = await workspace.writeContext('project-a', { scope: 'selected', assetIds: ['a1', 'a2'] });
    assert.equal(written.projectId, 'project-a');
    assert.deepEqual((await workspace.readContext('project-a'))?.context, { scope: 'selected', assetIds: ['a1', 'a2'] });

    // 上下文只是新对话的默认值来源，损坏不该挡住用户继续对话。
    await writeFile(path.join(root, 'projects', 'project-a', 'context.json'), '{broken', 'utf8');
    assert.equal(await workspace.readContext('project-a'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('项目删除后保留回收站：素材与项目文件清掉，对话仍可恢复', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-project-trash-keep-'));
  const workspace = new ProjectWorkspace(() => root);
  try {
    const paths = await workspace.ensure('project-a');
    // media/ 由引擎按需创建，桌面侧只负责删除，这里显式建出来模拟已有素材。
    await mkdir(paths.media, { recursive: true });
    await writeFile(path.join(paths.media, 'asset.png'), 'x', 'utf8');
    await workspace.writeContext('project-a', { scope: 'project' });
    await mkdir(path.join(paths.chats, '.trash'), { recursive: true });
    await writeFile(path.join(paths.chats, '.trash', 'entry.json'), '{}', 'utf8');

    await workspace.removeAfterDelete('project-a');

    // 素材、上下文、项目文件都不留。
    await assert.rejects(readFile(path.join(paths.media, 'asset.png'), 'utf8'));
    assert.equal(await workspace.readContext('project-a'), undefined);
    // 回收站必须还在：否则「删除后 7 天可恢复」就是一句空话。
    assert.match(await readFile(path.join(paths.chats, '.trash', 'entry.json'), 'utf8'), /\{}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('项目文件夹按项目隔离，删除只影响该项目', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-project-isolation-'));
  const workspace = new ProjectWorkspace(() => root);
  try {
    await workspace.ensure('project-a');
    await workspace.ensure('project-b');
    assert.deepEqual((await workspace.list()).sort(), ['project-a', 'project-b']);

    const statusA = await workspace.status('project-a', 3);
    assert.equal(statusA.exists, true);
    assert.equal(statusA.conversations, 3);
    // 两个项目的路径互不包含：这是「数据互不干扰」的目录层保证。
    assert.ok(!statusA.root.includes('project-b'));
    assert.ok(statusA.chats.startsWith(statusA.root), '对话目录必须位于项目文件夹内部');

    // 写入内容后占用统计才反映真实体积（空目录本身就是 0 字节）。
    await workspace.writeContext('project-a', { scope: 'project' });
    assert.ok((await workspace.status('project-a', 3)).bytes > 0, '写入上下文后应统计到占用');

    await workspace.remove('project-a');
    assert.equal(await workspace.exists('project-a'), false);
    assert.equal(await workspace.exists('project-b'), true, '删除 A 不应影响 B');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
/**
 * 升级路径的端到端保证：旧目录里的对话，迁移后必须在侧栏里真的出现。
 *
 * 单测分别覆盖过「文件搬过去了」和「会话按项目隔离」，但这两步之间的关键是
 * **重建项目索引**——只搬消息文件而不补索引，历史就在侧栏里消失了。
 * 这一条直接对应「升级后历史对话不丢失」，因此按主流程的真实顺序整体走一遍。
 */
test('旧目录迁移后历史对话在侧栏可见，消息完整且归属正确', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-migrate-e2e-'));
  const legacy = path.join(root, 'chats');
  const workspace = new ProjectWorkspace(() => root);
  const store = new ChatStore(() => root);
  try {
    // 旧版扁平布局：一个跨两个项目的会话 + 一个没有归属的会话。
    await mkdir(legacy, { recursive: true });
    const summaries = [
      { id: 'old-a', projectId: 'project-a', title: '上次的标注会话' },
      { id: 'old-orphan', title: '无归属的历史' },
    ];
    await writeFile(path.join(legacy, 'index.json'), JSON.stringify(summaries));
    await writeFile(path.join(legacy, 'old-a.jsonl'),
      `${JSON.stringify({ role: 'user', content: '把车框出来' })}\n${JSON.stringify({ role: 'assistant', content: '已框出 3 辆车' })}\n`, 'utf8');
    await writeFile(path.join(legacy, 'old-orphan.jsonl'), `${JSON.stringify({ role: 'user', content: '老问题' })}\n`, 'utf8');

    // 第一步：按归属把消息文件搬进项目文件夹。
    const result = await migrateLegacyChatLayout(legacy, workspace, async () => [
      { id: 'old-a', projectId: 'project-a', title: '上次的标注会话', messages: [{ role: 'user', content: '把车框出来' }, { role: 'assistant', content: '已框出 3 辆车' }] },
      { id: 'old-orphan', title: '无归属的历史', messages: [{ role: 'user', content: '老问题' }] },
    ]);
    assert.equal(result.migrated, 1);
    assert.equal(result.unassigned, 1);

    // 第二步：重建索引（主进程迁移流程里的同一步）。
    for (const summary of summaries) {
      await store.ensure({ sessionId: summary.id, ...(summary.projectId ? { projectId: summary.projectId } : {}), ...(summary.title ? { title: summary.title } : {}) });
    }

    // 迁移后的历史必须出现在列表里，且按项目分组正确。
    const all = await store.list();
    assert.deepEqual(all.sessions.map(item => item.id).sort(), ['old-a', 'old-orphan']);
    assert.deepEqual((await store.list('project-a')).sessions.map(item => item.id), ['old-a']);
    assert.equal(all.sessions.find(item => item.id === 'old-a')?.projectId, 'project-a');
    assert.equal(all.sessions.find(item => item.id === 'old-orphan')?.projectId, UNASSIGNED_PROJECT_ID);

    // 标题与消息都要还原：只搬文件不补内容等于迁了个空壳。
    assert.equal(all.sessions.find(item => item.id === 'old-a')?.title, '上次的标注会话');
    const restored = await store.get('old-a');
    assert.deepEqual(restored.messages.map(message => message.content), ['把车框出来', '已框出 3 辆车']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
