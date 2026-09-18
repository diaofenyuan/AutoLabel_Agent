import { CheckCircle2, Film, FolderPlus, Image as ImageIcon, Play, Settings2, Sparkles } from 'lucide-react';
import { useAiConfigured } from './aiState';
import { useApp } from './context';
import { useExampleProject } from './exampleProject';

/**
 * 欢迎页的三条路：按「代价从低到高」排开，让第一次打开软件的人不必猜先做什么。
 * 第 1 条不需要任何配置（示例项目自带合成图片与预置标注），第 3 条要配接口；
 * 三条都落在既有链路上，这里只负责把顺序和代价讲清楚，不新增任何能力。
 */
export default function OnboardingLanes({ busy, onImportImages, onImportImageFolder, onImportVideo, onImportVideoFolder }: {
  busy: boolean;
  onImportImages: () => void;
  onImportImageFolder: () => void;
  onImportVideo: () => void;
  onImportVideoFolder: () => void;
}) {
  const { prefs, navigate } = useApp();
  const configured = useAiConfigured();
  const example = useExampleProject();
  return <div className="onboarding-lanes">
    <section className="onboarding-lane">
      <header><span className="onboarding-step">1</span><h2>先试一下</h2></header>
      <p>内置合成图片与预置标注，不用配置任何接口，就能走完导入、标注、复核、导出。</p>
      <div className="onboarding-actions">
        <button className="onboarding-primary" disabled={busy || example.busy} onClick={() => void example.load()}><Play size={14} />载入示例项目</button>
      </div>
    </section>
    <section className="onboarding-lane">
      <header><span className="onboarding-step">2</span><h2>导入我的素材</h2></header>
      <p>选图片直接标注；选视频先抽帧成图片，入库后同样可以标注。</p>
      <div className="onboarding-actions onboarding-imports">
        <button disabled={busy} onClick={onImportImages}><ImageIcon size={14} />导入图片</button>
        <button disabled={busy} onClick={onImportImageFolder}><FolderPlus size={14} />导入图片文件夹</button>
        <button disabled={busy} onClick={onImportVideo}><Film size={14} />导入视频</button>
        <button disabled={busy} onClick={onImportVideoFolder}><FolderPlus size={14} />导入视频文件夹</button>
      </div>
    </section>
    <section className="onboarding-lane">
      <header><span className="onboarding-step">3</span><h2>让 AI 自动标注</h2></header>
      {configured
        ? <p><CheckCircle2 size={13} />当前模型：{prefs.chatModel || '已在设置里配置'}。在下面的输入框描述要求即可开始。</p>
        : <p>配置一个接口与 API Key 后，助手就能按你的描述批量标注。</p>}
      <div className="onboarding-actions">
        <button disabled={busy} onClick={() => void navigate('settings', 'ai')}>{configured ? <><Settings2 size={14} />调整 AI 配置</> : <><Sparkles size={14} />配置 AI</>}</button>
      </div>
    </section>
  </div>;
}
