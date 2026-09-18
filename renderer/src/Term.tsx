import type { ReactNode } from 'react';
import { explain, glossary, type GlossaryKey } from './glossary';

/**
 * 行内术语：正文里第一次出现时挂上它，鼠标停一下就有解释。
 * 不写成点击弹窗——读一句话不该被打断，也不该多一次跳转。
 */
export function Term({ name, children }: { name: GlossaryKey; children?: ReactNode }) {
  return <span className="term" title={explain(name)}>{children ?? glossary[name].term}</span>;
}
