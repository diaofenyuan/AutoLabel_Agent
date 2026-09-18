import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkDesktopQuality } from './desktop-quality-check';
import { checkDesktopRerun } from './desktop-rerun-check';
import { checkDesktopFive } from './desktop-five-check';
import { checkDesktopStorage } from './desktop-storage-check';
import { checkDesktopLocal } from './desktop-local-check';
import { checkDesktopMedia } from './desktop-media-check';
import { checkDesktopEditing } from './desktop-editing-check';
import { checkDesktopProviderDelete } from './desktop-provider-delete-check';
import { checkDesktopUpdateUi } from './desktop-update-ui-check';
import { checkDesktopRunControls } from './desktop-run-control-check';
import { checkDesktopReason } from './desktop-reason-check';
import { checkDesktopAnnotate } from './desktop-annotate-check';
import { checkDesktopUnknownRetry } from './desktop-unknown-retry-check';
import { checkDesktopFrameScope } from './desktop-frame-scope-check';
import { checkDesktopProjectIdentity } from './desktop-project-identity-check';
import { checkDesktopDirectoryImport } from './desktop-directory-import-check';
import { checkDesktopOnboarding } from './desktop-onboarding-check';
import { checkDesktopAiPreset } from './desktop-ai-preset-check';
import { checkDesktopComposer } from './desktop-composer-check';
import { checkDesktopSettings } from './desktop-settings-check';
import { checkDesktopErrorAction } from './desktop-error-action-check';
import { checkDesktopSidebar } from './desktop-sidebar-check';
import { gotoNav, openExampleCanvas } from './desktop-navigation';

/**
 * 环境变量 → 验收实现。与 scripts/desktop-smoke.mjs 的 MANUAL_CHECKS 一一对应：
 * 那边决定了「跑哪一条」，这里决定「跑哪一个函数」，两边都只加一行。
 * 落在表外时走下面的默认分支（--manual）。
 */
const DISPATCH: Array<[string, (window: BrowserWindow, output: string) => Promise<void>]> = [
  ['AUTOLABEL_ONBOARDING_UI_CHECK', checkDesktopOnboarding],
  ['AUTOLABEL_AI_PRESET_UI_CHECK', checkDesktopAiPreset],
  ['AUTOLABEL_COMPOSER_UI_CHECK', checkDesktopComposer],
  ['AUTOLABEL_SETTINGS_UI_CHECK', checkDesktopSettings],
  ['AUTOLABEL_ERROR_ACTION_UI_CHECK', checkDesktopErrorAction],
  ['AUTOLABEL_SIDEBAR_UI_CHECK', checkDesktopSidebar],
  ['AUTOLABEL_DIRECTORY_IMPORT_UI_CHECK', checkDesktopDirectoryImport],
  ['AUTOLABEL_PROJECT_IDENTITY_UI_CHECK', checkDesktopProjectIdentity],
  ['AUTOLABEL_FRAME_SCOPE_UI_CHECK', checkDesktopFrameScope],
  ['AUTOLABEL_UNKNOWN_RETRY_UI_CHECK', checkDesktopUnknownRetry],
  ['AUTOLABEL_ANNOTATE_UI_CHECK', checkDesktopAnnotate],
  ['AUTOLABEL_REASON_UI_CHECK', checkDesktopReason],
  ['AUTOLABEL_PROVIDER_DELETE_UI_CHECK', checkDesktopProviderDelete],
  ['AUTOLABEL_EDITING_UI_CHECK', checkDesktopEditing],
  ['AUTOLABEL_MEDIA_UI_CHECK', checkDesktopMedia],
  ['AUTOLABEL_LOCAL_UI_CHECK', checkDesktopLocal],
  ['AUTOLABEL_FIVE_UI_CHECK', checkDesktopFive],
  ['AUTOLABEL_STORAGE_UI_CHECK', checkDesktopStorage],
  ['AUTOLABEL_RERUN_UI_CHECK', checkDesktopRerun],
  ['AUTOLABEL_QUALITY_UI_CHECK', checkDesktopQuality],
  ['AUTOLABEL_UPDATE_UI_CHECK', checkDesktopUpdateUi],
  ['AUTOLABEL_RUN_CONTROL_UI_CHECK', checkDesktopRunControls],
];

// 只在桌面显式验收入口运行；所有文件夹、对话框选择及破坏性夹具均限制在独立测试目录。
export async function checkDesktopManual(window:BrowserWindow, output:string):Promise<void> {
  const entry = DISPATCH.find(([name]) => process.env[name] === '1');
  if (entry) return entry[1](window, output);
  // 旧的 --manual 手工链路（工作台时代的草稿、标签导入、导出历史、更新设置）已随工作台移除，整段删除。
  // 需要这些覆盖时，请按现界面在 MANUAL_CHECKS 里补一条独立验收，而不是在这里堆一条万能链。
  throw new Error(`没有匹配的验收入口，请检查 AUTOLABEL_*_UI_CHECK 是否与 scripts/desktop-smoke.mjs 的 MANUAL_CHECKS 一致。`);
}