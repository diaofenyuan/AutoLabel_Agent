import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from './chat-store';

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
    let file = await readFile(path.join(root, `${sessionId}.jsonl`), 'utf8');
    assert.deepEqual(file.trim().split('\n').map(line => JSON.parse(line).content), ['第一句', '回复一']);

    // 第二轮：完整历史（上一轮 + 新消息）只追加增量。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复一' }, { role: 'user', content: '第二句' }], reply: '回复二' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 4);
    file = await readFile(path.join(root, `${sessionId}.jsonl`), 'utf8');
    assert.deepEqual(file.trim().split('\n').map(line => JSON.parse(line).content), ['第一句', '回复一', '第二句', '回复二']);

    // 同一轮重复提交：内容与落库完全一致，不再追加。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复一' }, { role: 'user', content: '第二句' }], reply: '回复二' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 4);

    // 界面历史比落库短（读盘失败、会话列表被清）：新的一轮照样落库，不丢消息。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '补记的一句' }], reply: '补记回复' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 6);
    file = await readFile(path.join(root, `${sessionId}.jsonl`), 'utf8');
    assert.deepEqual(file.trim().split('\n').map(line => JSON.parse(line).content), ['第一句', '回复一', '第二句', '回复二', '补记的一句', '补记回复']);

    // 提交的消息全部是落库内容的子集（重复提交旧的一轮）：不追加任何内容。
    await store.record({ sessionId, providerId: 'p', model: 'm', messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回复一' }], reply: '复读回复' });
    entry = (await store.list()).sessions.find(item => item.id === sessionId);
    assert.equal(entry?.messageCount, 6);
    file = await readFile(path.join(root, `${sessionId}.jsonl`), 'utf8');
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
