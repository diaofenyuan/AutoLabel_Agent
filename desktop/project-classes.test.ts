import test from 'node:test';
import assert from 'node:assert/strict';
import { addProjectClasses } from './project-classes';

/**
 * 助手的建类别能力是「只增不改」的窄口径：放开整个 project.update 会把 settings（模板与规则）一起交出去。
 * 这条测试锁住两点——真正落库的只有 classes 与 projectId，以及「新增/跳过」由命令如实回报。
 */
function fixture(classes: Array<{ id: string; name: string; color: string }>) {
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    engine: {
      async request(command: string, payload: Record<string, unknown> = {}) {
        calls.push({ command, payload });
        if (command === 'project.list') return [{ id: 'project-1', name: '标注视频', classes }];
        if (command === 'project.update') return { id: 'project-1', name: '标注视频', classes: payload.classes };
        throw new Error(`未预期的命令：${command}`);
      },
    },
  };
}

test('只写类别与项目标识，重名跳过并如实回报', async () => {
  const f = fixture([{ id: 'box', name: '箱子', color: '#4a83ff' }]);
  const result = await addProjectClasses(f.engine, { projectId: 'project-1', names: ['箱子', '箱子', '粉色手办'] });
  const write = f.calls.find(call => call.command === 'project.update')!;
  assert.deepEqual(Object.keys(write.payload).sort(), ['classes', 'projectId'], '只允许写类别与项目标识');
  assert.deepEqual(result.added, ['粉色手办']);
  assert.deepEqual(result.skipped, ['箱子']);
  assert.deepEqual(result.classes.map(item => item.name), ['箱子', '粉色手办']);
  const added = result.classes.find(item => item.name === '粉色手办')!;
  assert.ok(added.id && added.id !== 'box', '新类别要有自己的标识');
  assert.match(added.color, /^#[0-9a-f]{6}$/i, '新类别要有可用配色');

  // 全都是重名时不发起写入，避免一次无意义的 project.update。
  const before = f.calls.length;
  const again = await addProjectClasses(f.engine, { projectId: 'project-1', names: ['箱子'] });
  assert.deepEqual(again.added, []);
  assert.equal(f.calls.length, before + 1, '只应发生一次读取，不再写入');
});

test('项目不存在时明确拒绝，不猜一个项目出来', async () => {
  const f = fixture([]);
  await assert.rejects(addProjectClasses(f.engine, { projectId: 'missing', names: ['箱子'] }), /项目不存在/);
});
