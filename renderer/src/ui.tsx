import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle, X, Search, ArrowUp, Square, Info, Image as ImageIcon, Film, Folder } from 'lucide-react';
import type { ChatAttachment } from './context';

export function Button({ children, className = '', busy, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button className={`button ${className}`} {...props} disabled={props.disabled || busy}>{busy && <LoaderCircle className="spin" size={15} />}{children}</button>;
}
export function IconButton({ label, children, active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <button className={`icon-button ${active ? 'active' : ''} ${props.className ?? ''}`} {...props} aria-label={label} title={label} aria-pressed={active}>{children}</button>;
}
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="actions">{actions}</div></div>;
}
export function Modal({ title, children, onClose, drawer = false, wide = false }: { title: string; children: ReactNode; onClose: () => void; drawer?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`modal ${drawer ? 'drawer' : ''} ${wide ? 'quality-modal' : ''}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-inner"><header><h2>{title}</h2><IconButton label="关闭弹窗" onClick={onClose}><X size={18} /></IconButton></header>{children}</div>
  </dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <label className="search-field"><Search size={15} /><input aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /></label>;
}
export function Empty({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="empty empty-state"><div className="empty-orbit" aria-hidden="true"><div className="empty-icon">{icon}</div><span className="empty-orbit-ring" /></div><h2>{title}</h2><p>{description}</p>{children && <div className="empty-actions">{children}</div>}</div>;
}
export function Loading({ label = '正在读取…', compact = false }: { label?: string; compact?: boolean }) {
  return <div className={`inline-loading ${compact ? 'compact' : ''}`} role="status" aria-live="polite"><LoaderCircle className="spin" size={compact ? 14 : 17} /><span>{label}</span></div>;
}
export function Notice({ children }: { children: ReactNode }) { return <div className="notice"><Info size={16} /><div>{children}</div></div>; }
export function Composer({ value, onChange, onSend, placeholder, busy, onCancel, children, attachments, onRemoveAttachment }: { value: string; onChange: (v: string) => void; onSend: () => void; placeholder: string; busy?: boolean; onCancel?: () => void; children?: ReactNode; attachments?: ChatAttachment[]; onRemoveAttachment?: (id: string) => void }) {
  const hasAttachments = Boolean(attachments?.length);
  const iconOf = (kind: ChatAttachment['kind']) => kind === 'image' ? <ImageIcon size={12} /> : kind === 'video' ? <Film size={12} /> : <Folder size={12} />;
  return <div className="composer">
    {/* 拖进来的文件先挂在这里，发送时才入库并确定项目归属；单枚可移除。 */}
    {hasAttachments && <div className="composer-attachments">{attachments!.map(item => <span className="attachment-chip" key={item.id} title={item.path}>
      {iconOf(item.kind)}<span className="truncate">{item.name}</span>
      {onRemoveAttachment && <button aria-label={`移除 ${item.name}`} onClick={() => onRemoveAttachment(item.id)}><X size={12} /></button>}
    </span>)}</div>}
    <textarea aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) { e.preventDefault(); onSend(); } }} />
    {/* 工具行收进卡片内：流程/模型/范围在左，快捷键提示与发送钮在右，不再散落在框外。 */}
    <div className="composer-toolbar">
      <div className="composer-tools">{children}</div>
      <kbd className="composer-kbd">Ctrl + Enter</kbd>
      <button className="send-button" aria-label={busy ? '停止对话' : '发送'} disabled={!busy && !value.trim() && !hasAttachments} onClick={busy ? onCancel : onSend}>{busy ? <Square size={13} /> : <ArrowUp size={17} />}</button>
    </div>
  </div>;
}
