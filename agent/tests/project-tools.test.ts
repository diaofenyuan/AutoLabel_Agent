import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TOOL_DEFINITIONS } from '../tools.ts';
import type { ToolEnvironment } from '../tools.ts';
import type { EngineClient } from '../types.ts';

type RecordValue = Record<string, unknown>;
const tool = (name: string) => TOOL_DEFINITIONS.find(value => value.name === name)!;

/**
 * 助手原先完全没有建类别能力：用户说「类别用粉色手办」，它只能回「请先在项目设置里新建检测类别」——
 * 而产品里并没有叫「项目设置」的入口。这条测试锁住新能力与它的边界（只增不改）。
 */
function fixture(classes: Array<{ id: string; name: string }> = [{ id: 'box', name: '箱子' }]) {
  const calls: Array<{ command: string; payload: RecordValue }> = [];
  const engine: EngineClient = { async request<T>(command: string, payload: RecordValue = {}) {
    calls.push({ command, payload });
    if (command === 'project.list') return [{ id: 'project-1', name: '标注视频', taskType: 'detect', classes, assetCount: 3, annotatedCount: 0, confirmedCount: 0 }] as T;
    if (command === 'project.open') return { id: 'project-1', name: '标注视频', taskType: 'detect', classes, settings: {}, assetCount: 3, annotatedCount: 0, confirmedCount: 0 } as T;
    if (command === 'project.classes.add') {
      // 与桌面侧同一份契约：新增与被跳过的名字由命令返回，助手不做二次判断。
      const names = payload.names as string[];
      const additions = names.filter(name => !classes.some(item => item.name === name));
      const merged = [...classes, ...additions.map((name, index) => ({ id: `new-${index}`, name }))];
      return { projectId: 'project-1', added: additions, skipped: names.filter(name => !additions.includes(name)),
        classes: merged.map(item => ({ id: item.id, name: item.name })) } as T;
    }
    if (command === 'project.update') return { id: 'project-1', name: '标注视频', classes: payload.classes } as T;
    throw new Error(`未预期的命令：${command}`);
  } };
  const environment: ToolEnvironment = { engine, projectId: 'project-1', context: {}, openAsset: () => {} };
  return { calls, environment };
}

test('用户给出类别名时助手可以直接建类，重名跳过并回报真实清单', async () => {
  const f = fixture();
  const created = await tool('set_project_classes').execute({ names: ['粉色手办'] }, f.environment) as RecordValue;
  assert.deepEqual(f.calls.at(-1), { command: 'project.classes.add', payload: { projectId: 'project-1', names: ['粉色手办'] } });
  assert.deepEqual(created.added, ['粉色手办']);
  assert.deepEqual((created.classes as RecordValue[]).map(item => item.name), ['箱子', '粉色手办']);

  // 重复项在工具侧就去重，不必让引擎收到两个一样的名字。
  const again = await tool('set_project_classes').execute({ names: ['箱子', '箱子'] }, f.environment) as RecordValue;
  assert.deepEqual(again.added, [], `重名不应新增，实际：${JSON.stringify(again)}`);
  assert.deepEqual(again.skipped, ['箱子'], '被跳过的名字要如实回报，助手才知道它没生效');
  assert.deepEqual((f.calls.at(-1)!.payload.names as string[]), ['箱子'], '重复项应先去重');

  // 形状问题在工具内拒绝，不靠引擎报错；空白名同样拒绝而不是静默丢掉。
  await assert.rejects(tool('set_project_classes').execute({ names: [] }, f.environment), /类别名|至少/);
  await assert.rejects(tool('set_project_classes').execute({ names: ['  '] }, f.environment), /不能为空/);
  await assert.rejects(tool('set_project_classes').execute({ names: Array.from({ length: 21 }, (_, i) => `c${i}`) }, f.environment), /20/);
  await assert.rejects(tool('set_project_classes').execute({ names: ['a'], projectId: 'other' }, f.environment), /不支持的参数/);
  await assert.rejects(tool('set_project_classes').execute({ names: ['x'.repeat(61)] }, f.environment), /60/);
});

test('助手侧只提交类别名，写操作标记为 mutation', async () => {
  const f = fixture();
  await tool('set_project_classes').execute({ names: ['粉色手办'] }, f.environment);
  const writes = f.calls.filter(call => call.command === 'project.classes.add');
  assert.equal(writes.length, 1, '应只发生一次建类别调用');
  assert.deepEqual(Object.keys(writes[0].payload).sort(), ['names', 'projectId'], `助手只允许提交类别名，实际：${JSON.stringify(writes[0].payload)}`);
  assert.equal(tool('set_project_classes').mutation, true, '写操作必须标记为 mutation，先看方案时才不会被执行');
});

test('缺少类别时的提示指向真实入口，并说明可以直接建', async () => {
  const f = fixture([]);
  await assert.rejects(tool('run_annotation').execute({ prompt: '标出箱子' }, f.environment), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CLASSES_REQUIRED');
    assert.match(error.message, /类别与点位模板/, `应指向真实入口，实际：${error.message}`);
    assert.match(error.message, /set_project_classes/, `应说明可以直接建，实际：${error.message}`);
    assert.doesNotMatch(error.message, /项目设置/, '不存在的入口不能出现在提示里');
    return true;
  });
});
