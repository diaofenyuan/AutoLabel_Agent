import { useState } from 'react';
import { useApp } from './context';
import { errorMessage, getBridge, request } from './bridge';
import { Button, Modal } from './ui';
import { dropRejectionNotice, useFileDrop, type DroppedFiles } from './fileDrop';
import { IMAGE_EXTENSION_LABEL, VIDEO_EXTENSION_LABEL } from '../../shared/mediaFormats';
import { baseName, projectNameFor, sameNameProject } from './projectNaming';
import type { Project } from './types';

export interface DropVideo { projectId: string; path: string }
export interface VideoPicks { projectId: string; files: string[] }

/**
 * 多视频候选清单：拖入多个视频、或选中一个视频文件夹时都用它。
 * 一次只起一个抽帧任务——同时跑几个既慢又难查，做成队列调度又超出本轮范围，
 * 所以只做「先列出来、逐个点」这一步，并在清单上把这件事写明白。
 */
export function VideoPickList({ picks, onChoose, onClose }: { picks: VideoPicks | null; onChoose: (path: string) => void; onClose: () => void }) {
  if (!picks) return null;
  return <Modal title="选择要抽帧的视频" onClose={onClose}>
    <div className="form-stack">
      <p className="muted tiny">共 {picks.files.length} 个候选，一次处理一个：抽完一个再点下一个，避免多个抽帧任务同时跑。</p>
      <div className="board-list">{picks.files.map(file => <article className="board-row" key={file}>
        <div className="board-main"><strong>{baseName(file)}</strong><span className="muted tiny break-word">{file}</span></div>
        <Button onClick={() => onChoose(file)}>抽帧</Button>
      </article>)}</div>
      <div className="modal-actions"><Button onClick={onClose}>关闭</Button></div>
    </div>
  </Modal>;
}

/**
 * 对话区的拖放处理：图片与文件夹直接入库，视频交给既有的抽帧流程，
 * 其它类型按原因如实说明，不静默忽略。
 */
export function useChatFileDrop() {
  const { project, projects, refreshProjects, refreshAssets, openProject, notify } = useApp();
  const [video, setVideo] = useState<DropVideo | null>(null);
  const [picks, setPicks] = useState<VideoPicks | null>(null);
  async function handle(files: DroppedFiles) {
    const rejection = dropRejectionNotice(files);
    if (rejection) notify(rejection, true);
    if (!files.images.length && !files.videos.length && !files.directories.length) return;
    try {
      const bridge = await getBridge();
      const notes: string[] = [];
      const imagePaths = [...files.images];
      const videoPaths = [...files.videos];
      // 文件夹：图片整目录交给引擎（同一套规则，界面只负责把「有多少用不上」讲清楚），视频进候选清单。
      for (const directory of files.directories) {
        const images = await bridge.listDirectory?.({ path: directory, kind: 'images' });
        const videos = await bridge.listDirectory?.({ path: directory, kind: 'video' });
        const label = baseName(directory);
        if (images?.files.length) {
          imagePaths.push(directory);
          if (images.unsupported) notes.push(`「${label}」里另有 ${images.unsupported} 个文件不是 JPG / JPEG / PNG，没有导入。`);
          if (images.truncated) notes.push(`「${label}」过大，本次只处理了上限内的部分。`);
        }
        if (videos?.files.length) videoPaths.push(...videos.files);
        else if (videos?.unsupported) notes.push(`「${label}」里有 ${videos.unsupported} 个文件不是视频，已跳过。`);
        if (!images?.files.length && !videos?.files.length) notes.push(`「${label}」里没有找到可导入的素材。图片支持 ${IMAGE_EXTENSION_LABEL}，视频支持 ${VIDEO_EXTENSION_LABEL}。`);
      }
      // 会话必须挂在项目下：拖进来的东西要有去处，没有项目就先按拖入对象的位置建一个（同名则复用）。
      let target = project;
      const anchor = files.directories[0] ?? files.images[0] ?? files.videos[0];
      if (!target) {
        const name = projectNameFor(anchor, files.directories.length > 0);
        target = sameNameProject(projects, name) ?? await request<Project>('project.create', { name, taskType: 'detect' });
        await refreshProjects();
      }
      if (imagePaths.length) {
        const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: target.id, paths: imagePaths, mode: 'copy' });
        notes.unshift(`已导入 ${result.imported} 张${result.skipped ? `，已在项目里 ${result.skipped} 张` : ''}。`);
        if (project) await refreshAssets();
      }
      // 视频先交给抽帧面板检查与设参，不直接建任务；多个视频列成清单逐个来。
      if (videoPaths.length === 1) setVideo({ projectId: target.id, path: videoPaths[0] });
      else if (videoPaths.length > 1) setPicks({ projectId: target.id, files: videoPaths });
      if (!project) await openProject(target);
      // openProject 会清掉当前提示，所以结果播报放在它之后。
      if (notes.length) notify(notes.join(' '));
    } catch (e) { notify(errorMessage(e), true); }
  }
  const drop = useFileDrop(handle);
  return {
    active: drop.active, handlers: drop.handlers, video, closeVideo: () => setVideo(null),
    picks, openPicks: (value: VideoPicks) => setPicks(value), closePicks: () => setPicks(null),
    chooseVideo: (path: string) => { const current = picks; setPicks(null); if (current) setVideo({ projectId: current.projectId, path }); }
  };
}
