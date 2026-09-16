# AutoLabel_Agent 项目长期记忆

> 只记可复用硬约束；流水账见同日 YYYY-MM-DD.md。通用本机坑（回收站 fail-closed、工具进程被回收、GitHub 推送走 SSH 443）见用户级记忆。

## 1. 构建与测试
- 引擎 `scripts/engine-build.ps1`：`-TestScope all` **不含迁移用例**（DataMaintenanceTest、EvaluationTest/FlowIntegrationTest 的 migration）。动 `Store.SCHEMA_VERSION` 或迁移/备份路径必须显式跑 evaluation+flow-integration+data-maintenance+backup-integration，只跑 all 是假绿灯。基线：all 574、data-maintenance 56、backup-integration 33、evaluation 62、flow-integration 90、media-recipes 51（新范围须同步注册 ValidateSet 与 EngineTest 分支）。
- `Store.backupBeforeMigration` 必须独立连接 `VACUUM INTO`（否则 migration_backup_failed，已有数据目录无法升级）。`SCHEMA_VERSION=11`。
- 打包：`npm run build` → `prepare:runtime` → `prepare:media-tools`（设 `AUTOLABEL_MEDIA_TOOLS_DIR`）→ electron-builder --win nsis；拉取用 ELECTRON_MIRROR/npmmirror；签名需 `AUTOLABEL_WIN_CERT_FILE`+`PASSWORD`；包内 jar 与仓库 jar SHA256 必须一致。打包态已过 JAVA_HOME 无效等验收；`smoke:packaged`/`check:ui` 本沙箱超时未闭环，源码态 `--ui` 可过。
- **应用运行期间不要重建 engine jar**（运行中引擎会坏，事件表只剩 call.queued）。

## 2. 引擎与维护锁
- `desktop/engine.ts` spawn 两处修复勿改回：`-Djdk.virtualThreadScheduler.parallelism=64`；`-Dsun.net.httpserver.maxReqTime=20 -Dsun.net.httpserver.idleInterval=10`。在途命令闸门 12。客户端崩溃自动重启 ≤5 次（1s→30s），显式 stop() 撤销待执行重启。
- 判断请求是否真发出只看事件表：`call.queued→sent→completed/failed/unknown`；`call.not_sent`=发送前被拦。
- Maintenance：READ_ONLY 放行；DATA_ACTIONS 放行但须回传当前锁 operationId（backup.create/restore.prepare/project.delete）；新增动作改两侧（引擎 `Maintenance.DATA_ACTIONS` + 桌面 `storage.withMaintenance`），validation schema 不加 operationId；`backup.preflight` 必须在进维护态前调用。项目删除=createBackup（独立锁）+锁内 project.delete 级联。

## 3. 训练 / 数据集 / 导出要点
- 训练：不可变快照 snapshotHash；独立 `inference/train_worker.py`（不复用 LocalInference）；与 LocalRuntime 设备互斥；不计 API 预算、OOM 不自动重跑；extraResources filter 须含 train_worker.py。**（2026-09-16 起）训练触发/查询已进 agent 白名单**：只放开 `training.dataset.list/get/create`（create 仅 source=version，桌面侧 assertAgentCommand 拦截其它来源）、`training.job.preflight/create/list/get/metrics/cancel`；重试/删除/权重登记/产物目录设置仍只由用户操作，冻结约束不变。
- 数据集版本：版本不可变、原始数据只读、划分以来源组为单位且分组约束优先、增强仅训练集、同源+同配方+同种子→同哈希；目录统一 `DatasetVersions.versionsRoot(Store)`。
- SPEC.md 章节编号不变量：新内容插原 §10 之前；外部引用 3.1/4.1/6.5/9.3 必须保持有效。
- 导出：扁平结构；占位符 `{split}{name}{assetId}{index}`（分类加 `{classId4}{className}`）；图片 .png；yolo/csv 五任务、coco detect/segment/pose、voc 仅 detect；清单 schemaVersion 3 只追加 lineage；改格式须同步 ExportHistory 写入与复现两条路径；Agent 只能读 `list_export_formats`。`EngineTest.label("detect")` classId 固定 item。

## 4. 本机运行与验收
- Electron：必须删 `ELECTRON_RUN_AS_NODE`；`--no-sandbox --in-process-gpu --disable-gpu`；主进程 stdout 不进控制台（用 AUTOLABEL_STAGE_LOG 落盘）；用 node 直接 spawn（经 npm run 包装易超时）；「启动+驱动+收尾」放同一次调用，常驻用一次性 schtasks。
- 命令行走 PowerShell（bash 缺 coreutils）；PowerShell 工具不回显 stdout → Out-File 落盘再 Read；含中文 .ps1 必须 UTF-8 带 BOM；读无 BOM UTF-8 显式 -Encoding UTF8；追加写 `[IO.File]::AppendAllText`。npm 不在 PATH，用托管 node 目录下 `npm\bin\npm-cli.js`；渲染层校验 `--prefix renderer run build`。
- 源码态 UI 检查：`AUTOLABEL_EXTRA_LAUNCH_ARGS="--no-sandbox --in-process-gpu --disable-gpu" AUTOLABEL_SMOKE_TIMEOUT=240000 AUTOLABEL_TEST_USER_DATA=tmp/xxx node scripts/desktop-smoke.mjs --ui`（user-data 放 tmp/ 才过），约 22 秒。
- **选择器漂移**：改侧栏/导航/设置 DOM 或按钮文案，必须同步扫 `desktop/ui-check.ts` 与 `scripts/desktop-release*-check.ts`；分诊用 `.qa/ui-probe.mjs`；改 ui-check.ts 后先 `npm run build:desktop`。
- 界面（2026-09-16 重构后）：主导航只剩对话 / 任务 / 设置，项目概览走侧栏项目行与快速跳转；标注工作台、流程编辑器、模型训练页、资源库页面、模型中心均已删除（模型配置在设置「软件 AI 配置」）。`desktop-smoke --ui` 覆盖 3 导航 + 项目概览 + 六个任务页签 + 8 个设置区块；`--training-ui` 检查训练只读看板与真实快照。
- **仍失效的旧验收脚本**：`renderer/tests/desktop-manual-check.ts` 及其 media/run-control/update/quality/resource/editing/reuse/local/five 分支都依赖已删除的工作台画布，`npm run check:run-controls`、`check:media-ui`、`--manual` 目前会失败；要用必须按对话式界面重写或退役。
- 单轮删除阈值 100：UI 检查/打包验收分散到不同轮次。`.qa/` 放可复用驱动；`asset.list` limit≤100，用 total 计数。

## 5. 数据与清理约定
- 数据目录在 `%APPDATA%\自动标注小助手\desktop-settings.json` 的 dataDir（现指 D:\AutoLabelQA\migrated）；该 %APPDATA% 是配置目录、与打包冒烟共用，不是验收残留。
- 安装类验收后必须卸载（`scripts/qa-app-uninstall.ps1`，NSIS 卸载器不能等退出码）；中间产物放仓库 `tmp/` 即时删；删 build/ 下内容前先扫源码引用（media-tools/runtime/release/release-4c/dev-install、electron-builder.cjs、installer.nsh、icon.* 均被引用且 gitignore）。
- 用户长期资产一律落引擎库（四处同步：Engine.execute dispatch、Store 建表+SCHEMA_VERSION、validation.ts schema、Maintenance 只读放行）。
- `engine/build/verification/run-*` 随测试累积（GB 级），测完按时间戳删本次目录。

## 6. 并行工作流与 Git（含用户明确协作约定）
- **用户要求：每完成一个小步骤就提交 GitHub，提交信息用简要中文**。粒度由计划文档 §8.1 的步骤表定义，一次提交 = 一个步骤。
- 多工作流并行改同一批文件：动工前 `git status --porcelain`+mtime；有他人在途改动先通报、**不夹带提交**；提交只 `git add` 本次具体路径（勿 -A）；中文提交信息用 UTF-8 无 BOM 的 `tmp/commit-msg.txt` + `git commit -F`。
- 读 git log/show 先设 OutputEncoding UTF8（控制台乱码≠提交坏了）；push 的 stderr 不算错，看 `$LASTEXITCODE` 与 `旧SHA..新SHA main -> main`；`origin.pushurl` 已固定 SSH over 443，直接 `git push`。`git status` 的 `[gone]` 是本地显示问题，权威判定用 `git ls-remote`。
- 界面重构计划文档：`C:\Users\zhy23\Desktop\Agent化界面重构_实施计划.md`（Codex 风格 Agent 化重构，含 17 个提交步骤表与 4 项已确认产品决策）。桌面另有：内部模型训练、数据集版本管理、数据存储与对话记录、视频划分与标注流程改进 四份实施计划。
