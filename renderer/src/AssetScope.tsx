import { useApp } from './context';
import { Field } from './ui';

export type AssetScope = 'project' | 'page' | 'selected';
export function useAssetScope(scope: AssetScope) {
  const { assets, assetTotal, selectedAssetIds } = useApp();
  // 省略 assetIds 才代表全项目；空数组必须报错，不能回退到全项目。
  const assetIds = scope === 'project' ? undefined : scope === 'page' ? assets.map(a => a.id) : selectedAssetIds;
  return { assetIds, count: assetIds?.length ?? assetTotal, label: scope === 'project' ? '全项目' : scope === 'page' ? '当前页' : '已勾选（跨页）' };
}
/**
 * `note` 用于补一句与「被排除部分」有关的实话，例如导出时按未标注剔除了多少张。
 * 选择框里的数字是「选中的素材数」，不是「实际提交数」，被排除的部分必须显式说出来，否则用户会以为素材丢了。
 */
export default function AssetScopeField({ value, onChange, disabled, label = '处理范围', note }: { value: AssetScope; onChange: (value: AssetScope) => void; disabled?: boolean; label?: string; note?: string }) {
  const { assets, assetTotal, selectedAssetIds } = useApp();
  const base = value === 'project' ? '由引擎读取全项目，包括其他页。' : value === 'page' ? '仅使用当前页的素材，执行时固定图片 ID。' : '仅使用工作台明确勾选的素材，包含其他页；空勾选不能执行。';
  return <Field label={label} hint={`${base}${note ?? ''}`}><select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value as AssetScope)}><option value="project">全项目 · {assetTotal} 张</option><option value="page">当前页 · {assets.length} 张</option><option value="selected">已勾选（跨页）· {selectedAssetIds.length} 张</option></select></Field>;
}
