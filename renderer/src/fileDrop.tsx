import { useState, type DragEvent } from 'react';
import { getBridge } from './bridge';
import { IMAGE_EXTENSION_LABEL, VIDEO_EXTENSION_LABEL, isImagePath, isVideoPath } from '../../shared/mediaFormats';
import { emptyDroppedFiles, type DropRejection, type DroppedFiles } from './dropMessages';

// 拒绝原因与提示文案放在无依赖的 dropMessages：纯函数才好在测试里直接断言，
// 而这个模块要引 React。类型与文案对调用方仍从这里取，保持既有导入路径不变。
export { dropRejectionNotice, type DropRejection, type DroppedFiles } from './dropMessages';

/**
 * 把拖入的文件按类型分开。路径由 preload 解析：渲染进程拿不到磁盘路径，
 * 浏览器演示里没有这个能力，所以未解析到路径的文件一律归到「unresolved」，由调用方如实提示。
 *
 * 分类用 shared/mediaFormats 的同一份常量：渲染层若自持一份，就会出现
 * 「主进程放行了、界面却归到其它」这种两边都觉得自己没错的错位。
 */
export async function classifyDrop(files: File[]): Promise<DroppedFiles> {
  const bridge = await getBridge();
  const paths: string[] = [];
  const unresolved: string[] = [];
  for (const file of files) {
    const path = bridge.pathForFile?.(file) ?? '';
    if (path) paths.push(path); else unresolved.push(file.name);
  }
  // 授权由主进程按扩展名判定：拖入和文件选择器一样是用户动作，但类型不能被渲染层说了算。
  const approved = bridge.grantDroppedFiles ? await bridge.grantDroppedFiles(paths)
    : { granted: paths, rejected: [] as DropRejection[], overLimit: undefined };
  const result: DroppedFiles = { ...emptyDroppedFiles, unresolved, rejected: [...approved.rejected], overLimit: approved.overLimit ?? null };
  for (const path of approved.granted) {
    if (isImagePath(path)) result.images.push(path);
    else if (isVideoPath(path)) result.videos.push(path);
    else result.directories.push(path);
  }
  return result;
}

/** 可拖入的扩展名清单：拖放提示与拒绝原因共用，改一处就够。 */
export const droppableExtensions = { imagesLabel: IMAGE_EXTENSION_LABEL, videoLabel: VIDEO_EXTENSION_LABEL };

/**
 * 拖放区：把图片、视频与文件夹直接拖进对话。
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
  return <div className={`drop-overlay ${visible ? 'active' : ''}`} aria-hidden={!visible}><div className="drop-hint">松开鼠标，把文件或文件夹放进这个项目</div></div>;
}
