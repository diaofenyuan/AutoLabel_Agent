import { useEffect, useState } from 'react';
import { Save, Trash2, Copy } from 'lucide-react';
import { Button, Field, Loading, Notice } from './ui';
import { request, isDemo, errorMessage } from './bridge';
import type { TaskType } from './types';

/** 与引擎 ExportFormats 保持一致的格式规范；界面只阻止明显无效的选择，最终校验仍在引擎。 */
export interface ExportFormatSpec {
  labelFormat: 'yolo' | 'coco' | 'voc' | 'csv';
  precision: number;
  naming: 'assetId' | 'original';
  layout: { image: string; classifyImage: string; label: string; index: string };
  includeDataYaml: boolean;
  cocoFileName: string;
  csvBom: boolean;
  csvColumns: string[];
  // 引擎解析后的规范会带上来源元数据；编辑草稿不设置这些字段。
  id?: string; name?: string; version?: number; source?: string;
}
/** 定义与规范同为扁平结构，元数据与格式字段在同一层。 */
export interface ExportFormatDefinition extends ExportFormatSpec {
  id: string; version: number; name: string; category?: string; note?: string;
  taskType: TaskType | null; builtin?: boolean; source: string;
}
export interface ExportFormatSelection { formatId?: string; formatVersion?: number; format?: ExportFormatSpec }

const formatNames: Record<string, string> = { yolo: 'YOLO 文本标签', coco: 'COCO JSON', voc: 'Pascal VOC XML', csv: '平铺 CSV 索引' };
const formatSupport: Record<string, TaskType[]> = {
  yolo: ['detect', 'obb', 'segment', 'pose', 'classify'],
  coco: ['detect', 'segment', 'pose'],
  voc: ['detect'],
  csv: ['detect', 'obb', 'segment', 'pose', 'classify'],
};
const allColumns = ['split', 'assetId', 'name', 'image', 'width', 'height', 'classId', 'className',
  'cx', 'cy', 'w', 'h', 'xmin', 'ymin', 'xmax', 'ymax', 'rotation', 'points', 'keypoints', 'visibility', 'attributes', 'status', 'source', 'group'];
const classifyColumns = ['split', 'assetId', 'name', 'image', 'width', 'height', 'classId', 'className', 'status', 'source', 'group'];
const placeholderHint = '可用占位符：{split} 训练/验证划分，{name} 文件名，{assetId} 素材标识，{index} 顺序号；分类任务额外可用 {classId4} {className}';

/** 该任务类型下各格式的默认布局，与引擎内置预设一致，切换格式时直接给出可用起点。 */
function defaultSpec(labelFormat: ExportFormatSpec['labelFormat'], taskType: TaskType): ExportFormatSpec {
  const classify = taskType === 'classify';
  const spec: ExportFormatSpec = {
    labelFormat, precision: 8, naming: 'assetId', includeDataYaml: !classify, cocoFileName: '{name}.png', csvBom: true,
    csvColumns: labelFormat === 'csv' ? (classify ? classifyColumns : allColumns) : [],
    layout: { image: 'images/{split}/{name}.png', classifyImage: '{split}/{classId4}/{name}.png', label: 'labels/{split}/{name}.txt', index: '' },
  };
  if (labelFormat === 'coco') spec.layout.index = 'annotations/instances_{split}.json';
  if (labelFormat === 'voc') { spec.layout.label = 'annotations/{name}.xml'; spec.layout.index = 'ImageSets/{split}.txt'; }
  if (labelFormat === 'csv') spec.layout.index = 'annotations.csv';
  if (labelFormat === 'yolo' && classify) spec.layout.label = '';
  if (labelFormat === 'coco' || labelFormat === 'csv') spec.layout.label = '';
  return spec;
}
/** 只保留规范字段，避免把 id/name/version 等元数据发给接受内联规范的命令。 */
export function exportFormatSpec(source: ExportFormatSpec): ExportFormatSpec {
  return { labelFormat: source.labelFormat, precision: source.precision, naming: source.naming,
    layout: { image: source.layout.image ?? '', classifyImage: source.layout.classifyImage ?? '',
      label: source.layout.label ?? '', index: source.layout.index ?? '' },
    includeDataYaml: source.includeDataYaml, cocoFileName: source.cocoFileName, csvBom: source.csvBom,
    csvColumns: [...source.csvColumns] };
}

export default function ExportFormatPicker({ taskType, disabled, selection, onChange }: {
  taskType: TaskType; disabled: boolean; selection: ExportFormatSelection; onChange: (selection: ExportFormatSelection) => void;
}) {
  const [definitions, setDefinitions] = useState<ExportFormatDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ExportFormatSpec | null>(null);
  const [editing, setEditing] = useState<{ id: string; version: number } | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [busy, setBusy] = useState(false);
  const usable = Object.keys(formatSupport).filter(format => formatSupport[format].includes(taskType));
  const selectedId = selection.format ? 'custom' : selection.formatId ?? '';
  const resolved = definitions.find(item => item.id === selectedId);
  const classify = taskType === 'classify';

  useEffect(() => {
    let active = true; setLoading(true); setError('');
    request<ExportFormatDefinition[]>('export.format.list', { taskType }).then(items => {
      if (!active) return;
      setDefinitions(items);
      // 未指定格式时按内置 YOLO 默认布局回填，界面与引擎的实际默认保持一致。
      if (!selection.format && !selection.formatId) {
        const fallback = items.find(item => item.id === 'builtin:yolo') ?? items[0];
        if (fallback) onChange({ formatId: fallback.id, formatVersion: fallback.version });
      }
    }).catch(e => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // 只随任务类型重新读取；当前选择不参与依赖，避免编辑过程中被回读覆盖。
  }, [taskType]);

  function choose(value: string) {
    setError('');
    if (value === 'custom') {
      const spec = draft ?? (resolved ? exportFormatSpec(resolved) : defaultSpec((usable[0] ?? 'yolo') as ExportFormatSpec['labelFormat'], taskType));
      setDraft(spec); setEditing(null); setTemplateName('');
      onChange({ format: spec });
      return;
    }
    setDraft(null); setEditing(null); setTemplateName('');
    const definition = definitions.find(item => item.id === value);
    onChange(definition ? { formatId: definition.id, formatVersion: definition.version } : {});
  }

  function fork() {
    if (!resolved) return;
    const spec = exportFormatSpec(resolved);
    setDraft(spec); setEditing(null); setTemplateName(resolved.builtin ? '' : resolved.name);
    onChange({ format: spec });
  }

  /** 编辑已保存模板：保留标识与版本，保存时作为新版本提交。 */
  function edit() {
    if (!resolved) return;
    const spec = exportFormatSpec(resolved);
    setDraft(spec); setEditing({ id: resolved.id, version: resolved.version }); setTemplateName(resolved.name);
    onChange({ format: spec });
  }

  function update(patch: Partial<ExportFormatSpec>) {
    if (!draft) return;
    const next: ExportFormatSpec = { ...draft, ...patch, layout: { ...draft.layout, ...(patch.layout ?? {}) } };
    setDraft(next); onChange({ format: next });
  }

  function switchFormat(labelFormat: ExportFormatSpec['labelFormat']) {
    if (!draft) return;
    // 保留用户已写的命名方式与精度，只替换该格式强制的目录与标签约定。
    const next: ExportFormatSpec = { ...defaultSpec(labelFormat, taskType), precision: draft.precision, naming: draft.naming };
    setDraft(next); onChange({ format: next });
  }

  async function saveTemplate() {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const name = templateName.trim();
      if (!name) throw new Error('请先填写模板名称。');
      const saved = await request<ExportFormatDefinition>('export.format.save', {
        taskType, name, ...(editing ? { id: editing.id, baseVersion: editing.version } : {}), ...exportFormatSpec(draft),
      });
      setDefinitions(items => [saved, ...items.filter(item => item.id !== saved.id)]);
      setEditing({ id: saved.id, version: saved.version }); setTemplateName(saved.name);
      setDraft(null); onChange({ formatId: saved.id, formatVersion: saved.version });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  async function removeTemplate() {
    if (!editing) return;
    setBusy(true); setError('');
    try {
      await request('export.format.delete', { formatId: editing.id, baseVersion: editing.version });
      const fallback = definitions.find(item => item.builtin);
      setDefinitions(items => items.filter(item => item.id !== editing.id));
      setEditing(null); setDraft(null); setTemplateName('');
      onChange(fallback ? { formatId: fallback.id, formatVersion: fallback.version } : {});
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  if (isDemo) return <Notice>浏览器演示只下载内部 JSON，导出格式与目录布局由桌面引擎实际执行。</Notice>;
  if (loading) return <Loading compact label="正在读取导出格式…" />;
  return <section className="operation-section">
    <div className="section-toolbar"><h3>导出格式</h3>{resolved && !resolved.builtin && <Button disabled={disabled || busy} onClick={edit}><Copy size={13} />编辑此模板</Button>}</div>
    <Field label="格式与布局" hint={resolved && !resolved.builtin ? undefined : '内置预设可直接使用；需要自定义目录或标签结构时选择「自定义布局」。'}>
      <select disabled={disabled || busy} value={selectedId} onChange={e => choose(e.target.value)}>
        {usable.map(format => <option key={format} value={`builtin:${format}`}>{formatNames[format]} · 默认布局</option>)}
        {definitions.filter(item => !item.builtin).map(item => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}
        <option value="custom">自定义布局…</option>
      </select>
    </Field>
    {resolved && !draft && <p className="muted">{resolved.note || resolved.name}{resolved.builtin ? '' : ` · 保存于 ${resolved.version} 版`}</p>}
    {resolved && !draft && <p className="muted break-word">{describe(resolved, classify)}</p>}
    {resolved && !draft && <Button disabled={disabled || busy} onClick={fork}>复制为自定义布局</Button>}
    {draft && <>
      <Notice>导出图片不做转码，因此图片路径必须以 .png 结尾；标签与索引的扩展名由标签格式决定。清单会记录本次生效的完整格式，历史副本的复现不依赖该模板是否仍然存在。</Notice>
      <div className="field-grid">
        <Field label="标签格式"><select disabled={disabled || busy} value={draft.labelFormat} onChange={e => switchFormat(e.target.value as ExportFormatSpec['labelFormat'])}>
          {usable.map(format => <option key={format} value={format}>{formatNames[format]}</option>)}
        </select></Field>
        <Field label="数值精度"><input type="number" min={1} max={8} step={1} disabled={disabled || busy} value={draft.precision} onChange={e => update({ precision: Number(e.target.value) })} /></Field>
      </div>
      <Field label="文件命名" hint="使用素材原始文件名时，重名会按素材顺序追加序号，路径保持可预测。">
        <select disabled={disabled || busy} value={draft.naming} onChange={e => update({ naming: e.target.value as ExportFormatSpec['naming'] })}>
          <option value="assetId">素材标识</option>
          <option value="original">原始文件名</option>
        </select>
      </Field>
      <Field label={classify ? '分类图片路径' : '图片路径'} hint={placeholderHint}>
        <input disabled={disabled || busy} value={classify ? draft.layout.classifyImage : draft.layout.image}
          onChange={e => update({ layout: classify ? { ...draft.layout, classifyImage: e.target.value } : { ...draft.layout, image: e.target.value } })} />
      </Field>
      {!classify && (draft.labelFormat === 'yolo' || draft.labelFormat === 'voc') &&
        <Field label="标签路径" hint={placeholderHint}><input disabled={disabled || busy} value={draft.layout.label} onChange={e => update({ layout: { ...draft.layout, label: e.target.value } })} /></Field>}
      {(draft.labelFormat === 'coco' || draft.labelFormat === 'csv' || draft.labelFormat === 'voc' || draft.layout.index) &&
        <Field label="索引文件路径" hint={`${placeholderHint}；包含 {split} 时每个划分各生成一份。`}>
          <input disabled={disabled || busy} value={draft.layout.index} onChange={e => update({ layout: { ...draft.layout, index: e.target.value } })} />
        </Field>}
      {draft.labelFormat === 'coco' &&
        <Field label="COCO file_name" hint="写入 JSON 的图片引用，默认是相对划分图片目录的图片名。">
          <input disabled={disabled || busy} value={draft.cocoFileName} onChange={e => update({ cocoFileName: e.target.value })} /></Field>}
      {draft.labelFormat === 'yolo' && !classify && <label className="checkbox-row">
        <input type="checkbox" disabled={disabled || busy} checked={draft.includeDataYaml} onChange={e => update({ includeDataYaml: e.target.checked })} />生成 data.yaml</label>}
      {draft.labelFormat === 'csv' && <>
        <label className="checkbox-row"><input type="checkbox" disabled={disabled || busy} checked={draft.csvBom} onChange={e => update({ csvBom: e.target.checked })} />写入 UTF-8 BOM（用 Excel 打开不乱码）</label>
        <Field label="CSV 列"><div className="field-grid">{(classify ? classifyColumns : allColumns).map(column => <label className="checkbox-row" key={column}>
          <input type="checkbox" disabled={disabled || busy} checked={draft.csvColumns.includes(column)}
            onChange={e => update({ csvColumns: e.target.checked ? [...draft.csvColumns, column] : draft.csvColumns.filter(value => value !== column) })} />{column}</label>)}</div></Field>
      </>}
      <Field label="模板名称" hint="留空只用于本次导出；填写后可保存为可复用格式。">
        <input disabled={disabled || busy} value={templateName} placeholder="例如：检测数据集 · COCO 单文件" onChange={e => setTemplateName(e.target.value)} />
      </Field>
      <div className="section-toolbar">
        <Button className="primary" disabled={disabled || !templateName.trim()} busy={busy} onClick={() => void saveTemplate()}><Save size={14} />{editing ? '保存新版本' : '保存为模板'}</Button>
        {editing && <Button disabled={disabled || busy} onClick={() => void removeTemplate()}><Trash2 size={14} />删除模板</Button>}
      </div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

function describe(format: ExportFormatSpec, classify: boolean): string {
  const parts = [`标签格式 ${formatNames[format.labelFormat]}`];
  parts.push(classify ? `分类图片 ${format.layout.classifyImage}` : `图片 ${format.layout.image}`);
  if (!classify && format.layout.label) parts.push(`标签 ${format.layout.label}`);
  if (format.layout.index) parts.push(`索引 ${format.layout.index}`);
  parts.push(`命名 ${format.naming === 'assetId' ? '素材标识' : '原始文件名'}`);
  return parts.join(' · ');
}
