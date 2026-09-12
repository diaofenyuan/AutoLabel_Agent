import type { ReusePolicy } from '../../shared/reuse';
import { Field } from './ui';

export default function ReusePolicyFields({ value, onChange, disabled, mode = 'api' }: { value: ReusePolicy; onChange: (key: keyof ReusePolicy, value: boolean | number | null) => void; disabled: boolean; mode?: 'api' | 'local' }) {
  const enabled = value.reuseEnabled !== false, force = value.forceRerun === true;
  const local = mode === 'local';
  return <details className="reuse-policy"><summary>{local ? '输入结果复用' : '候选复用'} · {force ? local ? '强制重新计算' : '强制重新请求' : enabled ? local ? '允许复用' : '已启用' : '已关闭'}{enabled && !force && ` · ${value.reuseMaxAgeSeconds == null ? '无时限' : `${value.reuseMaxAgeSeconds} 秒内`}`}</summary><div>
    <label className="checkbox-row"><input aria-label={local ? '允许复用已有输入结果' : '允许复用已有候选'} type="checkbox" disabled={disabled} checked={enabled} onChange={e => onChange('reuseEnabled', e.target.checked)}/>{local ? '允许复用匹配的已有输入结果' : '允许复用匹配的已有候选'}</label>
    <label className="checkbox-row"><input aria-label={local ? '强制重新执行本地模型' : '强制重新请求模型'} type="checkbox" disabled={disabled} checked={force} onChange={e => onChange('forceRerun', e.target.checked)}/>{local ? '强制重新执行本地模型' : '强制重新请求模型'}</label>
    <Field label="结果有效期（秒）" hint="留空表示无时限；填写正整数。"><input aria-label="复用结果有效期" disabled={disabled || !enabled || force} type="number" min={1} step={1} value={value.reuseMaxAgeSeconds ?? ''} placeholder="不限时" onChange={e => onChange('reuseMaxAgeSeconds', e.target.value === '' ? null : Number(e.target.value))}/></Field>
    <p className="muted tiny">{local ? '命中时复用已保存的输入结果，不重复本地计算，也不产生 API 请求。是否可复用由引擎核验；强制执行优先，失败与未知输入重试绕过复用。' : '命中复用时不发送模型请求。强制重新请求优先于复用设置；失败与未知样本重试会绕过复用。'}</p>
  </div></details>;
}
