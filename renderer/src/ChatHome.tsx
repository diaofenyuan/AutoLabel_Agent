import { useState } from 'react';
import { useApp } from './context';
import { request, errorMessage, getBridge } from './bridge';
import { Composer } from './ui';
import OnboardingLanes from './OnboardingLanes';
import { DropOverlay } from './fileDrop';
import VideoImport from './VideoImport';
import VideoBatchImport from './VideoBatch';
import ModelPicker from './ModelPicker';
import FlowPicker from './FlowPicker';
import LocalModelPicker from './LocalModelPicker';
import ProjectResolveDialog, { type ProjectChoice } from './ProjectResolveDialog';
import { applyProjectDraft } from './projectSetup';
import { VideoPickList, useChatFileDrop, importAttachments, filesToAttachments, materialNote } from './chatDrop';
import { VIDEO_EXTENSION_LABEL } from '../../shared/mediaFormats';
import { directoryName, folderName, sameNameProject } from './projectNaming';
import type { Project } from './types';

/** 卡片上的相对更新时间：与「继续最近项目」的排序口径一致，超过一周直接给日期。 */
function timeAgo(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(time);
  return date.getFullYear() === new Date().getFullYear()
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/**
 * 欢迎页：还没有进入任何项目时落在这里。
 * 会话必须挂在项目下，所以这里不做「不属于任何项目的对话」：
 * 描述或拖入的文件先确认项目归属（命名或选已有），发送后才建好项目并开始对话。
 */
export default function ChatHome() {
  const { projects, project, openProject, refreshProjects, notify, setMediaJob, setMediaTaskId, prefs, savePrefs, providers, navigate, setPendingVideoImports,
    homeDraft: input, setHomeDraft: setInput, homeAttachments: attachments, setHomeAttachments: setAttachments } = useApp();
  const [busy, setBusy] = useState(false);
  // 欢迎页还没有项目时，用户点「选择视频抽帧」要先有一个项目承载抽帧产物；这里存下这次点击建好的项目与选中路径。
  const [videoStart, setVideoStart] = useState<{ projectId: string; path: string } | null>(null);
  // 待发送附件只在当前进程内存保留，跨页面往返不丢；成功发送后清空，退出应用不落盘。
  // 项目归属确认：发送 / 导入都先弹框让用户命名或选已有项目，确认后才真正执行。
  const [projectPrompt, setProjectPrompt] = useState<null | { title: string; confirmLabel: string; suggest: string; run: (project: Project) => Promise<void> }>(null);
  const drop = useChatFileDrop(items => setAttachments(current => {
    const known = new Set(current.map(item => item.path));
    const fresh = items.filter(item => !known.has(item.path));
    return fresh.length ? [...current, ...fresh] : current;
  }));
  // 欢迎页还没有会话，选择模型即写入默认值：新建会话与任务都以它为初值。
  const choice = { providerId: prefs.chatProviderId, model: prefs.chatModel };
  async function saveChoice(next: Partial<typeof choice>) {
    try { await savePrefs({ ...prefs, chatProviderId: next.providerId ?? choice.providerId, chatModel: next.model ?? choice.model }); }
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
    try { await projectPrompt.run(target); }
    // run 里失败（例如附件导入被拒）不能变成未处理拒绝：如实通知，弹框关掉，输入与附件留在原地可重试。
    catch (e) { notify(errorMessage(e), true); }
    setProjectPrompt(null);
  }
  /**
   * 抽帧任务建好后要落到项目概览：欢迎页此时可能还没有打开任何项目（或者还停在上一个项目），
   * 直接切页会让「素材入库后出现在这里」指到别处，所以先把项目上下文切过去再切页。
   * 注意 openProject 会清掉当前提示、也会清空上一个项目的抽帧跟踪，调用方必须把它排在
   * 「播报结果」与「登记进度」之前。
   */
  async function showProjectOverview(projectId: string) {
    const owner = projects.find(item => item.id === projectId);
    try { if (owner && owner.id !== project?.id) await openProject(owner); }
    // 切换失败（例如素材正在切换）不该把用户卡在欢迎页：概览照常打开，提示里已经说明了落点。
    catch { /* 见上：继续切到概览。 */ }
    await navigate('overview');
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
          const result = await request<{ imported?: number; skipped?: number; queued?: boolean; total?: number }>('asset.import', { projectId: target.id, paths, mode: 'copy' });
          await openProject(target, result.queued ? `这批有 ${result.total ?? 0} 张，已转入后台导入任务，完成后即可开始标注` : result.imported ? `刚导入了 ${result.imported} 张图片，请开始标注` : '这批图片之前已经导入过，请核对已有标注');
          // openProject 会清掉当前提示，所以导入结果必须放在它之后播报，否则用户看不到。
          notify(result.queued ? `导入量较大（${result.total ?? 0} 张），已转入后台导入任务：进度见「任务 · 素材任务」，可随时取消。` : `已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`);
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
          // 多个视频先给清单：逐个调参数，或一键按默认参数整批排队，都在清单里选。
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
          const result = await request<{ imported?: number; skipped?: number; queued?: boolean; total?: number }>('asset.import', { projectId: target.id, paths: [directory], mode: 'copy' });
          await openProject(target, result.queued ? `这批有 ${result.total ?? 0} 张，已转入后台导入任务，完成后即可开始标注` : result.imported ? `刚导入了 ${result.imported} 张图片，请开始标注` : '这个文件夹里的图片已经导入过，请核对已有标注');
          // openProject 会清掉当前提示，所以导入结果必须放在它之后播报。
          notify([
            result.queued ? `导入量较大（${result.total ?? 0} 张），已转入后台导入任务：进度见「任务 · 素材任务」，可随时取消。` : `已导入 ${result.imported} 张，跳过 ${result.skipped} 张。`,
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
      <p className="chat-welcome-subtitle">导入图片或视频，也可以直接描述你想完成的标注。</p>
      {/* 欢迎页输入框是首要入口：先描述任务，再按需选择素材或配置模型。 */}
      <footer className="chat-dock">
        <Composer value={input} onChange={setInput} onSend={() => {
          const text = input.trim();
          if ((!text && !attachments.length) || busy) return;
          // 项目名不再自动取名：建议名取描述首行或首个附件的文件夹名，名称与归属在弹框里由用户确认。
          setProjectPrompt({
            title: '发送第一条消息', confirmLabel: '发送',
            suggest: pendingName || folderName(attachments[0]?.path ?? ''),
            run: async target => {
              // 附件随首条消息一起落库：图片与目录进项目，视频（含文件夹里的）交给会话页的抽帧面板。
              // 素材名单写进消息文本：会话历史里才能看出开局发的是什么。
              if (attachments.length) {
                // 导入失败就不开张这条会话：助手会照着「已添加 N 个文件」处理空项目。输入与附件原样保留，重试即可。
                const result = await importAttachments(target.id, attachments);
                if (result.videos.length) setPendingVideoImports({ projectId: target.id, files: result.videos });
                if (result.queued) notify(`这批有 ${result.total ?? 0} 张，导入量较大已转入后台任务：进度见「任务 · 素材任务」，可随时取消。`); else if (result.imported || result.skipped) notify(`已导入 ${result.imported} 张${result.skipped ? `，已在项目里 ${result.skipped} 张` : ''}。`);
              }
              const firstMessage = attachments.length
                ? text ? `${text}\n${materialNote(attachments)}` : `刚添加了 ${attachments.length} 个文件，请核对项目素材。${materialNote(attachments)}`
                : text;
              await openProject(target, firstMessage);
              setInput(''); setAttachments([]);
            }
          });
        }} placeholder="例如：标注工地照片里的安全帽和人员…" busy={busy}
          attachments={attachments} onRemoveAttachment={id => setAttachments(list => list.filter(item => item.id !== id))}
          onAttachFiles={files => void filesToAttachments(files).then(list => { if (list.length) setAttachments(previous => [...previous, ...list]); }).catch(e => notify(errorMessage(e), true))}
          // 把落点写在发送之前：用户先知道这句话会落到哪个项目，而不是发完才发现又多了一个项目。
          hint={pendingName
            ? pendingExisting ? `将并入已有项目「${pendingExisting.name}」` : `将新建项目「${pendingName}」（发送时可改名）`
            : '发送时确认项目名称'}>
          <div className="chat-options">
            <FlowPicker disabled={busy} onPick={prompt => { setInput(prompt); document.querySelector<HTMLTextAreaElement>('.chat-home textarea')?.focus(); }} />
            {/* 本机模型与云端接口并列在工具行：不配 API Key 也能开始标注。 */}
            <LocalModelPicker disabled={busy} onPick={prompt => { setInput(prompt); document.querySelector<HTMLTextAreaElement>('.chat-home textarea')?.focus(); }} />
            {/* 模型选择收进输入卡的工具行；默认值语义挂在悬浮提示里。 */}
            <span title="这里的默认值用于新建的对话与任务"><ModelPicker providers={providers} providerId={choice.providerId} model={choice.model} disabled={busy}
              onChange={next => void saveChoice(next)} onConfigure={() => void navigate('settings', 'ai')} /></span>
          </div>
        </Composer>
      </footer>
      <OnboardingLanes busy={busy}
        onImportImages={() => void importImages()} onImportImageFolder={() => void importImageFolder()}
        onImportVideo={() => void selectVideo()} onImportVideoFolder={() => void selectVideoFolder()} />
      {recentProjects.length > 0 && <section className="chat-recent" aria-labelledby="chat-recent-title">
        {/* 排序口径写在卡片上（相对更新时间），不再放一个没有对应内容的「最近更新」表头。 */}
        <div className="chat-recent-heading"><span id="chat-recent-title">继续最近项目</span></div>
        <div className="chat-recent-list">
          {recentProjects.map(item => {
            const updated = timeAgo(String(item.updatedAt ?? ''));
            return <button key={item.id} disabled={busy} title={`最近更新的项目 · ${item.assetCount} 张素材`}
              onClick={() => void openProject(item).catch(e => notify(errorMessage(e), true))}><span>继续</span><span className="truncate">{item.name}</span><small>{item.assetCount} 张素材{updated ? ` · ${updated}` : ''}</small></button>;
          })}
        </div>
      </section>}
    </div>
    {/* 多选视频或视频文件夹选出来的候选清单：与拖入多个视频共用同一个组件。 */}
    <VideoPickList picks={drop.picks} onChoose={path => { const target = drop.picks?.projectId; drop.closePicks(); if (target) setVideoStart({ projectId: target, path }); }}
      onChooseAll={drop.chooseAll} onClose={drop.closePicks} />
    {/* 一键抽帧：整批按默认参数建任务，首个任务交给进度条跟踪，其余排在其后逐个推进。 */}
    {drop.batch && (() => {
      const batch = drop.batch;
      return <VideoBatchImport key={batch.projectId} projectId={batch.projectId} files={batch.files}
        onClose={drop.closeBatch}
        onCreated={async ({ jobs, failed, stopped }) => {
          drop.closeBatch();
          const pending = stopped ? batch.files.length - jobs.length - failed : 0;
          await showProjectOverview(batch.projectId);
          setMediaTaskId(jobs[0].id); setMediaJob({ id: jobs[0].id, following: jobs.slice(1).map(job => job.id) });
          notify(`已为 ${jobs.length} 个视频创建抽帧任务，正在排队逐个处理${failed ? `，另有 ${failed} 个未能创建` : ''}${pending ? `，停止时还有 ${pending} 个未处理` : ''}；素材就绪后自动导入，进度见侧栏「任务」。`);
        }} />;
    })()}
    {/* 发送 / 导入共用的项目归属确认框：用户在这里命名或选已有项目，确认后才执行真正的动作。 */}
    {projectPrompt && <ProjectResolveDialog title={projectPrompt.title} confirmLabel={projectPrompt.confirmLabel} projects={projects} suggestName={projectPrompt.suggest}
      defaultProjectId={prefs.defaultProjectId ?? ''}
      onRemember={projectId => void savePrefs({ ...prefs, defaultProjectId: projectId || undefined }).catch(e => notify(errorMessage(e), true))}
      onClose={() => setProjectPrompt(null)} onConfirm={handleProjectChoice} />}
    {/* 拖入视频与点击「选择视频抽帧」都走同一个抽帧面板：区别只在于项目是拖放时建的还是按钮提前建好的。 */}
    {(drop.video ?? videoStart) && (() => {
      const source = drop.video ?? videoStart!;
      const close = () => { setVideoStart(null); drop.closeVideo(); };
      return <VideoImport key={source.path} projectId={source.projectId} initialSourcePath={source.path} onClose={close}
        onCreated={async (job, temporarySource) => {
          close();
          await showProjectOverview(source.projectId);
          setMediaTaskId(job.id); setMediaJob({ id: job.id, temporarySource });
          notify('已创建抽帧任务，素材入库后出现在这里；进度可在侧栏「任务」里查看。');
        }} />;
    })()}
  </div>;
}
