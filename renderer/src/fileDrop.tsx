import { useState, type DragEvent } from 'react';
import { getBridge } from './bridge';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'];
const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'ts'];

export interface DroppedFiles { images: string[]; videos: string[]; others: string[] }

function extensionOf(name: string): string { return name.split('.').pop()?.toLowerCase() ?? ''; }

/**
 * 把拖入的文件按类型分开。路径由 preload 解析：渲染进程拿不到磁盘路径，
 * 浏览器演示里没有这个能力，所以未解析到路径的文件一律归到「其它」，由调用方如实提示。
 */
export async function classifyDrop(files: File[]): Promise<DroppedFiles> {
  const bridge = await getBridge();
  const paths: string[] = [];
  const others: string[] = [];
  for (const file of files) {
    const path = bridge.pathForFile?.(file) ?? '';
    if (path) paths.push(path); else others.push(file.name);
  }
  // 授权由主进程按扩展名判定：拖入和文件选择器一样是用户动作，但类型不能被渲染层说了算。
  const approved = bridge.grantDroppedFiles ? await bridge.grantDroppedFiles(paths) : { granted: paths, rejected: [] };
  const result: DroppedFiles = { images: [], videos: [], others: [...others, ...approved.rejected] };
  for (const path of approved.granted) {
    const extension = extensionOf(path);
    if (IMAGE_EXTENSIONS.includes(extension)) result.images.push(path);
    else if (VIDEO_EXTENSIONS.includes(extension)) result.videos.push(path);
    else result.others.push(path.split(/[\\/]/).pop() ?? path);
  }
  return result;
}

/**
 * 拖放区：把图片、视频等文件直接拖进对话。
 * 用进出计数判断悬浮态，避免拖过子元素时反复闪烁。
 */
export function useFileDrop(onFiles: (files: DroppedFiles) => void | Promise<void>) {
  const [active, setActive] = useState(false);
  const [, setDepth] = useState(0);
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  return {
    active,
    handlers: {
      onDragEnter: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); setDepth(value => { const next = value + 1; if (next === 1) setActive(true); return next; }); },
      onDragOver: (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); },
      onDragLeave: (event: DragEvent) => { if (!hasFiles(event)) return; setDepth(value => { const next = Math.max(0, value - 1); if (next === 0) setActive(false); return next; }); },
      onDrop: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); setDepth(0); setActive(false); void classifyDrop([...(event.dataTransfer?.files ?? [])]).then(onFiles); },
    },
  };
}

/** 覆盖在对话区上的拖放提示，只在拖入文件时出现。 */
export function DropOverlay({ visible }: { visible: boolean }) {
  return <div className={`drop-overlay ${visible ? 'active' : ''}`} aria-hidden={!visible}><div className="drop-hint">松开鼠标，把文件放进这个项目</div></div>;
}
