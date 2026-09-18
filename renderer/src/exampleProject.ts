import { useState } from 'react';
import { useApp } from './context';
import { errorMessage, request } from './bridge';
import type { Project } from './types';

/**
 * 载入示例项目：内置合成图片与预置人工标注，不需要配置任何接口。
 * 首屏「先试一下」与设置页「示例」共用这一条链路，重复载入只会打开同一个项目。
 *
 * 忙碌状态只留在组件内部、不向所在页面申报：设置页会把「忙」当成未保存来拦离开，
 * 那会在载入完成后的正常跳转上把人挡下来。
 */
export function useExampleProject() {
  const { refreshProjects, openProject, notify } = useApp();
  const [busy, setBusy] = useState(false);
  async function load() {
    if (busy) return;
    setBusy(true);
    try {
      const project = await request<Project>('project.example');
      await refreshProjects();
      await openProject(project);
      notify('示例项目已载入，可以先看看素材与已有的标注。');
    } catch (e) { notify(errorMessage(e), true); }
    finally { setBusy(false); }
  }
  return { load, busy };
}
