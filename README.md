# 自动标注小助手

Windows 中文桌面标注工具，采用 Electron、React、TypeScript、Java 21 和 SQLite。界面按 Codex 式中性、简洁的工作空间设计，支持可选 Python YOLO 推理进程。

当前处于开发与集成阶段。需求与验收计划是本地文档（SPEC.md、TASK_PLAN.md），未纳入版本库；不要把设计计划或最小安装包当作全部功能已完成。模块实现现状见 `engine/README.md` 与 `desktop/`、`renderer/` 源码。

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

打包配置在 `packaging/`（`electron-builder.cjs`、`installer.nsh`、图标）且**已入版本库**：换一台机器 clone 后就能出包。此入口先跑 `check:all -- --skip-ui`（类型检查 + 全部单测 + 引擎测试，任何一步红都拦下打包），再构建 Java、界面与桌面主进程，最后生成含运行时的安装包，并做打包后契约与冒烟（`check:packaged-jar`、`check:installer-contract`、`smoke:packaged`）。输出在 build/release/；安装包支持选择安装路径和桌面快捷方式。当前签名与验收状态属本地计划文档（TASK_PLAN.md，未纳入版本库），安装包本身未做代码签名。全量回归（含 27 条 UI 验收）用 `npm run check:all`，受限环境可加 `-- --skip-slow` 跳过真下载/真推理的几条。

## 内置模型（不花钱的本机标注）

软件自带一组预训练模型，用本机算力标注，不需要 API Key，也不产生接口费用：

- **随安装包提供**（`resources/models`）：YOLO11n 的检测 / 分割 / 关键点 / 旋转框 / 分类五种任务，以及开放词汇检测用的 YOLO-World v2 S。
- **在模型库里按需下载**（落到 `<存储根>/models`）：YOLO-World v2 M、YOLO11s、以及开放词汇需要的 CLIP 文本编码器。只有你点了下载才会联网，下载完按 sha256 核对，内容不对就丢弃。
- **一键启用**：设置 → 软件 AI 配置 → 模型库，点「启用」即完成登记并授权给当前数据目录；之后在对话输入卡的「内置模型」里选它，或直接让助手挑。
- **开放词汇**：类别名由你给（如「人 / 汽车 / 交通标志」），不需要预训练固定的类别表。常见中文类别名有内置词表，命中即零下载；不在词表里的名字才需要 CLIP 编码器，本机没有时会明确报 `vocabulary_encoder_missing`，绝不偷偷联网。
- **本地推理环境**：设置 → 本地推理 → 「一键准备」，软件会自己找 Python、建独立虚拟环境，并从国内镜像装固定版本的 torch / torchvision / ultralytics / clip。

省钱对比里，本机方案与云端方案排在同一张指标表，本地行显示 `¥0 · 本机 N ms/张`。

## 验证

- `npm run check:desktop`、`npm run check:agent`：类型检查。
- `npm run test:desktop`、`npm run test:agent`：关键通信和操作边界。
- `powershell -File scripts/engine-build.ps1 -Test`：引擎关键链路。
- `npm run check:models`：内置权重在位且 sha256 与目录一致（打包前自动执行，不一致即中断打包）。
- `npm run check:model-library-ui`：模型库列表、一键启用与「内容不对就报需要修复」。
- `npm run check:runtime-setup-ui` / `check:runtime-setup-offline-ui`：一键准备环境的成功路径与断网保护。
- `npm run check:local-annotate-ui`：不配任何 API Key 走完标注，并验证候选进对比表且显示 ¥0。
- `npm run smoke:packaged`：使用已构建的应用 EXE 检查内置运行时及桌面通信。
- `node scripts/validate-agent-integration.mts`：隔离本地协议服务下的 Agent → Java → 标注队列联调，不代表实际服务商验证。
- `py -3.11 scripts/validate-datasets.py <导出目录...>`：使用已安装的 Ultralytics 读取实际导出数据，不训练模型。
- `py -3.11 inference/validate_vocabulary.py <模型.pt> <图片>`：开放词汇的分级词表（内置 / 缓存 / 编码器）与离线拒绝。
- `node scripts/validate-figurine-flow.mts`：真实接口下的「手办标注」端到端基线（候选落库、纯文本模型被拦且不污染结果、中文新词显式拒绝）；凭据只走 `AUTOLABEL_TEST_*` 环境变量，不落盘。

模型 API Key 在应用「设置 → 软件 AI 配置」里填写，由桌面凭据模块保存；不要放进源码。离线街景为合成图片，附带的两个框是人工预置示范，不是完整真值集或 AI 标注结果。
