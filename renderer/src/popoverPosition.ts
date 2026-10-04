import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * 工具行弹层的视口内定位。
 *
 * 输入卡里的弹层常嵌在另一个滚动弹层（处理范围弹层）里：绝对定位会被滚动容器裁剪，
 * 顶部方向的溢出还滚不回来，弹层大半内容永远看不见；靠右的触发器还会把弹层顶出窗口右缘。
 * 这里按触发器的视口位置算出 fixed 定位：横向夹在视口内，竖向哪边空间大往哪边开，
 * 剩余空间放不下整份内容时压住高度，超出部分走弹层内部滚动。
 *
 * width 是弹层的目标宽度，space 是弹层完整内容的估算高度，只用于决定展开方向。
 * 弹层开着的时候跟随窗口缩放与任何滚动容器（捕获阶段监听）重新计算，
 * 否则触发器滚走后弹层会留在旧的坐标上。
 */
const STYLE_KEYS = ['position', 'left', 'width', 'top', 'bottom', 'maxHeight'] as const;

function sameStyle(a: CSSProperties, b: CSSProperties): boolean {
  return STYLE_KEYS.every(key => a[key] === b[key]);
}

export function usePopoverPosition(open: boolean, width: number, space: number): { triggerRef: RefObject<HTMLButtonElement | null>; style: CSSProperties } {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = Math.min(width, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - w - 12));
      const below = window.innerHeight - rect.bottom;
      const openDown = below >= space || below >= rect.top;
      // 高度只压到实际可用的空间：下限挡住退化布局，同时保证弹层不会越过视口对侧。
      const next: CSSProperties = openDown
        ? { position: 'fixed', left, width: w, top: rect.bottom + 6, bottom: 'auto', maxHeight: Math.max(120, below - 12) }
        : { position: 'fixed', left, width: w, top: 'auto', bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(120, rect.top - 12) };
      // 滚动事件高频（弹层自身内滚也会冒进来）：值没变就不触发渲染。
      setStyle(prev => sameStyle(prev, next) ? prev : next);
    };
    compute();
    window.addEventListener('resize', compute);
    document.addEventListener('scroll', compute, true);
    return () => { window.removeEventListener('resize', compute); document.removeEventListener('scroll', compute, true); };
  }, [open, width, space]);
  return { triggerRef, style };
}
