import { useState } from 'react';
import { useApp, type ChatAttachment } from './context';
import { errorMessage, getBridge, request } from './bridge';
import { Button, Modal, SearchField } from './ui';
import { dropRejectionNotice, filesToDroppedFiles, useFileDrop, type DroppedFiles } from './fileDrop';
import { IMAGE_EXTENSION_LABEL, VIDEO_EXTENSION_LABEL } from '../../shared/mediaFormats';
import type { DesktopBridge } from '../../shared/protocol';
import { baseName } from './projectNaming';

export interface DropVideo { projectId: string; path: string }
export interface VideoPicks { projectId: string; files: string[] }

/**
 * 多视频候选清单：拖入多个视频、或选中一个视频文件夹时都用它。
 * 逐个点「抽帧」进入单个面板调参数；`onChooseAll` 走一键抽帧——按默认参数整批排队，
 * 由 VideoBatchImport 承接。引擎本就逐个执行媒体任务，批量建任务不会并发抢 FFmpeg。
 */
export function VideoPickList({ picks, onChoose, onChooseAll, onClose }: { picks: VideoPicks | null; onChoose: (path: string) => void; onChooseAll?: (files: string[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''), [showAll, setShowAll] = useState(false);
  if (!picks) return null;
  const matched = picks.files.filter(file => !query.trim() || file.toLowerCase().includes(query.trim().toLowerCase()));
  // 清单默认收敛到 20 条：一个文件夹拖进几十个视频时，整窗被列表吃掉还要一路滚。
  const visible = showAll ? matched : matched.slice(0, 20);
  return <Modal title="选择要抽帧的视频" onClose={onClose}>
    <div className="form-stack">
      <p className="muted tiny">共 {picks.files.length} 个候选{matched.length !== picks.files.length ? `（筛选出 ${matched.length} 个）` : ''}。可以逐个点「抽帧」调好参数再抽，也可以一键抽帧：整批按默认参数排队处理。</p>
      {matched.length > 1 && onChooseAll && <div className="actions"><Button className="primary" onClick={() => onChooseAll(matched)}>一键抽帧（{matched.length} 个）</Button></div>}
      {picks.files.length > 8 && <SearchField value={query} onChange={setQuery} placeholder="按文件名搜索" />}
      <div className="board-list video-pick-list">{visible.map(file => <article className="board-row" key={file}>
        <div className="board-main"><strong>{baseName(file)}</strong><span className="muted tiny break-word">{file}</span></div>
        <Button onClick={() => onChoose(file)}>抽帧</Button>
      </article>)}</div>
      {matched.length > visible.length && <Button onClick={() => setShowAll(true)}>还有 {matched.length - visible.length} 个 · 全部</Button>}
      <div className="modal-actions"><Button onClick={onClose}>关闭</Button></div>
    </div>
  </Modal>;
}

/**
 * 文件夹附件的统一扫描：拖入与点选共用同一套规则（与引擎的目录扫描一致）。
 * 视频清单随附件保存（videoPaths）：发送时才能把文件夹里的视频送进抽帧链路，
 * 素材括注也才能写出具体路径——否则助手只看到「某文件夹」，既导不了图也抽不了帧。
 */
async function scanDirectoryAttachment(bridge: DesktopBridge, directory: string): Promise<{ attachment: ChatAttachment | null; notes: string[] }> {
  const label = baseName(directory);
  const notes: string[] = [];
  let images: Awaited<ReturnType<NonNullable<DesktopBridge['listDirectory']>>> | undefined;
  let videos: Awaited<ReturnType<NonNullable<DesktopBridge['listDirectory']>>> | undefined;
  try {
    [images, videos] = await Promise.all([
      bridge.listDirectory?.({ path: directory, kind: 'images' }),
      bridge.listDirectory?.({ path: directory, kind: 'video' }),
    ]);
  } catch {
    // 扫描不可用（演示版没有文件系统）：退回不带数量的目录附件，导入能否成功由引擎到时如实回答。
    return { attachment: { id: crypto.randomUUID(), path: directory, kind: 'directory', name: label }, notes };
  }
  // 数量跟附件走：素材括注才能写明文件夹里有什么，而不是只报一个名字。
  const attachment: ChatAttachment | null = images?.files.length || videos?.files.length
    ? { id: crypto.randomUUID(), path: directory, kind: 'directory', name: label,
        ...(images?.files.length ? { imageCount: images.files.length } : {}),
        ...(videos?.files.length ? { videoCount: videos.files.length, videoPaths: videos.files } : {}) }
    : null;
  if (images?.files.length) {
    if (images.unsupported) notes.push(`「${label}」里另有 ${images.unsupported} 个文件不是 JPG / JPEG / PNG，不会导入。`);
    if (images.truncated) notes.push(`「${label}」过大，导入时只处理上限内的部分。`);
  }
  if (videos?.unsupported) notes.push(`「${label}」里有 ${videos.unsupported} 个文件不是视频，已跳过。`);
  if (!images?.files.length && !videos?.files.length) notes.push(`「${label}」里没有可导入的素材。图片支持 ${IMAGE_EXTENSION_LABEL}，视频支持 ${VIDEO_EXTENSION_LABEL}。`);
  return { attachment, notes };
}

/** 粘贴 / 点选的文件：与拖入同一条归类与授权管道（路径由 preload 解析、拒绝原因照旧如实回报）。 */
export async function filesToAttachments(files: File[]): Promise<ChatAttachment[]> {
  const result = await filesToDroppedFiles(files);
  const attachments: ChatAttachment[] = [...result.images.map(item => ({ id: crypto.randomUUID(), path: item, kind: 'image' as const, name: baseName(item) })),
    ...result.videos.map(item => ({ id: crypto.randomUUID(), path: item, kind: 'video' as const, name: baseName(item) }))];
  // 文件夹同样走统一扫描：点选进来的文件夹和拖入的一样携带数量与视频清单。
  if (result.directories.length) {
    const bridge = await getBridge();
    for (const directory of result.directories) {
      const { attachment } = await scanDirectoryAttachment(bridge, directory);
      if (attachment) attachments.push(attachment);
    }
  }
  // 一个都没进附件且有拒绝/未解析文件时必须发声：粘贴/点选拿不到路径、类型不支持都不能静默吞掉。
  if (!attachments.length && (result.rejected?.length || result.unresolved?.length)) throw new Error(dropRejectionNotice(result) ?? `以下文件无法作为附件：${(result.unresolved ?? []).join('、')}`);
  return attachments;
}

/** 随消息添加的素材写进消息文本：会话历史里才能看出当时发的是什么，不用凭记忆回忆。 */
export function materialNote(attachments: ChatAttachment[]): string {
  if (!attachments.length) return '';
  // 名字之外补类型与数量：光秃秃一个目录名（例如「data」）看不出是文件夹、也不知道里面有多少能用。
  const labels = attachments.map(item => {
    if (item.kind === 'video') return `${item.name}（视频）`;
    if (item.kind !== 'directory') return item.name;
    const counts = [item.imageCount ? `${item.imageCount} 张图片` : '', item.videoCount ? `${item.videoCount} 个视频` : ''].filter(Boolean);
    return counts.length ? `${item.name}（文件夹 · ${counts.join('、')}）` : `${item.name}（文件夹）`;
  });
  const shown = labels.slice(0, 8).join('、');
  // 视频要写出具体路径：助手只看到「data（11 个视频）」时既不能猜路径也无法抽帧，只能回「没收到视频」。
  // 路径随括注进入用户消息，授权以桌面侧登记为准，未登记的路径会被拒绝，这里不承担校验。
  const videoPaths = attachments.flatMap(item => (item.kind === 'video' ? [item.path] : item.videoPaths ?? []));
  const listed: string[] = [];
  let budget = 6000;
  for (const path of videoPaths) {
    if (budget < path.length + 2) break;
    listed.push(path); budget -= path.length + 2;
  }
  const videoNote = listed.length
    ? `。视频文件：${listed.join('、')}${videoPaths.length > listed.length ? ` 等 ${videoPaths.length} 个` : ''}` : '';
  return `（随消息添加素材：${shown}${attachments.length > 8 ? ` 等 ${attachments.length} 个文件` : ''}${videoNote}）`;
}

/**
 * 对话区的拖放处理：拖入的文件变成聊天框附件条，发送时才导入并确定项目归属；
 * 不再「拖入即建项目即入库」。拒绝原因照旧如实说明，不静默忽略。
 */
export function useChatFileDrop(onAttach: (attachments: ChatAttachment[]) => void) {
  const { notify } = useApp();
  const [video, setVideo] = useState<DropVideo | null>(null);
  const [picks, setPicks] = useState<VideoPicks | null>(null);
  const [batch, setBatch] = useState<VideoPicks | null>(null);
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
        const { attachment, notes: directoryNotes } = await scanDirectoryAttachment(bridge, directory);
        if (attachment) attachments.push(attachment);
        notes.push(...directoryNotes);
      }
      for (const path of files.images) push(path, 'image');
      for (const path of files.videos) push(path, 'video');
      onAttach(attachments);
      if (notes.length) notify(notes.join(' '));
    } catch (e) { notify(errorMessage(e), true); }
  }
  const drop = useFileDrop(handle, error => notify(errorMessage(error), true));
  return {
    active: drop.active, handlers: drop.handlers, video, closeVideo: () => setVideo(null),
    openVideo: (value: DropVideo) => setVideo(value),
    picks, openPicks: (value: VideoPicks) => setPicks(value), closePicks: () => setPicks(null),
    chooseVideo: (path: string) => { const current = picks; setPicks(null); if (current) setVideo({ projectId: current.projectId, path }); },
    batch, closeBatch: () => setBatch(null),
    // 一键抽帧整批接手当前清单：清单关闭，批量弹窗按同一批文件（含搜索筛选后的结果）打开。
    chooseAll: (files: string[]) => { const current = picks; setPicks(null); if (current) setBatch({ projectId: current.projectId, files }); },
    // 批量面板收起后若有视频没建成任务，调用方用这里把「只有这几个」的面板原样重开，
    // 不必让用户重新拖一遍整批。带上项目归属，重开后面板仍归这个项目。
    openBatch: (value: VideoPicks) => setBatch(value)
  };
}

/**
 * 附件真正落库：图片与目录交给 asset.import，视频（含文件夹里的）返回给调用方走抽帧流程。
 * 只把文件夹交给 asset.import 会静默丢掉里面的全部视频——引擎的目录扫描只收 jpg/jpeg/png，
 * 这正是「明明发了数据集文件夹，助手却说没收到视频」的来由。
 */
export async function importAttachments(projectId: string, attachments: ChatAttachment[]): Promise<{ imported: number; skipped: number; videos: string[]; queued?: boolean; total?: number }> {
  const paths = attachments.filter(item => item.kind !== 'video').map(item => item.path);
  const videos = attachments.filter(item => item.kind === 'video').map(item => item.path);
  for (const item of attachments) {
    if (item.kind !== 'directory') continue;
    // 正常路径直接用扫描时记下的清单；清单缺失（旧会话遗留附件等）再列一次目录补上。
    if (item.videoPaths?.length) { videos.push(...item.videoPaths); continue; }
    const scanned = await (await getBridge()).listDirectory?.({ path: item.path, kind: 'video' });
    if (scanned?.files.length) videos.push(...scanned.files);
  }
  if (!paths.length) return { imported: 0, skipped: 0, videos };
  // 超过阈值时引擎转入后台导入任务（queued），进度与取消走任务条；这里如实把两种结果都透出去。
  const result = await request<{ imported?: number; skipped?: number; queued?: boolean; total?: number }>('asset.import', { projectId, paths, mode: 'copy' });
  return { imported: result.imported ?? 0, skipped: result.skipped ?? 0, queued: result.queued, total: result.total, videos };
}
