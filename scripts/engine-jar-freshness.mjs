import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 交付一致性断言：包里的引擎 jar 必须是刚构建的这一份。
 *
 * 走查里出现的是「源码里修好的问题没进安装包」：交付包内的 jar 构建于 16:04，
 * 而最新一次引擎提交是 17:42 落库的——两边都没报错，只有打开包才发现少了修复。
 * 这类落后没有别的征兆，所以把它变成打包流程里的硬断言。
 *
 * 分两个模式，职责必须分开，否则会死锁：
 * - 默认（打包前）：只校验打包输入 engine/build/autolabel-engine.jar 比最后一次引擎提交新。
 *   **不能顺带校验交付目录里的副本**——那份文件是上一次打包的产物，只能由本次打包刷新，
 *   在打包前要求它新鲜等于要求「先有鸡还是先有蛋」，会让 pack 永远失败在半路。
 *   （这个缺陷真实发生过：pack:dir 卡在断言上，electron-builder 根本没执行。）
 * - --package（打包后）：校验交付目录里的副本与打包输入内容一致，证明包内确实是刚构建的这一份。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageMode = process.argv.includes('--package');
const releaseDirectory = process.env.AUTOLABEL_RELEASE_DIR || 'build/release';
const buildJar = path.join(root, 'engine/build/autolabel-engine.jar');
const packagedJar = path.join(root, releaseDirectory, 'win-unpacked/resources/engine/autolabel-engine.jar');

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const lastEngineCommit = Number(git(['log', '-1', '--format=%ct', '--', 'engine/']));
const lastEngineSubject = git(['log', '-1', '--format=%h %s', '--', 'engine/']);
if (!Number.isFinite(lastEngineCommit) || lastEngineCommit <= 0) {
  console.error('无法读取引擎侧的最后一次提交时间，请在完整仓库中运行。');
  process.exit(1);
}
const describe = async file => {
  const info = await stat(file);
  return { size: info.size, fresh: info.mtimeMs > lastEngineCommit * 1000,
    text: `构建于 ${new Date(info.mtimeMs).toLocaleString('zh-CN')} · 引擎最后提交 ${new Date(lastEngineCommit * 1000).toLocaleString('zh-CN')}（${lastEngineSubject}）` };
};
const digest = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

if (!packageMode) {
  // 打包前：只看打包输入。AUTOLABEL_ENGINE_JAR 可覆盖，供 CI 与断言自检使用。
  const target = process.env.AUTOLABEL_ENGINE_JAR ? path.resolve(root, process.env.AUTOLABEL_ENGINE_JAR) : buildJar;
  if (!existsSync(target)) {
    console.error(`没有找到将要打包的引擎 jar：${path.relative(root, target)}\n  请先执行 npm run build:engine。`);
    process.exit(1);
  }
  const info = await describe(target);
  if (!info.fresh) {
    console.error(`引擎 jar 早于最后一次引擎提交，交付包会缺修复：\n  ${path.relative(root, target)}\n  ${info.text}\n  请先执行 npm run build:engine 再打包。`);
    process.exit(1);
  }
  console.log(`打包输入不落后：${path.relative(root, target)} ${info.text}`);
  process.exit(0);
}

// 打包后：包内副本必须与打包输入是同一份内容，且不比引擎提交旧。
if (!existsSync(buildJar)) {
  console.error(`缺少打包输入，无法核对包内副本：${path.relative(root, buildJar)}`);
  process.exit(1);
}
if (!existsSync(packagedJar)) {
  console.error(`交付目录里没有引擎 jar：${path.relative(root, packagedJar)}\n  请先执行 npm run pack:dir 或 npm run pack:win。`);
  process.exit(1);
}
const [input, packaged] = [await describe(buildJar), await describe(packagedJar)];
const [inputHash, packagedHash] = [await digest(buildJar), await digest(packagedJar)];
let failed = false;
if (!packaged.fresh) {
  failed = true;
  console.error(`包内引擎 jar 早于最后一次引擎提交，交付包缺修复：\n  ${path.relative(root, packagedJar)}\n  ${packaged.text}`);
}
if (inputHash !== packagedHash) {
  failed = true;
  console.error('包内引擎 jar 与打包输入不是同一份内容，说明打包没有用上刚构建的产物：\n'
    + `  输入 ${path.relative(root, buildJar)} ${inputHash.slice(0, 16)}（${input.size} 字节）\n`
    + `  包内 ${path.relative(root, packagedJar)} ${packagedHash.slice(0, 16)}（${packaged.size} 字节）\n`
    + '  请重新执行 npm run pack:dir 或 npm run pack:win。');
}
if (failed) process.exit(1);
console.log(`包内引擎 jar 与打包输入一致：${path.relative(root, packagedJar)} ${inputHash.slice(0, 16)} · ${packaged.text}`);
