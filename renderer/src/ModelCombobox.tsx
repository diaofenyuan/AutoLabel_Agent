import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

/**
 * 设置页的模型组合框：输入框 + 自定义下拉候选。
 * 不用原生 datalist——它按输入框当前值过滤候选，填了模型名后 21 个候选只剩 1 个可见；
 * 这里的候选列表始终完整展示（可搜索），也保留手输清单里没有的模型名的能力。
 */
export default function ModelCombobox({ value, onChange, options, placeholder, disabled }: {
  value: string; onChange: (value: string) => void; options: string[]; placeholder?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [up, setUp] = useState(false);
  const [focusSearch, setFocusSearch] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = keyword ? options.filter(name => name.toLowerCase().includes(keyword)) : options;
    return list.slice(0, 300);
  }, [options, query]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  // 弹层默认向下展开；下方放不下且上方更高（如页面底部的字段）时改向上，避免撑出整页滚动。
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setUp(below < 340 && rect.top > below);
  }, [open]);
  function pick(name: string) { onChange(name); setOpen(false); setQuery(''); }
  return <div className="combo" ref={root}>
    <div className="combo-input">
      <input aria-label="模型名称" value={value} disabled={disabled} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => { setOpen(true); setFocusSearch(false); }}/>
      <button type="button" ref={trigger} className="combo-toggle" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
        aria-label="展开模型候选" onClick={() => { setOpen(v => !v); setFocusSearch(true); }}><ChevronDown size={14}/></button>
    </div>
    {open && <div className={`picker-popover combo-popover ${up ? 'up' : 'down'}`} role="dialog" aria-label="选择模型">
      <label className="picker-search"><Search size={15}/><input autoFocus={focusSearch} value={query} onChange={e => setQuery(e.target.value)}
        placeholder="搜索模型" onKeyDown={e => { if (e.key !== 'Enter') return; e.preventDefault(); const keyword = query.trim(); if (!keyword) return;
          const exact = options.find(name => name.toLowerCase() === keyword.toLowerCase()); pick(exact ?? keyword); }}/></label>
      <div className="picker-list">
        {visible.map(name => <div key={name} className={`picker-row ${value === name ? 'selected' : ''}`}>
          <button type="button" className="picker-choose" disabled={disabled} onClick={() => pick(name)}>
            <span className="picker-name truncate">{name}</span>
            {value === name && <Check size={15}/>}
          </button>
        </div>)}
        {query.trim() && !options.some(name => name.toLowerCase() === query.trim().toLowerCase()) && <div className="picker-row">
          <button type="button" className="picker-choose" disabled={disabled} onClick={() => pick(query.trim())}>
            <span className="picker-name truncate">使用「{query.trim()}」</span>
          </button>
        </div>}
        {!visible.length && !(query.trim() && !options.some(name => name.toLowerCase() === query.trim().toLowerCase())) &&
          <p className="quiet-empty">{options.length ? '没有匹配的模型。' : '该接口还没有登记模型，可手输名称或点「获取模型列表」。'}</p>}
      </div>
    </div>}
  </div>;
}
