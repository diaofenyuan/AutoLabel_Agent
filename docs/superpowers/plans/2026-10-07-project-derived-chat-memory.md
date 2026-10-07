# 项目派生对话与历史摘要 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution is selected for this task). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从项目入口新建独立对话，并让助手继承项目全部历史摘要以及最近会话实际使用的素材范围。

**Architecture:** 在共享会话类型中定义素材上下文与历史摘要；桌面 ChatStore 通过独立 memory JSON 快照实现 `chat.history.fork`，并在每次记录时保存最近素材上下文。Agent 只接收长度受限的摘要背景，渲染层统一调用派生接口并在项目概览、侧栏和聊天页显示/恢复继承状态。

**Tech Stack:** TypeScript、Electron 主进程、React 19、Node `node:test`、esbuild、现有桌面验收脚本。

**Spec:** `docs/superpowers/specs/2026-10-07-project-derived-chat-memory-design.md`

## Global Constraints

- 只处理当前项目会话；不读取或合并项目外会话。
- 旧索引、旧 JSONL 和没有新字段的会话必须兼容读取。
- 摘要是历史数据，不能扩大 Agent 工具的素材权限。
- 新会话消息独立落盘；旧会话内容只进入独立快照。
- 保留工作区已有未提交修改，不格式化无关文件。
- 所有新增代码注释使用中文，解释设计原因和关键逻辑。

---

### Task 1: 定义共享会话上下文和摘要类型

**Files:**
- Modify: `shared/chat.ts`
- Test: `desktop/chat-store.test.ts`（后续存储测试使用这些类型）

**Interfaces:**
- Produce `ChatMaterialContext`, `ChatMemoryConversation`, `ChatMemorySnapshot`
- Extend `ChatSessionSummary` with optional `context`
- Extend `ChatSession` with optional `context` and `memory`

- [ ] **Step 1: 写类型级最小失败测试**：在存储测试中构造包含 `context` 的会话输入，先确认当前 ChatStore 没有 `fork` 行为。
- [ ] **Step 2: 运行聚焦测试确认失败**：运行 `npm run test:desktop -- --test-name-pattern="派生"`，预期因缺少 `ChatStore.fork` 测试失败。
- [ ] **Step 3: 添加共享类型**：定义范围枚举、素材/参考 ID、摘要字段和快照元数据，所有新字段可选以兼容旧文件。
- [ ] **Step 4: 运行 `npm run check:desktop` 和 `npm run check:renderer`**，确保类型变更不破坏现有调用。

### Task 2: 实现 ChatStore 派生快照和上下文持久化

**Files:**
- Modify: `desktop/chat-store.ts`
- Modify: `desktop/chat-store.test.ts`

**Interfaces:**
- Add `ChatStore.fork(input): Promise<ChatSession>`
- Extend `ChatStore.record(input)` with optional `context`
- `get/list/bundle/delete/restore/status` preserve context and memory snapshot

- [ ] **Step 1: 写失败测试**：覆盖项目全部历史会话摘要、最近有消息会话的 context、空项目快照、快照文件重载、删除恢复保留快照、损坏快照跳过并继续。
- [ ] **Step 2: 运行 `npm run test:desktop -- --test-name-pattern="派生|快照|上下文"`**，确认测试因 `fork` 未实现而失败。
- [ ] **Step 3: 实现最小存储逻辑**：
  - `fork` 在 serial 队列中读取项目会话，按最近更新时间生成首条用户目标与最近助手结论。
  - 将摘要限制在 60000 字符，保留 `truncatedCount`，最近会话的上下文单独保存。
  - 记忆快照写入 `<sessionId>.memory.json`，读取失败只附加 warning。
  - `record` 更新 `entry.context`；删除/恢复/导出/状态统计同步处理快照。
- [ ] **Step 4: 运行同一聚焦测试确认通过**，并检查旧 ChatStore 测试仍通过。
- [ ] **Step 5: 提交独立存储变更**：`git add shared/chat.ts desktop/chat-store.ts desktop/chat-store.test.ts && git commit -m "支持项目对话上下文快照"`

### Task 3: 接入 chat.history.fork 和 Agent 摘要背景

**Files:**
- Modify: `desktop/validation.ts`
- Modify: `desktop/main.ts`
- Modify: `desktop/security.ts`（仅在上下文授权校验处保持字段白名单）
- Modify: `agent/types.ts`
- Modify: `agent/orchestrator.ts`
- Modify: `agent/tests/orchestrator.test.ts`
- Modify: `desktop/security.test.ts`

**Interfaces:**
- Add validated command `chat.history.fork`
- Extend `AgentContext.memorySummary?: string`
- Agent request carries `memorySummary` only as model background, never as tool asset scope

- [ ] **Step 1: 写失败测试**：
  - Agent 请求包含 `memorySummary` 时，发给 `chat.send` 的系统背景含摘要。
  - 摘要不会改变 `assetIds` 工具范围。
  - `chat.history.fork` 命令接受严格输入。
- [ ] **Step 2: 运行 `npm run test:agent` 与 `npm run test:desktop -- --test-name-pattern="memorySummary|history.fork"`**，确认新断言失败。
- [ ] **Step 3: 实现最小协议与 Agent 注入**：
  - validation 增加 `chat.history.fork` 和 `memorySummary` 的长度约束。
  - main 转发到 `chatStore.fork`；recordAgentChat 将 memorySummary 排除在持久化素材 context 外。
  - Agent 校验并把摘要作为明确的历史背景段拼接到系统指令，工具环境不读取该字段。
- [ ] **Step 4: 运行 Agent、桌面安全与协议测试确认通过。**

### Task 4: 渲染层派生会话和摘要展示

**Files:**
- Modify: `renderer/src/context.tsx`
- Modify: `renderer/src/App.tsx`
- Modify: `renderer/src/ChatPanel.tsx`
- Modify: `renderer/src/ProjectOverview.tsx`
- Modify: `renderer/src/Sidebar.tsx`
- Create: `renderer/src/chatMemory.ts`
- Create: `renderer/tests/chat-memory.test.ts`
- Modify: `scripts/desktop-test.mjs`

**Interfaces:**
- `startProjectChat` uses `chat.history.fork` for an opened project
- `formatChatMemory(memory): string` creates bounded Chinese background text
- Local `ChatSession` restores inherited `context` and `memory`

- [ ] **Step 1: 写 `chatMemory.test.ts` 失败测试**：摘要格式包含全部会话标题、首条目标、最近结论、素材范围和省略提示；空快照返回空字符串。
- [ ] **Step 2: 运行 `npm run test:desktop -- --test-name-pattern="对话摘要格式"`**，确认 formatter 尚不存在而失败。
- [ ] **Step 3: 实现 formatter 和状态接入**：
  - App 的派生流程使用返回的 `ChatSession`，设置继承范围和当前项目素材选择。
  - ChatPanel 发送时把 `formatChatMemory(session.memory)` 放入 Agent context，并在历史读取时恢复 context。
  - 项目概览和侧栏项目菜单增加“新建对话”；进入旧会话保持原行为。
  - ChatPanel 显示继承摘要的可折叠提示，摘要只作为背景，不污染新会话消息。
- [ ] **Step 4: 运行 formatter 测试和渲染类型检查。**
- [ ] **Step 5: 提交渲染层变更**：`git add renderer/src renderer/tests/chat-memory.test.ts scripts/desktop-test.mjs && git commit -m "支持从项目新建带记忆对话"`

### Task 5: 端到端验证与收尾

**Files:**
- Modify: `renderer/tests/desktop-sidebar-check.ts`（只增加本功能的入口断言）
- Possibly modify: `renderer/tests/desktop-project-identity-check.ts`（如需复用已有项目会话 fixture）

- [ ] **Step 1: 为项目概览和侧栏入口补验收断言**：点击“新建对话”后仍在目标项目，聊天页出现继承提示；旧会话继续入口不变。
- [ ] **Step 2: 运行 `npm run check:all -- --skip-ui`。**
- [ ] **Step 3: 运行 `npm run test:desktop`。**
- [ ] **Step 4: 运行 `npm run check:sidebar-ui` 或对应现有 UI 检查；若桌面启动并行失败，按脚本要求串行重跑一次。**
- [ ] **Step 5: 查看 `git diff --check` 和本次文件 diff，确保没有触碰工作区已有无关修改。**
- [ ] **Step 6: 按验证输出汇报实际通过项和未运行项，不用“全部完成”替代证据。**

