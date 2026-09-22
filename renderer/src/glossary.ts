/**
 * 术语人话化：每个词给出「一句话人话 + 什么时候用得上」。
 *
 * 这里只收「新人第一次遇到会卡住」的词，不收通用计算机词汇。展示层见 Term.tsx：
 * 术语第一次出现的那个位置挂上它，用户不必离开当前界面去别处查，也不用先理解整套概念才能动手。
 * 数据与展示分开，纯数据可以被测试直接断言，不必拉起 React。
 */
export interface GlossaryEntry {
  /** 界面上原样显示的术语。 */
  term: string;
  /** 一句话人话，用来替换或解释术语。 */
  plain: string;
  /** 什么时候用得上，补在悬浮提示后面。 */
  detail: string;
}

export const glossary = {
  frameExtract: {
    term: '抽帧',
    plain: '把视频拆成一张张图片',
    detail: '视频不能直接标注，拆成图片后才能像普通素材一样画框、复核。',
  },
  truthSet: {
    term: '真值集',
    plain: '人工确认过、当作参考答案的标注',
    detail: '用来给自动标注打分，代表「正确答案」，本身不参与训练。',
  },
  datasetVersion: {
    term: '数据集版本',
    plain: '某一刻定稿的数据快照',
    detail: '版本不可修改，训练与导出都从这里取数据，所以同样的设置能跑出同样的结果。',
  },
  recipe: {
    term: '配方',
    plain: '训练参数模板',
    detail: '把轮数、批大小这些参数存成一份可复用的设置，下次换数据也能照用。',
  },
  run: {
    term: '运行',
    plain: '一次批量标注',
    detail: '一次运行包含这一批图片的请求、失败样本与重试记录，结果在任务页回看。',
  },
  unknownResult: {
    term: '结果未知',
    plain: '请求发出去了，但没等到结果',
    detail: '服务商那边可能已经处理并计费，所以重发必须由你确认，不会自动重试。',
  },
  tracks: {
    term: '轨迹',
    plain: '同一个对象在视频里的连续位置',
    detail: '关键帧是这条轨迹上人工确认过的时刻，其余帧由算法补出来待你复核。',
  },
  thinkingDepth: {
    term: '思考深度',
    plain: '助手这次愿意花多少轮次',
    detail: '快速档少轮次、不额外自检；深入档多轮次并在结束后做一次结构化自检。',
  },
  structuredOutput: {
    term: '结构化输出',
    plain: '模型按约定好的格式交答案',
    detail: '标注结果是一份固定结构的 JSON，能直接入库核对；不具备它的模型跑标注会以「返回的不是标注结果」收场。',
  },
  toolCall: {
    term: '工具调用',
    plain: '模型能主动调用软件里的操作',
    detail: '只有验证过这项能力的模型才能当对话助手：它会真的建任务、读结果，而不是只给建议。',
  },
  yoloDataset: {
    term: 'YOLO 数据集',
    plain: '一种常见的标注数据打包格式',
    detail: '导出成它就能拿去训练或交给别的工具：每张图配一个同名 txt 标签文件。',
  },
  openVocabulary: {
    term: '开放词汇',
    plain: '类别不写死，识别什么由你现场说',
    detail: '在对话里写「人 / 汽车 / 交通标志」这类名字就能按词去框；中文名需在内置词表内，否则改填英文名。',
  },
  candidateLabel: {
    term: '候选标注',
    plain: '模型给的答案，还没经你确认',
    detail: '候选不会覆盖人工改过的内容；核对完点「保存并确认」才转正，导出与训练只认确认过的。',
  },
  desensitize: {
    term: '脱敏',
    plain: '去掉能认出你和密钥的内容再保存',
    detail: '诊断包会剔除 API Key、接口地址、图片与个人路径，只留排错真正需要的信息。',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof glossary;

export const glossaryKeys = Object.keys(glossary) as GlossaryKey[];

/** 悬浮提示：术语与人话放在一起，读的人不必先记住哪个是术语。 */
export function explain(name: GlossaryKey): string {
  const entry = glossary[name];
  return `${entry.term}：${entry.plain}。${entry.detail}`;
}
