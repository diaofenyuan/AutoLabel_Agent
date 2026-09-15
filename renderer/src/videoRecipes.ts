import { VIDEO_DENSITY_LABELS, type VideoExtractionRecipe, type VideoRecipeDraft } from '../../shared/media';
import { request } from './bridge';

/**
 * 抽帧配方的读取与呈现。
 *
 * 配方存放在引擎库里（`media.recipe.*`），不属于任何项目，因此换数据目录、迁移机器或从备份恢复后
 * 依然可用；界面侧只负责取值、套用与把差异讲清楚，不再自己维护一份本地存储。
 */

export function listRecipes(): Promise<VideoExtractionRecipe[]> {
  return request<VideoExtractionRecipe[]>('media.recipe.list', {});
}

export function saveRecipe(draft: VideoRecipeDraft): Promise<VideoExtractionRecipe> {
  return request<VideoExtractionRecipe>('media.recipe.save', draft as unknown as Record<string, unknown>);
}

export function removeRecipe(recipeId: string): Promise<{ recipeId: string; deleted: boolean }> {
  return request<{ recipeId: string; deleted: boolean }>('media.recipe.delete', { recipeId });
}

/** 套用后的一行人话摘要：配方改了高级区里的东西时，用户不必展开折叠区也能确认结果。 */
export function recipeSummary(recipe: VideoExtractionRecipe): string {
  const density = recipe.density === 'custom'
    ? `自定义采样（${recipe.customMode === 'interval' ? `每 ${recipe.customValue} 秒` : recipe.customMode === 'every_n' ? `每 ${recipe.customValue} 个源帧` : `${recipe.customValue} 帧/秒`}）`
    : VIDEO_DENSITY_LABELS[recipe.density];
  return [density, recipe.resize ? `输出 ${recipe.width} × ${recipe.height}（${recipe.fit === 'stretch' ? '拉伸' : '等比留边'}）` : '保持原始尺寸', recipe.format === 'jpg' ? `JPEG（质量 ${recipe.quality}）` : 'PNG'].join(' · ');
}

/**
 * 配方与当前项目的差异提示。
 *
 * 抽帧结果本身与任务类型无关，所以差异不阻挡套用 —— 但配方记录的是「当时为哪类标注准备的素材」，
 * 类别集对不上时用户应当先知道，而不是等抽完几百帧才发现标注任务不是自己想要的。
 */
export function recipeScopeNote(recipe: VideoExtractionRecipe, project: { taskType: string; classes: Array<{ name: string }> } | null): string {
  if (!project) return '';
  const taskNames: Record<string, string> = { detect: '检测框', obb: '旋转框', segment: '多边形', pose: '关键点', classify: '图片分类' };
  const notes: string[] = [];
  if (recipe.taskType && recipe.taskType !== project.taskType)
    notes.push(`配方面向${taskNames[recipe.taskType] ?? recipe.taskType}，当前项目是${taskNames[project.taskType] ?? project.taskType}`);
  if (recipe.classNames.length) {
    const current = new Set(project.classes.map(item => item.name));
    const missing = recipe.classNames.filter(name => !current.has(name));
    const extra = [...current].filter(name => !recipe.classNames.includes(name));
    if (missing.length || extra.length)
      notes.push(`类别集不一致（配方缺少：${missing.join('、') || '无'}；项目多出：${extra.join('、') || '无'}）`);
  }
  return notes.length ? `抽帧仍按配方参数执行；但${notes.join('；')}。` : '';
}
