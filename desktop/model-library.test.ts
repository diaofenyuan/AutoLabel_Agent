import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelLibrary } from './model-library';
import { DesktopError } from './validation';
import type { CatalogModel } from '../shared/model-library';

/**
 * 模型下载语义的负面用例：内容真伪只认 sha256，网络状况与内容真假是两回事。
 * 本地回环夹具当下载源（构造注入，不给生产留测试开关）：
 * 1. 每个源取回的内容都与目录记录的哈希不一致 → MODEL_LIBRARY_HASH_MISMATCH，且不留 .part / 目标文件；
 * 2. 每个源都连不上 → MODEL_LIBRARY_SOURCE_UNREACHABLE（网络问题，与内容无关）；
 * 3. 中途断流 → .part 保留、可续传：重试带 Range 从断点继续，完成后哈希一致。
 */
const payload = Buffer.from('model-library-download-contract-fixture'.repeat(16384)); // ≈590KB：小到测试快、大到断流时缓冲确已落盘
const digest = createHash('sha256').update(payload).digest('hex');

function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return { id: 'probe-model', name: '下载语义探针', taskType: 'detect', openVocabulary: false, fileName: 'probe.bin',
    sizeBytes: payload.length, sha256: digest, tier: 'download', group: '测试', downloadUrl: 'http://127.0.0.1:1/probe.bin',
    mirrorUrls: [], license: 'MIT', note: '仅测试注入，不属于发布目录', ...overrides };
}

async function fixture(model: CatalogModel, urls: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-model-library-'));
  const library = new ModelLibrary({
    builtinRoot: () => path.join(root, 'builtin'),
    storageRoot: () => root,
    dataDirectory: () => path.join(root, 'data'),
    catalogOverride: [model],
    sourcesOverride: () => urls,
  });
  const target = path.join(root, 'models', model.taskType === null ? 'text-encoder' : model.id, model.taskType === null ? '' : model.sha256.slice(0, 12), model.fileName);
  return { root, library, target, part: `${target}.part`, close: async () => { await rm(root, { recursive: true, force: true }); } };
}

function serve(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

test('下载内容与目录哈希不一致时一律丢弃，不留半个文件冒充可用', async () => {
  const wrong = Buffer.alloc(payload.length, 7);
  const first = await serve((_req, res) => { res.end(wrong); });
  const second = await serve((_req, res) => { res.end(wrong); });
  const f = await fixture(catalogModel(), [`${first.origin}/probe.bin`, `${second.origin}/probe.bin`]);
  try {
    await assert.rejects(() => f.library.install('probe-model'), (error: unknown) => error instanceof DesktopError && error.code === 'MODEL_LIBRARY_HASH_MISMATCH');
    assert.equal(await stat(f.part).then(() => true).catch(() => false), false, '校验不过的临时文件必须删掉');
    assert.equal(await stat(f.target).then(() => true).catch(() => false), false, '目标文件不得出现');
  } finally { await f.close(); first.server.close(); second.server.close(); }
});

test('每个下载源都连不上时报网络问题，不冒充内容问题', async () => {
  const f = await fixture(catalogModel(), ['http://127.0.0.1:1/probe.bin', 'http://127.0.0.1:2/probe.bin']);
  try {
    await assert.rejects(() => f.library.install('probe-model'), (error: unknown) => error instanceof DesktopError && error.code === 'MODEL_LIBRARY_SOURCE_UNREACHABLE');
  } finally { await f.close(); }
});

test('断流后续传：未完成分段按 Range 从断点继续，最终哈希一致', async () => {
  let ranged = 0;
  const flaky = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.write(payload.subarray(0, 256 * 1024));
    setTimeout(() => res.destroy(), 20);
  });
  const model = catalogModel();
  const f = await fixture(model, [`${flaky.origin}/probe.bin`]);
  try {
    // 断流必须以「下载类错误」明确失败（写缓冲落盘多少是 Node 层细节，不作为契约）。
    await assert.rejects(() => f.library.install('probe-model'), (error: unknown) => error instanceof DesktopError && /下载|中断|连接/.test((error as DesktopError).message));
    // 断点续传契约：分段在盘上多少就从多少继续——这里直接预置一段确定的未完成分段，断言 Range 起点与最终哈希。
    const resumeFrom = 200 * 1024;
    await mkdir(path.dirname(f.target), { recursive: true });
    await writeFile(f.part, payload.subarray(0, resumeFrom));
    const good = await serve((req, res) => {
      const range = Number((req.headers.range ?? '').replace(/\D/g, '') || 0);
      ranged = range;
      assert.ok(range > 0, '重试必须带 Range 断点续传');
      res.writeHead(206, { 'Content-Range': `bytes ${range}-${payload.length - 1}/${payload.length}`, 'Content-Length': String(payload.length - range) });
      res.end(payload.subarray(range));
    });
    try {
      const state = await new ModelLibrary({
        builtinRoot: () => path.join(f.root, 'builtin'), storageRoot: () => f.root, dataDirectory: () => path.join(f.root, 'data'),
        catalogOverride: [model], sourcesOverride: () => [`${good.origin}/probe.bin`],
      }).install('probe-model');
      assert.equal(ranged, resumeFrom, `续传应从分段末尾继续，实际起点 ${ranged}`);
      assert.ok(await f.library.readyFile('probe-model'), '续传完成后模型应处于就绪状态');
      assert.equal(createHash('sha256').update(await readFile(f.target)).digest('hex'), model.sha256, '续传拼出的完整文件必须通过目录哈希核对');
    } finally { good.server.close(); }
  } finally { await f.close(); flaky.server.close(); }
});
