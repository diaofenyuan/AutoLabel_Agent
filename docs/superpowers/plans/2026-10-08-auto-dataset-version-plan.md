# 标注任务自动生成数据集版本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每次标注任务进入 `completed` 或 `completed_with_errors` 终态后自动生成一个可追溯、幂等的数据集版本，用户随后可直接用最近的就绪版本训练。

**Architecture:** 在引擎内新增按 `runId` 唯一的自动版本来源记录，`Runs.settle` 事务提交后通过终态回调调用 `DatasetVersions.autoCreateForRun`。自动版本复用现有版本解析、体检、复制和重试逻辑，失败也保留版本记录；界面和助手只补充来源与状态提示，不绕过 `ready` 校验。

**Tech Stack:** Java 21、SQLite/Gson 引擎；TypeScript/React renderer；Node `node:test`；现有 PowerShell 引擎测试脚本。

**Spec:** `docs/superpowers/specs/2026-10-08-auto-dataset-version-design.md`

## Global Constraints

- 只对 `completed`、`completed_with_errors` 自动建版本；`needs_attention`、`cancelled`、`failed` 和运行中状态不触发。
- 同一 `runId` 只能产生一个自动版本；重复终态回调不得重复建版本。
- 自动版本使用 `annotationScope=labeled`；训练只能消费 `ready` 版本。
- 自动版本失败必须保留可读 failure，不回滚已完成标注，不伪造可训练状态。
- 不暴露绝对路径；自动来源只返回任务标识、状态和摘要。

---

### Task 1: 自动版本来源持久化与幂等协调器

**Files:**
- Modify: `engine/src/main/java/cn/autolabel/engine/Store.java`
- Modify: `engine/src/main/java/cn/autolabel/engine/DatasetVersions.java`
- Test: `engine/src/test/java/cn/autolabel/engine/DatasetVersionsTest.java`

**Interfaces:**
- Produces `DatasetVersions.autoCreateForRun(JsonObject terminalRun)`, a package-private fire-and-forget entry point used by the run scheduler.
- `dataset_versions.data` gains `sourceKind`, `sourceRunId`, and `sourceRunStatus`; `sourceKind` is `project` for manual versions and `annotation_run` for automatic versions.
- Store creates `dataset_version_sources(run_id PRIMARY KEY, version_id UNIQUE, created_at)` so duplicate callbacks are rejected atomically.

- [ ] **Step 1: Write the failing persistence/idempotency tests**

  Extend `DatasetVersionsTest` with a synthetic terminal run and assertions that:

  ```java
  JsonObject terminal = Json.obj("runId", "run-1", "projectId", pid,
      "status", "completed", "name", "自动标注 · fixture");
  e.datasetVersions.autoCreateForRun(terminal);
  e.datasetVersions.autoCreateForRun(terminal);
  JsonObject page = EngineTest.command(e, "dataset.version.list", Json.obj("projectId", pid));
  check(Json.array(page, "items").size() == 1, "同一标注任务只能生成一个自动版本");
  JsonObject version = Json.array(page, "items").get(0).getAsJsonObject();
  check(Json.required(version, "sourceKind").equals("annotation_run"), "版本记录自动标注任务来源");
  check(Json.required(version, "sourceRunId").equals("run-1"), "版本记录来源任务");
  ```

  Add a second case for no labeled assets or an inspection blocker; it must still return one `failed` version with `failure.message`, not throw without a version record.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `npm run build:engine -- -Test -TestScope dataset-versions`

  Expected: compilation/test failure because the source table and `autoCreateForRun` do not exist.

- [ ] **Step 3: Add the source table and schema allowlist**

  In `Store.initSchema`, add:

  ```sql
  CREATE TABLE IF NOT EXISTS dataset_version_sources(
    run_id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL UNIQUE REFERENCES dataset_versions(id),
    created_at TEXT NOT NULL
  )
  ```

  Include `dataset_version_sources` in the maintenance table allowlist used by backup/deletion checks.

- [ ] **Step 4: Implement the automatic coordinator**

  Refactor the common version insertion path in `DatasetVersions` so manual `create` keeps `sourceKind=project`, while `autoCreateForRun` uses `sourceKind=annotation_run`, `sourceRunId`, name `标注任务 · ${runName}`, default labeled recipe, and the terminal run status. Compute `resolve`, `inspect`, and recipe before the transaction; inside one transaction re-check `dataset_version_sources`, allocate version number, insert the version/build rows, and insert the source claim. If the input is empty or inspection has blocking errors, insert a failed version with the inspection and failure payload instead of dispatching a build. For a valid plan, dispatch the existing asynchronous `run` builder after commit.

  The coordinator must catch dispatch/inspection exceptions, mark the claimed version failed, and never throw back into `Runs.settle`.

- [ ] **Step 5: Verify the focused tests pass**

  Run: `npm run build:engine -- -Test -TestScope dataset-versions`

  Expected: all existing dataset-version assertions plus the new auto-source, failure-record, and duplicate-callback assertions pass.

- [ ] **Step 6: Commit the engine source change**

  ```powershell
  git add engine/src/main/java/cn/autolabel/engine/Store.java engine/src/main/java/cn/autolabel/engine/DatasetVersions.java engine/src/test/java/cn/autolabel/engine/DatasetVersionsTest.java
  git commit -m "支持标注任务自动生成数据集版本"
  ```

### Task 2: 标注任务终态触发与引擎 wiring

**Files:**
- Modify: `engine/src/main/java/cn/autolabel/engine/Runs.java`
- Modify: `engine/src/main/java/cn/autolabel/engine/Engine.java`
- Test: `engine/src/test/java/cn/autolabel/engine/EngineTest.java` or `DatasetVersionsTest.java`

**Interfaces:**
- `Runs` exposes `volatile Consumer<JsonObject> terminalHook`.
- `Runs.settle` returns from its SQLite transaction a terminal payload only when it changed the run from `running`; it invokes `terminalHook` after the transaction.

- [ ] **Step 1: Write the failing terminal-trigger integration test**

  Add an engine test that creates a project with labeled fixture assets, starts a local/synthetic run path already supported by the test harness, settles it to `completed`, and asserts one automatic `dataset_versions` record. Settle the same run again and assert the count remains one. Add assertions that a `needs_attention` or `cancelled` run creates no source claim.

- [ ] **Step 2: Run the focused engine test and confirm red**

  Run: `npm run build:engine -- -Test -TestScope dataset-versions`

  Expected: the run reaches its terminal status but no automatic version is present because `terminalHook` is not wired.

- [ ] **Step 3: Implement post-transaction terminal callbacks**

  Change `Runs.settle` to capture `{runId, projectId, name, status}` from the transaction, call the hook only for `completed` and `completed_with_errors`, and guard hook failures with a diagnostic event. Do not call the hook while the write transaction is open.

- [ ] **Step 4: Wire the coordinator in `Engine`**

  After constructing `datasetVersions`, assign:

  ```java
  runs.terminalHook = datasetVersions::autoCreateForRun;
  ```

  Keep the hook asynchronous through `DatasetVersions`' existing virtual-thread build executor so a large snapshot does not block run settlement.

- [ ] **Step 5: Run focused tests and the training dataset suite**

  Run: `npm run build:engine -- -Test -TestScope dataset-versions` and `npm run build:engine -- -Test -TestScope training-datasets`

  Expected: both suites pass, including no-trigger states and idempotent terminal callbacks.

- [ ] **Step 6: Commit the trigger wiring**

  ```powershell
  git add engine/src/main/java/cn/autolabel/engine/Runs.java engine/src/main/java/cn/autolabel/engine/Engine.java engine/src/test/java/cn/autolabel/engine/EngineTest.java engine/src/test/java/cn/autolabel/engine/DatasetVersionsTest.java
  git commit -m "接入标注终态自动建版本"
  ```

### Task 3: 来源摘要与用户可见闭环

**Files:**
- Modify: `renderer/src/DatasetVersions.tsx`
- Modify: `renderer/src/ProjectOverview.tsx`
- Modify: `renderer/src/eventNames.ts`
- Modify: `agent/training-tools.ts`
- Modify: `agent/orchestrator.ts`
- Test: `agent/tests/training-tools.test.ts`
- Test: `renderer/tests/desktop-annotate-check.ts` or the existing training UI check

**Interfaces:**
- `DatasetVersion` includes optional `sourceRunId` and `sourceRunStatus`.
- `versionSummary` returns those fields without paths; the system prompt tells the assistant that completed annotation runs create versions automatically.

- [ ] **Step 1: Write failing projection/UI assertions**

  Extend the training tool fixture version with `sourceKind='annotation_run'`, `sourceRunId='run-1'`, and `sourceRunStatus='completed'`; assert `list_dataset_versions` returns these fields. Add a desktop assertion that the project overview text explains automatic version creation and an automatic version row displays its source.

- [ ] **Step 2: Run the focused tests and confirm red**

  Run: `npm --prefix agent test -- --test-name-pattern='训练来源|数据集版本'`

  Expected: source fields are absent from the returned summary and the UI text/source marker is absent.

- [ ] **Step 3: Implement safe source projection and copy**

  Add the optional source fields to `DatasetVersion`, `versionSummary`, and the detail view. Keep absolute paths and full run payloads excluded. Update `ProjectOverview` to refresh versions after `run.completed`, `run.completed_with_errors`, and dataset-version events; show `自动 · 标注任务（运行标识前 8 位）` for automatic versions.

- [ ] **Step 4: Update assistant guidance**

  Change the training system prompt and `list_dataset_versions` description to explain that terminal annotation runs create versions automatically, that `building` must be awaited, and that only `ready` can feed `create_training_dataset`. Do not add a new write tool or bypass the engine readiness check.

- [ ] **Step 5: Verify focused tests pass**

  Run: `npm --prefix agent test -- --test-name-pattern='训练来源|数据集版本'` and the targeted desktop UI check for annotation/training.

- [ ] **Step 6: Commit the user-facing changes**

  ```powershell
  git add renderer/src/DatasetVersions.tsx renderer/src/ProjectOverview.tsx renderer/src/eventNames.ts agent/training-tools.ts agent/orchestrator.ts agent/tests/training-tools.test.ts renderer/tests/desktop-annotate-check.ts
  git commit -m "完善标注完成到训练版本提示"
  ```

### Task 4: Full verification and integration audit

**Files:**
- Modify: none unless a verification failure identifies a direct regression
- Test: existing repository checks

- [ ] **Step 1: Run the full non-UI gate**

  Run: `npm run check:all -- --skip-ui`

  Expected: desktop/renderer/agent type checks, contract checks, desktop tests, agent tests, and engine suites pass.

- [ ] **Step 2: Run the focused packaged/UI path**

  Run: `npm run check:annotate-ui` and `npm run check:training-ui`

  Expected: a completed annotation flow shows an automatic version and a ready version remains consumable by the training snapshot path.

- [ ] **Step 3: Inspect the final diff and working tree**

  Run: `git diff --check; git status --short; git log --oneline -4`

  Expected: no whitespace errors, only intended files changed, and each automatic version source is represented by a test.

- [ ] **Step 4: Commit any narrowly required verification fix**

  If a verification command fails, fix only the files named by that failure, rerun the failed command, and commit the focused correction with `git commit -m "修复自动版本回归问题"`; do not include unrelated formatting or generated artifacts.

