import { access, readFile, mkdir, cp, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.AUTOLABEL_JAVA_HOME, path.join(root, 'engine/build/runtime'), path.join(root, '.tools/java')];
try { candidates.unshift((await readFile(path.join(root, 'engine/build/runtime-path.txt'), 'utf8')).trim()); } catch { /* 等待引擎构建生成发现提示。 */ }
let home;
for (const candidate of candidates.filter(Boolean)) {
  try { const release = await readFile(path.join(candidate, 'release'), 'utf8'); if (/JAVA_VERSION="21\./.test(release)) { await access(path.join(candidate, 'bin/java.exe')); home = candidate; break; } } catch { /* 继续检查已知候选，不下载来源不明的运行时。 */ }
}
if (!home) throw new Error('未找到 Java 21，请先运行引擎环境准备，或设置 AUTOLABEL_JAVA_HOME');
const sourceVersion = /JAVA_VERSION="([^"]+)"/.exec(await readFile(path.join(home, 'release'), 'utf8'))?.[1];
await access(path.join(root, 'engine/build/autolabel-engine.jar'));
const target = path.join(root, 'build/runtime');
try {
  const release = await readFile(path.join(target, 'release'), 'utf8');
  if (/JAVA_VERSION="([^"]+)"/.exec(release)?.[1] === sourceVersion) { console.log('复用已构建的 Java 21 内置运行时：build/runtime'); process.exit(0); }
  throw new Error('已有运行时版本不兼容，请先移走 build/runtime 再重建');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.join(root, 'build'), { recursive: true });
const temporary = path.join(root, `build/runtime-${Date.now()}`);
try {
  await access(path.join(home, 'bin/jlink.exe'));
  const result = spawnSync(path.join(home, 'bin/jlink.exe'), ['--module-path', path.join(home, 'jmods'), '--add-modules',
    'java.base,java.desktop,java.net.http,java.sql,java.naming,java.management,jdk.httpserver,jdk.crypto.ec,jdk.charsets,jdk.unsupported,jdk.zipfs',
    '--strip-debug', '--no-header-files', '--no-man-pages', '--output', temporary], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('jlink 运行时构建失败');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await cp(home, temporary, { recursive: true });
}
await rename(temporary, target);
console.log('Java 21 兼容运行时已准备：build/runtime');
