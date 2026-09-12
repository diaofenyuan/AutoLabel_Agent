import { attributeDefinitions, attributeValueIssue } from './templateAttributes';
import type { Annotation } from './types';
import { Field } from './ui';

export default function AttributeValues({ definition, value = {}, onChange, disabled = false }: { definition: unknown; value?: Annotation['attributes']; onChange?: (value: NonNullable<Annotation['attributes']>) => void; disabled?: boolean }) {
  const wrapper = attributeDefinitions(definition);
  if (!wrapper?.definitions.length) return null;
  function set(id: string, next: string | number | boolean | undefined) { const updated = { ...value }; if (next === undefined) delete updated[id]; else updated[id] = next; onChange?.(updated); }
  return <div className="attribute-values">{wrapper.definitions.map(d => {
    const current = value[d.id], issue = attributeValueIssue(d, current), label = `${d.name}${d.required ? ' *' : ''}`;
    return <Field key={d.id} label={label} hint={issue ?? undefined}>{!onChange ? <span>{current === undefined ? '未填写' : typeof current === 'boolean' ? current ? '是' : '否' : String(current)}</span> : d.type === 'boolean' ? <select aria-label={`属性 ${d.name}`} aria-invalid={Boolean(issue)} disabled={disabled} value={typeof current === 'boolean' ? String(current) : ''} onChange={e => set(d.id, e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">未填写</option><option value="true">是</option><option value="false">否</option></select> : d.type === 'select' ? <select aria-label={`属性 ${d.name}`} aria-invalid={Boolean(issue)} disabled={disabled} value={typeof current === 'string' ? current : ''} onChange={e => set(d.id, e.target.value || undefined)}><option value="">未填写</option>{typeof current === 'string' && !d.options.includes(current) && <option value={current}>旧值：{current}（需更正）</option>}{d.options.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input aria-label={`属性 ${d.name}`} aria-invalid={Boolean(issue)} disabled={disabled} type={d.type === 'number' ? 'number' : 'text'} step={d.type === 'number' ? 'any' : undefined} min={d.type === 'number' ? d.min : undefined} max={d.type === 'number' ? d.max : undefined} maxLength={d.type === 'text' ? d.maxLength : undefined} value={typeof current === 'string' || typeof current === 'number' ? current : ''} onChange={e => set(d.id, e.target.value === '' ? undefined : d.type === 'number' ? Number(e.target.value) : e.target.value)}/>}</Field>;
  })}</div>;
}
