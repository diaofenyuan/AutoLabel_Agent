import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { TransformOperation } from '../../shared/preprocessing';
import { Button, Field, IconButton } from './ui';

const names = { crop: '裁剪', resize: '缩放', tile: '切片' };
const validSize = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 20000;
const validOffset = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const known = (op: TransformOperation) => op && typeof op === 'object' && Object.hasOwn(names, op.kind);

// 这里只检查参数自身的约束；实际输入范围和每张图的边界必须由引擎预检。
export function transformParameterIssues(value: Record<string, unknown>): string[] {
  const operations = Array.isArray(value.operations) ? value.operations as TransformOperation[] : [];
  const issues: string[] = [];
  if (!operations.length) issues.push('至少添加一个图像处理操作。');
  if (operations.length > 30) issues.push('最多支持 30 个操作。');
  if (operations.filter(op => op?.kind === 'tile').length > 1) issues.push('一个处理计划最多包含一次切片。');
  for (const [index, op] of operations.entries()) {
    const label = `操作 ${index + 1}`;
    if (!known(op)) { issues.push(`${label}的类型不受支持，请移除后重新添加。`); continue; }
    if (!validSize(op.width) || !validSize(op.height)) issues.push(`${label}的宽高须为 1～20000 的整数像素。`);
    else if (op.width * op.height > 40000000) issues.push(`${label}的宽高乘积不能超过 4000 万像素。`);
    if (op.kind === 'crop' && (!validOffset(op.x) || !validOffset(op.y))) issues.push(`${label}的裁剪起点须为非负整数像素。`);
    if (op.kind === 'resize' && !['contain', 'stretch'].includes(op.fit)) issues.push(`${label}需要选择缩放方式。`);
    if (op.kind === 'tile' && (!validOffset(op.overlapX ?? 0) || !validOffset(op.overlapY ?? 0) || (op.overlapX ?? 0) >= op.width || (op.overlapY ?? 0) >= op.height)) issues.push(`${label}的重叠量须为非负整数，且分别小于切片宽高。`);
  }
  if (value.background !== undefined && (typeof value.background !== 'string' || !/^#[\da-f]{6}$/i.test(value.background))) issues.push('背景色需使用 #RRGGBB 格式。');
  return issues;
}

export default function TransformParametersEditor({ value, onChange, disabled }: { value: Record<string, unknown>; onChange: (key: string, value: unknown) => void; disabled: boolean }) {
  const operations = Array.isArray(value.operations) ? value.operations as TransformOperation[] : [];
  const [adding, setAdding] = useState<TransformOperation['kind']>('resize'), [selected, setSelected] = useState<number | null>(null);
  const hasTile = operations.some(op => op?.kind === 'tile'), issues = transformParameterIssues(value);
  function edit(index: number, patch: Record<string, number | string>) { onChange('operations', operations.map((op, i) => i === index ? { ...op, ...patch } : op)); }
  function move(index: number, delta: number) { const next = [...operations], target = index + delta; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; onChange('operations', next); setSelected(target); }
  function add() {
    if (operations.length >= 30 || (adding === 'tile' && hasTile)) return;
    const next: TransformOperation = adding === 'crop' ? { kind: 'crop', x: 0, y: 0, width: 640, height: 640 } : adding === 'resize' ? { kind: 'resize', width: 640, height: 640, fit: 'contain' } : { kind: 'tile', width: 640, height: 640, overlapX: 0, overlapY: 0 };
    onChange('operations', [...operations, next]); setSelected(operations.length);
  }
  return <div className="transform-editor"><p className="muted tiny">操作按从上到下的顺序执行。这里编辑的是处理计划，实际输入仍需引擎逐图预检。</p>
    <div className="transform-operation-list">{operations.map((op, index) => <section key={index} className="transform-operation"><div className="transform-operation-heading"><button disabled={disabled} className="transform-operation-toggle" aria-expanded={selected === index} onClick={() => setSelected(selected === index ? null : index)}><strong>{index + 1}. {known(op) ? names[op.kind] : '待修正操作'}</strong>{known(op) && <small>{op.width} × {op.height}{op.kind === 'resize' ? op.fit === 'contain' ? ' · 等比留边' : ' · 拉伸' : ''}</small>}</button><div className="actions"><IconButton label={`操作 ${index + 1} 上移`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13}/></IconButton><IconButton label={`操作 ${index + 1} 下移`} disabled={disabled || index === operations.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13}/></IconButton><IconButton label={`移除操作 ${index + 1}`} disabled={disabled} onClick={() => { onChange('operations', operations.filter((_, i) => i !== index)); setSelected(null); }}><Trash2 size={13}/></IconButton></div></div>
      {selected === index && known(op) && <div className="transform-operation-fields"><div className="field-grid">{op.kind === 'crop' && (['x', 'y'] as const).map(key => <Field key={key} label={key === 'x' ? '左侧起点 X' : '顶部起点 Y'}><input aria-label={`操作 ${index + 1} ${key}`} disabled={disabled} type="number" min={0} step={1} value={op[key]} onChange={e => edit(index, { [key]: Number(e.target.value) })}/></Field>)}{(['width', 'height'] as const).map(key => <Field key={key} label={key === 'width' ? '宽度（像素）' : '高度（像素）'}><input aria-label={`操作 ${index + 1} ${key}`} disabled={disabled} type="number" min={1} max={20000} step={1} value={op[key]} onChange={e => edit(index, { [key]: Number(e.target.value) })}/></Field>)}{op.kind === 'tile' && (['overlapX', 'overlapY'] as const).map(key => <Field key={key} label={key === 'overlapX' ? '水平重叠（像素）' : '垂直重叠（像素）'}><input aria-label={`操作 ${index + 1} ${key}`} disabled={disabled} type="number" min={0} max={Math.max(0, (key === 'overlapX' ? op.width : op.height) - 1)} step={1} value={op[key] ?? 0} onChange={e => edit(index, { [key]: Number(e.target.value) })}/></Field>)}</div>
        {op.kind === 'resize' && <Field label="缩放方式"><select aria-label={`操作 ${index + 1} fit`} disabled={disabled} value={op.fit} onChange={e => edit(index, { fit: e.target.value })}><option value="contain">等比缩放并留边</option><option value="stretch">拉伸至指定宽高</option></select></Field>}
        {op.kind === 'crop' && <p className="muted tiny">起点以当步图像左上角为原点，完整裁剪区域必须位于图内。</p>}{op.kind === 'tile' && <p className="muted tiny">切片宽高不得超过当步图像；水平、垂直重叠量分别小于切片宽高。</p>}
      </div>}</section>)}</div>
    <div className="transform-add-operation"><select aria-label="新增图像操作" disabled={disabled || operations.length >= 30} value={adding} onChange={e => setAdding(e.target.value as TransformOperation['kind'])}><option value="crop">裁剪</option><option value="resize">缩放</option><option value="tile" disabled={hasTile}>切片{hasTile ? '（已添加）' : ''}</option></select><Button disabled={disabled || operations.length >= 30 || (adding === 'tile' && hasTile)} onClick={add}><Plus size={13}/>添加操作</Button></div><small className="muted">{operations.length} / 30 个操作 · 最多一次切片</small>
    <details className="transform-background"><summary>留边背景色</summary><Field label="背景色（可选）"><input aria-label="图像处理背景色" disabled={disabled} maxLength={7} value={String(value.background ?? '')} placeholder="引擎默认" onChange={e => onChange('background', e.target.value || undefined)}/></Field></details>
    {issues.length > 0 && <div className="transform-parameter-issues" role="status"><strong>参数待完善</strong>{issues.map(message => <p key={message}>{message}</p>)}</div>}
  </div>;
}
