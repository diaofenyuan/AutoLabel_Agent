import { VIDEO_DENSITY_LABELS, type VideoDensity, type VideoExtractionRecipe } from '../../shared/media';

/**
 * 抽帧配方的本机持久化。
 *
 * 计划明确优先只做前端持久化：配方就是「同一类素材会反复做出的那组选择」，跨设备/跨项目同步需要
 * 动引擎 Store schema，收益与代价不成比例，因此落在 localStorage。内置推荐配方只存在于代码里，
 * 不写入存储——否则后续版本调整推荐值时，用户会同时看到「旧推荐」与「新推荐」。
 */

const STORAGE_KEY = 'autolabel.videoRecipes.v1';
const MAX_RECIPES = 50;
const MAX_NAME = 40;
const DENSITIES: VideoDensity[] = ['dense', 'standard', 'sparse', 'custom'];
const MODES = ['interval', 'every_n', 'fps'] as const;

/** 内置推荐配方：覆盖计划里点名的三类素材，值本身取自当前默认与既有参数范围。 */
export const BUILTIN_RECIPES: VideoExtractionRecipe[] = [
  { id: 'builtin-phone-portrait', name: '手机竖屏 · 手持', builtin: true, density: 'dense', customMode: 'interval', customValue: '1', resize: false, width: '640', height: '640', fit: 'contain', format: 'png', quality: '3' },
  { id: 'builtin-fixed-camera', name: '监控固定机位', builtin: true, density: 'sparse', customMode: 'interval', customValue: '1', resize: false, width: '640', height: '640', fit: 'contain', format: 'jpg', quality: '3' },
  { id: 'builtin-fast-motion', name: '高速运动 · 车辆与体育', builtin: true, density: 'custom', customMode: 'fps', customValue: '5', resize: false, width: '640', height: '640', fit: 'contain', format: 'png', quality: '3' }
];

/** 只接受安全整数文本，避免把 "12.5" 或空串写进配方后套用时被引擎拒绝。 */
function integerText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  return /^\d+$/.test(text) ? text : fallback;
}

/** 采样值放宽到小数与科学计数的常见写法，但必须是有限正数。 */
function numberText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  const parsed = Number(text);
  return text && Number.isFinite(parsed) && parsed > 0 ? text.slice(0, 24) : fallback;
}

/**
 * 存储里的内容当作不可信输入：逐字段校验并回退到默认值，只把「有名字」当作必备条件。
 * 这样即便用户手改过 localStorage，读回来的仍是一个能被表单与引擎接受的对象。
 */
export function normalizeRecipe(input: unknown, fallbackId: string): VideoExtractionRecipe | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() && !raw.id.startsWith('builtin-') ? raw.id.trim().slice(0, 64) : fallbackId;
  const density = DENSITIES.includes(raw.density as VideoDensity) ? raw.density as VideoDensity : 'standard';
  const customMode = (MODES as readonly string[]).includes(String(raw.customMode)) ? raw.customMode as typeof MODES[number] : 'interval';
  const quality = integerText(raw.quality, '3');
  return {
    id, name, density, customMode,
    customValue: customMode === 'every_n' ? integerText(raw.customValue, '10') : numberText(raw.customValue, '1'),
    resize: raw.resize === true,
    width: integerText(raw.width, '640'),
    height: integerText(raw.height, '640'),
    fit: raw.fit === 'stretch' ? 'stretch' : 'contain',
    format: raw.format === 'jpg' ? 'jpg' : 'png',
    quality: Number(quality) >= 2 && Number(quality) <= 31 ? quality : '3'
  };
}

/** 读取用户配方；存储不可用（隐私模式、配额耗尽）时退化为「只有内置推荐」，不影响弹窗可用。 */
export function loadUserRecipes(): VideoExtractionRecipe[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_RECIPES).map((item, index) => normalizeRecipe(item, `recipe-${index}`)).filter((item): item is VideoExtractionRecipe => item !== null);
  } catch { return []; }
}

export function allRecipes(user: VideoExtractionRecipe[]): VideoExtractionRecipe[] { return [...BUILTIN_RECIPES, ...user]; }

function persist(recipes: VideoExtractionRecipe[]) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes.slice(0, MAX_RECIPES))); }
  catch { throw new Error('无法写入本机存储，配方只在本次会话内有效。'); }
}

/** 同名用户配方视为更新而非新增：否则反复保存会攒出一串无法区分的同名项。 */
export function saveRecipe(recipes: VideoExtractionRecipe[], recipe: VideoExtractionRecipe): VideoExtractionRecipe[] {
  const next = [...recipes.filter(item => item.name !== recipe.name && item.id !== recipe.id), recipe].slice(-MAX_RECIPES);
  persist(next);
  return next;
}

export function removeRecipe(recipes: VideoExtractionRecipe[], id: string): VideoExtractionRecipe[] {
  const next = recipes.filter(item => item.id !== id);
  persist(next);
  return next;
}

/** 套用后的一行人话摘要：配方改了高级区里的东西时，用户不必展开折叠区也能确认结果。 */
export function recipeSummary(recipe: VideoExtractionRecipe): string {
  const density = recipe.density === 'custom'
    ? `自定义采样（${recipe.customMode === 'interval' ? `每 ${recipe.customValue} 秒` : recipe.customMode === 'every_n' ? `每 ${recipe.customValue} 个源帧` : `${recipe.customValue} 帧/秒`}）`
    : VIDEO_DENSITY_LABELS[recipe.density];
  return [density, recipe.resize ? `输出 ${recipe.width} × ${recipe.height}（${recipe.fit === 'stretch' ? '拉伸' : '等比留边'}）` : '保持原始尺寸', recipe.format === 'jpg' ? `JPEG（质量 ${recipe.quality}）` : 'PNG'].join(' · ');
}
