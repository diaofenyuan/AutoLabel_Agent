import type { Asset } from '../../shared/protocol';

export interface VideoContinuityIssue {
  assetId: string;
  frameId?: string;
  code: 'candidate_gap' | 'center_jump' | 'box_scale' | 'aspect_change' | 'near_edge';
  message: string;
  metric?: number;
}

type Box = { classId: string; x: number; y: number; width: number; height: number; area: number };
type Frame = { asset: Asset; time?: number; pts?: bigint; boxes: Box[]; scene?: string };

const MAX_PAIR_SECONDS = 2.5;
const MAX_GAP_SIDE_SECONDS = 3;
const CENTER_JUMP_BOX_DIAGONALS = 1;
const BOX_SCALE_RATIO = 3.5;
const ASPECT_RATIO_CHANGE = 1.8;

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function frameTime(asset: Asset): number | undefined {
  const metadata = asset.metadata ?? {};
  const direct = finite(metadata.timeSeconds);
  if (direct !== undefined) return direct;
  if (typeof metadata.sourcePts !== 'string') return undefined;
  const timeBase = metadata.timeBase;
  if (!timeBase || typeof timeBase !== 'object') return undefined;
  const { numerator, denominator } = timeBase as Record<string, unknown>;
  const n = finite(numerator);
  const d = finite(denominator);
  if (!n || !d) return undefined;
  try { return Number(BigInt(metadata.sourcePts)) * n / d; } catch { return undefined; }
}

function framePts(asset: Asset): bigint | undefined {
  const value = asset.metadata?.sourcePts;
  if (typeof value !== 'string') return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

function presentationIndex(asset: Asset): number | undefined {
  return finite(asset.metadata?.sourcePresentationIndex);
}

function sortFrames(a: Frame, b: Frame): number {
  if (a.pts !== undefined && b.pts !== undefined && a.pts !== b.pts) return a.pts < b.pts ? -1 : 1;
  if (a.time !== undefined && b.time !== undefined && a.time !== b.time) return a.time - b.time;
  const ai = presentationIndex(a.asset);
  const bi = presentationIndex(b.asset);
  if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi;
  const af = String(a.asset.metadata?.frameId ?? a.asset.name);
  const bf = String(b.asset.metadata?.frameId ?? b.asset.name);
  return af.localeCompare(bf, 'zh-CN', { numeric: true }) || a.asset.id.localeCompare(b.asset.id);
}

function elapsedSeconds(a: Frame, b: Frame): number | undefined {
  if (a.time !== undefined && b.time !== undefined) return Math.abs(b.time - a.time);
  if (a.pts !== undefined && b.pts !== undefined) {
    const base = a.asset.metadata?.timeBase;
    if (base && typeof base === 'object') {
      const { numerator, denominator } = base as Record<string, unknown>;
      const n = finite(numerator);
      const d = finite(denominator);
      if (n && d) return Number(b.pts - a.pts) * n / d;
    }
  }
  return undefined;
}

function boxesFor(asset: Asset): Box[] {
  const byClass = new Map<string, Box>();
  for (const annotation of asset.annotations ?? []) {
    const bbox = annotation.bbox;
    if (!bbox || ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite) || bbox.width <= 0 || bbox.height <= 0) continue;
    const box = { classId: annotation.classId, ...bbox, area: bbox.width * bbox.height };
    const existing = byClass.get(annotation.classId);
    if (!existing || box.area > existing.area) byClass.set(annotation.classId, box);
  }
  return [...byClass.values()];
}

function sameScene(a: Frame, b: Frame): boolean {
  return !a.scene || !b.scene || a.scene === b.scene;
}

function frameId(frame: Frame): string | undefined {
  const value = frame.asset.metadata?.frameId;
  return typeof value === 'string' ? value : undefined;
}

/** 对同一视频组已加载的帧做只读检查；不改标注，也不推断人工空目标。 */
export function inspectVideoContinuity(assets: Asset[]): VideoContinuityIssue[] {
  const frames: Frame[] = assets.map(asset => ({
    asset,
    time: frameTime(asset),
    pts: framePts(asset),
    boxes: boxesFor(asset),
    scene: typeof asset.metadata?.sceneId === 'string' ? asset.metadata.sceneId : undefined,
  })).sort(sortFrames);
  const issues: VideoContinuityIssue[] = [];
  const add = (frame: Frame, code: VideoContinuityIssue['code'], message: string, metric?: number) => {
    issues.push({ assetId: frame.asset.id, frameId: frameId(frame), code, message, ...(metric === undefined ? {} : { metric }) });
  };

  for (let index = 0; index < frames.length; index++) {
    const current = frames[index];
    const previous = frames[index - 1];
    if (!current.boxes.length && current.asset.resultState === 'empty') {
      let before = index - 1;
      while (before >= 0 && !frames[before].boxes.length && index - before <= 3) before--;
      let after = index + 1;
      while (after < frames.length && !frames[after].boxes.length && after - index <= 3) after++;
      const left = frames[before];
      const right = frames[after];
      const leftGap = left && elapsedSeconds(left, current);
      const rightGap = right && elapsedSeconds(current, right);
      const sharedClass = left && right && left.boxes.some(box => right.boxes.some(value => value.classId === box.classId));
      if (left?.boxes.length && right?.boxes.length && sameScene(left, current) && sameScene(current, right)
        && sharedClass
        && (leftGap === undefined || leftGap <= MAX_GAP_SIDE_SECONDS)
        && (rightGap === undefined || rightGap <= MAX_GAP_SIDE_SECONDS)) {
        add(current, 'candidate_gap', '前后视频帧都有候选框，这一帧没有目标结果；请复核是否发生短暂漏检。');
      }
    }

    for (const box of current.boxes) {
      const width = current.asset.width;
      const height = current.asset.height;
      if (width > 0 && height > 0) {
        const edgeDistance = Math.min(box.x, box.y, width - box.x - box.width, height - box.y - box.height);
        if (edgeDistance <= Math.min(width, height) * 0.015) {
          add(current, 'near_edge', '候选框贴近画面边缘，请确认目标是否完整入框。');
        }
      }
    }

    if (!previous || !current.boxes.length || !previous.boxes.length || !sameScene(previous, current)) continue;
    const elapsed = elapsedSeconds(previous, current);
    if (elapsed !== undefined && elapsed > MAX_PAIR_SECONDS) continue;
    for (const box of current.boxes) {
      const old = previous.boxes.find(value => value.classId === box.classId);
      if (!old) continue;
      const width = Math.max(current.asset.width, previous.asset.width);
      const height = Math.max(current.asset.height, previous.asset.height);
      if (width > 0 && height > 0 && current.asset.width > 0 && current.asset.height > 0
        && previous.asset.width > 0 && previous.asset.height > 0) {
        const dx = (box.x + box.width / 2) / current.asset.width - (old.x + old.width / 2) / previous.asset.width;
        const dy = (box.y + box.height / 2) / current.asset.height - (old.y + old.height / 2) / previous.asset.height;
        const distance = Math.hypot(dx * width, dy * height);
        const oldDiagonal = Math.hypot(old.width / previous.asset.width * width, old.height / previous.asset.height * height);
        const newDiagonal = Math.hypot(box.width / current.asset.width * width, box.height / current.asset.height * height);
        const relativeDistance = distance / Math.max(Number.EPSILON, (oldDiagonal + newDiagonal) / 2);
        if (relativeDistance >= CENTER_JUMP_BOX_DIAGONALS) {
          add(current, 'center_jump', '候选框中心相邻帧移动超过一个框对角线，请核对是否跟错目标。', relativeDistance);
        }
      }
      const oldArea = old.area / Math.max(1, previous.asset.width * previous.asset.height);
      const newArea = box.area / Math.max(1, current.asset.width * current.asset.height);
      const scale = Math.max(oldArea, newArea) / Math.max(Number.EPSILON, Math.min(oldArea, newArea));
      if (scale >= BOX_SCALE_RATIO) add(current, 'box_scale', '候选框面积与上一帧差异较大，请核对目标尺度与框边界。', scale);
      const oldAspect = old.width / old.height;
      const newAspect = box.width / box.height;
      const aspect = Math.max(oldAspect, newAspect) / Math.min(oldAspect, newAspect);
      if (aspect >= ASPECT_RATIO_CHANGE) add(current, 'aspect_change', '候选框宽高比例变化较大，请核对是否框住了同一目标。', aspect);
    }
  }
  return issues.filter((issue, index) => issues.findIndex(value => value.assetId === issue.assetId && value.code === issue.code) === index);
}
