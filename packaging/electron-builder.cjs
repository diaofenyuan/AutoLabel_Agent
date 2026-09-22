const path = require('node:path');

// 代码签名：只有同时提供证书文件与口令时才启用，未配置时保持未签名安装包，
// 交付说明中据实记录签名状态，不把本地无证书构建描述为已签名。
const certificateFile = process.env.AUTOLABEL_WIN_CERT_FILE;
const certificatePassword = process.env.AUTOLABEL_WIN_CERT_PASSWORD;
const signing = certificateFile && certificatePassword ? {
  certificateFile: path.resolve(certificateFile), certificatePassword,
  signingHashAlgorithms: ['sha256'],
  rfc3161TimeStampServer: process.env.AUTOLABEL_WIN_TIMESTAMP_URL || 'http://timestamp.digicert.com',
} : null;

module.exports = {
  appId: 'com.autolabel.assistant', productName: '自动标注小助手', executableName: '自动标注小助手',
  directories: { output: process.env.AUTOLABEL_RELEASE_DIR || 'build/release', buildResources: 'packaging' },
  files: ['desktop/dist/**/*.cjs', '!desktop/dist/*.test.cjs', 'desktop/fallback/**/*', 'renderer/dist/**/*', { from: 'packaging/icon.png', to: 'build/icon.png' }, 'package.json'],
  extraResources: [
    { from: process.env.AUTOLABEL_ENGINE_JAR ? path.resolve(process.env.AUTOLABEL_ENGINE_JAR) : 'engine/build/autolabel-engine.jar', to: 'engine/autolabel-engine.jar' },
    { from: 'build/runtime', to: 'runtime', filter: ['**/*'] },
    // 别名表（aliases.json）必须进包：worker 靠它在取向量前把中文名翻成英文规范名，
    // 少了它，安装包里「车辆 → car」这类名字会退化成「需要下载编码器」。
    { from: process.env.AUTOLABEL_INFERENCE_DIR ? path.resolve(process.env.AUTOLABEL_INFERENCE_DIR) : 'inference', to: 'inference', filter: ['worker.py', 'train_worker.py', 'vocab/*.npz', 'vocab/aliases.json'] },
    { from: 'build/media-tools', to: 'media-tools', filter: ['ffmpeg.exe', 'ffprobe.exe', 'versions.json'] },
    { from: 'build/media-tools/third-party', to: 'third-party', filter: ['ffmpeg/LICENSE', 'ffmpeg/README.txt', 'ffmpeg/source.json'] },
    // 内置模型权重：随包提供，用户不联网也能标注。半成品分段不带进安装包。
    { from: 'build/models', to: 'models', filter: ['**/*', '!*.part'] },
  ],
  asar: true, npmRebuild: false, electronLanguages: ['zh-CN', 'en-US'],
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'packaging/icon.ico', requestedExecutionLevel: 'asInvoker',
    ...(signing ? { signtoolOptions: signing } : {}) },
  nsis: {
    oneClick: false, perMachine: false, allowElevation: true, allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: '自动标注小助手',
    installerLanguages: ['zh_CN'], language: '2052', displayLanguageSelector: false,
    include: 'packaging/installer.nsh', deleteAppDataOnUninstall: false,
    artifactName: 'AutoLabel-Setup-${version}-${arch}.${ext}', runAfterFinish: true,
  },
};
