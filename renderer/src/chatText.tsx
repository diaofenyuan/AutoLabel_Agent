import type { ReactNode } from 'react';

/**
 * 助手回复的最小 Markdown 渲染。
 *
 * 助手回答里本来就在用 **加粗**、`代码`、无序/有序列表与换行分段；此前一律按纯文本渲染，
 * 用户在气泡里看到的是 `**任务**：自动标注 · glm-5.3-flash` 这种带符号的裸文本——
 * 走查把它记成了「未渲染的 Markdown 裸文本」。
 *
 * 只支持确实会出现的几种语法，不引入完整 Markdown 解析器：宁可少渲染几种，
 * 也不要把「结构化展示」变成新的一层注入面。因此：
 * 1. 只把文本转成 React 节点，全程不使用 innerHTML，链接也不解析成 <a>；
 * 2. 未识别的内容按原文输出，不会吞掉用户的字符。
 */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).filter(part => part !== '').map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>;
    return <span key={key}>{part}</span>;
  });
}

interface Line { kind: 'paragraph' | 'bullet' | 'ordered' | 'heading'; text: string }

function classify(raw: string): Line {
  const text = raw.trimEnd();
  if (/^\s{0,3}#{1,4}\s+/.test(text)) return { kind: 'heading', text: text.replace(/^\s{0,3}#{1,4}\s+/, '') };
  if (/^\s*[-*·]\s+/.test(text)) return { kind: 'bullet', text: text.replace(/^\s*[-*·]\s+/, '') };
  if (/^\s*\d+[.)]\s+/.test(text)) return { kind: 'ordered', text: text.replace(/^\s*\d+[.)]\s+/, '') };
  return { kind: 'paragraph', text };
}

export function RichText({ text }: { text: string }) {
  const lines = (text ?? '').split('\n');
  const blocks: ReactNode[] = [];
  let list: { kind: 'bullet' | 'ordered'; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item, `li-${blocks.length}-${index}`)}</li>);
    blocks.push(list.kind === 'bullet' ? <ul key={`ul-${blocks.length}`}>{items}</ul> : <ol key={`ol-${blocks.length}`}>{items}</ol>);
    list = null;
  };
  lines.forEach((raw, index) => {
    if (!raw.trim()) { flush(); return; }
    const line = classify(raw);
    if (line.kind === 'bullet' || line.kind === 'ordered') {
      // 列表项之间夹着空行或换行都算同一个列表，避免每一行都单独成块。
      if (list && list.kind !== line.kind) flush();
      list ??= { kind: line.kind, items: [] };
      list.items.push(line.text);
      return;
    }
    flush();
    if (line.kind === 'heading') blocks.push(<p className="chat-subheading" key={`h-${index}`}>{inline(line.text, `h-${index}`)}</p>);
    else blocks.push(<p key={`p-${index}`}>{inline(line.text, `p-${index}`)}</p>);
  });
  flush();
  return <>{blocks}</>;
}
