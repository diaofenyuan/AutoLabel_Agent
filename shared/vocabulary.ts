import type { LabelClass } from './protocol.ts';

/**
 * 把开放词汇的文本类别映射到项目类别。
 *
 * 规则只有三步，顺序固定：先按名字精确匹配（去空白 + 忽略大小写），再查中文同义词表，
 * 仍未命中的一律置 null（界面显示成「忽略」）。**不做模糊猜测**：类别映射错一次，
 * 整批候选都会带错标签，宁可让用户确认一次，也不能替他猜。
 */
const SYNONYMS: string[][] = [
  ['person', '人', '行人', '人群', '人脸'],
  ['car', '汽车', '轿车', '小汽车', '车辆', '机动车'],
  ['truck', '卡车', '货车', '载重车', '自卸车'],
  ['bus', '公交车', '巴士', '客车'],
  ['motorcycle', '摩托车', '电动车', '机车'],
  ['bicycle', '自行车', '单车'],
  ['train', '火车', '列车', '火车车厢'],
  ['boat', '船', '船舶', '轮船'],
  ['airplane', '飞机', '客机'],
  ['traffic light', '交通灯', '红绿灯', '信号灯'],
  ['traffic sign', '交通标志', '标志牌', '指示牌'],
  ['stop sign', '停车标志'],
  ['helmet', '安全帽', '头盔'],
  ['safety vest', '反光背心', '安全背心'],
  ['chair', '椅子', '座椅'],
  ['dog', '狗', '犬'],
  ['cat', '猫'],
  ['face', '人脸', '面部'],
  ['license plate', '车牌', '号牌'],
];

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const groupOf = (() => {
  const index = new Map<string, number>();
  SYNONYMS.forEach((group, position) => { for (const name of group) index.set(normalize(name), position); });
  return (value: string) => index.get(normalize(value));
})();

export type ClassMapReason = 'exact' | 'alias' | 'none';

export interface DerivedClassMapEntry {
  /** 本次请求的文本类别名，原样保留。 */
  text: string;
  projectClassId: string | null;
  reason: ClassMapReason;
}

export interface DerivedClassMap {
  /** 直接喂给 local.run.create / flow.local 步骤的 classMap：键是 textClasses 的下标。 */
  classMap: Record<string, string | null>;
  entries: DerivedClassMapEntry[];
  /** 未命中的条数；界面要把它们显式显示成「忽略」，等用户确认而不是静默吞掉。 */
  unmatched: number;
}

export function deriveClassMap(textClasses: string[], projectClasses: Array<Pick<LabelClass, 'id' | 'name'>>): DerivedClassMap {
  const byName = new Map<string, string>();
  for (const item of projectClasses) byName.set(normalize(item.name), item.id);
  const classMap: Record<string, string | null> = {};
  const entries: DerivedClassMapEntry[] = [];
  textClasses.forEach((text, index) => {
    const exact = byName.get(normalize(text));
    if (exact) { classMap[String(index)] = exact; entries.push({ text, projectClassId: exact, reason: 'exact' }); return; }
    const group = groupOf(text);
    const alias = group === undefined ? undefined
      : projectClasses.find(item => groupOf(item.name) === group)?.id;
    if (alias) { classMap[String(index)] = alias; entries.push({ text, projectClassId: alias, reason: 'alias' }); return; }
    // 未命中：明确记为忽略，由用户在界面上确认或改。
    classMap[String(index)] = null;
    entries.push({ text, projectClassId: null, reason: 'none' });
  });
  return { classMap, entries, unmatched: entries.filter(entry => entry.reason === 'none').length };
}
