import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const root = process.cwd();
const args = process.argv.slice(2);
const selected = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`缺少冻结输入 ${name}`); return path.resolve(args[index + 1]); };
const desktop = selected('--desktop'); const renderer = selected('--renderer'); const engine = selected('--engine'); const output = selected('--output');
const inference = selected('--inference');
if (!fs.statSync(path.join(inference, 'worker.py')).isFile()) throw new Error('冻结推理输入缺少 worker.py');
const checkIndex = args.indexOf('--check'); const check = checkIndex < 0 ? 'release5' : args[checkIndex + 1];
if (!['release5', 'release6a', 'release6b', 'release7a', 'release7b'].includes(check)) throw new Error('未知安装包检查模式');
const media = check === 'release7b' || args.includes('--media') ? selected('--media') : undefined;
if (media) {
  for (const filename of ['ffmpeg.exe', 'ffprobe.exe', 'versions.json', 'third-party/ffmpeg/LICENSE', 'third-party/ffmpeg/README.txt', 'third-party/ffmpeg/source.json']) {
    if (!fs.statSync(path.join(media, filename)).isFile()) throw new Error(`冻结媒体输入缺少 ${filename}`);
  }
  const versions = JSON.parse(fs.readFileSync(path.join(media, 'versions.json'), 'utf8'));
  for (const name of ['ffmpeg', 'ffprobe']) if (!new RegExp(`^${name} version 8\\.1\\.1(?:[-+ ]|$)`).test(versions[name])) throw new Error('冻结媒体工具版本不是已验收的 8.1.1');
}
if (!output.startsWith(path.join(root, 'build') + path.sep)) throw new Error('独立打包输出必须位于工作区 build 内');
const stage = path.join(root, '.qa', 'package-inputs', `${check}-${Date.now()}`);
const app = path.join(stage, 'app'); const resources = path.join(stage, 'resources'); const buildResources = path.join(stage, 'build-resources');
const baseline = path.join(root, 'build', 'release-4c', 'win-unpacked', 'resources');
fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(resources, { recursive: true });
// Java 和 npm 运行时依赖来自已验证旧包，业务代码及推理脚本只复制明确冻结的输入。
const dependencyApp = path.join(stage, 'dependency-app');
require('@electron/asar').extractAll(path.join(baseline, 'app.asar'), dependencyApp);
fs.cpSync(path.join(dependencyApp, 'node_modules'), path.join(app, 'node_modules'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'package.json'), path.join(app, 'package.json'));
fs.mkdirSync(path.join(app, 'desktop', 'dist'), { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'agent.cjs']) fs.copyFileSync(path.join(desktop, 'desktop', 'dist', name), path.join(app, 'desktop', 'dist', name));
fs.cpSync(path.join(desktop, 'desktop', 'fallback'), path.join(app, 'desktop', 'fallback'), { recursive: true });
fs.cpSync(renderer, path.join(app, 'renderer', 'dist'), { recursive: true });
fs.cpSync(path.join(desktop, 'build'), buildResources, { recursive: true });
fs.mkdirSync(path.join(app, 'build')); fs.copyFileSync(path.join(buildResources, 'icon.png'), path.join(app, 'build', 'icon.png'));
fs.mkdirSync(path.join(resources, 'engine')); fs.copyFileSync(engine, path.join(resources, 'engine', 'autolabel-engine.jar'));
fs.cpSync(path.join(baseline, 'runtime'), path.join(resources, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(resources, 'inference')); fs.copyFileSync(path.join(inference, 'worker.py'), path.join(resources, 'inference', 'worker.py'));
if (media) {
  fs.mkdirSync(path.join(resources, 'media-tools'));
  for (const filename of ['ffmpeg.exe', 'ffprobe.exe', 'versions.json']) fs.copyFileSync(path.join(media, filename), path.join(resources, 'media-tools', filename));
  fs.mkdirSync(path.join(resources, 'third-party', 'ffmpeg'), { recursive: true });
  for (const filename of ['LICENSE', 'README.txt', 'source.json']) fs.copyFileSync(path.join(media, 'third-party', 'ffmpeg', filename), path.join(resources, 'third-party', 'ffmpeg', filename));
}

await build({ entryPoints: [path.join(desktop, 'scripts', `desktop-${check}-check.ts`)], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(app, 'desktop', 'dist', `${check}-check.cjs`), logLevel: 'warning' });
const mainPath = path.join(app, 'desktop', 'dist', 'main.cjs'); let main = fs.readFileSync(mainPath, 'utf8');
const marker = '  if (process.argv.includes("--desktop-release-check")) {';
if (main.split(marker).length !== 2) throw new Error('冻结启动检查标记不唯一，停止包装');
const checkFunction = { release5: 'checkRelease5', release6a: 'checkRelease6a', release6b: 'checkRelease6b', release7a: 'checkRelease7a', release7b: 'checkRelease7b' }[check];
main = main.replace(marker, `  if (process.argv.includes("--desktop-${check}-check")) {\n    await require("./${check}-check.cjs").${checkFunction}(window, output2, engine, grants, userData);\n    require("electron").app.quit(); return;\n  }\n` + marker);
fs.writeFileSync(mainPath, main);
const config = require(path.join(desktop, 'build', 'electron-builder.cjs'));
config.directories = { app, output, buildResources }; config.files = ['**/*', '!**/*.test.cjs'];
config.extraResources = ['engine', 'runtime', 'inference', ...(media ? ['media-tools', 'third-party'] : [])].map(name => ({ from: path.join(resources, name), to: name }));
config.win.icon = path.join(buildResources, 'icon.ico'); config.nsis.include = path.join(buildResources, 'installer.nsh');
config.electronVersion = require('electron/package.json').version;
const configPath = path.join(stage, 'builder.json'); fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(stage, 'inputs.json'), JSON.stringify({ desktop, renderer, engine, inference, ...(media ? { media } : {}), output, testHook: `desktop-${check}-check.ts` }, null, 2));
console.log(`冻结输入完成：${stage}`);
const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--win', 'nsis', '--x64', '--config', configPath], { cwd: root, stdio: 'inherit', windowsHide: true });
process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
