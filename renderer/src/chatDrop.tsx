import { useState } from 'react';
import { useApp } from './context';
import { request, errorMessage } from './bridge';
import { useFileDrop, type DroppedFiles } from './fileDrop';
import type { Project } from './types';

/** 拖入的文件没有项目可落脚时，用它所在文件夹当项目名，和「导入图片开始标注」保持一致。 */
function folderName(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return (parts.length >= 2 ? parts[parts.length - 2] : '').slice(0, 80) || '未命名项目';
}

export interface DropVideo { projectId: string; path: string }

/**
 * 对话区的拖放处理：图片直接入库，视频交给既有的抽帧流程，
 * 其它类型如实说明不支持，不静默忽略。
 */
export function useChatFileDrop() {
  const { project, refreshProjects, refreshAssets, openProject, notify } = useApp();
  const [video, setVideo] = useState<DropVideo | null>(null);
  async function handle(files: DroppedFiles) {
    if (files.others.length) notify(`暂不支持这些文件：${files.others.join('、')}`, true);
    if (!files.images.length && !files.videos.length) return;
    try {
      // 会话必须挂在项目下：拖进来的东西要有去处，没有项目就先按文件位置建一个。
      let target = project;
      if (!target) {
        target = await request<Project>('project.create', { name: folderName(files.images[0] ?? files.videos[0]), taskType: 'detect' });
        await refreshProjects();
      }
      if (files.images.length) {
        const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: target.id, paths: files.images, mode: 'copy' });
        notify(`已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`, result.skipped > 0);
        if (project) await refreshAssets();
      }
      // 视频先交给抽帧面板检查与设参，不直接建任务。
      if (files.videos.length) {
        if (files.videos.length > 1) notify('一次只处理一个视频，已打开第一个。');
        setVideo({ projectId: target.id, path: files.videos[0] });
      }
      if (!project) await openProject(target);
    } catch (e) { notify(errorMessage(e), true); }
  }
  const drop = useFileDrop(handle);
  return { active: drop.active, handlers: drop.handlers, video, closeVideo: () => setVideo(null) };
}
