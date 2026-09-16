import { stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 交付一致性断言：出包用的引擎 jar 不能早于最后一次引擎侧提交。
 *
 * 走查里出现的是「源码里修好的问题没进安装包」：交付包内的 jar 构建于 16:04，
 * 而最新一次引擎提交是 17:42 落库的——两边都没报错，只有打开包才发现少了修复。
 * 这类落后没有别的征兆，所以把它变成打包流程里的一条硬断言。
 *
 * 判定用文件的修改时间与 git 提交时间比较：jar 是编译产物，只能靠时间先后判断新鲜度。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * 目标 jar：优先看交付目录，其次看引擎构建产物。
 * AUTOLABEL_ENGINE_JAR 可指定单个文件，供 CI 与断言自检使用。
 */
function jarCandidates() {
  if (process.env.AUTOLABEL_ENGINE_JAR) return [path.resolve(root, process.env.AUTOLABEL_ENGINE_JAR)];
  const releaseDirectory = process.env.AUTOLABEL_RELEASE_DIR || 'build/release';
  return [
    path.join(root, releaseDirectory, 'win-unpacked/resources/engine/autolabel-engine.jar'),
    path.join(root, 'engine/build/autolabel-engine.jar')
  ];
}

const lastEngineCommit = Number(git(['log', '-1', '--format=%ct', '--', 'engine/']));
const lastEngineSubject = git(['log', '-1', '--format=%h %s', '--', 'engine/']);
if (!Number.isFinite(lastEngineCommit) || lastEngineCommit <= 0) {
  console.error('无法读取引擎侧的最后一次提交时间，请在完整仓库中运行。');
  process.exit(1);
}

const jars = jarCandidates();
const present = jars.filter(candidate => existsSync(candidate));
if (!present.length) {
  // 只有产物缺失时才算失败：pack 流程里的 jar 由 build:engine 生成，没生成就不该继续打包。
  console.error(`没有找到引擎 jar，检查过：\n  ${jars.join('\n  ')}`);
  process.exit(1);
}

let failed = false;
for (const jar of present) {
  const info = await stat(jar);
  const builtAt = info.mtimeMs;
  const fresh = builtAt > lastEngineCommit * 1000;
  const detail = `构建于 ${new Date(builtAt).toLocaleString('zh-CN')} · 引擎最后提交 ${new Date(lastEngineCommit * 1000).toLocaleString('zh-CN')}（${lastEngineSubject}）`;
  if (fresh) { console.log(`引擎 jar 不落后：${path.relative(root, jar)} ${detail}`); continue; }
  failed = true;
  console.error(`引擎 jar 早于最后一次引擎提交，交付包会缺修复：\n  ${path.relative(root, jar)}\n  ${detail}\n  请先执行 npm run build:engine 再打包。`);
}
process.exit(failed ? 1 : 0);
