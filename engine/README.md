# Java 引擎

从项目根目录构建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/engine-build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/engine-build.ps1 -Test
```

产物是 `engine/build/autolabel-engine.jar`，含 SQLite、JSON、EXIF 依赖及共享示例资源。`engine/build/runtime-path.txt` 输出 Java 21 根目录；`scripts/engine-java.ps1` 输出 java.exe 路径，加 `-HomePath` 输出根目录。支持 `AUTOLABEL_JAVA_HOME`、项目 `.tools/java`、`engine/runtime` 及本机已安装 JDK 21。首次依赖下载使用阿里 Maven 镜像。PowerShell 脚本兼容 Windows PowerShell 5。

启动参数、受保护 HTTP 与 SSE 以根目录 `COORDINATION.md` 为准；stdin 应保持打开，父进程断开后引擎退出。Key 只经 `credential.set` 注入当前进程内存，不进入数据库。数据目录不可放在程序安装目录内。

当前实现：项目与 JPEG/PNG 导入、EXIF 1～8、sRGB/PNG ICC/透明背景、正式标注及独立草稿、乐观版本校验、五类固定副本导出、接口配置和能力测试、Chat Completions/Responses、Java 有界标注队列、共享并发与频率、请求预算、有限重试、事务事件与 SSE、暂停取消及未知状态恢复。默认街景是合成图片及不完整的预置人工示范框。

补充接口：

- `annotation.history {assetId}` 返回最近 100 个版本；`annotation.draft.discard {assetId}` 丢弃独立草稿。
- `run.attempts {runId}` 返回最近 200 次调用详情，图像编码和凭据脱敏；运行详情最多返回 5000 个样本，带 `samplesTruncated` 标记。
- `provider.capabilities {providerId,model}` 返回能力状态和版本化测试依据；协议保存为 `chat-completions` 或 `responses`。
- `chat.send` 与 `run.create` 可带同一个 `budgetScopeId` 和 `maxRequests`，统一原子计数；未传 scope 时聊天可使用 `sessionId`，普通运行使用运行 ID。`budget.get` 查询额度，`budget.update {budgetScopeId,maxRequests}` 明确调整上限。
- `chat.cancel {sessionId}` 取消会话调用；等待共享额度期间不预占预算，已发送调用取消时保留未知状态。
- `run.resume` 可同时传 `maxRequests`；`run.retry` 默认只重试失败，只有明确 `retryUnknown:true` 才重新发送未知样本。
- `system.suspend/system.resume` 仅控制新分派，不重发未知请求；正常重启后运行先暂停等待复核。

标注模型必须返回 `{assetId, annotations:[...]}`，assetId 要与请求末尾 target 素材标识一致；坐标为规范化基准图像素。Pose 点名和点序来自 `project.settings.keypointNames`，OBB rotation 为度。结果缺失不作为无目标，空数组才表示模型未找到目标。新候选不覆盖人工版本、草稿或期间变化的正式版本。查看历史候选后可通过 `annotation.save` 以当前正式 `baseVersion` 明确采用。

导出生成独立目录，图片和标签固定，`manifest.json` 包含类别、几何、版本、来源和分组。分类目录使用与清单对应的数字类别名称。未传 assetIds 表示全部，显式空数组拒绝执行。未标注样本阻断导出，合法空目标保留。项目已有素材时不允许直接更改透明合成背景。

验证代码位于 `src/test/java/.../EngineTest.java`，测试数据在 `engine/build/verification/`。`-Test -TestScope transport` 只验证响应上限、正文超时、PNG ICC 和待发送取消。`-Test -TestScope capabilities` 验证能力测试使用的两张 64px PNG 的逐块 CRC/实际解码，以及原生工具名称/参数和结构化布尔值判定；测试图片由 Java 编码器生成，双图内容不同。完整检查包含本地受控 HTTP 协议并发、乱序、共享预算、429、超时、重启、人工保护与实际 JAR 握手；这些不代表真实模型 API 验收。主控另外使用实际 Ultralytics 加载了五类导出。

第二轮补齐的人工链路：

- `system.canUpdate {}` 全量检查；`system.prepareUpdate {}` 在同一锁内封闭新写入口并检查，返回 `ready/canUpdate`、`locked`、`counts`、`reasons`，忙时自动解锁。只有 `ready:true,locked:true` 才可安装。`system.cancelUpdate {}` 解除锁。历史 unknown 调用单独计数但不当作仍在本地执行；未处理的未知样本和未结束运行仍阻止更新。连接或检查失败不能视为空闲。
- 数据维护使用主进程内部命令 `system.prepareDataMaintenance {operationId}` / `system.cancelDataMaintenance {operationId}`；operationId 为 1～128 位字母、数字、下划线或连字符，桌面使用 UUID。prepare 返回 `{mode:'data',operationId,ready,locked:true,dispatchPaused:true,counts,reasons,message}`，未就绪仍持锁，同一所有者可重复查询。它同时关闭写命令入口和 Runs 认领/入队屏障，等待真实命令、worker、在途请求和保存结束；排队、等待重试、未知结果及暂停记录可原样保留。维护标志与用户/预算/休眠暂停独立，已发送结果正常保存；重启仅将原 running 改为 restart_review，原 paused 原因保留。
- 数据锁与更新锁互斥，普通写入返回 `engine_data_maintenance_locked`；其他所有者返回 `maintenance_owner_conflict`，错误维护类型返回 `maintenance_mode_conflict`。维护文件操作须经内部 `enterOwned` 准入，执行中重复操作或释放锁返回 `maintenance_operation_busy`，完成后才可释放。数据锁期间 `system.canUpdate` 始终为 false；只读查询仍可用。无锁取消也返回 released:true，并在本引擎会话内登记该 operationId 已取消；同 ID 迟到 prepare 返回 `maintenance_operation_cancelled`，防止超时乱序重新加锁。重复取消幂等，但不能释放其他 owner 或更新锁；每次新操作使用新 UUID。
- `-Test -TestScope data-maintenance` 通过 50 项专项：所有权与两类锁互斥、活动命令及文件操作占用、真实 Responses 在途候选落盘后才就绪、下一样本不越过屏障、分派选取与入队间竞争、释放后的单次继续，以及暂停原因重启保留；复用既有更新维护检查。
- `annotation.importYolo {projectId,labelSpace,classMap,labelsDir?,assetIds?,items?,confirm?}` 支持 Detect、Pose（三维可见性）、OBB、Segment。labelSpace 必须为 source/baseline，classMap 将数字类别映射到稳定 ID；items 形如 `{assetId,labelPath,baseVersion?}`。目录方式按同名 txt 配对，重名拒绝。有正式版本或草稿时需显式 baseVersion。缺失/非法标签不修改原数据，存在的空 txt 才是无目标；导入默认候选，confirm 才是人工确认。返回 imported、errors、items。
- `asset.checkLocations {projectId,assetIds?}` 区分源文件/基准图 intact、missing、changed、unavailable；`asset.relocate {projectId,directory,assetIds?}` 只扫描选定目录，按源 hash 和未旋转尺寸唯一匹配，保留版本/草稿/任务。引用素材更新路径，复制素材恢复受管副本；基准图丢失时必须重新生成到完全一致的内容 hash 才恢复。返回 relocated、unchanged、issues、items。
- `annotation.render {assetId,version?,outputPath,format?,showLabels?,showKeypoints?,showGeometry?}` 输出 PNG/JPEG，使用正式版本；Pose 连接来自 settings.keypointConnections（索引或点名对）。新保存版本保留类别/模板快照，早期无快照版本通过 templateSource 标识当前配置回退。拒绝覆盖现有文件、原素材目录及历史训练导出目录，保存事件关联输出摘要与版本。
- `export.reproduce {exportId,outputDir}` 从固定 manifest 和图片/标签/YAML 副本复制，验证每项摘要；项目之后变化不参与重导出。`export.compare {exportId,otherExportId}` 返回 added/removed 的素材 ID 数组、changed 的 `{assetId,fields}` 数组、unchanged 数量和 classesChanged。新版本保存 manifestHash/labelHash/yamlHash；首轮早期无清单摘要的导出返回 legacy_export_unverified，不能伪称可证明未被外部修改。

第二轮没有新增数据库表或绕开统一存储，新增关系保存在现有版本和导出 JSON 中。`-Test -TestScope manual` 只运行新人工链路检查。独立真值评测、复核队列和 schema v2 迁移已在下述 4C 第一段实现，费用阈值与固定输入重跑见第二段。分类文件夹标签导入、视频及 Python 推理接入尚未实现；完整线性流程、受约束候选复用与备份恢复见后续章节。模型流式响应尚未接入；SSE 当前传递实际本地阶段和持久化结果。旧 run.create 不接受 flow/steps/pipeline；完整流程通过独立 flow 命令执行。UI 延迟、大样本容量、真实 API、安装环境和人工效率仍需分别验收。

## 4C 第一段接口契约（已实现）

当前 JAR 提供以下命令。第一段的 evaluation.create 只消费既有运行的候选快照，不创建模型调用；多方案真实重跑采用第二段的独立入口，完整流程调度尚未实现。`-Test -TestScope evaluation` 运行本段专项验证，使用合成已知答案和本地协议，不代表真实人工或外部模型验收。

### 独立真值与固定评测集

| 命令 | payload | data |
| --- | --- | --- |
| evaluationSet.create | projectId, name, assetIds（非空、无重复） | 评测集 `{id,projectId,name,taskType,revision,assetIds,truthCount,createdAt,updatedAt}` |
| evaluationSet.list | projectId | 评测集数组，含 publishedVersions: `[{id,version,sampleCount,createdAt}]` 摘要 |
| evaluationSet.get | setId, versionId? | 未发布编辑状态；指定 versionId 时返回该集的固定 manifest |
| evaluationSet.saveTruth | setId, assetId, annotations, baseTruthVersion, source: manual/imported_human, note? | `{setId,assetId,truthVersion,setRevision,savedAt}` |
| evaluationSet.getTruth | setId, assetId, truthVersion? | 指定或当前独立真值版本及来源、说明 |
| evaluationSet.publish | setId, baseSetRevision | `{id,setId,version,manifestHash,sampleCount,truthObjectCount,coverage,createdAt}`，其中 id 是后续 setVersionId |

创建时固定所选素材、项目任务类型、稳定类别和点位模板。素材集合或模板需要改变时新建集合；人工真值可以继续修订和再次发布，旧发布版不变化。baseTruthVersion=0 表示尚无真值；对象类任务的空 annotations 数组必须由显式真值保存操作提交，表示人工无目标。分类真值必须恰好一个类别，详见五类评测。发布要求每个样本都有独立真值，不能把缺失真值填为空数组。

真值保存是独立操作，不读取 Asset.confirmed 自动创建真值，不把 API 候选自动写入真值，也不把本次待评测结果作为答案。source 记录用户明确选择的人工制作或人工答案导入来源，不能由 Agent 根据“已确认”状态代填。第一段的 Agent 工具接入应先提供查询、已有结果评测和复核入口，不能自动把项目标注升级为独立人工真值。

普通 evaluationSet.get/list 不返回真值数组；显式 get(versionId)、getTruth 和 publish 返回供人工界面使用的完整真值。evaluation.results 同样包含 truthAnnotations/predictionAnnotations 供叠图复核，不能直接转发给 Agent 模型；Agent 只能使用无真值的发布摘要和字段白名单下的评测指标，不开放真值读取、保存或发布工具。

发布 manifest 固定素材 ID、归正内容 hash、源文件 hash、sourceGroup、规范化版本/变换、尺寸、模板、每图 truthVersion 及完整真值。基准图以独立不可变副本保存并校验，不能仅保留可改写的源路径。sourceGroup 根据已知 sourceVideoId/groupId/原始父素材关系确定，没有已知共同来源时使用素材自身来源标识；同时保留 sourceHash，避免只靠名称分组。

### 既有运行候选的固定对比

| 命令 | payload | data |
| --- | --- | --- |
| evaluation.preflight | setVersionId, schemes: `[{runId,name?}]`, match? | `{canEvaluate,issues,schemes,sampleCount,pairedComparableSamples,nearDuplicateCheck}` |
| evaluation.create | 与 preflight 相同 | `{id,setVersionId,status,source:'existing_run_snapshot',schemes,createdAt}` |
| evaluation.list | projectId | 已保存评测摘要数组 |
| evaluation.get | evaluationId | 固定方案来源、指标、分母、失败/缺失统计与评测规则版本 |
| evaluation.results | evaluationId, schemeId?, assetId?, offset?, limit? | `{items,total}`，逐图匹配、错误对象/点、候选版本及来源 |

schemeId 等于 runId。结果项含 `status,truthAnnotations,predictionAnnotations,pairs,unmatchedTruthIds,unmatchedPredictionIds,candidateVersion,mediaUrl`；不可计算项没有匹配指标。mediaUrl 为 `autolabel-media://evaluation/{setVersionId}/{assetId}`，由桌面转换为受 Bearer 鉴权保护的 `GET /evaluation-media/{setVersionId}/{assetId}`。此路由检查固定清单归属和图片 hash。

每个方案从 run 的样本和候选版本读取结果，不从素材当前显示版本猜测结果；人工修正不能混入模型候选。所有方案使用同一 setVersionId 清单，run 范围之外的评测样本标为 missing；失败、unknown、尚未完成、无候选、输入 hash 或模板不匹配分别处理。输入不匹配阻断评测，不能以相似文件名勉强配对。既有 run 在取快照时尚未完成的样本保留 pending，之后完成也不改写本次评测，需要新建评测。

preflight 和 create 都核对实际 run 快照中的参考素材：任何评测样本与参考的 contentHash、sourceHash 或已知 sourceGroup 重叠时阻断，检查覆盖所有方案，不只是同一 assetId。第一段近重复识别只返回 `nearDuplicateCheck:'manual_review_required'`，不得宣称已自动排除近重复泄漏。真值不进入参考或请求。第一段不会为补齐失败样本调用 API，也不把历史读取/计算耗时计为模型推理耗时；用量和尝试引用原运行，来源始终标为 existing_run_snapshot。

`match` 第一段固定支持 `{iouThreshold?:0.5,poseNormalization?:'image_diagonal'}`。阈值在 0～1 内，规则与算法版本写入评测快照。匹配先按类别分组，仅 IoU 达到阈值的边可匹配；先最大化匹配对象数，再在最大匹配中最大化总 IoU，仍并列时按稳定对象 ID 决定。一个预测或真值对象只能参与一次匹配，不能采用会少配对象的简单贪心。

- Detect 返回 matchedObjects、missedObjects、extraObjects、meanMatchedIoU、meanCenterErrorPixels，及 missed/scorableTruthObjects、extra/scorablePredictedObjects 两个独立比例。分母为零返回 null 和原因，不填 0 或 100%。
- Pose 先以同样的框规则匹配对象，再按模板点名/点序比较。仅真值 visibility>0 且预测 visibility>0 的点参与误差；缺少预测位置单列 missingPredictedKeypoints，未匹配真值对象中的可定位点单列 unmatchedObjectKeypoints，真值未知点单列 ignoredUnknownTruthKeypoints。平均误差按实际成对点数计算，归一化除以基准图对角线；缺失点不作为零误差。
- 失败/未知/pending/missing 样本不作为空目标参与漏多标计算。报告同时包含固定集 totalTruthObjects、可计算子集 scorableTruthObjects/scorablePredictedObjects、scorableSamples 和各类不可计算数量。指标明确是可计算子集口径；另给各方案共同可计算的 pairedComparableSamples，不能用忽略失败的单一准确率代替完整比较。
- 只有真实成功返回的空 annotations 才是模型无目标。候选缺少合法 annotations 数组时标为 invalid，保留候选版本和错误码；运行快照及候选自身的输入 hash、尺寸、规范化都必须符合发布集。没有已发布独立真值的运行仍只能展示已有运行统计/版本对照，不能创建这些质量指标。

### 复核队列与独立随机抽查

| 命令 | payload | data |
| --- | --- | --- |
| review.build | evaluationId 或 runId（二选一）, rules?: `{minMatchedIoU?,maxNormalizedPointError?}` | `{created,existing,items,itemsTruncated}`，按来源及候选版本幂等建立 |
| review.list | projectId, evaluationId?, runId?, sampleId?, status?, source?, offset?, limit? | `{items,total}`，source 为 execution/truth_comparison/random，total 使用相同过滤条件 |
| review.resolve | itemId, baseCandidateVersion（失败无候选时为 null）, action: checked/dismissed/request_relabel, note? | 更新后的复核项 |
| review.sample | projectId, assetIds（非空）, seed, count | `{id,mode:'random',populationCount,count,seed,assetVersions,createdAt}` |

复核项保存 `{id,projectId,assetId,candidateVersion,objectId?,reason,severity,source,status,evaluationId?,runId?,sampleId?}`。有真值时来源可为漏标、多标、配置阈值下的定位误差；仅 runId 时只利用实际失败/未知、格式或几何校验异常，不能把没有真值的正常候选推断为内容正确或错误。未配置的定位阈值不暗设“错误概率”，模型自报置信度不能直接作为准确率。构建复核不发送额外模型请求。

checked/dismissed 只处理该版本的该条复核记录，不自动确认素材、不改变真值；request_relabel 只标记待重标，不直接产生新调用。新候选不会继承旧项的解决状态。定位项保存实际触发阈值；改变该阈值形成独立判断，无关规则不会重复建立已有事实项。pending 样本复核为 info，missing 为 warning。随机抽样固定候选/正式版本、完整抽样范围、种子与名单，生成独立 mode=random 的待查记录；定向疑点与随机抽查分开统计，不混用分母。未标注素材版本可为 0，失败无候选为 null。

创建集合与随机抽样均要求明确的 1～1000 张无重复 assetIds，比较要求 1～8 个不重复 runId。分页默认 limit=100、最大 500，offset 为非负整数。review.build 单次最多建立 10000 项，只返回前 500 项，余项通过 review.list 读取。IoU 及复核阈值须为 0～1 有限数值，抽样 seed 非空且最长 256 字符，count 在 1～范围大小内。

### 存储与验证

Store 执行单次 schema v1→v2 迁移，在数据目录 backups 中使用 SQLite VACUUM INTO 生成一致性备份并检查 integrity_check。迁移失败阻止启动、回滚结构事务并保留旧库及备份；任何模块不得另建写库。候选选择采用同一只读事务快照，评测结果、复核状态与事件通过统一短事务落盘，新写命令纳入维护安装锁。发布前复制并校验固定图片；中途失败不会产生可见发布记录，失败暂存目录保留以便诊断。

主要稳定错误码为 evaluation_task_unsupported、evaluation_truth_conflict、evaluation_set_conflict、evaluation_truth_incomplete、evaluation_reference_overlap、evaluation_input_mismatch、evaluation_snapshot_corrupt、candidate_annotations_missing、review_version_conflict；HTTP 仍使用现有错误包装。当前专项 62 项断言覆盖真值与确认状态分离、贪心少配反例及 80 组独立穷举对照、不可计算状态与空目标分离、遮挡/不可定位点、同源及同 hash 参考泄漏、候选输入绑定、真值修订后旧评测不变、阈值复核幂等、随机抽样、维护锁、重启和迁移失败保护，以及实际 JAR 的固定图鉴权读取。不重复已通过的人工导出和底层并发检查。

## 4C 第二段：计价、费用暂停与固定输入重跑（已实现）

### 用户单价与计价边界

provider.save 的可选 pricing 字段为 `{model,currency,inputPerMillion?,cachedInputPerMillion?,outputPerMillion?}`，null 清空当前配置。价格绑定具体模型，币种为三位大写标识，单价为 0～1e9 的有限数值。没有内置单价、默认币种或汇率；同一预算范围不混加币种。每次尝试固定 priceSnapshot，其中包含用户单价、接口版本与保存时间，后改配置不会改写旧账目，已经创建的运行也使用其原接口快照。

Chat 用量读取 prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens，Responses 读取 input_tokens/output_tokens/input_tokens_details.cached_tokens。缓存是输入总量的子集，推理输出是输出总量的子集；计价为 `(input-cached)*输入单价 + cached*缓存单价 + output*输出单价` 后除以一百万。缺少缓存数量且有缓存差价时保留未知；两种输入单价完全相同则无需假定缓存数量即可计价。非零音频或 cache_write_tokens 等尚未配置价格的类别也保留未知，不冒充普通输入计价。

尝试 cost 包含 `{status:'known'|'unknown',currency,amount,reason?,basis:'reported_usage_user_prices',providerBilledAmount:null}`。known 表示按已返回用量和用户单价计算，不是服务商账单金额；错误或缺失用量不推断为免费。HTTP 失败或未完成响应中明确给出的 usage 会保留，没有 usage 时为未知。原始用量保留在独立尝试，读取长期记录不套用表单文本长度限制。

| 命令 | payload | data |
| --- | --- | --- |
| budget.get | budgetScopeId | 原请求预算字段及 cost 摘要 |
| budget.update | budgetScopeId, maxRequests?, costLimit?: `{currency,amount}` 或 null | 更新后的预算；省略字段保留旧值 |
| budget.estimate | providerId, model, requests, inputTokensPerRequest, outputTokensPerRequest, cachedInputTokensPerRequest? | `{source:'explicit_token_assumptions',requests,assumptions,priceSnapshot,currency,estimatedCost,reason,hardLimit:false}` |

budget.cost 为 `{currency,knownCost,knownCalls,unknownCalls,inFlightCalls,limit,control:'observed_cost_stop',hardLimit:false,basis:'reported_usage_user_prices',providerBilledAmount:null}`。knownCost 是已知计价的小计，不能忽略 unknownCalls/inFlightCalls 当作最终总费用。costLimit.amount 为大于 0 且不超过 1e12 的有限数值；maxRequests 如提供为 1～Number.MAX_SAFE_INTEGER 整数，仍是发送前原子预占的请求硬上限。

费用控制在已知小计达到阈值、有未知计费调用、价格不完整或币种冲突时停止后续发送及重试。已经发送的并发调用可能导致小计超出阈值，不保证远端账单上限；本段没有把未来或在途费用伪装成精确预占金额。用户明确调整阈值后可通过 run.resume 恢复，costLimit:null 仅解除费用暂停，不抹掉历史未知费用、币种或已用请求数。暂停原因分别为 budget_cost_exhausted、budget_cost_unknown、budget_pricing_unknown、budget_currency_mismatch。

estimate.requests 为 1～1e6 整数，三个 token 假设均为 0～1e9 整数，缓存不能超过输入。省略缓存量时 assumptions.cachedInputTokensPerRequest 为 null，有差价时 estimatedCost 为 null；没有假装用户提供了 0。估算不发送请求、不消耗额度，也不会补造价格。

### 重新调用的方案比较

| 命令 | payload | data |
| --- | --- | --- |
| evaluation.rerun.preflight | setVersionId, schemes, budgetScopeId, maxRequests, match? | `{canStart,issues,projectId,setVersionId,sampleCount,schemeCount,plannedRequests,estimatedMaxRequests,budgetScopeId,maxRequests,source:'fresh_run_snapshot',nearDuplicateCheck}` |
| evaluation.rerun.create | 与 preflight 相同 | `{id,comparisonId,projectId,setVersionId,source:'fresh_run_snapshot',status:'running',schemes,runIds,budgetScopeId,maxRequests,plannedRequests,estimatedMaxRequests,match,createdAt}` |
| evaluation.rerun.get | comparisonId | 比较记录，增加 schemes[].status/statistics、canFinish、budget、evaluationId? |
| evaluation.rerun.finish | comparisonId | 既有 Evaluation 格式，含 comparisonId，source 和 schemes[].source 为 fresh_run_snapshot；重复调用返回同一评测 |

schemes 为 1～8 个 `{name?,providerId,model,prompt,referenceAssetIds?,concurrency?,maxRetries?,maxRequests?}`。同配置允许独立重复实验，不去重或复用旧候选。参考为当前项目已人工标注素材，最多 63 张、无重复，且受接口 maxImages 限制；与评测集同 hash/已知同源的参考阻断。预检同时校验固定图、参考内容及每次图片合计 32 MiB 上限。name 如提供须非空，prompt 必须非空；concurrency 为 1～32、默认 1，maxRetries 为 0～6、默认 0。顶层 maxRequests 必填 1～1e6，单方案可选 maxRequests 也为 1～1e6。剩余额度必须能覆盖每个方案全部样本的一次调用，否则拒绝创建，不减少方案；重试或其他共享调用仍可能耗尽额度并暂停。

创建在同一事务落盘所有方案、样本、比较关系及事件，预检或二次预算检查失败不会留半个比较。每个样本只从发布集构造无真值的模板、图片尺寸和规范化字段，用发布集的固定图片调用模型；当前正式标注及真值不会进入 target 请求。新候选按尝试保存独立版本，强制不改写素材当前正式标注。图片 data URL 使用独立字节检查，不再受 100000 字符普通文本限制；普通文本限制保持不变。

get 的 status 为 running、needs_attention、ready 或 completed。只读查询不自动固化结果；所有来源 run 处于 completed/completed_with_errors/cancelled 后 canFinish=true。暂停/未知状态需人工处理，finish 返回 evaluation_runs_unfinished，不自动重发。控制复用 run.pause/resume/cancel/retry；未知结果重试仍要求 retryUnknown。finish 固化每个候选及 run 的用量计价小计，scheme.cost 的范围为 whole_source_run，随后共享预算变化不改写旧评测；并发 finish 只提交一份评测。

比较记录存于现有 resources 的保留种类 evaluation_comparison，通用 resource.save 不能伪造或覆盖，不新增数据库版本。budget.estimate、rerun.preflight、rerun.get 为维护锁下可用的只读命令；预算更新、create、finish 为写入。

`-Test -TestScope cost-rerun` 通过 47 项本地协议断言：两方案固定输入重跑、真值隔离、正式版本保护、预算/泄漏/混币原子拒绝、缓存计价、费用暂停与恢复、未知费用和重试、价格快照、并发请求硬上限、并发固化幂等、过滤总量、重启及维护锁。最终构建另通过原评测 62 项兼容检查和 Responses 大图 7 项检查。主控的外部模型验收单独记录，本段不据合成样例宣称人工质量或实际效率。

## 阶段 5：五类评测

沿用 evaluationSet、evaluation 和 evaluation.rerun 命令，taskType 支持 detect/pose/obb/segment/classify。固定真值版本、图片副本、方案来源、预算、失败/未知状态和参考隔离规则不变。旧评测不补算新指标，新字段缺失时可根据其原 taskType 展示。

- Detect/Pose 保留原一对一最大匹配规则与数值口径，算法版本仍为 max-cardinality-max-iou-v1。
- OBB 使用实际四角矩形（有序 points 或 bbox+rotation）区域交集；Segment 使用当前单个有序简单多边形的区域交集，支持凹形、包含及分离的交区，不使用外接矩形或像素栅格近似。相交面积为零的接触边界不贡献面积，IoU=交集面积/并集面积。复杂曲线、带孔输入、多轮廓输入和位图掩码尚未作为标注格式接入。
- OBB/Segment 仍在同类别且 IoU 达到阈值的边上先最大化配对数量、再最大化总 IoU。centerErrorPixels 使用真实区域质心距离；非 Pose 的多余关键点字段不参与点误差。采用双精度矢量面积和局部坐标累加，算法版本为 max-cardinality-region-iou-v1。

对象类 metrics 增加 metricKind=object_overlap；metrics 和 match 中 overlapMetric 分别为 bbox_iou、rotated_iou、polygon_iou。原漏标、多标、匹配数量、均值及空分母字段保留。

Classify 的人工标准答案须恰好一个类别，空真值返回 evaluation_classification_truth_required。成功返回空预测表示未给出类别，计 missingPrediction 并进入正确率分母；执行失败、未知、待完成、缺失或非法候选保持各自不可计算状态，不进入该分母。分类不使用 IoU 阈值或关键点误差，算法版本为 single-label-confusion-v1。

分类 metrics 为 metricKind=classification、overlapMetric=null，并新增：

```text
classification: {
  samples, correct, incorrect, missingPrediction,
  accuracy: number | null,
  confusion: [{truthClassId, predictionClassId: string | null, count}]
}
totalTruthLabels: number
```

incorrect 只统计明确错类；samples=correct+incorrect+missingPrediction，accuracy=correct/samples。confusion 使用稳定类别 ID，predictionClassId=null 单列没有预测类别的样本。scorableSamples 与其余状态覆盖数量仍为整数，totalTruthLabels 记录完整发布集的类别答案数。全部不可计算时 accuracy=null，notApplicableReasons['classification.accuracy']=zero_denominator。

分类下以下指标为 null，并在 notApplicableReasons 对应字段标 task_not_applicable：scorableTruthObjects、scorablePredictedObjects、matchedObjects、missedObjects、extraObjects、missedRate、extraRate、meanMatchedIoU、meanCenterErrorPixels、pairedKeypoints、locatedTruthKeypoints、missingPredictedKeypoints、unmatchedObjectKeypoints、ignoredUnknownTruthKeypoints、meanPointErrorPixels、meanPointErrorNormalized、totalTruthObjects。不能用这些空值伪造零漏标或框定位成绩。

分类逐图结果增加 classResult `{truthClassId,predictionClassId,correct,missingPrediction}`，pairs/unmatchedTruthIds/unmatchedPredictionIds 为空。review.build 生成 classification_wrong 或 classification_missing，来源仍为 truth_comparison；几何阈值不生成分类疑点，复核解决仍不更改真值或正式标注。

`-Test -TestScope five-task` 通过 52 项断言：解析旋转框 IoU、凹形/包含/接触/分离交区、60 组整数多边形独立精确单元格对照、分类正确/错类/空预测/失败/未知和空分母，以及 OBB/Segment/Classify 三个实际本地协议重跑；保留 Detect/Pose 的配对和 80 组穷举兼容检查，不重跑旧全套。人工计时另行交付，不据此宣称所有阶段已完成。

### 跨项目资源与人工参考

| 命令 | payload | data |
| --- | --- | --- |
| resource.save | id?, baseVersion?, kind: prompt/template/flow, name, content, category?, note? | 当前资源 `{id,version,kind,name,content,category,note,createdAt,updatedAt}` |
| resource.list | kind?, query?, category?, offset?, limit? | 资源当前版本数组；默认隐藏内部版本及 evaluation_comparison，显式 kind=evaluation_comparison 仍可读取重跑记录 |
| resource.get | resourceId, version? | 指定不可变版本或当前资源 |
| resource.apply | projectId, resourceId, version?, fields | `{project,resourceId,resourceVersion,fields}`，只覆盖明确选择的字段 |
| resource.reference | id?, baseVersion?, assetId, assetVersion, name, category?, note? | 当前人工参考资源版本，包含独立固定图片与来源 |
| resource.image | resourceId, version? | 仅主进程内部使用的 `{resourceId,resourceVersion,path,contentHash,width,height}` |

resource.reference 是正式命令名，内部调用 ResourceLibrary.addReference；没有 resource.addReference 别名。新资源 version=1；修改必须提供当前 baseVersion，历史内容保留。旧未版本化资源可用 baseVersion=0 迁移，原内容仍可 get(version=0)。prompt 的 content 为文本，template/flow 为 JSON；资源名称最多 100 字符、category 最多 100、note 最多 4000、content 序列化长度最多 2000000，list.limit 默认及最大 500。模板和流程应用只保存规则，不表示执行完整流程。

人工参考要求素材当前正式版本与 assetVersion 一致，并且来源为明确人工确认/修改或预置人工示例；候选和草稿不能直接作为参考。保存独立受管 PNG、内容 hash、尺寸、来源模板/标注/源 metadata 和人工说明，不依赖原素材路径。源文件删除或资源头版本变化后，旧引用仍使用其固定副本及版本。

run.create 和 evaluation.rerun 的每个方案可提供 referenceResources `[{resourceId,version?,classMap?}]`。资源参考与 referenceAssetIds 合计最多 63，且参考加目标仍受 provider.maxImages 约束。创建时解析并固定 resourceVersion；任务类型必须一致，类别 ID 或含义不同需显式完整 classMap 映射，Pose 点名、顺序及连接关系也须一致。原始来源 metadata 和 hash 保留，固定评测的参考重叠检查同时覆盖资源参考。

模型请求将参考的 annotations、人工 note、resourceId/resourceVersion 与对应图片配对；不发送 referenceImage/inputPath 等文件路径。发送时按受管相对路径重新验证固定图，不使用过期绝对源路径。更新资源不会追溯修改已建运行或已应用的项目字段。

resource.image 仅接受资源标识和可选版本，不接受任意路径；只允许 reference 资源，并验证文件位于数据目录 resource-library 内、真实路径不越界、PNG 格式、尺寸及内容 hash。桌面据此提供 `autolabel-media://resource/{resourceId}/{resourceVersion}`，URL 使用解析后的具体版本；renderer/Agent 不直接得到 path。引擎没有新增 resource-media HTTP route。resource.get/list/image 在维护锁下可读，save/apply/reference 为写入。

资源模块独立验证 66 项由其开发任务完成。`-Test -TestScope resource-integration` 通过 29 项接线检查，覆盖正式命令、显式映射、冻结版本及人工说明、源图删除后实际本地协议调用、资源参考重跑/泄漏阻断、固定媒体、列表范围、维护锁和重启。没有因此重复真实外部 API 验收。

## 数据备份与独立恢复目录

| Java 内部命令 | 参数 | 行为 |
| --- | --- | --- |
| backup.preflight | outputDir | 普通受跟踪操作；创建 WAL 一致快照并检查依赖和空间，返回 ready、issues、warnings、fileCount、totalBytes、availableBytes |
| backup.create | outputDir, operationId | 仅就绪的数据锁 owner 可执行；复制后核对依赖、校验归档后发布 `.autolabel`，返回 backupId、backupPath、status:completed |
| backup.inspect | backupPath | 可在维护锁中使用；验证归档、路径绑定和恢复依赖，返回 valid:true |
| restore.prepare | backupPath, targetParent, operationId | 仅就绪 owner 可执行；在当前数据目录外创建新目录并重定位已登记路径，返回 status:prepared、dataDir、backupId、currentDataChanged:false |

路径由桌面受控对话框提供；renderer 不持有维护 operationId，恢复结果的 dataDir 由桌面转换为一次性 preparationId。Java 不在本命令中切换引擎或覆盖当前目录。全部备份结果声明 credentialsIncluded:false、credentialRebindRequired:true，恢复后需重新绑定凭据；本机迁移的凭据作用域由桌面单独管理。`backup.progress` 事件保留 operationId、copying/verifying/completed 阶段与实际文件和字节计数。

备份 helper 独立 54 项检查由开发子任务完成。`-Test -TestScope backup-integration` 新增 33 项接线检查，覆盖取消先到与迟到加锁、所有权和异常后归还、真实归档/检查/独立目录恢复、启动新引擎后的人工版本及草稿、媒体重定位、暂停原因与未开始样本、凭据缺失及原目录后续修改保留；未触发模型请求。当前备份接受 schema 2 和 3，已登记流程步骤的冻结导入清单、参考快照及产物图片路径；恢复时重定位这些依赖，未知 schema 仍拒绝归档。

## 6A 线性流程执行

`flow.capabilities` 声明 import、filter、api、review、export 五类实际可执行节点；transform 和 local 仍不可用。`flow.preflight` 与 `flow.create` 接受 `{projectId,definition,input,execution?,budgetScopeId?,maxRequests?,failurePolicy?}`。定义为 `{version:1,name,steps:[{id,kind,enabled,parameters}]}`，最多 30 步；输入为项目 all/unlabeled/explicit 选图或已封存的同项目 artifact。非首节点单步执行必须显式选择 artifact，不隐式补跑前置节点。缺少必填配置以预检 issues 返回，已提供的参数即使在禁用步骤也要符合类型和范围。

输入清单及导入展开结果合计最多 10000 项。导入固定源 hash，筛选只处理固定范围；API 节点在一个数据库事务中登记子 run、samples、budget 关联和父步骤 childRunId。全部 API 节点继续使用既有共享标注队列、请求预算和凭据检查，文件节点使用单独单线程执行器。数据维护锁同步停止两类工作的新分派，已执行工作保存后才能备份；流程状态、步骤状态和实际文件 worker 均纳入维护判断。

每步产生可分页查看的不可变产物。`flow.artifact {artifactId,limit?,offset?}` 返回固定版本、逐项结果和来源，隐藏内部图片路径；已封存分项禁止修改。API 成功候选和所选导出版本分别记录，默认导出保护流程开始时的人工作业版本。导出只读取产物固定图片与版本，项目之后发生的编辑不会改变旧流程导出；失败和未知结果不会转换为合法空标注。

| 命令 | 参数及行为 |
| --- | --- |
| flow.get / flow.list | flowRunId；或 projectId?,limit?,offset?，列表返回 `{items,total}` |
| flow.pause / flow.cancel | flowRunId；停止后续分派并等待在途工作落盘，取消后的迟到候选不推广正式版本、不继续下游 |
| flow.resume | flowRunId, acknowledgeReviewStepId?, maxRequests?；复核 waitForHuman 必须明确确认，即使期间经历暂停或恢复 |
| flow.retry | flowRunId, stepId?, assetIds?, retryUnknown?, maxRequests?；沿原快照补失败，未知结果必须显式 retryUnknown |
| flow.rerun | flowRunId, fromStepId, definition?, budgetScopeId?, maxRequests?；创建新 revision，继承未修改且已完成的上游产物，返回 `{run,invalidatedStepIds}` |

末步 completed_with_errors 可补跑失败项，成功项不再请求。导入重试克隆已封存工作产物，API 重试生成新输出，旧产物和来源始终保留；下游已有固定产物或子运行时要求 rerun 新版本。复核生成问题清单或固定随机抽样，不会自动成为独立真值或人工确认。`event.list {flowRunId,after?}` 按全局 sequence 返回持久事件，同时保留 flowRunId、真实 stepId 与实际 API child runId。

数据库升级到 schema 3，新增 flow_runs、flow_steps、flow_artifacts、flow_artifact_items 及事件关联。schema 1/2 先生成一致备份再事务迁移；恢复后的未完运行保持暂停，已取消运行保持终态。新的普通/API 流程请求固定完整语义模板和 parser/validator/request 版本；credentialBindingVersion 是非秘密 UUID，绑定改变在扣预算前暂停。已发请求保存时使用当时捕获的凭据脱敏；旧运行保持旧请求格式，不补写新的契约标记。

`-Test -TestScope flow-integration` 检查五节点实际链路、固定人工版本导出、只重跑导出、产物单步执行、流程备份恢复、v1/v2 迁移及控制交错。`flow-foundation` 检查子任务事务回滚、语义模板请求、凭据绑定和取消后的迟到结果。均使用本地协议 fixture，没有宣称真实外部模型质量或最终桌面验收。

## 6B 可追溯候选复用

`run.create` 和流程 API 参数增加 `reuseEnabled?:boolean`（默认 true）、`forceRerun?:boolean`（默认 false）、`reuseMaxAgeSeconds?:正整数|null`（缺省或 null 不限期）。强制重标和关闭复用只跳过本轮读取，新的真实成功仍记录指纹供后续使用。`run.retry` / `flow.retry` 对失败项的显式重试直接请求；评测运行和没有完整冻结契约/凭据绑定的旧运行不参与复用，不回填历史证据。

指纹覆盖实际请求体、完整语义模板、目标图片及归一化契约、参考内容/版本/顺序、Provider 版本及有效参数、模型、提示词、parser/validator/request 版本和非秘密凭据绑定。改变规则、类别含义、模型配置、参考或输入会失效；有效期按原始真实请求完成时间计算。候选查询最多检查 64 份真实成功来源，并重新验证图片、几何与版本/样本/attempt 关联；复用链不会延长来源寿命。

调度器仍只在短调度锁内登记 preparing 并入既有有界请求执行器。读图、构造请求、计算指纹和查询来源都在 worker 中；命中后使用统一 writer 复查样本身份、运行状态、当前模板、几何与凭据绑定，再原子保存新候选。未命中才检查预算、获取 Provider permit 并走原子扣费与发送路径。系统暂停、数据维护和取消可停止后续分派，不需要等待大图读取释放全局调度锁。

复用结果保持 `candidate`，保护人工正式版本、草稿与 baseVersion。新版本、`run.get.samples` 和 `flow.artifact.items` 带 `reused:true` 及 `reusedFrom`：sourceRunId、sourceSampleId、sourceAssetId、sourceCandidateVersion、sourceAttemptId、sourceCompletedAt、sourceModel、sourceModelVersion、reuseFingerprint。可通过原始 run、attempt 与素材历史追溯。复用不创建 attempt、不增加 requestsUsed 或预算；statistics.reused 是 succeeded 的子集。流程总复用数只统计本次 child runs，继承上游后单独导出不会再计一次。

`-Test -TestScope reuse-integration` 使用本地实际请求，验证命中、预算已耗尽时的零请求复用、强制及关闭读取后的新来源、模板/提示词/凭据/Provider/有效期失效、人工保护、旧记录和失败重试旁路、流程统计与事件、重启来源追溯及共享并发限制。独立 CandidateReuseTest 校验历史关联和指纹契约；维护屏障与 6A 五节点兼容链另行检查。

实现依据：[Java ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)、[SQLite WAL](https://www.sqlite.org/wal.html)、[Java 颜色转换](https://docs.oracle.com/en/java/javase/21/docs/api/java.desktop/java/awt/image/ColorConvertOp.html)、[Java Area 区域运算](https://docs.oracle.com/en/java/javase/21/docs/api/java.desktop/java/awt/geom/Area.html)、[Ultralytics 数据格式](https://docs.ultralytics.com/datasets)、[Chat 用量类型](https://github.com/openai/openai-python/blob/main/src/openai/types/completion_usage.py)、[Responses 用量类型](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py)。
