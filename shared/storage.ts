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
