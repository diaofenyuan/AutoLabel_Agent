/**
 * 真实接口的「视觉 + 工具」能力摸底。
 *
 * 为什么需要它：标注模型的图片输入能力只由用户在设置里逐项点过验证才算数，
 * 而选了一个只会读文字的模型时，失败会推迟到跑标注那一刻才以模型返回解析失败的样子出现。
 * 这个脚本在隔离数据目录里起一个引擎，用环境变量给的真实接口逐项验证，
 * 并对通过图片验证的模型真的跑一次标注，看它能不能按契约返回 JSON。
 *
 * 密钥只从环境变量读，不落盘、不写进报告。
 *
 * 用法（PowerShell）：
 *   $env:AUTOLABEL_TEST_BASE_URL='https://example.com/v1'
 *   $env:AUTOLABEL_TEST_KEY='sk-...'
 *   $env:AUTOLABEL_TEST_MODELS='model-a,model-b'
 *   $env:AUTOLABEL_TEST_IMAGE='D:\some\frame.png'   # 可选；缺省只做能力验证
 *   node scripts/validate-vision-capability.mts
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { AgentError } from '../agent/validation.ts';
import type { EngineClient } from '../agent/types.ts';

const CAPABILITIES = ['image', 'multiImage', 'tools', 'structured'] as const;
const CAPABILITY_LABELS: Record<string, string> = { image: '单图输入', multiImage: '多图输入', tools: '工具调用', structured: '结构化输出' };
const TERMINAL = new Set(['completed', 'completed_with_errors', 'cancelled', 'paused', 'failed']);

const root = path.resolve(import.meta.dirname, '..');
const baseUrl = process.env.AUTOLABEL_TEST_BASE_URL?.trim();
const key = process.env.AUTOLABEL_TEST_KEY?.trim();
const models = (process.env.AUTOLABEL_TEST_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const image = process.env.AUTOLABEL_TEST_IMAGE?.trim();
const prompt = process.env.AUTOLABEL_TEST_PROMPT?.trim() ?? '把画面里的目标用矩形框标出来；没有目标就返回空数组。';
assert.ok(baseUrl, '需要 AUTOLABEL_TEST_BASE_URL（接口基础地址，例如 https://example.com/v1）');
assert.ok(key, '需要 AUTOLABEL_TEST_KEY（接口密钥；只从环境变量读取）');
assert.ok(models.length, '需要 AUTOLABEL_TEST_MODELS（逗号分隔的模型名）');

const dataDir = path.join(root, '.qa', `vision-capability-${Date.now()}`);
await mkdir(dataDir, { recursive: true });
const javaHome = (await readFile(path.join(root, 'engine/build/runtime-path.txt'), 'utf8')).trim();
const token = randomUUID() + randomUUID();
const runtimeJar = path.join(dataDir, 'engine.jar');
await copyFile(process.env.AUTOLABEL_ENGINE_JAR ?? path.join(root, 'engine/build/autolabel-engine.jar'), runtimeJar);

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
const report: Array<Record<string, unknown>> = [];
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
    name: '能力摸底', baseUrl, protocol: 'chat-completions', timeoutMs: 300000, maxRetries: 0, concurrency: 1,
  });
  // 密钥只在这一次进程里存在；引擎把它写进凭据模块，脚本自身不落盘。
  await command('credential.set', { providerId: provider.id, key });

  console.log(`接口：${baseUrl}`);
  console.log(`数据目录：${dataDir}`);
  console.log('');

  for (const model of models) {
    const entry: Record<string, unknown> = { model, capabilities: {} as Record<string, string> };
    const capabilities = entry.capabilities as Record<string, string>;
    for (const capability of CAPABILITIES) {
      const started = Date.now();
      try {
        const result = await command<{ status: string; detail?: string }>('provider.test', { providerId: provider.id, model, capability });
        capabilities[capability] = result.status === 'verified' ? '通过' : `未通过（${result.status}）`;
      } catch (error) {
        const api = error instanceof AgentError ? `${error.code}：${error.message}` : String(error);
        capabilities[capability] = `失败（${api}）`;
      }
      capabilities[capability] = `${capabilities[capability]} · ${Math.round((Date.now() - started) / 1000)}s`;
    }

    if (capabilities.image.startsWith('通过') && image) {
      const project = await command<{ id: string }>('project.create', {
        name: '视觉能力摸底', taskType: 'detect',
        classes: [{ id: 'target', name: '目标', color: '#437fe5' }],
      });
      await command('asset.import', { projectId: project.id, paths: [path.resolve(image)], mode: 'copy' });
      const assets = await command<{ items: Array<{ id: string }> }>('asset.list', { projectId: project.id });
      assert.ok(assets.items.length, '导入后没有素材');
      const started = Date.now();
      const run = await command<{ id: string }>('run.create', {
        projectId: project.id, assetIds: [assets.items[0].id], providerId: provider.id, model, prompt,
        concurrency: 1, maxRequests: 5, maxRetries: 0,
      });
      const deadline = Date.now() + Number(process.env.AUTOLABEL_TEST_RUN_TIMEOUT_MS ?? 6 * 60 * 1000);
      let current = await command<{ status: string; statistics?: Record<string, number>; pauseReason?: string }>('run.get', { runId: run.id });
      while (!TERMINAL.has(current.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        current = await command<{ status: string; statistics?: Record<string, number>; pauseReason?: string }>('run.get', { runId: run.id });
        // 真实大图上动辄几分钟，进度直接打出来，免得只看到一个静止的日志文件。
        if ((Date.now() - started) % 15000 < 3000) console.log(`    …${model} ${Math.round((Date.now() - started) / 1000)}s · 运行状态 ${current.status}`);
      }
      const asset = await command<{ status: string; annotations?: unknown[] }>('asset.get', { assetId: assets.items[0].id });
      entry.annotation = {
        status: current.status, pauseReason: current.pauseReason, statistics: current.statistics,
        assetStatus: asset.status, objectCount: asset.annotations?.length ?? 0,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    } else if (capabilities.image.startsWith('通过')) {
      entry.annotation = { status: '跳过', note: '未提供 AUTOLABEL_TEST_IMAGE，只做能力验证' };
    } else {
      entry.annotation = { status: '跳过', note: '未通过图片输入验证，不能作标注模型' };
    }
    report.push(entry);
  }

  console.log('模型'.padEnd(28) + CAPABILITIES.map(name => CAPABILITY_LABELS[name].padEnd(24)).join('') + '标注试跑');
  for (const entry of report) {
    const capabilities = entry.capabilities as Record<string, string>;
    const annotation = entry.annotation as Record<string, unknown>;
    const run = annotation.status === '跳过'
      ? `跳过（${annotation.note}）`
      : annotation.status === 'completed'
        ? `成功 · ${annotation.objectCount} 个对象 · ${annotation.seconds}s`
        : `未完成（${annotation.status}${annotation.pauseReason ? ' · ' + annotation.pauseReason : ''}）`;
    console.log(String(entry.model).padEnd(28) + CAPABILITIES.map(name => capabilities[name].split(' · ')[0].padEnd(24)).join('') + run);
  }
  console.log('');
  console.log('明细：');
  for (const entry of report) {
    console.log(`  ${entry.model}`);
    for (const capability of CAPABILITIES) console.log(`    ${CAPABILITY_LABELS[capability]}：${(entry.capabilities as Record<string, string>)[capability]}`);
    const annotation = entry.annotation as Record<string, unknown>;
    console.log(`    标注试跑：${JSON.stringify(annotation)}`);
  }
  await writeFile(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log(`报告：${path.join(dataDir, 'report.json')}`);

  const usable = report.filter(entry => (entry.capabilities as Record<string, string>).image.startsWith('通过'));
  if (!usable.length) console.log('\n结论：没有任何模型通过图片输入验证，这批接口不能用来标注图片。');
} finally {
  if (command!) await command('engine.shutdown').catch(() => {});
  engine.kill();
}
