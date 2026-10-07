import { keypointEdges } from './keypointEdges';
import { chipTextColor, chipTextWidth } from './canvasChip';
import { taskNames, type Asset, type LabelClass } from './types';

/**
 * 候选结果在运行创建时会冻结一份类别模板。运行期间项目类别表可能尚未刷新，
 * 只查当前表会把仍然有效的候选类别误显示成「类别缺失」；当前类别优先，冻结模板只补缺失项。
 */
export function mergeAnnotationClasses(classes: LabelClass[], metadata?: Record<string, unknown>): LabelClass[] {
  const merged = new Map(classes.map(item => [item.id, item]));
  const template = metadata?.annotationTemplate;
  if (!template || typeof template !== 'object' || Array.isArray(template)) return classes;
  const templateClasses = (template as { classes?: unknown }).classes;
  if (!Array.isArray(templateClasses)) return classes;
  for (const value of templateClasses) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || merged.has(item.id)) continue;
    merged.set(item.id, {
      id: item.id,
      name: item.name,
      color: typeof item.color === 'string' ? item.color : '#4a83ff',
    });
  }
  return [...merged.values()];
}

/**
 * 只读标注预览：图片 + 检测框 / 旋转框 / 多边形 / 关键点 / 分类。
 * 从工作台画布里抽出，去掉全部编辑交互与坐标控件；对话结果卡片与项目概览的抽查都用它，
 * 人工修正改由对话指令驱动，不再回到画布。
 */
export default function ResultViewer({ asset, classes, connectionTemplate, maxHeight }: {
  asset: Asset; classes: LabelClass[]; connectionTemplate?: unknown; maxHeight?: string;
}) {
  const resolvedClasses = mergeAnnotationClasses(classes, asset.metadata);
  const label = (classId: string) => resolvedClasses.find(item => item.id === classId);
  // 预览按容器宽度等比缩放，所以线宽与字号按图片尺寸取一个单位值，缩放后仍看得清。
  const unit = Math.max(1, Math.max(asset.width, asset.height) / 800);
  return <div className="result-viewer" style={maxHeight ? { maxHeight } : undefined}>
    {asset.annotations.length === 0 && <p className="quiet-empty">这张图还没有标注对象。</p>}
    <svg className="result-canvas" viewBox={`0 0 ${asset.width} ${asset.height}`} role="img"
      aria-label={`${asset.name} 的只读标注预览`} data-result-viewer={asset.id}>
      <image href={asset.mediaUrl} width={asset.width} height={asset.height} />
      {asset.annotations.map(shape => {
        const color = label(shape.classId)?.color ?? '#4a83ff';
        const bbox = shape.bbox;
        return <g key={shape.id} className="result-shape" style={{ color }}>
          {bbox && (() => {
            const name = label(shape.classId)?.name ?? '类别缺失';
            const chipWidth = chipTextWidth(name, 12 * unit) + 16 * unit;
            // 底板默认贴框上沿；X 夹在图片内（旋转框在自身坐标系里，不做图片边界夹取），
            // 贴不到图片顶部时改放框内，右缘与顶部的框标签都不再被裁掉。
            const chipX = shape.type === 'obb' ? bbox.x : Math.min(Math.max(0, bbox.x), Math.max(0, asset.width - chipWidth));
            const aboveY = bbox.y - 22 * unit;
            const chipY = aboveY >= 0 ? aboveY : bbox.y + 1.6 * unit;
            return <g transform={shape.type === 'obb' ? `rotate(${shape.rotation ?? 0},${bbox.x + bbox.width / 2},${bbox.y + bbox.height / 2})` : undefined}>
              <rect x={bbox.x} y={bbox.y} width={bbox.width} height={bbox.height} fill="transparent" stroke={color} strokeWidth={1.6 * unit} />
              <rect x={chipX} y={chipY} width={chipWidth} height={22 * unit} rx={3 * unit} fill={color} />
              <text x={chipX + 8 * unit} y={chipY + 15 * unit} fontSize={12 * unit} fontWeight={600} fill={chipTextColor(color)}>{name}</text>
            </g>;
          })()}
          {shape.points && <polygon points={shape.points.map(point => `${point.x},${point.y}`).join(' ')} fill={`${color}22`} stroke={color} strokeWidth={1.6 * unit} />}
          {shape.keypoints && <>
            {keypointEdges(shape.keypoints, connectionTemplate).map(([from, to], edge) => <line key={edge} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={1.2 * unit} />)}
            {shape.keypoints.map((point, index) => point.visibility > 0 && <g key={index}>
              <circle cx={point.x} cy={point.y} r={5 * unit} fill={point.visibility === 2 ? color : 'white'} stroke={color} strokeWidth={1.4 * unit} />
              <text x={point.x + 9 * unit} y={point.y - 8 * unit} fontSize={11 * unit} paintOrder="stroke" stroke="#fff" strokeWidth={2 * unit} fill={color}>{index + 1}</text>
            </g>)}
          </>}
          {shape.type === 'classify' && (() => {
            const text = `${label(shape.classId)?.name ?? '类别缺失'} · ${taskNames[shape.type]}`;
            const chipWidth = Math.max(140 * unit, chipTextWidth(text, 13 * unit) + 20 * unit);
            return <g><rect x={12 * unit} y={12 * unit} width={chipWidth} height={26 * unit} rx={5 * unit} fill={color} /><text x={22 * unit} y={30 * unit} fontSize={13 * unit} fontWeight={600} fill={chipTextColor(color)}>{text}</text></g>;
          })()}
        </g>;
      })}
    </svg>
  </div>;
}
