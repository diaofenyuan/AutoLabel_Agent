import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const installer = path.join(root, 'build', 'installer.nsh');
const builder = path.join(root, 'build', 'electron-builder.cjs');
const releaseDir = path.resolve(process.env.AUTOLABEL_RELEASE_DIR || path.join(root, 'build', 'release'));
const packageFile = path.join(releaseDir, 'AutoLabel-Setup-0.1.0-x64.exe');
const unpackedExe = path.join(releaseDir, 'win-unpacked', '自动标注小助手.exe');

const requireFile = (file) => {
  if (!fs.existsSync(file)) throw new Error(`缺少文件：${path.relative(root, file)}`);
  return fs.readFileSync(file, 'utf8');
};

const installerText = requireFile(installer);
const builderText = requireFile(builder);
const installerChecks = [
  ['安装时提供快捷方式页面', /Page custom AutoLabelShortcutPage AutoLabelShortcutPageLeave/],
  ['取消快捷方式时删除桌面链接', /Delete "\$newDesktopLink"/],
  ['保存取消快捷方式选择', /"DesktopShortcut" 0/],
  ['创建快捷方式时写入选择', /CreateShortCut "\$newDesktopLink"/],
  ['保存创建快捷方式选择', /"DesktopShortcut" 1/],
];
const builderChecks = [
  ['允许选择安装目录', /allowToChangeInstallationDirectory:\s*true/],
  ['使用多步骤安装器', /oneClick:\s*false/],
  ['创建开始菜单快捷方式', /createStartMenuShortcut:\s*true/],
  ['卸载保留用户数据', /deleteAppDataOnUninstall:\s*false/],
];

for (const [label, pattern] of [...installerChecks, ...builderChecks]) {
  const source = installerChecks.some(([item]) => item === label) ? installerText : builderText;
  if (!pattern.test(source)) throw new Error(`安装器契约不满足：${label}`);
}

for (const file of [packageFile, unpackedExe]) requireFile(file);
const result = {
  package: path.relative(root, packageFile),
  packageBytes: fs.statSync(packageFile).size,
  unpackedExecutable: path.relative(root, unpackedExe),
  shortcutPage: true,
  cancelShortcutBranch: true,
  installDirectoryPage: true,
  preservesUserData: true,
};
console.log(`安装器契约通过：${JSON.stringify(result)}`);
