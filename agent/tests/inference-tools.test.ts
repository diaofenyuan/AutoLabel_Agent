import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LOCAL_TOOL_DEFINITIONS } from '../inference-tools.ts';
import type { ToolEnvironment } from '../tools.ts';
import type { EngineClient } from '../types.ts';

type RecordValue = Record<string, unknown>;
const tool = (name: string) => LOCAL_TOOL_DEFINITIONS.find(tool => tool.name === name)!;
function fixture() {
  const calls: Array<{ command: string; payload: RecordValue }> = [];
  const state = {
    models: Array.from({ length: 101 }, (_, index) => ({ id: `model-${index}`, version: index + 2, kind: 'local_model', taskType: 'detect', format: 'onnx',
      name: `检测模型 ${index}`, modelPath: 'D:/private/model', content: { private: '完整配置' } } as RecordValue)),
    runtime: { configured: true, workerAvailable: true, available: true, workerHash: 'worker-hash', pythonVersion: '3.11',
      pythonPath: 'D:/private/python.exe', devices: [{ id: 'cpu', name: 'CPU', path: 'D:/private/device' }],
      slots: [{ device: 'cpu', busy: true, modelId: 'model-1', modelVersion: 3, runId: 'local-run', inputId: 'view-input', workerHash: 'worker-hash',
        classes: [{ id: '0', name: '目标', private: '完整配置' }], modelPath: 'D:/private/model',
        observedBackend: { kind: 'pytorch', device: 'cpu', providers: null, private: '完整配置' } }],
      issue: { code: 'device_busy', message: 'CPU 正在执行任务', private: '完整配置' } } as RecordValue,
  };
  const abort = new AbortController();
  const engine: EngineClient = { async request<T>(command: string, payload: RecordValue = {}) {
    calls.push({ command, payload });
    if (command === 'local.model.list') return { total: state.models.length, items: state.models.slice(payload.offset as number, (payload.offset as number) + (payload.limit as number)) } as T;
    if (command === 'local.runtime.get') return structuredClone(state.runtime) as T;
    throw new Error('禁止调用有副作用的本地命令');
  } };
  const environment: ToolEnvironment = { engine, context: {}, openAsset() {}, signal: abort.signal };
  return { calls, state, abort, environment };
}

test('只读模型列表按实际分页和版本返回，第二页不遗漏且不暴露文件配置', async () => {
  const f = fixture();
  const first = await tool('list_local_models').execute({}, f.environment) as RecordValue;
  assert.deepEqual(f.calls[0].payload, { offset: 0, limit: 100 }); assert.equal(first.total, 101); assert.equal(first.nextOffset, 100);
  assert.equal((first.items as RecordValue[])[0].version, 2);
  const second = await tool('list_local_models').execute({ offset: first.nextOffset, limit: 500, taskType: 'detect' }, f.environment) as RecordValue;
  assert.equal((second.items as RecordValue[])[0].id, 'model-100'); assert.equal((second.items as RecordValue[])[0].version, 102); assert.equal(second.nextOffset, null);
  assert.equal(JSON.stringify([first, second]).includes('D:/private'), false); assert.equal(JSON.stringify(first).includes('完整配置'), false);
  for (const args of [{ limit: 501 }, { offset: -1 }, { offset: 1.1 }, { taskType: 'unknown' }, { modelPath: 'D:/private/model' }, { register: true }])
    await assert.rejects(tool('list_local_models').execute(args, f.environment));
  f.state.models[1] = f.state.models[0];
  await assert.rejects(tool('list_local_models').execute({}, f.environment), /分页重复/);
  assert.equal(f.calls.every(call => call.command === 'local.model.list'), true);
});

test('本地运行环境只读取真实槽和类别，拒绝注入命令、重复类别与过长列表', async () => {
  const f = fixture();
  const result = await tool('get_local_runtime').execute({}, f.environment) as RecordValue;
  const slot = (result.slots as RecordValue[])[0];
  assert.deepEqual(slot.classes, [{ id: '0', name: '目标' }]); assert.equal(slot.modelVersion, 3); assert.equal(slot.inputId, 'view-input');
  assert.deepEqual(slot.observedBackend, { kind: 'pytorch', device: 'cpu', providers: null });
  assert.equal(JSON.stringify(result).includes('D:/private'), false); assert.equal(JSON.stringify(result).includes('完整配置'), false);
  for (const args of [{ probe: true }, { configure: true }, { authorize: true }, { pythonPath: 'D:/private/python' }])
    await assert.rejects(tool('get_local_runtime').execute(args, f.environment), /不支持的参数/);
  const rawSlot = (f.state.runtime.slots as RecordValue[])[0];
  rawSlot.classes = [{ id: '0', name: '甲' }, { id: '0', name: '乙' }];
  await assert.rejects(tool('get_local_runtime').execute({}, f.environment), /类别列表重复/);
  rawSlot.classes = Array.from({ length: 10001 }, (_, index) => ({ id: String(index), name: '目标' }));
  await assert.rejects(tool('get_local_runtime').execute({}, f.environment), /类别列表超出范围/);
  f.abort.abort();
  await assert.rejects(tool('get_local_runtime').execute({}, f.environment), /对话已停止/);
  assert.equal(f.calls.every(call => call.command === 'local.runtime.get'), true);
  assert.equal(LOCAL_TOOL_DEFINITIONS.every(tool => !tool.mutation), true);
});
