import { keypointEdges } from './keypointEdges';
import { taskNames, type Asset, type LabelClass } from './types';

/**
 * 只读标注预览：图片 + 检测框 / 旋转框 / 多边形 / 关键点 / 分类。
 * 从工作台画布里抽出，去掉全部编辑交互与坐标控件；对话结果卡片与项目概览的抽查都用它，
 * 人工修正改由对话指令驱动，不再回到画布。
 */
export default function ResultViewer({ asset, classes, connectionTemplate, maxHeight }: {
  asset: Asset; classes: LabelClass[]; connectionTemplate?: unknown; maxHeight?: number;
}) {
  const label = (classId: string) => classes.find(item => item.id === classId);
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
          {bbox && <g transform={shape.type === 'obb' ? `rotate(${shape.rotation ?? 0},${bbox.x + bbox.width / 2},${bbox.y + bbox.height / 2})` : undefined}>
            <rect x={bbox.x} y={bbox.y} width={bbox.width} height={bbox.height} fill="transparent" stroke={color} strokeWidth={1.6 * unit} />
            <rect x={bbox.x} y={Math.max(0, bbox.y - 22 * unit)} width={(label(shape.classId)?.name.length ?? 2) * 13 * unit + 16 * unit} height={22 * unit} rx={3 * unit} fill={color} />
            <text x={bbox.x + 8 * unit} y={Math.max(0, bbox.y - 22 * unit) + 15 * unit} fontSize={12 * unit} fill="white">{label(shape.classId)?.name ?? '类别缺失'}</text>
          </g>}
          {shape.points && <polygon points={shape.points.map(point => `${point.x},${point.y}`).join(' ')} fill={`${color}22`} stroke={color} strokeWidth={1.6 * unit} />}
          {shape.keypoints && <>
            {keypointEdges(shape.keypoints, connectionTemplate).map(([from, to], edge) => <line key={edge} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={1.2 * unit} />)}
            {shape.keypoints.map((point, index) => point.visibility > 0 && <g key={index}>
              <circle cx={point.x} cy={point.y} r={5 * unit} fill={point.visibility === 2 ? color : 'white'} stroke={color} strokeWidth={1.4 * unit} />
              <text x={point.x + 9 * unit} y={point.y - 8 * unit} fontSize={11 * unit} paintOrder="stroke" stroke="#fff" strokeWidth={2 * unit} fill={color}>{index + 1}</text>
            </g>)}
          </>}
          {shape.type === 'classify' && <g><rect x={12 * unit} y={12 * unit} width={140 * unit} height={26 * unit} rx={5 * unit} fill={color} /><text x={22 * unit} y={30 * unit} fill="white" fontSize={13 * unit}>{label(shape.classId)?.name ?? '类别缺失'} · {taskNames[shape.type]}</text></g>}
        </g>;
      })}
    </svg>
  </div>;
}
