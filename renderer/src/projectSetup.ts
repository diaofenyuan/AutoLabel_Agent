import { request } from './bridge';
import type { Project } from './types';

/** 类别与「标注要求」的分隔符：中文顿号、各类逗号、分号与换行都算。 */
export const CLASS_SEPARATORS = /[、,，;；\n]/;
export const MAX_CLASSES = 20;
export const MAX_CLASS_NAME = 60;

/** 把一行文本切成类别名：去空、去重、保持输入顺序。 */
export function parseClassNames(text: string): string[] {
  return [...new Set(text.split(CLASS_SEPARATORS).map(name => name.trim()).filter(Boolean))];
}

/**
 * 新建项目时一起落下的「类别」与「标注要求」。
 *
 * 走的是与「类别与点位模板」完全相同的两条命令，因此运行、导出、复现看到的是同一份模板：
 * - 类别 → project.classes.add（引擎分配 id 与颜色，导出时就是标签里的类别名）
 * - 标注要求 → project.settings.rules（已随项目模板冻结进每次运行，并作为 template.rules 发给模型）
 */
export async function applyProjectDraft(projectId: string, classes: string[], rules: string): Promise<Project | undefined> {
  if (!classes.length && !rules.trim()) return undefined;
  if (classes.length) await request('project.classes.add', { projectId, names: classes });
  if (rules.trim()) await request('project.update', { projectId, settings: { rules: rules.trim() } });
  // 取回最新的项目文档：紧接着的导入与开会话都要用带类别的那一份，不能拿新建时的空副本。
  return request<Project>('project.open', { projectId });
}
