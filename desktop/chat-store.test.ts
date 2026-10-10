import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from './chat-store';
import { UNASSIGNED_PROJECT_ID } from './project-workspace';

/** record 是历史可见性的根基：重复提交不产生重复消息，界面历史比落库短时也不能把新一轮整段丢掉。 */
test('对话记录按前缀对齐落盘：正常追加、重复提交跳过、历史缺失时补记', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-store-'));
  const store = new ChatStore(() => root);
  try {
    const sessionId = 'record-align-test';

    // 第一轮：用户消息 + 回复落库。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '第一句' }], reply: '回复一' });
    let entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 2);
    assert.equal(entry?.title, '第一句');
    let file = await readFile(path.join(root, 'projects', UNASSIGNED_PROJECT_ID, 'chats', `${sessionId}.jsonl`), 'utf8');
    assert.deepEqual(file.trim().split('\n').map(line => JSON.parse(line).content), ['第一句', '回复一']);

    // 第二轮：完整历史（上一轮 + 新消息）只追加增量。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复一' }, { role: 'user', content: '第二句' }], reply: '回复二' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 4);
    file = await readFile(path.join(root, 'projects', UNASSIGNED_PROJECT_ID, 'chats', `${sessionId}.jsonl`), 'utf8');
    assert.deepEqual(file.trim().split('\n').map(line => JSON.parse(line).content), ['第一句', '回复一', '第二句', '回复二']);

    // 同一轮重复提交：内容与落库完全一致，不再追加。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复一' }, { role: 'user', content: '第二句' }], reply: '回复二' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 4);

    // 界面历史比落库短（读盘失败、会话列表被清）：新的一轮照样落库，不丢消息。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '补记的一句' }], reply: '补记回复' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 6);
    file = await readFile(path.join(root, 'projects', UNASSIGNED_PROJECT_ID, 'chats', `${sessionId}.jsonl`), 'utf8');
    assert.deepEqual(file.trim().split('\n').map(line => JSON.parse(line).content), ['第一句', '回复一', '第二句', '回复二', '补记的一句', '补记回复']);

    // 提交的消息全部是落库内容的子集（重复提交旧的一轮）：不追加任何内容。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复一' }], reply: '复读回复' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 6);
    file = await readFile(path.join(root, 'projects', UNASSIGNED_PROJECT_ID, 'chats', `${sessionId}.jsonl`), 'utf8');
    const contents = file.trim().split('\n').map(line => JSON.parse(line).content);
    assert.equal(contents.filter(item => item === '第一句').length, 1, '已有的消息不能重复落库');
    assert.ok(!contents.includes('复读回复'), '整轮重复提交时回复也不重复追加');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('自动标题取首行：随消息附带的素材括注不进标题', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-store-title-'));
  const store = new ChatStore(() => root);
  try {
    const sessionId = 'title-first-line-test';
    await store.record({ sessionId, providerId: 'p', model: 'm',
      messages: [{ role: 'user', content: '把车框出来\n（随消息添加素材：a.jpg、b.mp4（视频））' }], reply: '收到' });
    const entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.title, '把车框出来');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除项目时其对话一并移入回收站，其他项目的会话不受影响', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-store-project-'));
  const store = new ChatStore(() => root);
  try {
    await store.record({ sessionId: 'doomed', projectId: 'project-gone', providerId: 'p', model: 'm', messages: [{ role: 'user', content: '被删项目的对话' }], reply: '好' });
    await store.record({ sessionId: 'kept', projectId: 'project-alive', providerId: 'p', model: 'm', messages: [{ role: 'user', content: '在用项目的对话' }], reply: '好' });

    assert.equal(await store.deleteByProject('project-gone'), 1);
    const sessions = (await store.list()).sessions;
    assert.deepEqual(sessions.map(item => item.id), ['kept']);

    // 回收站里能按既有入口恢复，恢复后消息完整。
    const trash = await store.trashList();
    assert.equal(trash.entries.length, 1);
    assert.equal(trash.entries[0].sessionId, 'doomed');
    const restored = await store.restore([trash.entries[0].id]);
    assert.equal(restored.restored, 1);
    const recovered = await store.get('doomed');
    assert.deepEqual(recovered.messages.map(message => message.content), ['被删项目的对话', '好']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('从项目派生新对话时保留全部历史摘要和最近会话素材范围', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-store-fork-'));
  const store = new ChatStore(() => root);
  try {
    await store.record({ sessionId: 'history-one', projectId: 'project-1', providerId: 'p', model: 'm',
      messages: [{ role: 'user', content: '先整理车辆素材' }], reply: '已整理车辆素材',
      context: { scope: 'selected', assetIds: ['asset-1', 'asset-2'], referenceAssetIds: ['reference-1'] } });
    await store.record({ sessionId: 'history-two', projectId: 'project-1', providerId: 'p', model: 'm',
      messages: [{ role: 'user', content: '再检查行人' }], reply: '已检查行人',
      context: { scope: 'project' } });
    await store.record({ sessionId: 'outside', projectId: 'project-2', providerId: 'p', model: 'm',
      messages: [{ role: 'user', content: '项目外的内容' }], reply: '不应进入摘要' });

    const forked = await store.fork({ sessionId: 'history-new', projectId: 'project-1', projectName: '车辆项目' });
    assert.equal(forked.id, 'history-new');
    assert.deepEqual(forked.context, { scope: 'project' });
    assert.deepEqual(forked.memory?.conversations.map(item => item.title), ['再检查行人', '先整理车辆素材']);
    assert.ok(forked.memory?.conversations.every(item => item.projectId === 'project-1'));

    const reloaded = await store.get('history-new');
    assert.deepEqual(reloaded.context, { scope: 'project' });
    assert.deepEqual(reloaded.memory?.conversations.map(item => item.lastAssistant), ['已检查行人', '已整理车辆素材']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('派生对话删除后恢复仍保留快照，损坏快照只给出警告', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-store-memory-life-'));
  const store = new ChatStore(() => root);
  try {
    await store.record({ sessionId: 'source', projectId: 'project-1', providerId: 'p', model: 'm',
      messages: [{ role: 'user', content: '保留这段背景' }], reply: '背景已记录', context: { scope: 'selected', assetIds: ['asset-1'] } });
    await store.fork({ sessionId: 'derived', projectId: 'project-1', projectName: '项目' });
    const memoryFile = path.join(root, 'projects', 'project-1', 'chats', 'derived.memory.json');
    assert.match(await readFile(memoryFile, 'utf8'), /背景已记录/);

    const trash = await store.delete(['derived']);
    assert.equal(trash.removed, 1);
    const trashEntries = await store.trashList();
    assert.equal((await store.restore([trashEntries.entries[0].id])).restored, 1);
    assert.equal((await store.get('derived')).memory?.conversations[0].lastAssistant, '背景已记录');

    await writeFile(memoryFile, '{broken', 'utf8');
    const reloaded = await store.get('derived');
    assert.equal(reloaded.memory, undefined);
    assert.match((await store.list()).warning ?? '', /摘要/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * 项目隔离的三个关键行为：会话按项目分目录落盘、跨项目查询仍然完整、
 * 会话改归属时文件跟着搬而不是复制一份。任一条退化都会让「项目之间数据互不干扰」失效。
 */
test('会话按项目分目录落盘，跨项目列表与按项目过滤都正确', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-isolation-'));
  const store = new ChatStore(() => root);
  try {
    await store.record({ sessionId: 'in-a', projectId: 'project-a', providerId: 'p', model: 'm', messages: [{ role: 'user', content: 'A 的问题' }], reply: 'A 答' });
    await store.record({ sessionId: 'in-b', projectId: 'project-b', providerId: 'p', model: 'm', messages: [{ role: 'user', content: 'B 的问题' }], reply: 'B 答' });

    // 两个项目的消息文件各自落在自己的目录里，不共用一份索引。
    const a = await readFile(path.join(root, 'projects', 'project-a', 'chats', 'in-a.jsonl'), 'utf8');
    const b = await readFile(path.join(root, 'projects', 'project-b', 'chats', 'in-b.jsonl'), 'utf8');
    assert.match(a, /A 的问题/); assert.ok(!a.includes('B 的问题'));
    assert.match(b, /B 的问题/); assert.ok(!b.includes('A 的问题'));

    // 按项目过滤只返回本项目会话；不带参数则跨全部项目返回。
    assert.deepEqual((await store.list('project-a')).sessions.map(item => item.id), ['in-a']);
    assert.deepEqual((await store.list()).sessions.map(item => item.id).sort(), ['in-a', 'in-b']);

    // 按 id 读取不依赖调用方知道归属：路由缓存建立后仍然命中正确项目。
    assert.deepEqual((await store.get('in-b')).messages.map(message => message.content), ['B 的问题', 'B 答']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('会话改归属时文件搬迁而不是复制，重命名与置顶跟随新项目', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-move-'));
  const store = new ChatStore(() => root);
  try {
    await store.ensure({ sessionId: 'movable', title: '待归属' });
    assert.equal((await store.get('movable')).projectId, UNASSIGNED_PROJECT_ID, '未指定项目的会话先进收容目录');

    // 并入项目：文件搬到项目目录，收容目录不再残留同名会话。
    await store.ensure({ sessionId: 'movable', projectId: 'project-a' });
    assert.deepEqual((await store.list('project-a')).sessions.map(item => item.id), ['movable']);
    assert.deepEqual((await store.list(UNASSIGNED_PROJECT_ID)).sessions, []);

    // 搬迁后写入的消息仍落在新项目，历史不丢也不重复。
    await store.record({ sessionId: 'movable', projectId: 'project-a', providerId: 'p', model: 'm', messages: [{ role: 'user', content: '并入后的问题' }], reply: '答' });
    const moved = await store.get('movable');
    assert.equal(moved.projectId, 'project-a');
    assert.deepEqual(moved.messages.map(message => message.content), ['并入后的问题', '答']);
    await assert.rejects(readFile(path.join(root, 'projects', UNASSIGNED_PROJECT_ID, 'chats', 'movable.jsonl'), 'utf8'), '收容目录不应残留消息文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('回收站按项目隔离：删除只影响本项目，清空与恢复仍跨项目可用', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-chat-trash-scope-'));
  const store = new ChatStore(() => root);
  try {
    await store.record({ sessionId: 'del-a', projectId: 'project-a', providerId: 'p', model: 'm', messages: [{ role: 'user', content: 'A' }], reply: 'a' });
    await store.record({ sessionId: 'del-b', projectId: 'project-b', providerId: 'p', model: 'm', messages: [{ role: 'user', content: 'B' }], reply: 'b' });

    await store.delete(['del-a']);
    assert.deepEqual((await store.list('project-b')).sessions.map(item => item.id), ['del-b'], 'B 项目不受 A 项目删除影响');
    // 回收站条目带归属，恢复时写回原项目而不是收容目录。
    const entries = (await store.trashList()).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].projectId, 'project-a');
    await store.restore([entries[0].id]);
    assert.deepEqual((await store.list('project-a')).sessions.map(item => item.id), ['del-a']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
