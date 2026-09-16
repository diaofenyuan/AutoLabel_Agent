import { useState } from 'react';
import { Scan } from 'lucide-react';
import { useApp } from './context';
import { request, errorMessage, isDemo } from './bridge';
import { Button, Notice } from './ui';
import type { Project } from './types';

/**
 * 示例入口：只在设置里出现，首屏与空态不再引导。
 * 载入后直接打开该项目继续对话，所以这里不向设置页申报「忙」：那会触发设置页的离开守卫，
 * 把载入完成后的正常跳转挡下来。
 */
export default function SamplesSection() {
  const { refreshProjects, openProject, notify } = useApp();
  const [busy, setBusy] = useState(false);
  async function load() {
    if (busy) return;
    setBusy(true);
    try {
      const project = await request<Project>('project.example');
      await refreshProjects();
      await openProject(project);
      notify('示例项目已载入。');
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  return <section className="settings-section"><h2>示例</h2>
    <Notice>示例使用内置合成图片与预置人工标注，仅用于体验完整流程，不会覆盖已有项目；重复载入只会打开同一个项目。</Notice>
    <div className="setting-row"><div><h3>载入示例项目</h3><p>{isDemo ? '浏览器演示会在本地演示空间创建示例项目。' : '在当前工作空间创建示例项目，并打开它继续对话。'}</p></div>
      <Button className="primary" busy={busy} aria-label="载入示例" onClick={() => void load()}><Scan size={14} />载入示例</Button></div>
  </section>;
}
