# 实施协作约定

本文件只记录共享接口和分工，需求范围以 SPEC.md 和 TASK_PLAN.md 为准。主控任务负责联调及验收，各开发任务完成一轮后由主控继续派发。文档中的计划能力不得当作已实现能力。

## 最新视觉要求

用户于 2026-09-10 明确要求界面类似 Codex 的观感。七页统一采用克制的桌面工具布局：低饱和中性色、轻量侧栏、简洁顶栏、宽敞工作区、细边框、少阴影、清楚的字体层级与柔和短动画。画布与对话为中心，避免营销大标题、渐变大卡片和统计卡片堆叠。软件保留自己的中文名称，蓝色仅用于少量关键操作。此要求优先于此前宽泛的“官网级”风格解释。

## 文件归属

- 主控：shared/、agent/、inference/、COORDINATION.md、TASK_PLAN.md 的执行记录及集成验证。
- 界面任务：renderer/，含独立 package.json、Vite 配置及 dist/。七页中文 React + TypeScript 界面、画布、全部交互、动画。可独立安装 renderer 依赖。
- 引擎任务：engine/、scripts/engine-*。Java 21、SQLite、模型、媒体、队列、数据集、存储与单元测试。
- 桌面任务：desktop/、根 package.json、scripts/desktop-*、build/ 及安装打包。根目录不使用 npm workspaces，构建通过 npm --prefix renderer run build。
- 不跨归属改文件；需要接口变更时先通知主控。共享目录不执行覆盖、清理或格式化他人文件。

## 第一版进程协议

- shared/protocol.ts 是界面基础实体类型。时间为 ISO 8601，坐标为基准图像素，类别使用稳定字符串 ID。taskType 使用小写 detect/obb/segment/pose/classify。
- Java 启动入口读取 stdin 第一行 JSON：`{"token":"随机令牌","dataDir":"绝对路径","protocolVersion":1}`，凭据和令牌不得进入命令行。stdout 就绪行：`{"type":"ready","port":动态端口,"protocolVersion":1,"version":"0.1.0"}`，普通日志使用 stderr 并脱敏。
- 引擎仅监听 127.0.0.1，`GET /health`、`POST /command`、`GET /events?after=序号`、`GET /media/{assetId}` 均由 Electron 代理并带 `Authorization: Bearer 启动令牌`。
- 命令请求 `{"command":"project.list","payload":{}}`；响应 `{"ok":true,"data":任意JSON}` 或 `{"ok":false,"error":{"code":"稳定错误码","message":"中文说明","details":{}}}`。HTTP 状态保持语义一致。
- SSE 的 id 为 sequence，data 为完整 EngineEvent；事件必须提交数据库后发送。首次快照通过 event.snapshot 返回 `{sequence, ...}`。安全退出命令 `engine.shutdown`。
- 主进程保存 Key 后通过已鉴权的内部 credential.set 命令向 Java 注入，Java 仅在内存持有密钥；重启由主进程重新注入。system.suspend / system.resume 仅由主进程调用，唤醒不自动解除人为暂停或重发未知请求。Java 任务提供 engine/build/runtime-path.txt 或 engine/build/runtime/ 供桌面打包。
- Renderer 仅使用 `window.autoLabel`（类型见 shared/protocol.ts），不访问 Node、任意 HTTP 或令牌。主进程代理素材为受限 `autolabel-media://asset/{id}`，给 UI 的 mediaUrl/thumbnailUrl 使用此地址。开发浏览器可使用 Vite 受控代理及隔离演示适配器；演示不能显示 AI 成功或冒充持久化引擎。
- 桌面开发从 renderer dev server 加载，生产从 renderer/dist/index.html 加载；Vite base 使用 './'。

## 命令约定

采用以下名称和最小字段；实现需要新增命令或字段时在此追加并通知主控。

| 命令 | 请求 payload | data |
| --- | --- | --- |
| project.list | 空 | Project[] |
| project.create | name, description?, taskType, classes? | Project |
| project.update | projectId, name?, description?, classes?, settings? | Project |
| project.open | projectId | Project |
| project.example | 空 | Project（明确预置人工样例） |
| asset.list | projectId, offset?, limit?, status? | {items: Asset[], total} |
| asset.import | projectId, paths: string[], mode?: copy/reference | {imported, skipped, errors} |
| asset.get | assetId | Asset |
| annotation.save | assetId, annotations, baseVersion, confirm?: boolean | Asset |
| annotation.draft | assetId, annotations, baseVersion | {savedAt} |
| export.preflight | projectId, taskType?, assetIds?, formatId?, formatVersion? | {issues, summary, format} |
| export.create | projectId, outputDir, taskType?, assetIds?, trainRatio?, onlyConfirmed?, formatId?, formatVersion?, format? | {id, path, status, labelFormat, ...} |
| export.list | projectId | array |
| export.format.list | taskType? | 数组，内置预设 + 保存模板（扁平定义：元数据与格式字段同层） |
| export.format.get | formatId, version? | 格式定义 |
| export.format.save | id?, baseVersion?, taskType, name, category?, note?, labelFormat, precision?, naming?, layout, includeDataYaml?, cocoFileName?, csvBom?, csvColumns? | 版本化后的格式定义 |
| export.format.delete | formatId, baseVersion? | {formatId, version, deleted} |
| provider.list | 空 | array（不包含凭据） |
| provider.save | id?, name, baseUrl, protocol, model?, ... | object（不包含凭据） |
| provider.models | providerId | {models: string[]} |
| provider.test | providerId, model, capability | {status, testedAt, message} |
| credential.set | providerId, key | {saved: true}（主进程拦截、safeStorage 保存后通过受控通道注入 Java） |
| run.create | projectId, assetIds?, providerId, model, prompt, concurrency?, maxRequests?, ... | run |
| run.list | projectId? | array |
| run.get | runId | run（包含 samples 和 statistics） |
| run.pause / run.resume / run.cancel / run.retry | runId, assetIds? | run |
| event.snapshot | runId? | {sequence, ...} |
| event.list | runId?, assetId?, after? | EngineEvent[] |
| resource.list | kind? | array |
| resource.save | id?, kind, name, content | object |
| settings.get | 空 | object |
| settings.save | settings | object |
| diagnostics.get | 空 | object |
| chat.send | projectId?, providerId, model, messages, tools? | {content, toolCalls?, usage?} |
| dataset.version.preflight | projectId, annotationScope? | {assets, excluded, groups, inspection, blocking, canBuild} |
| dataset.version.create | projectId, name?, annotationScope?, seed? | 版本视图（status=building，异步生成） |
| dataset.version.get / list / items | versionId / projectId?,offset?,limit? / versionId,outcome?,offset?,limit? | 版本视图 / {items,total} / 逐项记录 |
| dataset.version.cancel / delete | versionId / versionId, confirm:true | {cancelled} / {deleted} |
| dataset.version.compare | versionId, otherVersionId | {added, removed, changed, unchanged, classesChanged, recipeChanged} |
| dataset.version.verify | versionId | {verified, total, missing, changed, consistent, contentHash, manifestHash} |

第一轮先打通项目、离线人工示例、编辑保存及导出。所有未实现入口须说明缺少条件，禁止虚构任务数据、成功提示和远端百分比。总目标继续覆盖全部八阶段，不因首轮完成宣布全部完成。

## Agent 与流程接入

- agent/worker.ts 由 Electron utilityProcess.fork 启动，esbuild 打包到 desktop/dist/agent.cjs。父子消息定义在 agent/types.ts：主进程发 `{type:'agent.request',id,payload}`；worker 发 agent.response、agent.event；worker 所需引擎调用发 `{type:'engine.request',id,command,payload}`，主进程返回 engine.response。worker 没有引擎 token。取消为 `{type:'agent.cancel',sessionId}`。
- renderer 使用 agent.chat（主进程拦截），payload 为 `{sessionId,projectId?,providerId,model,messages:[{role:'user'|'assistant',content}],context?,autoExecute?}`。context 可包含 annotationProviderId、annotationModel、assetIds、prompt、maxRequests、exportDir。exportDir 必须来自用户文件对话框并在主进程校验；模型工具参数中没有路径权限。缺省标注配置读取 project.settings.providerId/model/prompt。agent.cancel 的 payload 为 `{sessionId}`。
- 返回 `{content,messages,actions,status}`；status 为 completed/needs_input/cancelled/limited。actions 是真实工具执行结果或明确的 planned 状态。后续消息仅传用户和助手文本；原生工具消息由 worker 构造。agent.open_asset 事件只请求定位，界面不能覆盖未保存编辑。
- Agent 临时通知使用独立 bridge.onAgentEvent（shared/protocol.ts 的 AgentEvent），没有 sequence，不与 Java 持久 SSE 游标混用。此订阅在旧适配器中可选，正式桌面应提供。
- 阶段 5 的 Agent context 新增 concurrency（1～32）、referenceAssetIds、referenceResources；maxRequests 可显式 null 表示不设本轮上限，不向 Java 发送 null 预算。项目内参考必须排除在明确目标范围之外；共享资源参考使用 `{resourceId,version?,classMap?}`，由用户选择映射、Java 固定实际版本，两类参考合计最多 63 项并受接口图片上限约束。模型不能通过工具参数改写参考映射。对话不读取逐图真值类别或坐标。
- shared/configuration.ts 统一界面与助手的步骤、项目、全局覆盖规则，并返回来源；项目兼容旧 providerId/model 和新的 annotationProviderId/annotationModel。切换接口不继承另一接口的模型名，显式 null 请求上限不能被空值回退覆盖。
- provider.capabilities({providerId,model}) 返回 `{tools,text,image,...}`，值 verified/unverified/unsupported，必须绑定接口配置版本和模型。未通过原生工具测试只允许对话。
- chat.send 的 messages 使用 OpenAI Chat 消息结构，包括 tool_call_id / tool_calls。tools 使用 Chat functions 结构，Java 适配 Responses。统一返回 `{content,toolCalls?:[{id,name,arguments}],usage?}`。可携带 sessionId 和 maxRequests，模型调用仍由 Java 计数及执行。
- shared/flow.ts 提供流程定义、模块中文名、默认流程及输入输出校验，供画布与 Agent 复用；它不承担标注调度。

## 可选本地推理进程

- inference/worker.py 为可选 Python 进程，由 Java 每设备最多一个工作进程串行调度；普通图片和 API 标注不依赖它。
- `python -u inference/worker.py` 隐藏启动，stdout 首行 `{type:'ready',protocolVersion:1}`。stdin 按行接收 `{id,command,payload}`；响应 `{type:'response',id,ok,data}` 或 error。阶段事件 `{type:'event',id,assetId,stage:'local_inference'}` 仅表示实际进入推理。
- probe 返回实际运行环境；load 接 `{modelPath:绝对路径,taskType,device:'cpu'|'0',expectedModelHash?}`，返回模型任务、内容指纹和原始类别表。模型必须是已存在的 .pt/.onnx 文件，worker 不自动下载。加载失败清除旧模型；Java 桥接必须提供并核对冻结摘要。
- predict 接 `{imagePath:基准图绝对路径,assetId,classMap,expectedInputHash?,imageSize?,confidence?,iou?,maxDetections?,keypointNames?}`。classMap 的键为模型类别编号，值为项目稳定类别 ID；明确忽略用 null，缺映射不能静默当作无目标。结果含 annotations、width/height、source、modelHash、inputHash、device、requestedDevice、observedBackend、elapsedMs、excludedByClassMap，使用基准图像素坐标。device 保留旧协议兼容，只表示请求值；observedBackend 为 null、实际 PyTorch 权重设备，或 ONNX Runtime 实际启用的 providers 列表，后者不证明全部算子在 GPU。shutdown 有应答后退出。
- Java 启动时设置 AUTOLABEL_PARENT_PID 为自身 PID；Windows worker 持有父进程句柄，父进程退出后结束自身，补足阻塞推理无法及时读取 EOF 的情况。正常取消、超时与清理仍由 Java 关闭所拥有的进程；不得按 Python 进程名称批量终止。
- 主控已用官方 YOLO11n Detect 模型，在合成街景上实际验证 CPU 和 RTX 5070 Ti GPU，各返回 11 个目标并通过坐标检查；任务类型不符与缺类别映射被拒绝。此结果只证明上述 Detect/设备范围，尚不等于 Java/界面集成或其余模型类型已验收。
- 后续 CPU 实测补充：YOLO11n Segment（街景 9 个轮廓）、Pose（官方 bus 样本 4 个人体、17 点）、Classify（街景 1 个分类）通过结构和坐标检查。OBB 的官方 boats 样本返回部分越界角点，inference/validate_runtime.py --task obb 的严格范围断言保留失败。接入时须保留候选及明确几何问题供人工复核，不能静默逐点钳制造成非矩形，亦不能把被拒绝结果伪装成无目标。测试模型与外部样本均位于 .qa/models，不打入安装包。
- OBB 输出现带 geometryIssues（annotationId/code/severity/field/message）和 requiresGeometryReview，越界原始角点完整保留。实际 boats 推理 169 个对象，其中 18 个明确标记越界；矩形直角关系保留。--allow-reviewable-geometry 只验证问题识别与关联，当前验证器用 basicStructureAndBoundsPassed 区分基础范围，并明确 adoptionValidation=requires_java_validation，不能跳过 Java 几何采用校验。
- Segment 从 masks.data 检查完整轮廓树，孔洞、多区域、退化或越界边界生成 segment_topology_unsupported，并在 geometryDiagnostics 保留 annotationId、所有 rings/parentRingId/depth/hole、基准像素坐标及 maskToBaseline。不能仅以 masks.xy 的单外轮廓作为完整结果。LocalInference.Prediction 保留完整 rawResult/issues/provenance；adoptable=false 时 annotations=null，不得以空标签覆盖。
- TransformedImages 在专属 generation 目录内持锁，逐视图发布 input.png/input.json，原子发布为完成点；close 保留已发布文件与有效空目录，仅清理本会话临时文件。外部取消通过 Control，不能依赖同步 close 打断 render。TransformGeometry 与像素生成均须接入流程产物、基准坐标回映及导出复核检查后开放节点。

## 软件内模型训练模块（本轮新增，阶段 9）

- 边界修订：`SPEC.md` 原先“不纳入软件内训练”的条款已按用户最新要求修订为第 10 节。训练在本地执行，不使用业务云，**不计入模型 API 预算**（不接入 `Budgets`/`Costs`），仅记录任务事件与耗时。本模块未实现前，不得在界面或说明中声称训练可用。
- 数据集统一为不可变快照 `training_datasets`（`snapshotHash`）：来源为 `upload`（用户选择的训练集与验证集目录）或 `export`（引用已完成导出版本，逐文件校验清单哈希后复制）。训练只读快照，启动后不可变；换数据即新快照与新任务。划分沿用导出既有的 `{split}` 与来源组防泄漏规则，效果图不进入训练图片。
- 引擎命令（参数与响应边界写入新增的 `shared/training.ts`，界面与桌面共用）：`training.runtime.get`、`training.dataset.create/list/get`、`training.job.preflight/create/list/get/metrics/log/cancel/retry`、`training.job.artifact`、`training.job.registerModel`、`training.job.delete`。
- 桌面：`training.dataset.create` 的 `trainDir`/`valDir` 必须经 `PathGrants.require(..., ['directory'])`；`training.job.artifact` 与 `local.model.resolve` 同级，不向渲染层开放。`local.model.register` 只接受经文件对话框或受管产物授权通道产生的 `modelPath`：训练产物由主进程先经 `training.job.artifact` 解析受管绝对路径，再 `PathGrants.add(path,'model')`，**不得为此放宽既有校验规则**。
- 训练进程：新增 `inference/train_worker.py`，沿用 `inference/worker.py` 的行级 JSON 协议族（`ready` 握手、`event` 进度、`response` 结果）、`AUTOLABEL_PARENT_PID` 父进程句柄监测与 `YOLO_AUTOINSTALL=false`；命令为 `probe`/`train`/`cancel`/`shutdown`。训练请求**不设固定总超时**，由 Java 侧心跳与停滞判定管理；**不得复用 `LocalInference`**（该类硬限制单请求 `timeout<=600000ms` 且一进程单活动请求）。
- 训练进程的实现约束（实测踩坑，不得改动）：Windows 上只要存在一个阻塞在 stdin 读取上的线程，之后再导入 `torch`/`ultralytics` 就会永久挂起。因此依赖必须在控制线程启动之前完成预加载（`preload()`），训练在主线程内联执行，控制线程只处理 `cancel`/`shutdown` 这类无导入的回执。协议通道固定为真实 stdout（`protocol` 引用），训练期的 `redirect_stdout` 不得改写协议行。
- 逐轮指标只上报 ultralytics 真实输出（`metrics/precision(B)`、`recall`、`mAP50`、`mAP50-95`、`train/*_loss`），落库值与 `results.csv` 同源；`on_fit_epoch_end` 在训练收尾时会以同一轮次再触发一次，重复与越界轮次必须忽略，不得重复计入任务进度。取消通过 `trainer.stop`（8.4）在当前轮次边界生效。
- 设备互斥：训练与 `LocalRuntime` 共享设备占用。训练占用设备时 `local.model.load`/`local.run.create`/`track.local.sequence` 返回 `device_busy_by_training`；推理占用设备时 `training.job.create` 返回 `device_busy`。不静默共享显存、不自动降级设备、不排队抢占。
- 进度真实性：进度只来自工作进程实际完成的训练轮次，不伪造百分比；估算剩余时间必须标注为估算；停滞只记录并提示，不静默终止进程；取消为优雅停止并保留已产出轮次指标与最后权重，超时后仅强制终止自身进程树。
- 打包（已落实，不得回退）：`build/electron-builder.cjs` 的 `extraResources` 中 `inference` 过滤为 `['worker.py','train_worker.py']`；冻结打包脚本（`desktop-pack-frozen.mjs`/`desktop-pack-milestone.mjs`）的输入校验与复制步骤已纳入 `train_worker.py`，缺少该文件时打包必须直接失败。
- Agent：训练命令**不进入** `agent/tools.ts` 白名单；后续如需只读能力，仅允许读取已提交任务状态。

## 本地数据存储与对话记录（阶段 1～6 已实现；阶段 7 验收部分完成）

- 存储根：默认 `<安装目录>\AutoLabelData`（开发态为 `<repo>\build\dev-install\AutoLabelData`），根下分三类受管目录 `datasets/`（划分好的训练集＝导出默认落点）、`uploads/`（用户上传的训练集）、`chats/`（对话记录）。三类均可单独覆盖为外部绝对路径，留空跟随存储根。启动时做可写探测，不可写则回退 `%LOCALAPPDATA%\自动标注小助手\AutoLabelData`，并在设置页与诊断中显示实际生效目录与回退原因，**不静默降级**。
- 命令：`storage.paths.get/save/probe/migration/migrate`。路径类设置**不得**走 `settings.save`（该命令对命中 `/path|dataDir|directory|credentialScope|root/i` 的字段一律以 `SETTING_REQUIRES_MIGRATION` 拒绝）；校验规则为绝对路径且非磁盘根、互不嵌套、不存在则创建、已有内容不清空，保存后立即生效且不自动搬移既有文件。
- 对话记录（对齐 Codex）：`<chats>/index.json`（会话索引：`id/title/titleSource/pinned/pinOrder/projectId/providerId/model/createdAt/updatedAt/lastMessageAt/messageCount/status`）+ `<sessionId>.jsonl` 逐条追加。命令 `chat.history.list/get/status/ensure/rename/pin/delete/clear/trash.list/restore/purge/export`；删除先移入 `<chats>/.trash/`（保留 7 天）；执行中的会话禁止删除；落盘在 `agent.chat` 拦截点完成，流式增量不落盘，失败记为带 `error` 的助手消息；API Key 永不入盘。
- 项目删除：`project.delete.preflight`（逐表计数 + 受管占用 + 外部导出目录 + 阻塞项）与 `project.delete`（要求 `confirmName` 完全匹配、默认先备份、必须在维护锁内、按反向依赖顺序显式级联）。外部导出目录**永不删除**。刻意不删 `video_sources`/`screening_features`（按内容寻址，跨项目复用）。
- 导出默认落点（阶段 5.1–5.3 已实现）：`export.create` 的 `outputDir` 可缺省，由桌面主进程注入 `<datasetsRoot>\<项目名>-<时间戳>` 并授权；流程定义中启用的 `export` 步骤缺省时同样注入，模板里显式写的路径仍逐一授权。渲染层只从 `storage.paths.get` 读取该目录用于提示，不自行拼接判断。
- 受管原图根（阶段 5.4–5.6 已实现，接口已冻结）：引擎启动 JSON 新增可选 `materialsRoot`，缺省保持 `<数据目录>/originals`；自定义值必须是绝对路径且不等于、不包含数据目录，否则启动即 `materials_root_invalid`，**不静默回退**。桌面在 `createBackend` 传入解析后的 `uploads` 目录，因此导入复制（`asset.import` 的 copy 模式）、素材重定位复制、流程导入暂存都落在该目录，`OverlayRenderer.protectTarget` 与 `ExportHistory.protectDestination` 同样把它当作受保护目录；`ProjectDeletion` 只删除数据库确认属于该项目、且位于数据目录或受管原图根之内的文件。
- 受管原图根的生效时机：该值只在引擎启动时读取。`storage.paths.save` 后若上传目录实际变化，主进程在引擎空闲（`system.canUpdate.ready`）时自动重启引擎使新落点立即生效，并返回 `materialsRoot:'active'`；有在途任务时返回 `materialsRoot:'pending-restart'`，界面必须如实说明「将在引擎重启后生效」，不得显示为已生效。
- 备份与恢复：归档条目沿用内容派生的相对名（`originals/imported-<hash>.<ext>`），恢复按绑定重写把外部受管原图收进新数据目录的 `originals/`，恢复目录自包含；三类新数据目录（`datasets/`、`uploads/`、`chats/`）**尚未纳入 `backup.create`**（计划 §5 风险 2 的建议项），界面与文档不得声称已被备份覆盖。
- 界面现状：阶段 3（Codex 式侧栏、对话主页、取消项目中心）与阶段 4 的界面部分（项目删除三步弹窗、会话删除/置顶/重命名入口）已在工作区实现并通过源码态八页 UI 检查（含项目删除弹窗断言），不属于缺口；仍有待补的是三类新数据目录纳入备份清单，以及需要外部环境的验收项（干净 Windows、真实用户机器升级演练、代码签名）。

## 数据集版本管理模块（本轮新增，阶段 10）

- 定位：数据集版本是「原始数据集 → 版本 → 产物」链路的中间层。素材标注版本（`versions`）、导出版本（`exports` + 清单）、训练快照（`training_datasets`）与评测集版本继续保持各自语义，导出与训练快照降级为版本的消费结果，通过可空 `datasetVersionId` 关联；旧数据保持可查、可复现。
- 不可变约束（实现时不得放宽）：版本进入 `ready` 后内容、清单与划分归属不可变更，任何调整必须产生新版本号；生成过程只读原始素材与标注；副本逐文件校验哈希；划分以来源组为最小单位，分组约束优先级高于比例与分层；增强仅作用于训练集（阶段 D）；同源 + 同配方 + 同种子必须得到同一内容哈希。
- 存储与命令：schema 由 9 升至 10，只新增 `dataset_versions`（项目内递增 `number`，`UNIQUE(project_id,version)`）、`dataset_version_items`（被排除项也入库并带 `reasonCode`）、`dataset_version_builds`（分阶段真实计数进度）与可空字段，不改既有表结构。目录为数据根下 `datasets/versions/<version_id>/`，先写 `.autolabel-partial-` 临时目录再原子发布，失败整体删除。
- 清单：`manifest.json` 使用 `schemaVersion 3`、`kind='dataset-version'`，与导出清单同源；**不得包含绝对路径、用户目录与凭据**（I9）。读取侧对缺字段的历史清单回退既有约定。
- 阶段 A 只支持最简配方：`sourceKind='project'`、`annotationScope` 为 `labeled`/`confirmed`、无筛选与转换、按默认 70/20/10 以来源组为单位划分（`rule='ratio-source-group-v1'`）。`upload`/`export` 来源、过滤与采样、几何裁剪与平铺、增强、自定义划分分别属于后续阶段，未实现前不得在界面声称可用。
- 桌面与 Agent：`dataset.version.*` 写操作**不进入** `agent/tools.ts` 白名单，只能由用户在界面显式触发；所有命令的参数结构写入 `desktop/validation.ts`，不引入新的路径授权（版本副本全部位于受管目录）。
- 删除为软删除，副本保留，彻底清理交由「本地数据存储」生命周期处理；阶段 F 之前没有消费端引用版本。

## 桌面更新接口

- settings.updateManifestUrl 为更新清单地址，空字符串关闭更新。UI 通过 update.status/check/download/cancel/install 命令及空 payload 调用，主进程持有下载与安装状态，不接受界面任意可执行路径。
- 返回 `{state,currentVersion,release?:{version,releaseNotes,publishedAt?,size},downloadedBytes,totalBytes?,error?:{code,message}}`；state 为 unconfigured/idle/checking/up-to-date/available/downloading/verifying/ready/cancelled/error/installing。下载时 UI 可约每 500ms 查询真实字节进度，不伪造百分比。
- 清单 `{schemaVersion:1,appId:'com.autolabel.assistant',platform:'win32',arch:'x64',version:'x.y.z',releaseNotes,downloadUrl,sha256,size,publishedAt?}`。正式仅 HTTPS；HTTP 回环仅为测试实例使用。安装前重检文件摘要、PE 产品名与版本；全量活动任务未结束时阻止安装，先让用户处理任务。
- 没有线上服务器时只验证本地测试清单、下载校验与失败处理，不能宣称线上更新已经可用。

## 第二轮人工链路接口

- system.canUpdate 返回 `{ready,locked,counts:{runningRuns,activeSamples,activeCalls,writingExports,activeCommands},reasons:[]}`。system.prepareUpdate 原子阻止新写任务并全量核对；忙时返回 ready:false 并解锁，就绪时保持锁到 system.cancelUpdate 或退出。三个命令只供主进程更新管理使用。
- annotation.importYolo 接 `{projectId,labelSpace:'source'|'baseline',classMap:{'0':'稳定类别ID'},labelsDir?,assetIds?,items?:[{assetId,labelPath,baseVersion?}],confirm?:false}`，返回 `{imported,errors:[{assetId,code,message}],items}`。当前 txt 入口覆盖 Detect/Pose/OBB/Segment；Classify 不使用此入口。空文件为显式无目标，缺失/歧义/非法文件不修改原标注。
- asset.relocate 接 `{projectId,directory,assetIds?}`，返回 `{relocated,unchanged,issues:[{assetId,code,candidates?}],items}`，按所选目录内的源内容指纹与尺寸核对。asset.checkLocations({projectId,assetIds?}) 返回原文件及基准图状态，基准图尚在时仍可使用。
- annotation.render 接 `{assetId,version?,outputPath,format?:'png'|'jpeg',showLabels?,showKeypoints?,showGeometry?}`，返回 `{path,assetId,version,width,height}`。只绘制已保存版本，不能覆盖素材或历史导出。
- export.reproduce 接 `{exportId,outputDir}`，生成独立新副本；export.compare 接 `{exportId,otherExportId}`，返回 `{added,removed,changed,unchanged,formatChanged}`。均读取历史固定清单和副本。
- 自定义导出格式（本轮新增）：`export.format.save` 的定义为扁平结构，格式字段为 `{labelFormat:'yolo'|'coco'|'voc'|'csv', precision:1~8, naming:'assetId'|'original', layout:{image,classifyImage,label,index}, includeDataYaml, cocoFileName, csvBom, csvColumns}`。路径模板占位符限于 `{split}{name}{assetId}{index}`，分类任务额外允许 `{classId4}{className}`；图片路径必须以 `.png` 结尾（导出不转码），标签 `.txt`/`.xml`、索引 `.json`/`.csv` 由格式决定。导出图片目录、标签目录与索引文件全部由模板渲染，`{split}` 使索引按划分各生成一份。
- 格式任务兼容：yolo 覆盖全部五种任务；csv 覆盖全部五种；coco 支持 detect/segment/pose；voc 仅支持 detect。不兼容组合在保存与导出时都以 `export_format_task_unsupported` 拒绝，不能生成看似有效却无法训练的数据集。
- 导出清单升级为 schemaVersion 2：新增 `format`（本次生效的完整规范，含来源 id/version）与 `auxiliaryFiles:[{path,hash}]`，逐图条目按需记录 `label`/`labelHash`（COCO/CSV 无逐图标签）。复现按清单记录的实际路径逐项校验复制，旧清单缺少这些字段时回退 YOLO 约定，因此删除格式模板后历史副本仍可复现。
- Agent 只能通过 `list_export_formats` 读取可用格式，并在 `export_dataset` 里引用已存在或内置的 `formatId`；模型不能自造目录模板或内联规范，`export.format.save/delete` 不在 Agent 命令白名单内。
- 所有新增输入文件/目录及输出路径仍需由主进程按文件对话框授权校验，不能把模型输出当成路径权限。

## 开发任务

阶段 5 资源命令：resource.list 支持 kind/category/query/limit/offset；resource.save 仅创建或修订 prompt/template/flow，修改必传 baseVersion，旧资源从 0 迁移。resource.get `{resourceId,version?}` 读取版本；resource.apply `{projectId,resourceId,version?,fields}` 仅覆盖明确选定字段；resource.reference 从 `{assetId,assetVersion,name,category?,note?}` 的已保存人工版本创建受管参考。resource.image 仅供主进程解析 `{resourceId,version?}` 为受管路径；界面图片地址为 `autolabel-media://resource/{resourceId}/{具体版本}`，不接收任意路径。run.create 和 evaluation.rerun 的方案均接 referenceResources；普通 resource.save 禁止写内部评测、版本或伪造人工参考。

数据维护接口（已完成 release-5）：界面调用 backup.preflight/create `{outputDir}`、backup.inspect `{backupPath}`、restore.prepare `{backupPath,targetParent}`、storage.status `{}`、storage.activate `{preparationId}`、storage.migrate `{targetParent}`。路径均来自桌面对话框；主进程独占生成 operationId 并协调 system.prepareDataMaintenance/cancelDataMaintenance，界面不能指定锁所有者或凭据作用域。restore.prepare 的候选目录只存于主进程，界面拿一次性 preparationId；外部恢复使用新的空凭据作用域，本机目录迁移沿用当前作用域。返回类型见 shared/storage.ts，备份进度事件为 backup.progress。切换先验证新引擎与项目可读，随后原子提交桌面配置；当前用户数据不被覆盖，提交前失败回到原目录。

阶段 6A 流程接口（已冻结）：完整 DTO 位于 shared/flow.ts。flow.capabilities 返回实际可用节点；flow.preflight/create 共用 FlowStartRequest，input 必须明确全项目、未标注、显式 ID 或固定 artifact，执行 API 步骤必须给共享请求上限。flow.get `{flowRunId}`、flow.list `{projectId?,offset?,limit?}`；flow.artifact `{artifactId,offset?,limit?}` 返回项目归属、固定版本和逐项结果，不返回内部文件路径。flow.pause/cancel `{flowRunId}`；resume/retry/rerun 参数见相应共享类型，重跑产生新 revision 与失效步骤列表，不原地修改旧快照。需要人工检查的 review 只暂停等待，resume 的 acknowledgeReviewStepId 不代表批量人工确认标签。

流程硬边界：最多 30 步，stepId 为 1～128 个字母、数字、下划线、点或连字符；流程名 1～200 字符。project explicit/filter.assetIds 最多 10000、去重且不得为空；import.paths 最多 10000、每项最多 32767 字符，目录展开后也最多 10000，超过则阻断且不截断。filter 宽高整数 1～100000 且 min≤max；随机抽样 count 为 1～1000 且不超过有效输入数量，seed 为 1～256 字符。API prompt 为 1～100000 字符，参考合计最多 63，concurrency 1～32、maxRetries 0～6、maxRequests 1～1000000。flow.list 每页最多 100、artifact 每页最多 500。单步执行非首节点必须提供兼容 artifact，不隐式执行前驱。import 仅第一启用步，export 是最后启用步；transform/local 尚未实现时拒绝执行。

流程路径与事件：桌面逐一授权 definition 中 import.paths 和 export.outputDir，模板中残留路径不自动取得权限；Agent 不能从模型参数取得路径授权，只能使用用户选定导出目录。event.list 支持 flowRunId；EngineEvent 同时保留子运行 runId、flowRunId、stepId、assetId、attemptId 和全局 sequence，事件在状态提交后发出。

6A 五节点和 6B 普通图片候选复用接口已冻结并分别收入 release-6a/release-6b。run.create 与 flow API parameters 使用 shared/reuse.ts 的 reuseEnabled（默认 true）、forceRerun（默认 false）、reuseMaxAgeSeconds（正整数秒或 null 无时限）；重试绕过读取，评测仍真实调用。候选、样本和流程产物公开 reused/reusedFrom，统计 reused 是 succeeded 子集，命中不生成 attempt、不消耗 API 预算、不继承人工确认。Agent 还须分别计入聊天请求，不能将复用会话显示为总请求 0。强制新调用成功结果可以成为后续来源，凭据绑定、完整输入/配置和有效期仍需一致。

阶段 7A 冻结契约：shared/preprocessing.ts、shared/inference.ts、shared/flow.ts 为共享 DTO。schema 4 的 samples 使用独立 inputId（普通图等于 assetId，变换图等于原始产物项 UUID），assetId 始终是父图；run_baselines 每运行每父图只存一份快照和计划，input_results 保存不可变单输入结果，run_asset_results 按完整 resultSetHash 保存不可变父图聚合。视图模型请求目标身份使用 inputId；父图只按一组输入聚合生成候选，不能被最后一片覆盖。views/view_annotations 与父图 annotations 产物分开，父图和模型输入分别计数。viewReuse:true 已通过独立输入结果的来源与强制重算验收，当前结果集合聚合持久化后才允许下游继续。

7A local 参数也使用 ReusePolicy；sample/FlowArtifactItem 的 inputReusedFrom 及 InputResult.provenance.reusedFrom 使用 shared/reuse.ts 的 InputReuseProvenance。API 来源必须关联真实 attempt；local 来源记录模型 ID、数字版本、模型/worker 摘要与实际后端，不沿复用链，也不捏造父图聚合的单次来源。每设备 load 在同一截止时间内先实际 probe，再 load；冻结该设备进程的 Python/Ultralytics/Torch/ONNX Runtime/NumPy/OpenCV 版本，缺键时正常执行但不复用，显式 null 区分可选 ONNX 后端不可用。暂停后重载的环境身份变化时保持旧快照并以 local_environment_changed 暂停，要求创建新运行；来源实际环境也须匹配其冻结版本。

本地接口：local.runtime.configure `{pythonPath:string|null}` 由桌面拦截并仅在本机配置中原子保存；local.runtime.probe 返回实际环境。local.model.register 使用用户刚选择的模型路径登记不可变版本，local.model.list 分页，local.model.load 返回模型实际类别和 observedBackend。local.run.create 与 flow local 参数见 LocalParameters，类别映射须完整且 null 表示明确忽略。公开 Run 的 modelId/modelVersion/device 及 FlowStepState.local 来自冻结快照；恢复不能用活动模型头替代。run.result.get `{resultId}` 返回 InputResult，上限 32 MiB，超限保留原始存证并返回错误。正常 API 不依赖 Python。

只读本地入口：local.runtime.get `{}` 返回当前内存环境与 slots，不启动 Python；slots 可含已加载真实 classes/workerHash/observedBackend。local.model.get `{modelId,modelVersion?}` 只读指定登记版本元数据，不返回路径或恢复执行授权；加载及运行仍须实际文件摘要/授权校验。Agent 只能通过这些公共只读入口取状态和模型，不能调用私有 resolve。原生严格工具参数中的 classMap 使用 `{modelClassId,projectClassId:string|null}[]`，拒绝重复编号后转为实际流程的 Record；已保存流程和 IPC 始终使用实际 Record。

本地执行授权：私有启动 JSON 可带 localWorkerPath、localPythonPath 和 localModelAuthorizations（当前 credentialScopeId 已选定的 path/modelHash，最多 500 条、总启动消息 8 MiB）；local.model.authorize 和 local.model.resolve 均不得对 renderer/Agent 开放。Java 每次加载/推理核内存白名单及实际 SHA，不从数据库或备份还原执行授权。外部恢复新作用域不继承授权，本机迁移保持当前授权。input 媒体通过 autolabel-media://input/{inputId} 和私有 flow.input.image 解析受管理的固定 PNG；不向界面返回内部路径。7A 冻结打包必须显式提供 --inference，不能回退到旧包 worker。

变换与复核：操作最多 30 个，单次 tile，边长不超过 20000 且每图最多 4000 万像素，实际边界由 Engine 逐图预检。TransformedImages 发布固定像素；TransformGeometry 保留完整孔洞/多区域诊断并正确回映。InputAggregation 仅将成功、合法、无需复核输入计入可采用覆盖；失败、未知、缺片、几何问题和局部 Classify 保留结果并要求复核。候选不覆盖人工正式版本，flow.resume 不解除几何标记。VideoFrames 仅 complete.json 成功产物可后续导入，视频时间身份不能被现有图片 SHA 去重抹去。

7B 活动契约集中在 shared/media.ts：媒体任务的 artifactCommitted 与 assetsCommitted 分开，completed/ready 只表示抽帧完整产物可导入，completed/done 且 assetsCommitted 才表示素材已入库；未知总量为 null。media.video.inspect/create 只接受桌面对话框授权来源，inspect 的像素宽高比假设必须可见，create 可固定 expectedSourceHash。任务列表最大 100、frames/screening 四类分页最大 500；公开 maxFrames 为 10000，不静默截断。schema 5 保存媒体任务、来源和筛选特征，只有已发布产物进入备份，发布清单保持原字节，数据库路径显式重定位。

flow.import.mediaJobId 与 paths 互斥，flow.filter.screening 生成可解释建议，excludeAssetIds 为明确排除；近重复和模糊不隐式删除，人工及草稿保持。帧保留字符串 PTS、实际时间基、源视频身份，同内容不同时间仍是独立素材。导出按内容与来源组的连通关系划分，清单保留 videoFrame 来源而不追加到 YOLO 标签行。Agent 媒体工具只读四项及提交筛选一项，无任意视频路径或工具执行配置权限。7B 必须继续显式使用冻结 inference-7a；活动 worker 的 7C 跟踪命令尚未接入产品。

7C 活动契约集中在 shared/tracks.ts：一个已入库 mediaJob 与固定模板建立 Detect/Pose 时间轴，实际 PTS 保留字符串，场景未检查为 null，跨抽帧范围间隙不猜连接。轨迹及关键帧修改使用轨迹/时间轴版本和标注/草稿前置条件，生成默认只重算受影响区间，保留其他轨迹贡献、历史与人工版本。shared/templates.ts 的版本化属性定义仅在显式包装时启用；旧冻结模板不从当前项目回填新语义，属性缺失生成保留待复核而不冒充有效标注。7B 五份冻结输入及已交付包不随活动 7C 重编。

- 主控：01a088bc-02d7-7753-ab13-8486bcd6b4fb。
- 界面设计与交互：01a088c0-1538-7ad2-96aa-202df18fbc56。
- Java 引擎与数据链路：01a088c0-16fd-7c10-bd05-57d25ba7bd3c。
- 桌面运行与安装交付：01a088c0-18c4-71a3-8513-8eeef756c37a。
