import type { Annotation, Project, TaskType } from './protocol.ts';

export type ResourceKind = 'prompt' | 'template' | 'reference' | 'flow';
export type ResourceField = 'prompt' | 'classes' | 'keypointNames' | 'keypointConnections'
  | 'attributes' | 'rules' | 'occlusionRules' | 'blurRules' | 'flow';
export interface LibraryResource {
  id: string; version: number; kind: ResourceKind; name: string;
  category: string; note: string; content: unknown; createdAt: string; updatedAt: string;
}
export interface ReferenceContent {
  sourceAssetId: string; sourceProjectId: string; sourceAssetVersion: number;
  source: 'manual' | 'preset_manual'; sourceStatus: 'modified' | 'confirmed';
  name: string; width: number; height: number; contentHash: string;
  annotations: Annotation[]; template: Pick<Project, 'classes' | 'settings'> & { taskType: TaskType };
  metadata: Record<string, unknown>; frozenAt: string;
}
export interface ReferenceSelection {
  resourceId: string; version?: number; classMap?: Record<string, string>;
}
export interface ResourceApplication {
  project: Project; resourceId: string; resourceVersion: number; fields: ResourceField[];
}
