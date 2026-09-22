import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Star } from 'lucide-react';
import type { Provider } from './types';
import { thinkingDepthNames, type ThinkingDepth } from './types';
import { isDemo } from './bridge';

/**
 * 模型与思考深度选择器：收起时只有一行小字（模型 · 深度），点开才出现搜索框、模型列表与档位。
 * 「常用」标记只影响这里的排序，存在本机；它不改变接口配置，也不代表服务商侧的任何状态。
 */
const FAVORITES_KEY = 'autolabel.modelFavorites';
const DEPTHS: ThinkingDepth[] = ['fast', 'standard', 'deep'];

function readFavorites(): string[] {
  try { const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]'); return Array.isArray(raw) ? raw.filter(item => typeof item === 'string') : []; }
  catch { return []; }
}
export interface ModelChoice { providerId: string; model: string; key: string }
export function modelOptions(providers: Provider[], current?: { providerId?: string; model?: string }): ModelChoice[] {
  const options: ModelChoice[] = [], seen = new Set<string>();
  const add = (providerId?: string, model?: string) => {
    if (!providerId || !model) return;
    const key = `${providerId}|${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ key, providerId, model });
  };
  // 已保存凭据的接口在前；每个接口展开「获取模型列表」登记下来的全部候选模型。
  // 只列 provider.model 的话，能扫描到 20 个模型的接口在下拉里也只显示 1 个。
  // 未配置密钥的接口不再整组跳过：登记过的候选照样列出（行内带「未配置密钥」标记），
  // 否则凭据未注入引擎时（如引擎重启前）用户会误以为扫描结果丢了。
  for (const provider of providers) {
    if (!provider.hasCredential && !provider.models?.length && !provider.model) continue;
    add(provider.id, provider.model);
    for (const name of provider.models ?? []) add(provider.id, name);
  }
  // 当前选择一定在列表里，避免接口已删或凭据未保存时下拉把已选模型吃掉。
  add(current?.providerId, current?.model);
  return options;
}

export default function ModelPicker({ providers, providerId, model, depth, disabled, onChange, onDepthChange, onConfigure }: {
  providers: Provider[]; providerId?: string; model?: string; depth: ThinkingDepth; disabled?: boolean;
  onChange: (choice: { providerId: string; model: string }) => void;
  onDepthChange: (depth: ThinkingDepth) => void;
  onConfigure: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(readFavorites);
  const root = useRef<HTMLDivElement>(null);
  const options = useMemo(() => modelOptions(providers, { providerId, model }), [providers, providerId, model]);
  const nameOf = (item: ModelChoice) => `${providers.find(provider => provider.id === item.providerId)?.name ?? item.providerId} · ${item.model}`;
  const providerOf = (id: string) => providers.find(provider => provider.id === id);
  const [showAllModels, setShowAllModels] = useState(false);
  const matched = options
    .filter(item => !query.trim() || nameOf(item).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(favorites.includes(b.key)) - Number(favorites.includes(a.key)));
  // 列表默认收敛：接口模型一多，整层弹出就被列表占满——先给前 8 个，其余「还有 N 个 · 全部」再展开。
  const visible = showAllModels ? matched : matched.slice(0, 8);
  const current = options.find(item => item.providerId === providerId && item.model === model);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  function toggleFavorite(key: string) {
    setFavorites(current => {
      const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key];
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch { /* 存不下只影响下次打开的顺序 */ }
      return next;
    });
  }
  const label = model ? `${model} · ${thinkingDepthNames[depth]}` : '选择模型';

  return <div className="model-picker" ref={root}>
    <button type="button" className="model-picker-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="truncate">{label}</span><ChevronDown size={13} />
    </button>
    {open && <div className="picker-popover" role="dialog" aria-label="选择模型与思考深度">
      <label className="picker-search"><Search size={15} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型" /></label>
      <div className="picker-list">{visible.map(item => <div key={item.key} className={`picker-row ${current?.key === item.key ? 'selected' : ''}`}>
        <button type="button" className="picker-choose" disabled={disabled} onClick={() => onChange(item)}>
          <span className="picker-name truncate">{item.model}</span>
          <small className="truncate">{providerOf(item.providerId)?.name ?? item.providerId}{providerOf(item.providerId)?.hasCredential === false && ' · 未配置密钥'}</small>
          {current?.key === item.key && <Check size={15} />}
        </button>
        <button type="button" className={`picker-star ${favorites.includes(item.key) ? 'on' : ''}`} aria-pressed={favorites.includes(item.key)}
          aria-label={favorites.includes(item.key) ? `取消常用 ${item.model}` : `标为常用 ${item.model}`} onClick={() => toggleFavorite(item.key)}><Star size={15} /></button>
      </div>)}{matched.length > 8 && !showAllModels && <button type="button" className="local-model-more" onClick={() => setShowAllModels(true)}>还有 {matched.length - 8} 个 · 全部</button>}{!visible.length && <p className="quiet-empty">{providers.length ? '没有匹配的模型。' : '还没有配置接口。'}</p>}</div>
      {/* 档位跟随当前模型：服务商没有统一定义 reasoning，档位改的是助手自身的投入。 */}
      <div className="picker-effort">
        <p className="muted tiny">思考深度 · {model ?? '未选择模型'}</p>
        <div className="picker-effort-options">{DEPTHS.map(item => <button key={item} type="button" disabled={disabled}
          className={depth === item ? 'selected' : ''} aria-pressed={depth === item}
          onClick={() => { onDepthChange(item); setOpen(false); }}>{thinkingDepthNames[item]}</button>)}</div>
      </div>
      <div className="picker-foot">
        <span className="muted tiny">{isDemo ? '浏览器演示不调用模型' : '模型与密钥在设置里配置；这里只选择本次对话用哪一个'}</span>
        <button type="button" className="text-button" onClick={() => { setOpen(false); onConfigure(); }}>配置</button>
      </div>
    </div>}
  </div>;
}
