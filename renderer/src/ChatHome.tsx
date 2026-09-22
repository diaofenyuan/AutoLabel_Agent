import { useState } from 'react';
import { useApp } from './context';
import { request, errorMessage, getBridge } from './bridge';
import { Composer } from './ui';
import OnboardingLanes from './OnboardingLanes';
import { DropOverlay } from './fileDrop';
import VideoImport from './VideoImport';
import ModelPicker from './ModelPicker';
import FlowPicker from './FlowPicker';
import LocalModelPicker from './LocalModelPicker';
import ProjectResolveDialog, { type ProjectChoice } from './ProjectResolveDialog';
import { applyProjectDraft } from './projectSetup';
import { VideoPickList, useChatFileDrop, importAttachments } from './chatDrop';
import { VIDEO_EXTENSION_LABEL } from '../../shared/mediaFormats';
import { directoryName, folderName, sameNameProject } from './projectNaming';
import type { ChatAttachment } from './context';
import type { Project } from './types';

/**
 * 欢迎页：还没有进入任何项目时落在这里。
 * 会话必须挂在项目下，所以这里不做「不属于任何项目的对话」：
 * 描述或拖入的文件先确认项目归属（命名或选已有），发送后才建好项目并开始对话。
 */
export default function ChatHome() {
  const { projects, openProject, refreshProjects, notify, setMediaJob, setMediaTaskId, prefs, savePrefs, providers, navigate, setPendingVideoImports } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // 欢迎页还没有项目时，用户点「选择视频抽帧」要先有一个项目承载抽帧产物；这里存下这次点击建好的项目与选中路径。
  const [videoStart, setVideoStart] = useState<{ projectId: string; path: string } | null>(null);
  // 拖进来的文件挂在聊天框附件条上，发送时随项目确认一起入库；不再拖入即建项目。
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // 项目归属确认：发送 / 导入都先弹框让用户命名或选已有项目，确认后才真正执行。
  const [projectPrompt, setProjectPrompt] = useState<null | { title: string; confirmLabel: string; suggest: string; run: (project: Project) => Promise<void> }>(null);
  const drop = useChatFileDrop(items => setAttachments(current => {
    const known = new Set(current.map(item => item.path));
    const fresh = items.filter(item => !known.has(item.path));
    return fresh.length ? [...current, ...fresh] : current;
  }));
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
   * 项目不再自动命名：建议名（描述首行 / 文件夹名）只作预填，真正的名称与归属由用户在弹框里确认。
   * 确认后同名项目仍复用——弹框里敲出已有项目的名字时，并入而不是悄悄再建一个。
   */
  async function handleProjectChoice(action: ProjectChoice) {
    if (!projectPrompt) return;
    let target: Project;
    if (action.mode === 'existing') target = action.project;
    else {
      const existing = sameNameProject(projects, action.name);
      target = existing ?? await request<Project>('project.create', { name: action.name.slice(0, 80), taskType: action.taskType });
      if (existing) notify(`已接入同名项目「${existing.name}」。`);
      // 同名接入时沿用项目原有模板，只有新建的项目才写入这次填的类别与标注要求。
      else target = await applyProjectDraft(target.id, action.classes, action.rules) ?? target;
    }
    await refreshProjects();
    await projectPrompt.run(target);
    setProjectPrompt(null);
  }
  /** 「导入图片开始标注」：先选图，弹框确认项目归属后导入，最后开一条会话说明这批图。 */
  async function importImages() {
    if (busy) return;
    setBusy(true);
    try {
      const paths = await (await getBridge()).chooseFiles({ kind: 'images', multiple: true });
      if (!paths.length) return;
      setProjectPrompt({
        title: '导入图片', confirmLabel: '导入并继续', suggest: folderName(paths[0]),
        run: async target => {
          const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: target.id, paths, mode: 'copy' });
          await openProject(target, result.imported ? `刚导入了 ${result.imported} 张图片，请开始标注` : '这批图片之前已经导入过，请核对已有标注');
          // openProject 会清掉当前提示，所以导入结果必须放在它之后播报，否则用户看不到。
          notify(`已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`);
        }
      });
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  /** 「选择视频抽帧」：先选视频，弹框确认项目归属后进入抽帧面板。与图片导入同一条授权链路。 */
  async function selectVideo() {
    if (busy) return;
    setBusy(true);
    try {
      // 允许一次多选：先前是单选，批量导视频只能一个个来。
      const paths = await (await getBridge()).chooseFiles({ kind: 'video', multiple: true });
      if (!paths.length) return;
      setProjectPrompt({
        title: '选择视频抽帧', confirmLabel: '继续', suggest: folderName(paths[0]),
        run: async target => {
          // 多个视频先给清单：同时起多个抽帧任务既慢又难查，交给用户一个个来。
          if (paths.length === 1) setVideoStart({ projectId: target.id, path: paths[0] });
          else drop.openPicks({ projectId: target.id, files: paths });
        }
      });
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
      setProjectPrompt({
        title: '导入图片文件夹', confirmLabel: '导入并继续', suggest: directoryName(directory),
        run: async target => {
          const result = await request<{ imported: number; skipped: number }>('asset.import', { projectId: target.id, paths: [directory], mode: 'copy' });
          await openProject(target, result.imported ? `刚导入了 ${result.imported} 张图片，请开始标注` : '这个文件夹里的图片已经导入过，请核对已有标注');
          // openProject 会清掉当前提示，所以导入结果必须放在它之后播报。
          notify([
            `已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`,
            scanned?.unsupported ? `文件夹里另有 ${scanned.unsupported} 个文件不是 JPG / JPEG / PNG，没有导入。` : '',
            scanned?.truncated ? '文件夹过大，本次只处理了上限内的部分，其余请分批导入。' : ''
          ].filter(Boolean).join(' '));
        }
      });
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
      setProjectPrompt({
        title: '选择视频文件夹', confirmLabel: '继续', suggest: directoryName(directory),
        run: async target => { drop.openPicks({ projectId: target.id, files: scanned.files }); }
      });
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }

  return <div className={`chat-home ${drop.active ? 'drop-active' : ''}`} {...drop.handlers}>
    <DropOverlay visible={drop.active} />
    <div className="chat-welcome">
      <h1>今天要标注什么？</h1>
      <OnboardingLanes busy={busy}
        onImportImages={() => void importImages()} onImportImageFolder={() => void importImageFolder()}
        onImportVideo={() => void selectVideo()} onImportVideoFolder={() => void selectVideoFolder()} />
      {recentProjects.length > 0 && <section className="chat-recent" aria-labelledby="chat-recent-title">
        <div className="chat-recent-heading"><span id="chat-recent-title">继续最近项目</span><small>最近更新</small></div>
        <div className="chat-recent-list">
          {recentProjects.map(item => <button key={item.id} disabled={busy} title={`最近更新的项目 · ${item.assetCount} 张素材`}
            onClick={() => void openProject(item).catch(e => notify(errorMessage(e), true))}><span>继续</span>{item.name}<small>{item.assetCount} 张素材</small></button>)}
        </div>
      </section>}
      <p className="muted tiny chat-start-hint">选择素材 → 确认项目 → 描述标注要求。也可以把图片或视频直接拖进聊天框。</p>
    </div>
    {/* 输入区同样固定在页面最下方：欢迎语与建议在上方，发送时先确认项目名称与归属，再开始对话。 */}
    <footer className="chat-dock">
      <Composer value={input} onChange={setInput} onSend={() => {
        const text = input.trim();
        if ((!text && !attachments.length) || busy) return;
        // 项目名不再自动取名：建议名取描述首行或首个附件的文件夹名，名称与归属在弹框里由用户确认。
        setProjectPrompt({
          title: '发送第一条消息', confirmLabel: '发送',
          suggest: pendingName || folderName(attachments[0]?.path ?? ''),
          run: async target => {
            // 附件随首条消息一起落库：图片与目录进项目，视频交给会话页的抽帧面板。
            if (attachments.length) {
              const result = await importAttachments(target.id, attachments);
              if (result.videos.length) setPendingVideoImports({ projectId: target.id, files: result.videos });
              if (result.imported || result.skipped) notify(`已导入 ${result.imported} 张${result.skipped ? `，已在项目里 ${result.skipped} 张` : ''}。`);
              setAttachments([]);
            }
            await openProject(target, text || `刚添加了 ${attachments.length} 个文件，请核对项目素材。`);
          }
        });
      }} placeholder="例如：标注工地照片里的安全帽和人员…" busy={busy}
        attachments={attachments} onRemoveAttachment={id => setAttachments(list => list.filter(item => item.id !== id))}>
        <div className="chat-options">
          <FlowPicker disabled={busy} onPick={prompt => { setInput(prompt); document.querySelector<HTMLTextAreaElement>('.chat-home textarea')?.focus(); }} />
          {/* 本机模型与云端接口并列在工具行：不配 API Key 也能开始标注。 */}
          <LocalModelPicker disabled={busy} onPick={prompt => { setInput(prompt); document.querySelector<HTMLTextAreaElement>('.chat-home textarea')?.focus(); }} />
          {/* 模型选择收进输入卡的工具行；默认值语义挂在悬浮提示里。 */}
          <span title="这里的默认值用于新建的对话与任务"><ModelPicker providers={providers} providerId={choice.providerId} model={choice.model} depth={choice.depth} disabled={busy}
            onChange={next => void saveChoice(next)} onDepthChange={next => void saveChoice({ depth: next })} onConfigure={() => void navigate('settings', 'ai')} /></span>
        </div>
        {/* 把落点写在发送之前：用户先知道这句话会落到哪个项目，而不是发完才发现又多了一个项目。 */}
        <span className="composer-hint">{pendingName
          ? pendingExisting ? `将并入已有项目「${pendingExisting.name}」` : `将新建项目「${pendingName}」（发送时可改名）`
          : '发送时确认项目名称'}</span>
      </Composer>
    </footer>
    {/* 多选视频或视频文件夹选出来的候选清单：与拖入多个视频共用同一个组件。 */}
    <VideoPickList picks={drop.picks} onChoose={path => { const target = drop.picks?.projectId; drop.closePicks(); if (target) setVideoStart({ projectId: target, path }); }} onClose={drop.closePicks} />
    {/* 发送 / 导入共用的项目归属确认框：用户在这里命名或选已有项目，确认后才执行真正的动作。 */}
    {projectPrompt && <ProjectResolveDialog title={projectPrompt.title} confirmLabel={projectPrompt.confirmLabel} projects={projects} suggestName={projectPrompt.suggest}
      defaultProjectId={prefs.defaultProjectId ?? ''}
      onRemember={projectId => void savePrefs({ ...prefs, defaultProjectId: projectId || undefined }).catch(e => notify(errorMessage(e), true))}
      onClose={() => setProjectPrompt(null)} onConfirm={handleProjectChoice} />}
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
