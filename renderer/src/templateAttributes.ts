import type { TemplateAttributeDefinition, TemplateAttributeDefinitions } from '../../shared/templates';
import type { Annotation } from './types';

export const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

// 只识别公开包装；旧说明 JSON 继续作为说明，不能在读取时改写为新模板。
export function attributeDefinitions(value: unknown): TemplateAttributeDefinitions | null {
  const object = record(value);
  if (object?.kind !== 'attribute_definitions' || object.version !== 1 || !Array.isArray(object.definitions)) return null;
  if (!object.definitions.every(item => { const d = record(item); return d && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.required === 'boolean' && ['text', 'number', 'boolean', 'select'].includes(String(d.type)) && (d.type !== 'select' || Array.isArray(d.options) && d.options.every(v => typeof v === 'string')); })) return null;
  return object as unknown as TemplateAttributeDefinitions;
}

export function attributeValueIssue(definition: TemplateAttributeDefinition, value: unknown): string | null {
  const d = definition;
  if (d.required && (value === undefined || value === null || d.type === 'text' && typeof value === 'string' && !value.trim() || d.type === 'select' && value === '')) return '需要填写';
  if (value === undefined) return null;
  if (d.type === 'text') return typeof value !== 'string' ? '需要文本' : d.maxLength !== undefined && value.length > d.maxLength ? `最多 ${d.maxLength} 个字符` : null;
  if (d.type === 'number') return typeof value !== 'number' || !Number.isFinite(value) ? '需要有效数字' : d.min !== undefined && value < d.min ? `不得小于 ${d.min}` : d.max !== undefined && value > d.max ? `不得大于 ${d.max}` : null;
  if (d.type === 'boolean') return typeof value === 'boolean' ? null : '需要明确选择是或否';
  return typeof value === 'string' && d.options.includes(value) ? null : '请选择模板中的选项';
}

export function annotationAttributeIssues(annotations: Annotation[], attributes: unknown): string[] {
  const definitions = attributeDefinitions(attributes);
  return definitions ? annotations.flatMap((a, i) => definitions.definitions.flatMap(d => { const issue = attributeValueIssue(d, a.attributes?.[d.id]); return issue ? [`对象 ${i + 1} · ${d.name}：${issue}`] : []; })) : [];
}
