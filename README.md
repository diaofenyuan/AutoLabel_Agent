# 自动标注小助手

Windows 中文桌面标注工具，采用 Electron、React、TypeScript、Java 21 和 SQLite。界面按 Codex 式中性、简洁的工作空间设计，支持可选 Python YOLO 推理进程。

当前处于开发与集成阶段。完整需求见 SPEC.md，实际进度和验收缺口集中记录在 TASK_PLAN.md；不要把设计计划或最小安装包当作全部功能已完成。

## 开发

需要 Node.js 和 Java 21；安装后的正式程序会包含 Electron 与 Java 运行时。首次安装开发依赖并构建引擎：

```powershell
npm install
npm --prefix renderer install
npm run build:engine
npm run dev
```

无法下载 npm 依赖时可在安装命令后追加 `--registry=https://registry.npmmirror.com`。Java 发现规则与依赖构建说明见 engine/README.md。

## Windows 构建

```powershell
npm run pack:win
```

此入口先构建 Java、界面与桌面主进程，再生成包含运行时的安装包。输出在 build/release/；安装包支持选择安装路径和桌面快捷方式。当前签名及实际验收状态以 TASK_PLAN.md 为准。

## 验证

- `npm run check:desktop`、`npm run check:agent`：类型检查。
- `npm run test:desktop`、`npm run test:agent`：关键通信和操作边界。
- `powershell -File scripts/engine-build.ps1 -Test`：引擎关键链路。
- `npm run smoke:packaged`：使用已构建的应用 EXE 检查内置运行时及桌面通信。
- `node scripts/validate-agent-integration.mts`：隔离本地协议服务下的 Agent → Java → 标注队列联调，不代表实际服务商验证。
- `py -3.11 scripts/validate-datasets.py <导出目录...>`：使用已安装的 Ultralytics 读取实际导出数据，不训练模型。

模型 API Key 在应用的模型中心填写，由桌面凭据模块保存；不要放进源码。离线街景为合成图片，附带的两个框是人工预置示范，不是完整真值集或 AI 标注结果。
