/**
 * 画布对象标签（类别色底板 + 名称文字）共用的配色与测宽：
 * 可编辑画布（QualityCanvas）与只读预览（ResultViewer）必须呈现一致。
 */

/** 标签底色用类别色；浅色底配深字、深色底配白字，任何类别色下都读得清。非 6 位 hex（防御）时退回白字。 */
export function chipTextColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  return ((n >> 16 & 255) * .299 + (n >> 8 & 255) * .587 + (n & 255) * .114) > 168 ? '#1d1f22' : '#fff';
}

/** 中文/全角字符按全宽、其余按 0.66 宽估算文本像素宽，标签底板据此定宽，混合语言的长名也不会截断。 */
export function chipTextWidth(name: string, fontSize: number): number {
  return [...name].reduce((n, ch) => n + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : .66), 0) * fontSize;
}
