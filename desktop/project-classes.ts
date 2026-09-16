import { DesktopError } from './validation';

interface ProjectClass { id: string; name: string; color: string }
interface ProjectLike { id: string; name: string; classes: ProjectClass[] }
interface EngineLike { request(command: string, payload?: Record<string, unknown>, timeout?: number): Promise<unknown> }
export interface AddedClasses { projectId: string; added: string[]; skipped: string[]; classes: ProjectClass[] }

/**
 * 新增项目类别（只增不改）。
 *
 * 助手原先完全没有建类别能力，用户说「类别用粉色手办」时只能被打断去手工配置，
 * 而给它的指引还指向不存在的「项目设置」。放开整个 `project.update` 又太宽——settings 里含模板与规则，
 * 破坏面过大。因此这里只做「追加类别名」：读回当前类别、跳过重名、补上配色，其余字段原样带回。
 *
 * 返回值直接说明「真正新增了哪些、跳过了哪些」：让调用方自己比对会得出
 * 「重名也算新增」这种自相矛盾的结果，助手据此汇报就会骗人。
 */
export async function addProjectClasses(engine: EngineLike, payload: { projectId: string; names: string[] }): Promise<AddedClasses> {
  const projects = await engine.request('project.list') as ProjectLike[];
  const current = projects.find(item => item.id === payload.projectId);
  if (!current) throw new DesktopError('COMMAND_DENIED', '项目不存在或尚未打开');
  const requested = [...new Set(payload.names.map(name => name.trim()).filter(Boolean))];
  const existing = new Set(current.classes.map(item => item.name));
  const additions = requested.filter(name => !existing.has(name));
  if (!additions.length) return { projectId: current.id, added: [], skipped: requested, classes: current.classes };
  const palette = ['#4a83ff', '#e0559b', '#22a06b', '#f2994a', '#9b51e0', '#eb5757'];
  const classes = [...current.classes, ...additions.map((name, index) => ({
    id: crypto.randomUUID(), name, color: palette[(current.classes.length + index) % palette.length] }))];
  // 只发 classes 与 projectId：设置、名称、模板都不在这次写入范围内。
  const updated = await engine.request('project.update', { projectId: current.id, classes }) as ProjectLike;
  return { projectId: current.id, added: additions, skipped: requested.filter(name => !additions.includes(name)), classes: updated.classes ?? classes };
}
