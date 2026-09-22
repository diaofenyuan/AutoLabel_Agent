/**
 * 「手办标注」端到端基线（真实接口、隔离数据目录）。
 *
 * 它回答一个问题：一个只想把「画面中间那个手办」标出来的用户，从零到出候选框这条路到底通不通、
 * 出错时是不是给的是能行动的拒绝而不是假结果。三段断言：
 * 1. 正例：视觉模型跑真实帧图 → 候选落库（记录对象数、耗时、实发体积）；
 * 2. 反例一：纯文本模型必须被能力验证拦下，硬跑也只失败、不许把垃圾写成标注（素材版本不变）；
 * 3. 反例二：中文新词必须被显式拒绝（vocabulary_term_needs_english）——由 inference/validate_vocabulary.py 承担，
 *    这里调用并要求全绿，保证两条链路对同一个承诺口径一致。
 *
 * 密钥只从环境变量读，不落盘、不写进报告。
 *
 * 用法（PowerShell）：
 *   $env:AUTOLABEL_TEST_BASE_URL='https://example.com/v1'
 *   $env:AUTOLABEL_TEST_KEY='sk-...'
 *   $env:AUTOLABEL_TEST_MODEL='vision-model-id'
 *   $env:AUTOLABEL_TEST_TEXT_MODEL='text-model-id'   # 可选；给了就跑反例一
 *   $env:AUTOLABEL_TEST_IMAGE='D:\some\figurine-frame.png'
 *   node scripts/validate-figurine-flow.mts
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { AgentError } from '../agent/validation.ts';
import type { EngineClient } from '../agent/types.ts';

const TERMINAL = new Set(['completed', 'completed_with_errors', 'cancelled', 'paused', 'failed', 'needs_attention']);
const root = path.resolve(import.meta.dirname, '..');
const baseUrl = process.env.AUTOLABEL_TEST_BASE_URL?.trim();
const key = process.env.AUTOLABEL_TEST_KEY?.trim();
const model = process.env.AUTOLABEL_TEST_MODEL?.trim();
const textModel = process.env.AUTOLABEL_TEST_TEXT_MODEL?.trim();
const image = process.env.AUTOLABEL_TEST_IMAGE?.trim();
const python = process.env.AUTOLABEL_TEST_PYTHON?.trim() ?? 'C:/Users/zhy23/AppData/Local/Programs/Python/Python311/python.exe';
assert.ok(baseUrl, '需要 AUTOLABEL_TEST_BASE_URL（接口基础地址）');
assert.ok(key, '需要 AUTOLABEL_TEST_KEY（接口密钥；只从环境变量读取）');
assert.ok(model, '需要 AUTOLABEL_TEST_MODEL（跑标注的视觉模型 id）');
assert.ok(image, '需要 AUTOLABEL_TEST_IMAGE（手办帧图路径）');

const dataDir = path.join(root, '.qa', `figurine-flow-${Date.now()}`);
await mkdir(dataDir, { recursive: true });
const javaHome = (await (await import('node:fs/promises')).readFile(path.join(root, 'engine/build/runtime-path.txt'), 'utf8')).trim();
const token = randomUUID() + randomUUID();
const runtimeJar = path.join(dataDir, 'engine.jar');
await copyFile(path.join(root, 'engine/build/autolabel-engine.jar'), runtimeJar);

const engine = spawn(path.join(javaHome, 'bin/java.exe'), ['-jar', runtimeJar], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
engine.stderr.resume();
const output = createInterface({ input: engine.stdout });
const ready = new Promise<{ port: number }>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('引擎启动超时')), 20000);
  output.once('line', line => { clearTimeout(timeout); resolve(JSON.parse(line)); });
  engine.once('exit', code => { clearTimeout(timeout); reject(new Error(`引擎提前退出：${code}`)); });
});
engine.stdin.write(JSON.stringify({ token, dataDir, protocolVersion: 1 }) + '\n');

let command: EngineClient['request'];
const report: Record<string, unknown> = { steps: [] as Array<Record<string, unknown>> };
const steps = report.steps as Array<Record<string, unknown>>;
try {
  const address = await ready;
  command = async <T>(name: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const slow = ['provider.test', 'run.get', 'asset.import'].includes(name);
    const response = await fetch(`http://127.0.0.1:${address.port}/command`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: name, payload }), signal: AbortSignal.timeout(slow ? 360000 : 30000),
    });
    const result = await response.json() as { ok: boolean; data: T; error: { code: string; message: string } };
    if (!result.ok) throw new AgentError(result.error.code, result.error.message);
    return result.data;
  };
  const provider = await command<{ id: string }>('provider.save', {
    name: '手办基线', baseUrl, protocol: 'chat-completions', timeoutMs: 300000, maxRetries: 0, concurrency: 1,
  });
  await command('credential.set', { providerId: provider.id, key });
  console.log(`接口：${baseUrl}`);
  console.log(`数据目录：${dataDir}`);
  console.log('');

  // ===== 1. 正例：视觉模型真的把手办标出来 =====
  for (const capability of ['image', 'structured'] as const) {
    const result = await command<{ status: string }>('provider.test', { providerId: provider.id, model, capability });
    assert.equal(result.status, 'verified', `标注模型必须通过「${capability}」验证，实际 ${result.status}；不能蒙着眼睛跑标注`);
  }
  steps.push({ step: 'vision-capabilities', model, image: 'verified', structured: 'verified' });

  const project = await command<{ id: string }>('project.create', {
    name: '手办标注基线', taskType: 'detect', classes: [{ id: 'figurine', name: '手办', color: '#e36fa8' }],
  });
  await command('asset.import', { projectId: project.id, paths: [path.resolve(image)], mode: 'copy' });
  const assets = await command<{ items: Array<{ id: string; version: number; status: string }> }>('asset.list', { projectId: project.id });
  assert.equal(assets.items.length, 1, '导入后应有 1 张素材');
  const prompt = '只要画面中间那个粉色头发的小手办，不要框旁边的大号毛绒公仔和背景；没有目标就返回空数组。';
  const started = Date.now();
  const run = await command<{ id: string }>('run.create', {
    projectId: project.id, assetIds: [assets.items[0].id], providerId: provider.id, model, prompt,
    concurrency: 1, maxRequests: 5, maxRetries: 0,
  });
  let current = await command<{ status: string; statistics?: Record<string, number>; payloadActual?: Record<string, unknown> }>('run.get', { runId: run.id });
  const deadline = Date.now() + Number(process.env.AUTOLABEL_TEST_RUN_TIMEOUT_MS ?? 6 * 60 * 1000);
  while (!TERMINAL.has(current.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    current = await command('run.get', { runId: run.id });
  }
  assert.ok(TERMINAL.has(current.status), `运行未在期限内结束，最后状态 ${current.status}`);
  const annotated = await command<{ status: string; version: number; annotations?: Array<{ classId: string; confidence?: number }> }>('asset.get', { assetId: assets.items[0].id });
  assert.equal(annotated.status, 'candidate', `正例结果应落成候选（不覆盖人工），实际 ${annotated.status}`);
  const objects = (annotated.annotations ?? []).length;
  steps.push({ step: 'figurine-annotation', runStatus: current.status, statistics: current.statistics,
    objects, elapsedSeconds: Math.round((Date.now() - started) / 1000), payloadActual: current.payloadActual ?? null });
  console.log(`正例：${current.status} · ${objects} 个对象 · ${Math.round((Date.now() - started) / 1000)}s`);

  // ===== 2. 反例一：纯文本模型必须被拦；硬跑也不许污染已有结果 =====
  if (textModel) {
    const vision = await command<{ status: string }>('provider.test', { providerId: provider.id, model: textModel, capability: 'image' });
    assert.notEqual(vision.status, 'verified', '纯文本模型竟然通过了图片输入验证——能力验证本身不可信');
    const before = annotated.version;
    const failedRun = await command<{ id: string }>('run.create', {
      projectId: project.id, assetIds: [assets.items[0].id], providerId: provider.id, model: textModel, prompt,
      concurrency: 1, maxRequests: 5, maxRetries: 0,
    });
    let failedState = await command<{ status: string; statistics?: Record<string, number> }>('run.get', { runId: failedRun.id });
    const failedDeadline = Date.now() + 3 * 60 * 1000;
    while (!TERMINAL.has(failedState.status) && Date.now() < failedDeadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      failedState = await command('run.get', { runId: failedRun.id });
    }
    const after = await command<{ version: number; annotations?: unknown[] }>('asset.get', { assetId: assets.items[0].id });
    assert.ok((failedState.statistics?.failed ?? 0) >= 1, `文本模型硬跑必须失败，实际统计 ${JSON.stringify(failedState.statistics)}`);
    assert.equal(after.version, before, `失败的运行不得改写已有标注版本（${before} → ${after.version}）`);
    steps.push({ step: 'text-model-blocked', capability: vision.status, runStatus: failedState.status, statistics: failedState.statistics, versionUnchanged: true });
    console.log(`反例一：文本模型被拦（image=${vision.status}），硬跑 ${failedState.status} 且版本未变`);
  } else {
    console.log('反例一：未提供 AUTOLABEL_TEST_TEXT_MODEL，跳过（不是通过）。');
  }

  // ===== 3. 反例二：中文新词必须显式拒绝（由词表验收脚本承担同一承诺）=====
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [path.join(root, 'inference/validate_vocabulary.py'), path.join(root, 'build/models/yolov8s-worldv2.pt'), path.resolve(image)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    child.stdout.on('data', chunk => { tail += chunk; });
    child.stderr.on('data', chunk => { tail += chunk; });
    child.once('exit', code => {
      if (code === 0) { console.log(`反例二：validate_vocabulary.py 全绿（${tail.trim().split('\n').at(-1) ?? ''}）`); steps.push({ step: 'chinese-term-rejected', exitCode: 0, summary: tail.trim().split('\n').at(-1) ?? '' }); resolve(); }
      else reject(new Error(`validate_vocabulary.py 退出码 ${code}（中文新词必须显式拒绝）：\n${tail.slice(-1500)}`));
    });
  });

  await writeFile(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('');
  console.log(`手办端到端基线通过。报告：${path.join(dataDir, 'report.json')}`);
} finally {
  try { engine.stdin.write(JSON.stringify({ id: 'shutdown', command: 'shutdown', payload: {} }) + '\n'); engine.stdin.end(); } catch { /* 引擎已退出 */ }
  engine.kill();
}
