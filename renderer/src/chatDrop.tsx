import { useState } from 'react';
import { useApp, type ChatAttachment } from './context';
import { errorMessage, getBridge, request } from './bridge';
import { Button, Modal } from './ui';
import { dropRejectionNotice, useFileDrop, type DroppedFiles } from './fileDrop';
import { IMAGE_EXTENSION_LABEL, VIDEO_EXTENSION_LABEL } from '../../shared/mediaFormats';
import { baseName } from './projectNaming';

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
 * 对话区的拖放处理：拖入的文件变成聊天框附件条，发送时才导入并确定项目归属；
 * 不再「拖入即建项目即入库」。拒绝原因照旧如实说明，不静默忽略。
 */
export function useChatFileDrop(onAttach: (attachments: ChatAttachment[]) => void) {
  const { notify } = useApp();
  const [video, setVideo] = useState<DropVideo | null>(null);
  const [picks, setPicks] = useState<VideoPicks | null>(null);
  async function handle(files: DroppedFiles) {
    const rejection = dropRejectionNotice(files);
    if (rejection) notify(rejection, true);
    if (!files.images.length && !files.videos.length && !files.directories.length) return;
    try {
      const bridge = await getBridge();
      const notes: string[] = [];
      const attachments: ChatAttachment[] = [];
      const push = (path: string, kind: ChatAttachment['kind']) => attachments.push({ id: crypto.randomUUID(), path, kind, name: baseName(path) });
      // 文件夹先按引擎同一套规则数一数：能用的整目录作为附件挂进聊天框，「有多少用不上」在这里讲清楚。
      for (const directory of files.directories) {
        const images = await bridge.listDirectory?.({ path: directory, kind: 'images' });
        const videos = await bridge.listDirectory?.({ path: directory, kind: 'video' });
        const label = baseName(directory);
        if (images?.files.length || videos?.files.length) push(directory, 'directory');
        if (images?.files.length) {
          if (images.unsupported) notes.push(`「${label}」里另有 ${images.unsupported} 个文件不是 JPG / JPEG / PNG，不会导入。`);
          if (images.truncated) notes.push(`「${label}」过大，导入时只处理上限内的部分。`);
        }
        if (videos?.unsupported) notes.push(`「${label}」里有 ${videos.unsupported} 个文件不是视频，已跳过。`);
        if (!images?.files.length && !videos?.files.length) notes.push(`「${label}」里没有可导入的素材。图片支持 ${IMAGE_EXTENSION_LABEL}，视频支持 ${VIDEO_EXTENSION_LABEL}。`);
      }
      for (const path of files.images) push(path, 'image');
      for (const path of files.videos) push(path, 'video');
      onAttach(attachments);
      if (notes.length) notify(notes.join(' '));
    } catch (e) { notify(errorMessage(e), true); }
  }
  const drop = useFileDrop(handle);
  return {
    active: drop.active, handlers: drop.handlers, video, closeVideo: () => setVideo(null),
    openVideo: (value: DropVideo) => setVideo(value),
    picks, openPicks: (value: VideoPicks) => setPicks(value), closePicks: () => setPicks(null),
    chooseVideo: (path: string) => { const current = picks; setPicks(null); if (current) setVideo({ projectId: current.projectId, path }); }
  };
}

/** 附件真正落库：图片与目录交给 asset.import，视频返回给调用方走抽帧流程。 */
export async function importAttachments(projectId: string, attachments: ChatAttachment[]): Promise<{ imported: number; skipped: number; videos: string[] }> {
  const paths = attachments.filter(item => item.kind !== 'video').map(item => item.path);
  const videos = attachments.filter(item => item.kind === 'video').map(item => item.path);
  if (!paths.length) return { imported: 0, skipped: 0, videos };
  const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId, paths, mode: 'copy' });
  return { ...result, videos };
}
