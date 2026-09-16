import { useState } from 'react';
import { Image as ImageIcon, Film } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage, getBridge } from './bridge';
import { Composer } from './ui';
import { AiSetupNotice } from './AiSetup';
import { DropOverlay } from './fileDrop';
import { useChatFileDrop } from './chatDrop';
import VideoImport from './VideoImport';
import ModelPicker from './ModelPicker';
import FlowPicker from './FlowPicker';
import type { Project } from './types';

/** 从导入路径里取一个像样的项目名：用文件所在文件夹名，取不到就退回通用名。 */
function folderName(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const name = parts.length >= 2 ? parts[parts.length - 2] : '';
  return name.slice(0, 80) || '未命名项目';
}

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
  // 「继续 <最近项目>」按最近更新的项目走，没有项目时这一项不出现。
  const lastProject = [...projects].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];

  /** 建项目 → 进入该项目的会话 → 首条消息自动发出。 */
  async function startProject(name: string, description: string, firstMessage: string) {
    const created = await request<Project>('project.create', { name: name.trim().slice(0, 80), description, taskType: 'detect' });
    // 先刷新项目列表：侧栏会话是按项目归组的，列表落后会把新项目的会话显示成「项目已删除」。
    await refreshProjects();
    await openProject(created, firstMessage);
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
      const created = await request<Project>('project.create', { name: folderName(paths[0]), taskType: 'detect' });
      const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: created.id, paths, mode: 'copy' });
      notify(`已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`);
      // 先刷新项目列表：侧栏会话是按项目归组的，列表落后会把新项目的会话显示成「项目已删除」。
      await refreshProjects();
      await openProject(created, `刚导入了 ${result.imported} 张图片，请开始标注`);
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  /** 「选择视频抽帧」：先选视频，再按视频所在文件夹建项目，随后进入抽帧面板。与图片导入同一条授权链路。 */
  async function selectVideo() {
    if (busy) return;
    setBusy(true);
    try {
      const paths = await (await getBridge()).chooseFiles({ kind: 'video' });
      if (!paths.length) return;
      const created = await request<Project>('project.create', { name: folderName(paths[0]), taskType: 'detect' });
      // 先刷新项目列表：侧栏会话是按项目归组的，列表落后会把新项目的会话显示成「项目已删除」。
      await refreshProjects();
      // 抽帧在面板里检查和设参，此处只把项目与已授权路径交给它，不预先建任务。
      setVideoStart({ projectId: created.id, path: paths[0] });
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
        <button disabled={busy} onClick={() => void selectVideo()}><Film size={14} />选择视频抽帧</button>
        {lastProject && <button disabled={busy} onClick={() => void openProject(lastProject).catch(e => notify(errorMessage(e), true))}>继续 {lastProject.name}</button>}
      </div>
      <p className="muted tiny">也可以把图片或视频直接拖进来，会新建项目并入库；长任务在对话里选流程发起。</p>
    </div>
    {/* 输入区同样固定在页面最下方：欢迎语与建议在上方，发送后按这句话建好项目并开始对话。 */}
    <footer className="chat-dock">
      <Composer value={input} onChange={setInput} onSend={() => void start()} placeholder="例如：标注工地照片里的安全帽和人员…" busy={busy}>
        <div className="chat-options">
          <FlowPicker disabled={busy} onPick={prompt => { setInput(prompt); document.querySelector<HTMLTextAreaElement>('.chat-home textarea')?.focus(); }} />
          <span className="composer-hint">Ctrl + Enter 发送 · 会按这句话建好项目并开始第一条对话</span>
        </div>
      </Composer>
      <div className="chat-model-line">
        <ModelPicker providers={providers} providerId={choice.providerId} model={choice.model} depth={choice.depth} disabled={busy}
          onChange={next => void saveChoice(next)} onDepthChange={next => void saveChoice({ depth: next })} onConfigure={() => void navigate('settings', 'ai')} />
        <span className="muted tiny">这里的默认值用于新建的对话与任务</span>
      </div>
    </footer>
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
