import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selectedJar = process.env.AUTOLABEL_ENGINE_JAR;
if (!selectedJar) throw new Error('里程碑打包必须通过 AUTOLABEL_ENGINE_JAR 明确指定已验收的稳定 JAR');
const selectedInference = process.env.AUTOLABEL_INFERENCE_DIR;
if (!selectedInference) throw new Error('里程碑打包必须通过 AUTOLABEL_INFERENCE_DIR 明确指定已验收的推理脚本目录');
const inference = path.resolve(root, selectedInference);
await access(path.join(inference, 'worker.py'));
const jar = path.resolve(root, selectedJar);
await access(jar); await access(path.join(root, 'build/runtime/bin/java.exe'));
const builderHome = path.join(root, 'node_modules/electron-builder');
const pkg = JSON.parse(await readFile(path.join(builderHome, 'package.json'), 'utf8'));
// 只读取明确选定的稳定引擎，避免默认退回旧里程碑或混入正在开发的构建。
const child = spawn(process.execPath, [path.join(builderHome, pkg.bin['electron-builder']), '--win', 'nsis', '--x64', '--config', 'build/electron-builder.cjs'],
  { cwd: root, env: { ...process.env, AUTOLABEL_ENGINE_JAR: jar, AUTOLABEL_INFERENCE_DIR: inference }, windowsHide: true, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
