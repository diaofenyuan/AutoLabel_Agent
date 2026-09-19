import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * 打包前准备内置模型权重：`build/models` 与安装包里的 `resources/models` 是同一批文件。
 *
 * 三件事按顺序做完才算通过：
 * 1. 权重必须在位——缺失时按共享目录里的地址（含国内镜像）取回，不静默留空；
 * 2. 每个权重的 sha256 必须与 `shared/model-library.ts` 的目录一致，差一个字节就失败，
 *    宁可不产出安装包，也不能让用户下到一个内容不对的模型；
 * 3. 内置合计体积不得超过目录里声明的预算，避免安装包悄悄膨胀。
 *
 * `AUTOLABEL_MODELS_DIR` 可指定一个已验收的权重目录，脚本从中复制而不是联网取回。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'build/models');
const stage = process.env.AUTOLABEL_MODELS_DIR ? path.resolve(process.env.AUTOLABEL_MODELS_DIR) : undefined;

const catalogBundle = path.join(root, 'tmp/desktop-models-catalog.mjs');
await mkdir(path.dirname(catalogBundle), { recursive: true });
const { build } = await import('esbuild');
await build({ entryPoints: [path.join(root, 'shared/model-library.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: catalogBundle, logLevel: 'warning' });
const { MODEL_CATALOG, bundledModelBytes, BUNDLED_MODEL_BUDGET_BYTES, formatModelBytes } = await import(pathToFileURL(catalogBundle).href);

const digest = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

async function fetchTo(url, part) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`下载源返回 ${response.status}`); }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
}

/** 缺文件时按目录里的地址取回；任一地址成功即可，内容真伪留给下一步的哈希核对。 */
async function fetchModel(model) {
  const part = path.join(target, `${model.fileName}.part`);
  const reason = [];
  for (const url of [model.downloadUrl, ...model.mirrorUrls]) {
    try {
      console.log(`正在取回内置权重 ${model.fileName}：${url}`);
      await fetchTo(url, part);
      return part;
    } catch (error) { reason.push(`${url} → ${error instanceof Error ? error.message : error}`); }
  }
  await rm(part, { force: true });
  throw new Error(`内置权重 ${model.fileName} 取回失败，且本机没有现成文件。\n  已尝试的地址：\n    ${reason.join('\n    ')}\n`
    + `  离线环境请把权重放到 build/models/，或用 AUTOLABEL_MODELS_DIR 指定已验收的权重目录。`);
}

await mkdir(target, { recursive: true });
const installed = [];
for (const model of MODEL_CATALOG.filter(item => item.tier === 'bundled')) {
  const file = path.join(target, model.fileName);
  const existing = await stat(file).catch(() => null);
  if (!existing && stage) {
    const part = `${file}.part`;
    await copyFile(path.join(stage, model.fileName), part);
    await rename(part, file);
  }
  if (!(await stat(file).catch(() => null))) {
    const part = await fetchModel(model);
    await rename(part, file);
  }
  const info = await stat(file);
  if (info.size !== model.sizeBytes) {
    throw new Error(`内置权重 ${model.fileName} 体积与目录不一致：目录记 ${model.sizeBytes} 字节，实际 ${info.size} 字节。\n`
      + `  请删除 build/models/${model.fileName} 后重新运行，或核对 shared/model-library.ts 里的 sizeBytes。`);
  }
  const actual = await digest(file);
  if (actual !== model.sha256) {
    throw new Error(`内置权重 ${model.fileName} 的 sha256 与目录不一致，已停止打包：\n`
      + `  目录：${model.sha256}\n  实际：${actual}\n`
      + `  请删除 build/models/${model.fileName} 后重新运行以重新取回。`);
  }
  installed.push({ id: model.id, fileName: model.fileName, sizeBytes: info.size });
}

const total = bundledModelBytes();
if (total > BUNDLED_MODEL_BUDGET_BYTES) {
  throw new Error(`内置权重合计 ${formatModelBytes(total)}，超过 ${formatModelBytes(BUNDLED_MODEL_BUDGET_BYTES)} 的预算。\n`
    + '  请把其中某个模型改到按需下载档位，而不是放宽这个上限。');
}
await rm(catalogBundle, { force: true });
console.log(`内置模型权重已就绪：build/models（${installed.length} 个，${formatModelBytes(total)}）`);
