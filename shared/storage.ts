export interface BackupIssue {
  code: string;
  message: string;
  target?: string;
  kind?: string;
}

export interface BackupSummary {
  schemaVersion: number;
  fileCount: number;
  totalBytes: number;
  issues: BackupIssue[];
  warnings: BackupIssue[];
  credentialsIncluded: false;
  credentialRebindRequired: true;
}

export interface BackupPreflight extends BackupSummary {
  ready: boolean;
  availableBytes: number;
}

export interface BackupCreated extends BackupSummary {
  backupId: string;
  backupPath: string;
  status: 'completed';
}

export interface BackupInspection extends BackupSummary {
  backupId: string;
  createdAt: string;
  valid: true;
}

// 界面只能持有主进程签发的准备标识，不能提供恢复目录或凭据作用域。
export interface RestorePreparation {
  preparationId: string;
  backupId: string;
  credentialRebindRequired: true;
}

export interface StorageStatus {
  busy: boolean;
  phase: string;
  dataDir: string;
  error?: { code: string; message: string };
}

export interface StorageUsage {
  totalBytes: number;
  projectBytes: number;
  processBytes: number;
  databaseBytes: number;
  cacheBytes: number;
  otherBytes: number;
  cacheCandidates: Array<{ path: string; bytes: number }>;
}

export interface StorageCleanup extends StorageUsage {
  removedBytes: number;
  removedPaths: string[];
}

export interface StorageActivation {
  activated: true;
  dataDir: string;
  credentialRebindRequired: boolean;
  previousDataRetained: true;
}

export interface BackupProgress {
  operationId: string;
  phase: 'copying' | 'verifying' | 'completed';
  completedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
}

// 三类业务数据的落点与数据库目录相互独立：默认跟随存储根，也可分别覆盖为外部绝对路径。
export type StoragePathKind = 'datasets' | 'uploads' | 'chats';
export type StoragePathSource = 'default' | 'custom' | 'fallback';

export interface StoragePathEntry {
  kind: StoragePathKind;
  label: string;
  path: string;
  custom: boolean;
  source: StoragePathSource;
  /** 回退到其他位置的原因；仅 source 为 fallback 时存在。 */
  reason?: string;
  bytes: number;
  files: number;
}

export interface StoragePathsState {
  installDirectory: string;
  defaultRoot: string;
  fallbackRoot: string;
  root: string;
  rootSource: StoragePathSource;
  rootReason?: string;
  dataDirectory: string;
  entries: StoragePathEntry[];
  writable: boolean;
}

export interface StoragePathProbe {
  path: string;
  absolute: boolean;
  exists: boolean;
  created: boolean;
  writable: boolean;
  reason?: string;
}

export interface StoragePathCandidate {
  kind: StoragePathKind;
  label: string;
  from: string;
  to: string;
  files: number;
  bytes: number;
}

export interface StoragePathMigrationPlan {
  candidates: StoragePathCandidate[];
}

export interface StoragePathMigrationResult {
  copiedFiles: number;
  copiedBytes: number;
  skipped: number;
  failures: Array<{ kind: StoragePathKind; path: string; message: string }>;
  sourcesRetained: true;
}
