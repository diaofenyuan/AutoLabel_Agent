import test from 'node:test';
import assert from 'node:assert/strict';
import { formatChatMemory } from '../src/chatMemory';
import type { ChatMemorySnapshot } from '../../shared/chat';

test('对话摘要格式包含全部历史目标、结论和素材范围', () => {
  const memory: ChatMemorySnapshot = {
    projectId: 'project-1', generatedAt: '2026-10-07T00:00:00.000Z', truncatedCount: 1,
    conversations: [{ id: 's-1', projectId: 'project-1', title: '车辆检查', updatedAt: '2026-10-06T00:00:00.000Z', messageCount: 4,
      firstUser: '先整理车辆素材', lastAssistant: '已整理完成', context: { scope: 'selected', assetIds: ['a-1', 'a-2'], referenceAssetIds: ['r-1'] } }],
  };
  const result = formatChatMemory(memory);
  assert.match(result, /车辆检查/);
  assert.match(result, /先整理车辆素材/);
  assert.match(result, /已整理完成/);
  assert.match(result, /已勾选素材 2 项/);
  assert.match(result, /人工参考 1 项/);
  assert.match(result, /另有 1 条历史摘要因长度限制省略/);
});

test('没有历史摘要时不向助手注入空背景', () => {
  assert.equal(formatChatMemory(undefined), '');
  assert.equal(formatChatMemory({ projectId: 'project-1', generatedAt: '2026-10-07T00:00:00.000Z', conversations: [], truncatedCount: 0 }), '');
});
