export type TransformOperation =
  | { kind: 'crop'; x: number; y: number; width: number; height: number }
  | { kind: 'resize'; width: number; height: number; fit: 'contain' | 'stretch' }
  | { kind: 'tile'; width: number; height: number; overlapX?: number; overlapY?: number };

export interface TransformParameters {
  operations: TransformOperation[];
  background?: string;
}

export interface GeometryIssue {
  annotationId?: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
}

export interface BaselineIdentity {
  assetId: string;
  contentHash: string;
  width: number;
  height: number;
  normalizationVersion: string;
  inputVersion: number;
}

export type AffineMatrix = [number, number, number, number, number, number];
export interface PixelRect { x: number; y: number; width: number; height: number }
export interface TransformView {
  viewId: string;
  width: number;
  height: number;
  baselineToInput: AffineMatrix;
  inputToBaseline: AffineMatrix;
  validInputRect: PixelRect;
  baselineCoverageRect: PixelRect;
  tile?: PixelRect | null;
}

export interface TransformPlan {
  version: 'baseline-transform-v1';
  coordinateSpace: 'baseline_pixel_edges';
  baseline: BaselineIdentity;
  operations: TransformOperation[];
  steps: Array<Record<string, unknown>>;
  views: TransformView[];
  coverageArea: number;
  coversWholeBaseline: boolean;
  roundOffTolerancePx: number;
}

export interface ModelInputSnapshot {
  inputId: string;
  kind: 'baseline' | 'view';
  assetId: string;
  contentHash: string;
  width: number;
  height: number;
  normalizationVersion: string;
  viewId?: string;
  planHash?: string;
  inputTransform?: TransformView;
  pixelTransformVersion?: string;
}
