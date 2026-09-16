import { useState } from 'react';
import { FolderPlus, Image as ImageIcon, Film } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage, getBridge } from './bridge';
import { Composer } from './ui';
import { AiSetupNotice } from './AiSetup';
import { DropOverlay } from './fileDrop';
import { VideoPickList, useChatFileDrop } from './chatDrop';
import VideoImport from './VideoImport';
import ModelPicker from './ModelPicker';
import FlowPicker from './FlowPicker';
import { VIDEO_EXTENSION_LABEL } from '../../shared/mediaFormats';
import { directoryName, folderName, sameNameProject } from './projectNaming';
import type { Project } from './types';

/**
 * 欢迎页：还没有进入任何项目时落在这里。
 * 会话必须挂在项目下，所以这里不做「不属于任何项目的对话」：
 * 输入一句话就按描述建好项目，并把这句话作为该项目的第一条指令发出去。
 */
export default function ChatHome() {
  const { projects, openProject, refreshProjects, notify, setMediaJob, setMediaTaskId, prefs, savePrefs, providers, navigate } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // 欢迎页还没有项目时，用户点「选择视频抽帧」要先有一个项目承载抽帧产物；这里存下这次点击建好的项目与选中路径。
  const [videoStart, setVideoStart] = useState<{ projectId: string; path: string } | null>(null);
  const drop = useChatFileDrop();
  // 欢迎页还没有会话，选择模型与深度即写入默认值：新建会话与任务都以它为初值。
  const choice = { providerId: prefs.chatProviderId, model: prefs.chatModel, depth: prefs.chatThinkingDepth ?? 'standard' };
  async function saveChoice(next: Partial<typeof choice>) {
    try { await savePrefs({ ...prefs, chatProviderId: next.providerId ?? choice.providerId, chatModel: next.model ?? choice.model, chatThinkingDepth: next.depth ?? choice.depth }); }
    catch (e) { notify(errorMessage(e), true); }
  }
  // 最近更新的几个项目都留出入口：只给一个「继续」时，用户没法表达「我要接着另一个项目干」。
  const recentProjects = [...projects].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, 3);
  // 首行前 40 字就是项目名。把它先算出来显示在输入框旁：用户才知道这句话会落到哪个项目，而不是发完才发现多了一个项目。
  const pendingName = input.trim().split('\n')[0].slice(0, 40).trim();
  const pendingExisting = pendingName ? sameNameProject(projects, pendingName) : undefined;

  /**
   * 同名项目默认复用而不是再建一个。
   * 重复拖入同一批素材原先会在侧栏留下两个外观完全一致的项目，用户分不清哪个有素材，
   * 助手又会落在空的那个上——复用是这个问题的源头修复。
   */
  async function resolveProject(name: string, description?: string): Promise<{ project: Project; reused: boolean }> {
    const existing = sameNameProject(projects, name);
    if (existing) return { project: existing, reused: true };
    return { project: await request<Project>('project.create', { name: name.trim().slice(0, 80), description, taskType: 'detect' }), reused: false };
  }

  /** 建项目 → 进入该项目的会话 → 首条消息自动发出。同名项目已存在时接入它，不再新建。 */
  async function startProject(name: string, description: string, firstMessage: string) {
    const { project: target, reused } = await resolveProject(name, description);
    // 先刷新项目列表：侧栏会话是按项目归组的，列表落后会把新项目的会话显示成「项目已删除」。
    await refreshProjects();
    await openProject(target, firstMessage);
    // openProject 会清掉当前提示，所以这句话必须放在它之后，否则用户看不到。
    if (reused) notify(`已接入同名项目「${target.name}」，这条消息发在它里面。想另起一个请先在侧栏重命名项目。`);
  }
  async function start() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      // 项目名取描述第一行，类别留空：类别由用户在对话里说明，不再预置任何场景。
      await startProject(text.split('\n')[0].slice(0, 40), text, text);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  /** 「导入图片开始标注」：先选图，再按图片所在文件夹建项目并导入，最后开一条会话说明这批图。 */
  async function importImages() {
    if (busy) return;
    setBusy(true);
    try {
      const paths = await (await getBridge()).chooseFiles({ kind: 'images', multiple: true });
      if (!paths.length) return;
      const { project: target, reused } = await resolveProject(folderName(paths[0]));
      const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: target.id, paths, mode: 'copy' });
      // 先刷新项目列表：侧栏会话是按项目归组的，列表落后会把新项目的会话显示成「项目已删除」。
      await refreshProjects();
      await openProject(target, result.imported ? `刚导入了 ${result.imported} 张图片，请开始标注` : '这批图片之前已经导入过，请核对已有标注');
      // openProject 会清掉当前提示，所以导入结果必须放在它之后播报，否则用户看不到。
      // 跳过数单独说明：同一批图重复导入会按内容指纹去重，用户需要知道素材没有丢，只是已经在了。
      notify(reused
        ? `已并入同名项目「${target.name}」：新增 ${result.imported} 张，已存在 ${result.skipped} 张。`
        : `已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  /** 「选择视频抽帧」：先选视频，再按视频所在文件夹建项目，随后进入抽帧面板。与图片导入同一条授权链路。 */
  async function selectVideo() {
    if (busy) return;
    setBusy(true);
    try {
      // 允许一次多选：先前是单选，批量导视频只能一个个来。
      const paths = await (await getBridge()).chooseFiles({ kind: 'video', multiple: true });
      if (!paths.length) return;
      const { project: target, reused } = await resolveProject(folderName(paths[0]));
      // 先刷新项目列表：侧栏会话是按项目归组的，列表落后会把新项目的会话显示成「项目已删除」。
      await refreshProjects();
      if (reused) notify(`已接入同名项目「${target.name}」，抽帧素材会并入其中。`);
      // 多个视频先给清单：同时起多个抽帧任务既慢又难查，交给用户一个个来。
      if (paths.length === 1) setVideoStart({ projectId: target.id, path: paths[0] });
      else drop.openPicks({ projectId: target.id, files: paths });
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  /**
   * 「导入图片文件夹」：整目录一次导入。
   * 导入前后各做一件事——先枚举目录把「有多少文件用不上」问出来，再按引擎的目录扫描规则导入。
   * 少了前一步，含 webp 的文件夹会静默少收素材，用户只看到一个偏小的数字。
   */
  async function importImageFolder() {
    if (busy) return;
    setBusy(true);
    try {
      const bridge = await getBridge();
      const [directory] = await bridge.chooseFiles({ kind: 'directory' });
      if (!directory) return;
      const scanned = await bridge.listDirectory?.({ path: directory, kind: 'images' });
      const { project: target, reused } = await resolveProject(directoryName(directory));
      const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: target.id, paths: [directory], mode: 'copy' });
      await refreshProjects();
      await openProject(target, result.imported ? `刚导入了 ${result.imported} 张图片，请开始标注` : '这个文件夹里的图片已经导入过，请核对已有标注');
      // openProject 会清掉当前提示，所以导入结果必须放在它之后播报。
      notify([
        reused ? `已并入同名项目「${target.name}」：新增 ${result.imported} 张，已在项目里 ${result.skipped} 张。` : `已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`,
        scanned?.unsupported ? `文件夹里另有 ${scanned.unsupported} 个文件不是 JPG / JPEG / PNG，没有导入。` : '',
        scanned?.truncated ? '文件夹过大，本次只处理了上限内的部分，其余请分批导入。' : ''
      ].filter(Boolean).join(' '));
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  /** 「选择视频文件夹」：列出文件夹里的视频让用户挑，逐个发起抽帧；没有视频时如实说明原因。 */
  async function selectVideoFolder() {
    if (busy) return;
    setBusy(true);
    try {
      const bridge = await getBridge();
      const [directory] = await bridge.chooseFiles({ kind: 'directory' });
      if (!directory) return;
      const scanned = await bridge.listDirectory?.({ path: directory, kind: 'video' });
      if (!scanned?.files.length) {
        notify(`这个文件夹里没有可抽帧的视频（支持 ${VIDEO_EXTENSION_LABEL}）${scanned?.unsupported ? `；另有 ${scanned.unsupported} 个文件不是视频` : ''}。`, true);
        return;
      }
      const { project: target } = await resolveProject(directoryName(directory));
      await refreshProjects();
      drop.openPicks({ projectId: target.id, files: scanned.files });
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  return <div className={`chat-home ${drop.active ? 'drop-active' : ''}`} {...drop.handlers}>
    <DropOverlay visible={drop.active} />
    <div className="chat-welcome">
      <h1>今天要标注什么？</h1>
      <AiSetupNotice />
      <div className="chat-suggestions" aria-label="建议">
        <button disabled={busy} onClick={() => void importImages()}><ImageIcon size={14} />导入图片开始标注</button>
        <button disabled={busy} onClick={() => void importImageFolder()}><FolderPlus size={14} />导入图片文件夹</button>
        <button disabled={busy} onClick={() => void selectVideo()}><Film size={14} />选择视频抽帧</button>
        <button disabled={busy} onClick={() => void selectVideoFolder()}><FolderPlus size={14} />选择视频文件夹</button>
        {recentProjects.map(item => <button key={item.id} disabled={busy} title={`最近更新的项目 · ${item.assetCount} 张素材`}
          onClick={() => void openProject(item).catch(e => notify(errorMessage(e), true))}>继续 {item.name}（{item.assetCount} 张）</button>)}
      </div>
      <p className="muted tiny">也可以把图片或视频直接拖进来，会新建项目并入库；长任务在对话里选流程发起。</p>
    </div>
    {/* 输入区同样固定在页面最下方：欢迎语与建议在上方，发送后按这句话建好项目并开始对话。 */}
    <footer className="chat-dock">
      <Composer value={input} onChange={setInput} onSend={() => void start()} placeholder="例如：标注工地照片里的安全帽和人员…" busy={busy}>
        <div className="chat-options">
          <FlowPicker disabled={busy} onPick={prompt => { setInput(prompt); document.querySelector<HTMLTextAreaElement>('.chat-home textarea')?.focus(); }} />
          {/* 把落点写在发送之前：新建还是并入同名项目，用户发之前就能看到。 */}
          {pendingName
            ? <span className="composer-hint">{pendingExisting
              ? `将并入已有项目「${pendingExisting.name}」（现有 ${pendingExisting.assetCount} 张素材）`
              : `将新建项目「${pendingName}」`} · Ctrl + Enter 发送</span>
            : <span className="composer-hint">Ctrl + Enter 发送 · 会按这句话建好项目并开始第一条对话</span>}
        </div>
      </Composer>
      <div className="chat-model-line">
        <ModelPicker providers={providers} providerId={choice.providerId} model={choice.model} depth={choice.depth} disabled={busy}
          onChange={next => void saveChoice(next)} onDepthChange={next => void saveChoice({ depth: next })} onConfigure={() => void navigate('settings', 'ai')} />
        <span className="muted tiny">这里的默认值用于新建的对话与任务</span>
      </div>
    </footer>
    {/* 多选视频或视频文件夹选出来的候选清单：与拖入多个视频共用同一个组件。 */}
    <VideoPickList picks={drop.picks} onChoose={path => { const target = drop.picks?.projectId; drop.closePicks(); if (target) setVideoStart({ projectId: target, path }); }} onClose={drop.closePicks} />
    {/* 拖入视频与点击「选择视频抽帧」都走同一个抽帧面板：区别只在于项目是拖放时建的还是按钮提前建好的。 */}
    {(drop.video ?? videoStart) && (() => {
      const source = drop.video ?? videoStart!;
      const close = () => { if (drop.video) drop.closeVideo(); else setVideoStart(null); };
      return <VideoImport key={source.path} projectId={source.projectId} initialSourcePath={source.path} onClose={close}
        onCreated={(job, temporarySource) => {
          setMediaTaskId(job.id); setMediaJob({ id: job.id, temporarySource }); close();
          // 抽帧在后台跑，用户先看到素材落点，再回对话说要标什么。
          notify('已创建抽帧任务，素材入库后出现在这里；进度可在侧栏「任务」里查看。');
          void navigate('overview');
        }} />;
    })()}
  </div>;
}
