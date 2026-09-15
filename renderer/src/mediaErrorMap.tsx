import { Button } from './ui';

/**
 * 引擎媒体错误码 → 面向用户的说明与可执行动作。
 *
 * 引擎对旋转、HDR、几何信息的处理是「宁可拒绝也不猜测」的有意设计（见 VideoFrames.java 的
 * rotation() 与 color_transfer 判定），本模块只做呈现层映射：不改错误码语义、不放宽任何校验，
 * 只把「卡在哪一步」变成「下一步能做什么」。
 *
 * 动作由调用方按自身能力提供 handler，缺少 handler 的动作不渲染——避免出现点了没反应的按钮。
 */
export type MediaErrorActionId = 'transcode' | 'copyCommand' | 'reselect' | 'reduceDensity' | 'openMediaRuntime' | 'retry';
export type MediaErrorActionHandlers = { [K in MediaErrorActionId]?: () => void };

interface MediaErrorEntry { title: string; detail: string; actions: MediaErrorActionId[] }

const ACTION_LABELS: Record<MediaErrorActionId, string> = {
  transcode: '一键转码并重试',
  copyCommand: '复制转码命令',
  reselect: '重新选择视频',
  reduceDensity: '降低采样密度',
  openMediaRuntime: '打开媒体运行时设置',
  retry: '重试'
};

/** 转码类兜底动作的固定出口：转码后几何与色彩近似恒定，引擎的严格校验即可通过。 */
const TRANSCODE_ACTIONS: MediaErrorActionId[] = ['transcode', 'copyCommand', 'reselect'];

const ENTRIES: Record<string, MediaErrorEntry> = {
  video_rotation_unsupported: {
    title: '这段视频的旋转信息不常见，需要先转码',
    detail: '引擎只接受无镜像的 0°、90°、180°、270° 显示矩阵。它不会猜测方向，以免抽出的帧整体转错。',
    actions: TRANSCODE_ACTIONS
  },
  video_color_unsupported: {
    title: '这是 HDR 视频，需要先转成普通色彩范围',
    detail: '引擎不会替 HDR 猜测色调映射，否则帧的颜色不可信，标注结果也会失真。',
    actions: TRANSCODE_ACTIONS
  },
  video_geometry_unsupported: {
    title: '这段视频的像素比例或时间基准无法确认',
    detail: '引擎要求几何信息明确才开工，需要先转成标准方形像素的视频。',
    actions: TRANSCODE_ACTIONS
  },
  video_timestamp_invalid: {
    title: '视频时间戳重复或倒退',
    detail: '引擎不猜测修复时间戳，需要先转码为恒定帧率的文件。',
    actions: TRANSCODE_ACTIONS
  },
  video_timebase_changed: {
    title: '视频中途改变了时间基准',
    detail: '这类文件无法按统一网格抽帧，需要先转码。',
    actions: TRANSCODE_ACTIONS
  },
  video_dimensions_changed: {
    title: '视频中途改变了画面尺寸',
    detail: '引擎要求整段尺寸一致，需要先转码。',
    actions: TRANSCODE_ACTIONS
  },
  video_geometry_changed: {
    title: '视频中途改变了像素比例',
    detail: '引擎要求整段几何一致，需要先转码。',
    actions: TRANSCODE_ACTIONS
  },
  video_probe_failed: {
    title: '无法读取这个视频',
    detail: '文件可能损坏、加密，或封装格式不在支持范围内。转码通常能绕开这类容器问题。',
    actions: TRANSCODE_ACTIONS
  },
  video_image_invalid: {
    title: '抽出的帧校验失败',
    detail: '这是引擎的完整性校验，通常说明解码过程不可信，建议先转码再试。',
    actions: TRANSCODE_ACTIONS
  },
  video_frame_mismatch: {
    title: '输出帧与来源帧不能一一对应',
    detail: '引擎要求逐帧可复核，不对应就不发布结果。建议先转码为恒定参数的文件。',
    actions: TRANSCODE_ACTIONS
  },
  video_protocol_invalid: {
    title: '媒体管道输出不符合预期',
    detail: '可能是编解码器与当前 FFmpeg 版本不兼容，建议先转码再试。',
    actions: TRANSCODE_ACTIONS
  },
  // 桌面侧「一键转码」兜底的失败路径：转码本身没成功时，主出路回到可复制的命令，避免原地重试空转。
  transcode_failed: {
    title: '转码没有完成',
    detail: '本机 FFmpeg 处理这个文件时报错。可以复制命令到终端手动执行，或改用图片导入。',
    actions: ['copyCommand', 'transcode', 'reselect']
  },
  transcode_timeout: {
    title: '转码耗时过长，已停止',
    detail: '可以只抽取其中一段，或改用图片导入。',
    actions: ['copyCommand', 'reselect']
  },
  path_denied: {
    title: '这个文件还没有通过选择器授权',
    detail: '请重新选择视频后再继续。',
    actions: ['reselect']
  },
  video_stream_missing: {
    title: '这个文件里没有可用的视频画面',
    detail: '可能是纯音频文件，或只含封面图的容器。',
    actions: ['reselect']
  },
  video_source_missing: {
    title: '找不到刚才选择的文件',
    detail: '文件可能被移动、重命名，或所在磁盘未连接。',
    actions: ['reselect']
  },
  video_source_changed: {
    title: '视频内容在读取过程中发生了变化',
    detail: '请确认文件没有被其它程序写入，再重新选择。',
    actions: ['reselect']
  },
  video_environment_missing: {
    title: '还没有配置 FFmpeg',
    detail: '抽帧依赖本机的 FFmpeg 与 ffprobe。请到「设置 · 视频工具」完成配置后重试。',
    actions: ['openMediaRuntime', 'retry']
  },
  media_runtime_missing: {
    title: '还没有配置 FFmpeg',
    detail: '抽帧与素材筛选都要用到本机的 FFmpeg 与 ffprobe。请到「设置 · 视频工具」完成配置后重试。',
    actions: ['openMediaRuntime', 'retry']
  },
  video_frame_limit: {
    title: '按当前密度抽出的帧数超过上限',
    detail: '引擎单次最多处理 10000 帧，并且不会发布被截断的结果。降低密度或缩短时间范围即可继续。',
    actions: ['reduceDensity']
  },
  video_output_limit: {
    title: '输出体积超过限额',
    detail: '可以降低采样密度、缩小输出尺寸，或只抽其中一段。',
    actions: ['reduceDensity']
  },
  video_metadata_limit: {
    title: '视频的元数据量超出有界缓冲',
    detail: '建议缩短时间范围后重试。',
    actions: ['reduceDensity']
  },
  video_timeout: {
    title: '抽帧超时',
    detail: '可以缩短时间范围或降低采样密度后重试。',
    actions: ['reduceDensity', 'retry']
  },
  video_worker_busy: {
    title: '已有其它素材任务正在运行',
    detail: '同一个媒体工作器一次只处理一个任务，请等当前任务结束后再试。',
    actions: ['retry']
  },
  media_busy: {
    title: '媒体处理正在忙',
    detail: '请等待当前任务结束后重试。',
    actions: ['retry']
  },
  command_not_implemented: {
    title: '当前引擎尚不支持媒体处理',
    detail: '请更新并重启桌面应用。',
    actions: ['retry']
  },
  unknown_command: {
    title: '当前引擎尚不支持媒体处理',
    detail: '请更新并重启桌面应用。',
    actions: ['retry']
  },
  video_ranges_invalid: {
    title: '时间段填写有误',
    detail: '时间段需按先后顺序、互不重叠，终点大于起点，且不超过已知视频时长。',
    actions: []
  },
  video_ranges_overlap: {
    title: '时间段互相重叠',
    detail: '每段抽帧范围必须互不重叠。',
    actions: []
  },
  video_parameters_invalid: {
    title: '抽帧参数不在允许范围内',
    detail: '请检查采样密度与输出尺寸。',
    actions: []
  },
  video_size_invalid: {
    title: '输出尺寸不在允许范围内',
    detail: '宽高需为 1～20000 的整数，且不超过 4000 万像素。',
    actions: []
  },
  video_cancelled: {
    title: '抽帧已取消',
    detail: '已经生成的完整帧会保留为未完成产物。',
    actions: []
  },
  video_closed: {
    title: '媒体工作器已关闭',
    detail: '重启应用后即可继续。',
    actions: []
  },
  video_directory_invalid: {
    title: '抽帧生成目录不可用',
    detail: '请检查存储根目录是否可写。',
    actions: []
  }
};

const CODE_PATTERN = /^\[([a-z0-9_]+)\]\s*([\s\S]*)$/i;
/** 不含方括号时的宽松识别：桌面侧或网络层可能只把错误码嵌在文本里。 */
const LOOSE_PATTERN = /(?:^|[\s:("'])((?:video|media|command|engine)_[a-z0-9_]+)/i;

/**
 * 从引擎/桌面侧抛出的错误文本里分离错误码与原始说明。
 * 引擎的规范形式是 `[code] message`；无法识别时返回空码，由调用方走兜底文案。
 */
export function parseEngineError(raw: string): { code: string; message: string } {
  const trimmed = (raw ?? '').trim();
  const strict = CODE_PATTERN.exec(trimmed);
  if (strict) return { code: strict[1].toLowerCase(), message: strict[2].trim() || trimmed };
  const loose = LOOSE_PATTERN.exec(trimmed);
  return { code: loose ? loose[1].toLowerCase() : '', message: trimmed };
}

export interface MediaErrorInfo {
  code: string;
  message: string;
  title: string;
  detail: string;
  actions: { id: MediaErrorActionId; label: string }[];
}

/** 错误码 → 用户语言。未知错误码退化为「重试 / 重新选择」两条安全出口，不暴露原始码给主视觉。 */
export function mediaErrorInfo(raw: string): MediaErrorInfo {
  const { code, message } = parseEngineError(raw);
  const entry = ENTRIES[code] ?? {
    title: '操作未完成',
    detail: '可以查看诊断详情，或重新选择视频再试。',
    actions: ['reselect'] as MediaErrorActionId[]
  };
  return { code, message, title: entry.title, detail: entry.detail, actions: entry.actions.map(id => ({ id, label: ACTION_LABELS[id] })) };
}

/**
 * 媒体错误面板：主视觉只给一句人话与可执行动作，原始错误码收进折叠的诊断详情。
 * 作为通用组件使用时可以不传 handlers，此时只展示说明与诊断详情。
 */
export function MediaErrorPanel({ error, handlers, busy }: { error: string; handlers?: MediaErrorActionHandlers; busy?: boolean }) {
  if (!error) return null;
  const info = mediaErrorInfo(error);
  const actions = info.actions.filter(action => handlers?.[action.id]);
  return <div className="inline-error media-error" role="alert">
    <p className="media-error-title">{info.title}</p>
    <p className="media-error-detail">{info.detail}</p>
    {actions.length > 0 && <div className="media-error-actions">{actions.map((action, index) => <Button key={action.id} className={index === 0 ? 'primary' : ''} busy={busy} disabled={busy} onClick={() => handlers![action.id]!()}>{action.label}</Button>)}</div>}
    <details className="media-error-diagnostics"><summary>诊断详情</summary><p>{error}</p></details>
  </div>;
}
