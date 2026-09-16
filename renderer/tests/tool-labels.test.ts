import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../../agent/tools.ts';
import { toolLabel, toolNames } from '../src/toolLabels';

/**
 * 工具中文名的完整性。
 * 走查里出现过助手步骤显示英文原名（`preview_image_screening`）——映射表没跟上工具改名与新增，
 * 用户看到那一行并不知道刚才发生了什么。这条断言把「漏映射」变成红灯，而不是靠人眼发现。
 */
test('每个助手工具都有中文名，且不保留已不存在的旧键', () => {
  const names = TOOL_DEFINITIONS.map(tool => tool.name);
  assert.ok(names.length > 40, `工具清单应被真的读到，实际 ${names.length} 个`);
  const missing = names.filter(name => !toolNames[name]);
  assert.deepEqual(missing, [], `以下工具缺少中文名：${missing.join('、')}`);
  const known = new Set(names);
  const stale = Object.keys(toolNames).filter(name => !known.has(name));
  assert.deepEqual(stale, [], `以下映射指向已不存在的工具：${stale.join('、')}`);
  for (const name of names) {
    const label = toolLabel(name);
    assert.notEqual(label, name, `${name} 回落到了英文原名`);
    assert.doesNotMatch(label, /[a-z]_/, `${name} 的中文名里不应含工具名风格的下划线`);
  }
  // 未收录的名字仍如实回原名，不假装它是什么操作。
  assert.equal(toolLabel('not_a_real_tool'), 'not_a_real_tool');
});
