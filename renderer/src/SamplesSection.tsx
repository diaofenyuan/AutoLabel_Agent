import { Scan } from 'lucide-react';
import { Button, Notice } from './ui';
import { useExampleProject } from './exampleProject';
import { isDemo } from './bridge';

/**
 * 设置页的示例入口。与首屏「先试一下」共用同一个 useExampleProject，
 * 两处入口走同一条链路，不各自维护载入逻辑。
 */
export default function SamplesSection() {
  const example = useExampleProject();
  return <section className="settings-section"><h2>示例</h2>
    <Notice>示例使用内置合成图片与预置人工标注，仅用于体验完整流程，不会覆盖已有项目；重复载入只会打开同一个项目。</Notice>
    <div className="setting-row"><div><h3>载入示例项目</h3><p>{isDemo ? '浏览器演示会在本地演示空间创建示例项目。' : '在当前工作空间创建示例项目，并打开它继续对话。'}</p></div>
      <Button className="primary" busy={example.busy} aria-label="载入示例" onClick={() => void example.load()}><Scan size={14} />载入示例</Button></div>
  </section>;
}
