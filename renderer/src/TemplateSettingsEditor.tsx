import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { TemplateAttributeDefinition, TemplateAttributeDefinitions } from '../../shared/templates';
import { attributeDefinitions, record } from './templateAttributes';
import { Button, Field, IconButton } from './ui';

function Explanation({ label, value, onChange, disabled }: { label: string; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const json = value !== undefined && typeof value !== 'string';
  const [text, setText] = useState(typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2));
  return <Field label={label} hint={json ? '保留旧 JSON 格式，仅作为标注说明。' : '用于人工标注说明，不自动执行规则。'}><textarea aria-label={label} rows={3} disabled={disabled} value={text} onChange={e => {
    const next = e.target.value; setText(next);
    try { const parsed: unknown = json ? JSON.parse(next) : next; e.target.setCustomValidity(''); onChange(parsed); }
    catch { e.target.setCustomValidity('请填写有效 JSON，或放弃本次编辑。'); }
  }}/></Field>;
}

function Attributes({ value, onChange, disabled }: { value: unknown; onChange: (value: TemplateAttributeDefinitions) => void; disabled: boolean }) {
  const wrapper = attributeDefinitions(value);
  function update(index: number, definition: TemplateAttributeDefinition) { onChange({ ...wrapper!, definitions: wrapper!.definitions.map((d, i) => i === index ? definition : d) }); }
  return <details className="template-section"><summary>结构化属性 <span>{wrapper ? `${wrapper.definitions.length} 项` : value === undefined ? '未启用' : '保留旧说明'}</span></summary><div className="template-section-body">
    {!wrapper ? <><p className="muted tiny">按模板填写文本、数字、是非或选项；旧说明不会自动转换。</p>{value !== undefined && <details><summary>查看现有属性说明</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>}<Button type="button" disabled={disabled} onClick={() => onChange({ kind: 'attribute_definitions', version: 1, definitions: [] })}>{value === undefined ? '启用结构化属性' : '用结构化属性替换此说明'}</Button></> : <>
      {wrapper.definitions.map((d, index) => <section className="attribute-definition" key={d.id}><div className="attribute-definition-heading"><Field label={`属性 ${index + 1} 名称`}><input aria-label={`属性定义${index + 1}名称`} required maxLength={100} disabled={disabled} value={d.name} onChange={e => update(index, { ...d, name: e.target.value })}/></Field><Field label="类型"><select aria-label={`属性定义${index + 1}类型`} disabled={disabled} value={d.type} onChange={e => {
        const base = { id: d.id, name: d.name, required: d.required }, type = e.target.value as TemplateAttributeDefinition['type'];
        update(index, type === 'select' ? { ...base, type, options: ['选项一'] } : { ...base, type });
      }}><option value="text">文本</option><option value="number">数字</option><option value="boolean">是 / 否</option><option value="select">单选</option></select></Field><label className="checkbox-row"><input aria-label={`属性定义${index + 1}必填`} type="checkbox" disabled={disabled} checked={d.required} onChange={e => update(index, { ...d, required: e.target.checked })}/>必填</label><IconButton type="button" label={`删除属性定义${index + 1}`} disabled={disabled} onClick={() => onChange({ ...wrapper, definitions: wrapper.definitions.filter((_, i) => i !== index) })}><Trash2 size={14}/></IconButton></div>
        
        {d.type === 'select' && <Field label="选项" hint="每行一个选项，最多 256 项。"><textarea aria-label={`属性定义${index + 1}选项`} rows={3} required disabled={disabled} value={d.options.join('\n')} onChange={e => { const options = e.target.value.split('\n'); e.target.setCustomValidity(options.length > 256 || options.some(v => !v.trim() || v.length > 1000) || new Set(options).size !== options.length ? '选项须非空且不重复，每项不超过 1000 字符。' : ''); update(index, { ...d, options }); }}/></Field>}
        <details className="attribute-constraints"><summary>取值限制与身份</summary><p className="muted tiny">稳定属性 ID：{d.id}</p>{d.type === 'text' && <Field label="文本长度上限"><input aria-label={`属性定义${index + 1}长度上限`} type="number" min={1} max={100000} step={1} disabled={disabled} value={d.maxLength ?? ''} placeholder="不设置" onChange={e => update(index, { ...d, maxLength: e.target.value === '' ? undefined : Number(e.target.value) })}/></Field>}{d.type === 'number' && <div className="field-grid">{(['min', 'max'] as const).map((key, i) => <Field key={key} label={i ? '最大值' : '最小值'}><input aria-label={`属性定义${index + 1}${i ? '最大值' : '最小值'}`} type="number" step="any" min={key === 'max' ? d.min : undefined} max={key === 'min' ? d.max : undefined} disabled={disabled} value={d[key] ?? ''} placeholder="不设置" onChange={e => update(index, { ...d, [key]: e.target.value === '' ? undefined : Number(e.target.value) })}/></Field>)}</div>}</details>
      </section>)}<Button type="button" disabled={disabled || wrapper.definitions.length >= 256} onClick={() => onChange({ ...wrapper, definitions: [...wrapper.definitions, { id: `attr-${crypto.randomUUID()}`, name: '', type: 'text', required: false }] })}><Plus size={14}/>添加属性</Button>
    </>}
  </div></details>;
}

function Connections({ names, value, onChange, disabled }: { names: string[]; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const pairs = Array.isArray(value) ? value : null;
  const endpoint = (value: unknown) => typeof value === 'number' && Number.isInteger(value) ? names[value] ?? '' : typeof value === 'string' && names.includes(value) ? value : '';
  return <details className="template-section"><summary>骨架连接 <span>{pairs?.length ?? 0} 条</span></summary><div className="template-section-body"><p className="muted tiny">只绘制这里明确连接且两端可定位的点。点名变动后请核对连接。</p>{value !== undefined && !pairs && <><p className="inline-error">现有连接不是点对数组，请明确重建后再编辑。</p><pre>{JSON.stringify(value, null, 2)}</pre><Button type="button" disabled={disabled} onClick={() => onChange([])}>重建连接列表</Button></>}{pairs?.map((pair, index) => <div className="connection-row" key={index}>{[0, 1].map(side => <select key={side} aria-label={`连接${index + 1}${side ? '终点' : '起点'}`} required disabled={disabled} value={Array.isArray(pair) ? endpoint(pair[side]) : ''} onChange={e => onChange(pairs.map((p, i) => { if (i !== index) return p; const next = Array.isArray(p) && p.length === 2 ? [...p] : ['', '']; next[side] = e.target.value; return next; }))}><option value="">选择点位</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select>)}<IconButton type="button" label={`删除连接${index + 1}`} disabled={disabled} onClick={() => onChange(pairs.filter((_, i) => i !== index))}><Trash2 size={14}/></IconButton></div>)}{(pairs || value === undefined) && <Button type="button" disabled={disabled || names.length < 2} onClick={() => onChange([...(pairs ?? []), [names[0], names[1]]])}><Plus size={14}/>添加连接</Button>}</div></details>;
}

export default function TemplateSettingsEditor({ settings, keypointNames = [], pose = false, disabled = false, onChange }: { settings: Record<string, unknown>; keypointNames?: string[]; pose?: boolean; disabled?: boolean; onChange: (key: string, value: unknown) => void }) {
  return <div className="template-settings-editor">{pose && <Connections names={keypointNames} value={settings.keypointConnections} disabled={disabled} onChange={value => onChange('keypointConnections', value)}/>}<Attributes value={settings.attributes} onChange={value => onChange('attributes', value)} disabled={disabled}/><details className="template-section"><summary>标注规则说明</summary><div className="template-section-body">{[['rules', '标注规则'], ['occlusionRules', '遮挡规则'], ['blurRules', '模糊规则']].map(([key, label]) => <Explanation key={key} label={label} value={settings[key]} disabled={disabled} onChange={value => onChange(key, value)}/>)}</div></details></div>;
}

export function TemplateResourceEditor({ content, disabled, onChange }: { content: string; disabled: boolean; onChange: (content: string) => void }) {
  let root: Record<string, unknown> | null; try { root = record(JSON.parse(content)); } catch { return null; }
  if (!root) return null;
  const nested = record(root.settings), settings = { ...nested, ...root }, names = settings.keypointNames;
  return <TemplateSettingsEditor settings={settings} keypointNames={Array.isArray(names) ? names.map(String) : []} pose={root.taskType === 'pose' || Array.isArray(names)} disabled={disabled} onChange={(key, value) => {
    // 沿资源原有顶层/嵌套位置写回，其他字段和旧版本内容保持原样。
    const next = Object.hasOwn(root, key) || !nested ? { ...root, [key]: value } : { ...root, settings: { ...nested, [key]: value } };
    onChange(JSON.stringify(next, null, 2));
  }}/>;
}
