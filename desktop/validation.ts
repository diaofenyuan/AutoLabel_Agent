import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().max(32000);
const name = z.string().trim().min(1).max(256);
const count = z.number().int().min(0).max(1000000);
const finite = z.number().finite();
const taskType = z.enum(['detect', 'obb', 'segment', 'pose', 'classify']);
const json = z.json();
const record = z.record(z.string().max(128), json);
const point = z.strictObject({ x: finite, y: finite });
const classes = z.array(z.strictObject({ id, name, color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(10000);
const annotation = z.strictObject({
  id, classId: id, type: taskType,
  bbox: z.strictObject({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() }).optional(),
  rotation: finite.optional(), points: z.array(point).max(100000).optional(),
  keypoints: z.array(z.strictObject({ x: finite, y: finite, name, visibility: z.union([z.literal(0), z.literal(1), z.literal(2)]) })).max(10000).optional(),
  attributes: z.record(z.string(), z.union([text, finite, z.boolean()])).optional(), confidence: finite.min(0).max(1).optional(),
});
const annotations = z.array(annotation).max(100000);
const assetIds = z.array(id).max(100000).optional();
const runControl = z.strictObject({ runId: id, assetIds });
const evaluationAssetIds = z.array(id).min(1).max(1000).refine(values => new Set(values).size === values.length, '评测素材不能重复');
const evaluationMatch = z.strictObject({ iouThreshold: finite.min(0).max(1).optional(), poseNormalization: z.literal('image_diagonal').optional() });
const evaluationRequest = z.strictObject({ setVersionId: id,
  schemes: z.array(z.strictObject({ runId: id, name: name.optional() })).min(1).max(8)
    .refine(values => new Set(values.map(value => value.runId)).size === values.length, '评测方案不能重复运行'),
  match: evaluationMatch.optional(),
});
const currency = z.string().regex(/^[A-Z]{3}$/);
const unitPrice = finite.min(0).max(1e9);
const pricing = z.strictObject({ model: name, currency,
  inputPerMillion: unitPrice.optional(), cachedInputPerMillion: unitPrice.optional(), outputPerMillion: unitPrice.optional(),
});
const tokenCount = z.number().int().min(0).max(1e9);
const resourceVersion = z.number().int().min(0).max(2147483647);
const reuseFields = { reuseEnabled: z.boolean().optional(), forceRerun: z.boolean().optional(),
  reuseMaxAgeSeconds: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional() };
const referenceFields = {
  referenceAssetIds: z.array(id).max(63).refine(values => new Set(values).size === values.length, '参考素材不能重复').optional(),
  referenceResources: z.array(z.strictObject({ resourceId: id, version: resourceVersion.optional(), classMap: z.record(id, id).optional() }))
    .max(63).refine(values => new Set(values.map(value => value.resourceId)).size === values.length, '参考资源不能重复').optional(),
};
const referenceCapacity = (value: { referenceAssetIds?: string[]; referenceResources?: unknown[] }) =>
  (value.referenceAssetIds?.length ?? 0) + (value.referenceResources?.length ?? 0) <= 63;
const estimateRequest = z.strictObject({ providerId: id, model: name, requests: count.min(1),
  inputTokensPerRequest: tokenCount, outputTokensPerRequest: tokenCount, cachedInputTokensPerRequest: tokenCount.optional(),
}).refine(value => (value.cachedInputTokensPerRequest ?? 0) <= value.inputTokensPerRequest, '缓存 token 不能超过输入 token');
const rerunRequest = z.strictObject({ setVersionId: id, budgetScopeId: id, maxRequests: count.min(1),
  // 相同方案可以作为独立重复实验；只有单方案中的参考素材需要去重。
  schemes: z.array(z.strictObject({ name: name.optional(), providerId: id, model: name,
    prompt: text.refine(value => !!value.trim(), '提示词不能为空'),
    ...referenceFields,
    concurrency: count.min(1).max(32).optional(), maxRetries: count.max(6).optional(), maxRequests: count.min(1).optional(),
  }).refine(referenceCapacity, '项目和资源库参考合计最多 63 张')).min(1).max(8), match: evaluationMatch.optional(),
});
const evaluationPage = { offset: z.number().int().min(0).max(2147483647).optional(), limit: count.min(1).max(500).optional() };
const empty = z.strictObject({});
const mediaPath = z.string().min(1).max(32767);
const mediaPage = { offset: z.number().int().min(0).max(2147483647).optional(), limit: z.number().int().min(1).max(500).optional() };
const mediaJob = z.strictObject({ jobId: id });
const mediaStream = z.number().int().min(0).max(65535);
const videoRanges = z.array(z.strictObject({ start: finite.min(0).max(604800), end: finite.min(0).max(604800) })
  .refine(value => value.start < value.end, '时间段结束值须大于开始值')).min(1).max(32)
  .refine(values => values.every((value, index) => index === 0 || value.start >= values[index - 1].end), '时间段须按时间排序且不能重叠');
const videoOptions = { ranges: videoRanges, streamIndex: mediaStream.optional(), format: z.enum(['png', 'jpg']).optional(),
  jpegQuality: z.number().int().min(2).max(31).optional(), maxFrames: z.number().int().min(1).max(10000).optional(),
  maxOutputBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), timeoutMs: z.number().int().min(1).max(86400000).optional(),
  outputSize: z.strictObject({ width: z.number().int().min(1).max(20000), height: z.number().int().min(1).max(20000), fit: z.enum(['contain', 'stretch']).optional() })
    .refine(value => value.width * value.height <= 40000000, '输出不能超过 4000 万像素').optional() };
const videoParameters = z.union([
  z.strictObject({ ...videoOptions, mode: z.literal('interval'), intervalSeconds: finite.min(.001).max(604800) }),
  z.strictObject({ ...videoOptions, mode: z.literal('every_n'), everyNFrames: z.number().int().min(1).max(1000000) }),
  z.strictObject({ ...videoOptions, mode: z.literal('fps'), targetFps: finite.min(.001).max(240) }),
]);
const screening = z.strictObject({ deduplicate: z.boolean().optional(), nearEnabled: z.boolean().optional(), blurEnabled: z.boolean().optional(),
  nearMaxDistance: z.number().int().min(0).max(64).optional(), aspectRatioTolerance: finite.min(0).max(1).optional(),
  maxComparisons: z.number().int().min(0).max(2000000).optional(), maxPairs: z.number().int().min(0).max(20000).optional(),
  blurThreshold: finite.min(0).optional() }).refine(value => !value.blurEnabled || value.blurThreshold !== undefined, '启用模糊提示须指定阈值');
const localModelVersion = z.number().int().min(1).max(2147483647);
const localDevice = z.string().regex(/^(cpu|0|[1-9][0-9]{0,2})$/);
const localTimeout = z.number().int().min(1000).max(600000);
const localFields = { modelId: id, modelVersion: localModelVersion.optional(), device: localDevice.optional(), ...reuseFields,
  classMap: z.record(z.string().regex(/^(0|[1-9][0-9]*)$/).max(32), id.nullable()),
  confidence: finite.min(0).max(1).optional(), iou: finite.min(0).max(1).optional(),
  imageSize: z.number().int().min(32).max(4096).optional(), maxDetections: z.number().int().min(1).max(10000).optional(), timeoutMs: localTimeout.optional() };
const flowLocal = z.strictObject(localFields);
const transformDimension = z.number().int().min(1).max(20000);
const transformOperations = z.array(z.union([
  z.strictObject({ kind: z.literal('crop'), x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000),
    width: transformDimension, height: transformDimension }).refine(value => value.x + value.width <= 20000 && value.y + value.height <= 20000, '裁剪矩形超过支持的图像范围'),
  z.strictObject({ kind: z.literal('resize'), width: transformDimension, height: transformDimension, fit: z.enum(['contain', 'stretch']).optional() }),
  z.strictObject({ kind: z.literal('tile'), width: transformDimension, height: transformDimension,
    overlapX: z.number().int().min(0).max(19999).optional(), overlapY: z.number().int().min(0).max(19999).optional() })
    .refine(value => (value.overlapX ?? 0) < value.width && (value.overlapY ?? 0) < value.height, '切片重叠必须小于切片尺寸'),
]).refine(value => value.width * value.height <= 40000000, '处理图像不能超过 4000 万像素')).max(30)
  .refine(values => values.filter(value => value.kind === 'tile').length <= 1, '同一图像处理计划最多执行一次切片');
const flowTransform = z.strictObject({ operations: transformOperations, background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
function containsExecutionAuthority(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    /^(pythonPath|localPythonPath|workerPath|localWorkerPath|scriptPath|pythonExecutable|executable|localModelGrants|localModelAuthorizations|ffmpegPath|ffprobePath|mediaFfmpegPath|mediaFfprobePath|mediaToolPaths)$/i.test(key) || containsExecutionAuthority(child));
}
const stepId = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const flowAssetIds = z.array(id).min(1).max(10000).refine(values => new Set(values).size === values.length, '流程素材不能重复');
const flowImport = z.strictObject({ paths: z.array(z.string().min(1).max(32767)).min(1).max(10000).optional(), mode: z.enum(['copy', 'reference']).optional(), mediaJobId: id.optional() })
  .refine(value => value.paths === undefined || value.mediaJobId === undefined, '素材路径和媒体任务只能选择一种导入来源');
const dimension = z.number().int().min(1).max(100000);
const flowFilter = z.strictObject({ assetIds: flowAssetIds.optional(), excludeAssetIds: z.array(id).max(10000).refine(values => new Set(values).size === values.length, '排除素材不能重复').optional(),
  statuses: z.array(z.enum(['unlabeled', 'candidate', 'modified', 'confirmed', 'invalid', 'missing'])).max(6).refine(values => new Set(values).size === values.length).optional(),
  minWidth: dimension.optional(), minHeight: dimension.optional(), maxWidth: dimension.optional(), maxHeight: dimension.optional(), deduplicate: z.boolean().optional(), screening: screening.optional(),
}).refine(value => (value.minWidth ?? 1) <= (value.maxWidth ?? 100000) && (value.minHeight ?? 1) <= (value.maxHeight ?? 100000), '流程筛选宽高范围无效');
const flowApi = z.strictObject({ providerId: id, model: name,
  prompt: z.string().min(1).max(100000).refine(value => !!value.trim(), '提示词不能为空'), ...referenceFields, ...reuseFields,
  concurrency: count.min(1).max(32).optional(), maxRetries: count.max(6).optional(), maxRequests: count.min(1).optional(),
});
const flowReview = z.strictObject({ buildIssues: z.boolean().optional(), waitForHuman: z.boolean().optional(),
  randomSample: z.strictObject({ count: count.min(1).max(1000), seed: z.string().min(1).max(256).refine(value => !!value.trim()) }).optional() });
const flowExport = z.strictObject({ outputDir: z.string().min(1).max(32767), trainRatio: finite.gt(0).lt(1).optional(), onlyConfirmed: z.boolean().optional(), annotationSelection: z.enum(['protected', 'candidate']).optional() });
const flowStep = z.union([
  z.strictObject({ id: stepId, kind: z.literal('import'), enabled: z.boolean(), parameters: flowImport }),
  z.strictObject({ id: stepId, kind: z.literal('filter'), enabled: z.boolean(), parameters: flowFilter }),
  z.strictObject({ id: stepId, kind: z.literal('api'), enabled: z.literal(true), parameters: flowApi.refine(referenceCapacity, '项目和资源库参考合计最多 63 张') }),
  z.strictObject({ id: stepId, kind: z.literal('api'), enabled: z.literal(false), parameters: flowApi.partial().refine(referenceCapacity, '项目和资源库参考合计最多 63 张') }),
  z.strictObject({ id: stepId, kind: z.literal('review'), enabled: z.boolean(), parameters: flowReview }),
  z.strictObject({ id: stepId, kind: z.literal('export'), enabled: z.literal(true), parameters: flowExport }),
  z.strictObject({ id: stepId, kind: z.literal('export'), enabled: z.literal(false), parameters: flowExport.partial() }),
  z.strictObject({ id: stepId, kind: z.literal('local'), enabled: z.literal(true), parameters: flowLocal }),
  z.strictObject({ id: stepId, kind: z.literal('local'), enabled: z.literal(false), parameters: flowLocal.partial() }),
  z.strictObject({ id: stepId, kind: z.literal('transform'), enabled: z.literal(true), parameters: flowTransform }),
  z.strictObject({ id: stepId, kind: z.literal('transform'), enabled: z.literal(false), parameters: flowTransform.partial() }),
]);
const flowDefinition = z.strictObject({ version: z.literal(1), name: z.string().trim().min(1).max(200),
  steps: z.array(flowStep).max(30).refine(values => new Set(values.map(value => value.id)).size === values.length, '流程步骤标识不能重复') });
const flowInput = z.union([
  z.strictObject({ source: z.literal('project'), selection: z.enum(['all', 'unlabeled']) }),
  z.strictObject({ source: z.literal('project'), selection: z.literal('explicit'), assetIds: flowAssetIds }),
  z.strictObject({ source: z.literal('artifact'), artifactId: id }),
]);
const flowStartBase = z.strictObject({ projectId: id, definition: flowDefinition, input: flowInput,
  execution: z.union([z.strictObject({ mode: z.literal('all') }), z.strictObject({ mode: z.literal('single'), stepId })]).optional(),
  budgetScopeId: id.optional(), maxRequests: count.min(1).optional(), failurePolicy: z.enum(['continue', 'pause']).optional(),
});
const flowStart = flowStartBase.refine(value => value.maxRequests !== undefined || !value.definition.steps.some(step => step.enabled && step.kind === 'api'
  && (value.execution?.mode !== 'single' || value.execution.stepId === step.id)), '执行 API 步骤必须设置共享请求上限');
const flowPreflightStep = z.union([...flowStep.options,
  z.strictObject({ id: stepId, kind: z.literal('api'), enabled: z.literal(true), parameters: flowApi.partial().refine(referenceCapacity, '项目和资源库参考合计最多 63 张') }),
  z.strictObject({ id: stepId, kind: z.literal('export'), enabled: z.literal(true), parameters: flowExport.partial() }),
  z.strictObject({ id: stepId, kind: z.literal('local'), enabled: z.literal(true), parameters: flowLocal.partial() }),
  z.strictObject({ id: stepId, kind: z.literal('transform'), enabled: z.literal(true), parameters: flowTransform.partial() }),
]);
const flowPreflight = flowStartBase.extend({ definition: flowDefinition.extend({ steps: z.array(flowPreflightStep).max(30)
  .refine(values => new Set(values.map(value => value.id)).size === values.length, '流程步骤标识不能重复') }) });
const flowControl = z.strictObject({ flowRunId: id });
const trackIdentifier = z.string().min(1).max(128).refine(value => !!value.trim(), '轨迹标识不能为空白');
const trackName = z.string().trim().min(1).max(200);
const trackVersion = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const trackPage = { offset: z.number().int().min(0).max(2147483647).optional(), limit: z.number().int().min(1).max(100).optional() };
const trackDetailPage = { ...trackPage, limit: z.number().int().min(1).max(500).optional() };
const trackWrite = z.strictObject({ trackId: trackIdentifier, baseVersion: trackVersion, timelineVersion: trackVersion });
const trackAnnotation = annotation.extend({ id: trackIdentifier, classId: trackIdentifier, type: z.enum(['detect', 'pose']),
  keypoints: z.array(z.strictObject({ x: finite, y: finite, name: trackIdentifier, visibility: z.union([z.literal(0), z.literal(1), z.literal(2)]) })).max(65536).optional() });
const trackKeyframeSave = trackWrite.extend({ keyframeId: trackIdentifier.optional(), frameId: trackIdentifier, state: z.enum(['located', 'occluded', 'enter', 'exit', 'unlocatable']),
  annotation: trackAnnotation.nullable().optional(), baseAnnotationVersion: trackVersion,
  // 草稿时间是并发条件中的不透明标识，不能转成 Date 后截断精度。
  baseDraftSavedAt: z.string().min(1).max(100).nullable().optional() })
  .refine(value => value.state === 'unlocatable' ? value.annotation == null : value.annotation != null, '不可定位状态不能携带几何，其余关键帧须有单对象标注');
const trackGenerationParameters = z.strictObject({ maxGapSeconds: finite.gt(0).max(1e12).optional(), maxCenterSpeedPixelsPerSecond: finite.gt(0).max(1e12).optional(),
  maxKeypointSpeedPixelsPerSecond: finite.gt(0).max(1e12).optional(), maxScaleFactor: finite.min(1).max(1e12).optional() });
const trackGeneratePreview = trackWrite.extend({ parameters: trackGenerationParameters.optional(), scope: z.enum(['affected', 'all']).optional() });
const exportFields = { projectId: id, taskType: taskType.optional(), assetIds };
const message = z.strictObject({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: text, tool_call_id: id.optional(),
  tool_calls: z.array(z.strictObject({ id, type: z.literal('function'), function: z.strictObject({ name, arguments: text }) })).max(64).optional() });
const schemas: Record<string, z.ZodType> = {
  'project.list': empty,
  'project.create': z.strictObject({ name, description: text.optional(), taskType, classes: classes.optional() }),
  'project.update': z.strictObject({ projectId: id, name: name.optional(), description: text.optional(), classes: classes.optional(), settings: record.optional() }),
  'project.open': z.strictObject({ projectId: id }),
  'project.example': empty,
  'media.runtime.get': empty,
  'media.runtime.configure': z.strictObject({ ffmpegPath: mediaPath.nullable(), ffprobePath: mediaPath.nullable() }),
  'media.video.inspect': z.strictObject({ sourcePath: mediaPath, streamIndex: mediaStream.optional() }),
  'media.video.create': z.strictObject({ projectId: id, sourcePath: mediaPath, expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), parameters: videoParameters }),
  'media.video.import': mediaJob,
  'media.video.frames': mediaJob.extend(mediaPage),
  'media.job.get': mediaJob,
  'media.job.list': z.strictObject({ projectId: id.optional(), kind: z.enum(['video_extract', 'image_screening']).optional(), ...mediaPage, limit: z.number().int().min(1).max(100).optional() }),
  'media.job.cancel': mediaJob,
  'media.job.retry': mediaJob,
  'media.screening.create': z.strictObject({ projectId: id, assetIds: flowAssetIds.optional(), parameters: screening }),
  'media.screening.result': mediaJob.extend({ ...mediaPage, section: z.enum(['items', 'exactGroups', 'nearPairs', 'sourceLeakageGroups']).optional() }),
  'track.timeline.create': z.strictObject({ projectId: trackIdentifier, mediaJobId: trackIdentifier, name: trackName.optional() }),
  'track.timeline.list': z.strictObject({ projectId: trackIdentifier, ...trackPage }),
  'track.timeline.get': z.strictObject({ timelineId: trackIdentifier }),
  'track.timeline.frames': z.strictObject({ timelineId: trackIdentifier, trackId: trackIdentifier.optional(), aroundFrameId: trackIdentifier.optional(), ...trackDetailPage })
    .refine(value => value.aroundFrameId === undefined || value.offset === undefined, '定位帧与页偏移不能同时指定'),
  'track.timeline.update': z.strictObject({ timelineId: trackIdentifier, baseVersion: trackVersion, name: trackName.optional(),
    scenes: z.array(z.strictObject({ startFrameId: trackIdentifier, endFrameId: trackIdentifier, sceneId: trackIdentifier.nullable() })).max(10000).optional() }),
  'track.create': z.strictObject({ timelineId: trackIdentifier, timelineVersion: trackVersion, classId: trackIdentifier, name: trackName.optional() }),
  'track.list': z.strictObject({ timelineId: trackIdentifier, includeArchived: z.boolean().optional(), ...trackPage }),
  'track.get': z.strictObject({ trackId: trackIdentifier, version: trackVersion.optional() }),
  'track.update': z.strictObject({ trackId: trackIdentifier, baseVersion: trackVersion, name: trackName }),
  'track.delete': trackWrite,
  'track.keyframe.list': z.strictObject({ trackId: trackIdentifier, aroundFrameId: trackIdentifier.optional(), ...trackDetailPage }),
  'track.keyframe.save': trackKeyframeSave,
  'track.keyframe.delete': trackWrite.extend({ keyframeId: trackIdentifier }),
  'track.split': trackWrite.extend({ splitFrameId: trackIdentifier, leftName: trackName.optional(), rightName: trackName.optional() }),
  'track.merge': z.strictObject({ leftTrackId: trackIdentifier, leftVersion: trackVersion, rightTrackId: trackIdentifier, rightVersion: trackVersion,
    timelineVersion: trackVersion, name: trackName.optional(), confirmSameObject: z.boolean().optional() })
    .refine(value => value.leftTrackId !== value.rightTrackId, '不能把同一条轨迹与自身合并'),
  'track.generate.preview': trackGeneratePreview,
  'track.generate': trackGeneratePreview.extend({ expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  'track.generation.get': z.strictObject({ generationId: trackIdentifier }),
  'track.generation.list': z.strictObject({ trackId: trackIdentifier, ...trackPage }),
  'track.generation.results': z.strictObject({ generationId: trackIdentifier, section: z.enum(['frames', 'intervals', 'skipped']).optional(), ...trackDetailPage }),
  'track.generation.cancel': z.strictObject({ generationId: trackIdentifier }),
  'track.generation.retry': z.strictObject({ generationId: trackIdentifier }),
  // 本地序列跟踪只接收轨迹版本与范围；模型、视频路径和凭据均由引擎从固定记录组装。
  'track.local.sequence': z.strictObject({ timelineId: trackIdentifier, timelineVersion: trackVersion,
    modelId: id, modelVersion: localModelVersion.optional(), device: localDevice.optional(), timeoutMs: localTimeout.optional(),
    classMap: z.record(z.string().regex(/^\d+$/), id.nullable()), scope: z.enum(['affected', 'all']).optional(), detector: z.literal('detect') }),
  'track.local.sequence.get': z.strictObject({ candidateId: trackIdentifier }),
  'track.local.sequence.list': z.strictObject({ timelineId: trackIdentifier, ...trackPage }),
  'track.local.sequence.confirm': z.strictObject({ candidateId: trackIdentifier, timelineId: trackIdentifier, timelineVersion: trackVersion, confirm: z.literal(true) }),
  // 提升为正式轨迹生成只能由用户显式确认触发，不进入 Agent 工具白名单。
  'track.local.sequence.promote': z.strictObject({ candidateId: trackIdentifier, timelineId: trackIdentifier, timelineVersion: trackVersion, confirm: z.literal(true) }),
  'asset.list': z.strictObject({ projectId: id, offset: count.optional(), limit: count.min(1).max(1000).optional(), status: z.enum(['unlabeled', 'candidate', 'modified', 'confirmed', 'invalid', 'missing']).optional() }),
  'asset.import': z.strictObject({ projectId: id, paths: z.array(z.string().min(1).max(32767)).min(1).max(100000), mode: z.enum(['copy', 'reference']).optional() }),
  'asset.get': z.strictObject({ assetId: id }),
  'asset.checkLocations': z.strictObject({ projectId: id, assetIds }),
  'asset.relocate': z.strictObject({ projectId: id, directory: z.string().min(1).max(32767), assetIds }),
  'annotation.save': z.strictObject({ assetId: id, annotations, baseVersion: count, confirm: z.boolean().optional() }),
  'annotation.draft': z.strictObject({ assetId: id, annotations, baseVersion: count }),
  'annotation.history': z.strictObject({ assetId: id }),
  'annotation.draft.discard': z.strictObject({ assetId: id }),
  'annotation.importYolo': z.strictObject({ projectId: id, labelSpace: z.enum(['source', 'baseline']), classMap: z.record(z.string().regex(/^\d+$/), id),
    labelsDir: z.string().min(1).max(32767).optional(), assetIds, confirm: z.literal(false).optional(),
    items: z.array(z.strictObject({ assetId: id, labelPath: z.string().min(1).max(32767), baseVersion: count.optional() })).max(100000).optional(),
  }).refine(value => !!value.labelsDir !== !!value.items, '应选择标签文件夹或文件列表'),
  'annotation.render': z.strictObject({ assetId: id, version: count.optional(), outputPath: z.string().min(1).max(32767),
    format: z.enum(['png', 'jpeg']).optional(), showLabels: z.boolean().optional(), showKeypoints: z.boolean().optional(), showGeometry: z.boolean().optional() }),
  'export.preflight': z.strictObject(exportFields),
  'export.create': z.strictObject({ ...exportFields, outputDir: z.string().min(1).max(32767), trainRatio: finite.gt(0).lt(1).optional(), onlyConfirmed: z.boolean().optional() }),
  'export.list': z.strictObject({ projectId: id }),
  'export.reproduce': z.strictObject({ exportId: id, outputDir: z.string().min(1).max(32767) }),
  'export.compare': z.strictObject({ exportId: id, otherExportId: id }),
  'evaluationSet.create': z.strictObject({ projectId: id, name, assetIds: evaluationAssetIds }),
  'evaluationSet.list': z.strictObject({ projectId: id }),
  'evaluationSet.get': z.strictObject({ setId: id, versionId: id.optional() }),
  'evaluationSet.saveTruth': z.strictObject({ setId: id, assetId: id, annotations, baseTruthVersion: count,
    source: z.enum(['manual', 'imported_human']), note: text.optional() }),
  'evaluationSet.getTruth': z.strictObject({ setId: id, assetId: id, truthVersion: count.min(1).optional() }),
  'evaluationSet.publish': z.strictObject({ setId: id, baseSetRevision: count.min(1) }),
  'evaluation.preflight': evaluationRequest,
  'evaluation.create': evaluationRequest,
  'evaluation.list': z.strictObject({ projectId: id }),
  'evaluation.get': z.strictObject({ evaluationId: id }),
  'evaluation.results': z.strictObject({ evaluationId: id, schemeId: id.optional(), assetId: id.optional(), ...evaluationPage }),
  'evaluation.rerun.preflight': rerunRequest,
  'evaluation.rerun.create': rerunRequest,
  'evaluation.rerun.get': z.strictObject({ comparisonId: id }),
  'evaluation.rerun.finish': z.strictObject({ comparisonId: id }),
  'budget.get': z.strictObject({ budgetScopeId: id }),
  'budget.update': z.strictObject({ budgetScopeId: id, maxRequests: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    costLimit: z.strictObject({ currency, amount: finite.gt(0).max(1e12) }).nullable().optional(),
  }),
  'budget.estimate': estimateRequest,
  'review.build': z.strictObject({ evaluationId: id.optional(), runId: id.optional(),
    rules: z.strictObject({ minMatchedIoU: finite.min(0).max(1).optional(), maxNormalizedPointError: finite.min(0).max(1).optional() }).optional(),
  }).refine(value => !!value.evaluationId !== !!value.runId, '应选择评测或运行中的一个来源'),
  'review.list': z.strictObject({ projectId: id, evaluationId: id.optional(), runId: id.optional(), sampleId: id.optional(),
    source: z.enum(['execution', 'truth_comparison', 'random']).optional(),
    status: z.enum(['pending', 'checked', 'dismissed', 'request_relabel']).optional(), ...evaluationPage }),
  'review.resolve': z.strictObject({ itemId: id, baseCandidateVersion: count.nullable(),
    action: z.enum(['checked', 'dismissed', 'request_relabel']), note: text.optional() }),
  'review.sample': z.strictObject({ projectId: id, assetIds: evaluationAssetIds,
    seed: z.string().min(1).max(256).refine(value => !!value.trim(), '随机种子不能为空'), count: count.min(1).max(1000),
  }).refine(value => value.count <= value.assetIds.length, '抽样数量不能超过素材范围'),
  'provider.list': empty,
  'provider.save': z.strictObject({
    id: id.optional(), name, baseUrl: z.url().refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, '接口地址应为不含凭据的 HTTP/HTTPS 基础地址'),
    protocol: z.enum(['chat-completions', 'responses', 'chat_completions']), model: name.optional(),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(10000)).optional(),
    extraParameters: record.optional(), concurrency: count.min(1).max(128).optional(), requestsPerMinute: count.optional(),
    timeoutMs: count.min(1000).max(3600000).optional(), maxRetries: count.max(10).optional(), maxImages: count.min(1).max(64).optional(), quotaGroupId: id.optional(),
    pricing: pricing.nullable().optional(),
  }),
  'provider.delete': z.strictObject({ providerId: id }),
  'provider.models': z.strictObject({ providerId: id }),
  'provider.capabilities': z.strictObject({ providerId: id, model: name }),
  'provider.test': z.strictObject({ providerId: id, model: name, capability: z.enum(['connection', 'text', 'image', 'multi-image', 'structured', 'tools', 'vision', 'structured-output', 'tool-calling']) }),
  'credential.set': z.strictObject({ providerId: id, key: z.string().min(1).max(16384) }),
  'local.runtime.configure': z.strictObject({ pythonPath: z.string().min(1).max(32767).nullable() }),
  'local.runtime.get': empty,
  'local.runtime.probe': empty,
  'local.model.get': z.strictObject({ modelId: id, modelVersion: localModelVersion.optional() }),
  'local.model.register': z.strictObject({ id: id.optional(), baseVersion: localModelVersion.optional(), name, taskType, modelPath: z.string().min(1).max(32767) }),
  'local.model.list': z.strictObject({ taskType: taskType.optional(), ...evaluationPage }),
  'local.model.load': z.strictObject({ modelId: id, modelVersion: localModelVersion.optional(), device: localDevice.optional(), timeoutMs: localTimeout.optional() }),
  'local.run.create': z.strictObject({ projectId: id, assetIds: flowAssetIds.optional(), ...localFields, failurePolicy: z.enum(['continue', 'pause']).optional() }),
  'run.result.get': z.strictObject({ resultId: id }),
  'run.create': z.strictObject({ projectId: id, assetIds, providerId: id, model: name, prompt: text,
    budgetScopeId: id.optional(),
    concurrency: count.min(1).max(128).optional(), maxRequests: count.min(1).optional(),
    taskType: taskType.optional(), referenceIds: z.array(id).max(100).optional(), parameters: record.optional(),
    ...reuseFields, ...referenceFields,
  }).refine(referenceCapacity, '项目和资源库参考合计最多 63 张'),
  'run.list': z.strictObject({ projectId: id.optional() }),
  'run.get': z.strictObject({ runId: id }),
  'run.pause': runControl, 'run.resume': runControl, 'run.cancel': runControl,
  'run.retry': z.strictObject({ runId: id, assetIds, retryUnknown: z.boolean().optional() }),
  'run.attempts': z.strictObject({ runId: id, assetId: id.optional() }),
  'event.snapshot': z.strictObject({ runId: id.optional() }),
  'event.list': z.strictObject({ runId: id.optional(), flowRunId: id.optional(), assetId: id.optional(), after: count.optional() }),
  'flow.capabilities': empty,
  'flow.preflight': flowPreflight, 'flow.create': flowStart,
  'flow.get': flowControl,
  'flow.list': z.strictObject({ projectId: id.optional(), ...evaluationPage, limit: count.min(1).max(100).optional() }),
  'flow.artifact': z.strictObject({ artifactId: id, ...evaluationPage }),
  'flow.pause': flowControl, 'flow.cancel': flowControl,
  'flow.resume': z.strictObject({ flowRunId: id, acknowledgeReviewStepId: stepId.optional(), maxRequests: count.min(1).optional() }),
  'flow.retry': z.strictObject({ flowRunId: id, stepId: stepId.optional(), assetIds: flowAssetIds.optional(), retryUnknown: z.boolean().optional(), maxRequests: count.min(1).optional() }),
  'flow.rerun': z.strictObject({ flowRunId: id, fromStepId: stepId, definition: flowDefinition.optional(), budgetScopeId: id.optional(), maxRequests: count.min(1).optional() }),
  'resource.list': z.strictObject({ kind: z.enum(['prompt', 'template', 'flow', 'reference', 'evaluation_comparison']).optional(),
    query: z.string().max(500).optional(), category: z.string().max(256).optional(), ...evaluationPage }),
  'resource.save': z.strictObject({ id: id.optional(), baseVersion: resourceVersion.optional(), kind: z.enum(['prompt', 'template', 'flow']),
    name, category: z.string().max(256).optional(), note: text.optional(), content: json }),
  'resource.get': z.strictObject({ resourceId: id, version: resourceVersion.optional() }),
  'resource.apply': z.strictObject({ projectId: id, resourceId: id, version: resourceVersion.optional(),
    fields: z.array(z.enum(['prompt', 'classes', 'keypointNames', 'keypointConnections', 'attributes', 'rules', 'occlusionRules', 'blurRules', 'flow']))
      .min(1).max(9).refine(values => new Set(values).size === values.length, '应用字段不能重复') }),
  'resource.reference': z.strictObject({ id: id.optional(), baseVersion: resourceVersion.optional(), assetId: id, assetVersion: resourceVersion,
    name, category: z.string().max(256).optional(), note: text.optional() }),
  'settings.get': empty,
  'settings.save': z.strictObject({ settings: record }).refine(value => !containsExecutionAuthority(value.settings), '本地执行路径与授权必须通过专用文件选择和配置入口'),
  'diagnostics.get': empty,
  'diagnostics.save': empty,
  'backup.preflight': z.strictObject({ outputDir: z.string().min(1).max(32767) }),
  'backup.create': z.strictObject({ outputDir: z.string().min(1).max(32767) }),
  'backup.inspect': z.strictObject({ backupPath: z.string().min(1).max(32767) }),
  'restore.prepare': z.strictObject({ backupPath: z.string().min(1).max(32767), targetParent: z.string().min(1).max(32767) }),
  'storage.status': empty,
  'storage.usage': empty,
  'storage.cleanup': empty,
  'storage.activate': z.strictObject({ preparationId: id }),
  'storage.migrate': z.strictObject({ targetParent: z.string().min(1).max(32767) }),
  'update.status': empty, 'update.check': empty, 'update.download': empty, 'update.cancel': empty, 'update.install': empty,
  'chat.cancel': z.strictObject({ sessionId: id }),
  'chat.send': z.strictObject({ projectId: id.optional(), providerId: id, model: name,
    messages: z.array(message).min(1).max(200), tools: z.array(record).max(64).optional(), stream: z.boolean().optional(), sessionId: id.optional(), maxRequests: count.min(1).optional(), runId: id.optional(), budgetScopeId: id.optional(),
  }),
  'agent.chat': z.strictObject({ sessionId: id, projectId: id.optional(), providerId: id, model: name,
    messages: z.array(message).min(1).max(200), autoExecute: z.boolean().optional(),
    context: z.strictObject({ annotationProviderId: id.optional(), annotationModel: name.optional(), assetIds,
      prompt: text.optional(), concurrency: count.min(1).max(32).optional(), maxRequests: count.min(1).nullable().optional(),
      exportDir: z.string().max(32767).optional(), ...referenceFields }).refine(referenceCapacity, '项目和资源库参考合计最多 63 张').optional(),
  }),
  'agent.cancel': z.strictObject({ sessionId: id }),
};

export class DesktopError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const agentCommands = new Set(['provider.list', 'provider.capabilities', 'chat.send', 'chat.cancel', 'project.open', 'asset.list', 'asset.get',
  'run.list', 'run.get', 'run.create', 'run.pause', 'run.resume', 'run.cancel', 'export.preflight', 'export.create',
  'evaluationSet.list', 'evaluationSet.get', 'evaluation.list', 'evaluation.get', 'evaluation.results',
  'evaluation.preflight', 'evaluation.create', 'review.list',
  'evaluation.rerun.preflight', 'evaluation.rerun.create', 'evaluation.rerun.get', 'evaluation.rerun.finish', 'budget.estimate', 'budget.get',
  'flow.capabilities', 'flow.preflight', 'flow.create', 'flow.get', 'flow.list', 'flow.artifact', 'flow.pause', 'flow.resume', 'flow.cancel', 'flow.retry', 'flow.rerun',
  'local.runtime.get', 'local.model.get', 'media.job.get', 'media.job.list', 'media.video.frames', 'media.screening.result', 'media.screening.create',
  'track.timeline.list', 'track.timeline.get', 'track.timeline.frames', 'track.list', 'track.get', 'track.keyframe.list',
  'track.generation.list', 'track.generation.get', 'track.generation.results', 'track.generate.preview', 'track.generate', 'track.generation.cancel']);

export function assertAgentCommand(command: unknown, payload?: unknown): asserts command is string {
  // 人工真值和复核结论只能由用户显式提交，不能随界面白名单自动开放给模型。
  if (typeof command !== 'string' || !agentCommands.has(command)) throw new DesktopError('AGENT_COMMAND_DENIED', '此操作不在 Agent 工具范围内');
  if (command === 'evaluationSet.get' && payload && typeof payload === 'object' && Object.hasOwn(payload, 'versionId')) {
    throw new DesktopError('AGENT_COMMAND_DENIED', 'Agent 仅可读取评测集摘要，不能读取人工真值清单');
  }
  if (command.startsWith('flow.') && payload && typeof payload === 'object') {
    const input = payload as Record<string, unknown>;
    if ((command === 'flow.resume' && Object.hasOwn(input, 'acknowledgeReviewStepId')) || (command === 'flow.retry' && Object.hasOwn(input, 'retryUnknown'))) {
      throw new DesktopError('AGENT_COMMAND_DENIED', '人工检查确认与未知请求重试必须由用户明确操作');
    }
    const definition = input.definition as { steps?: Array<{ kind?: string; parameters?: object }> } | undefined;
    if (definition?.steps?.some(step => step.kind === 'import' && step.parameters && Object.hasOwn(step.parameters, 'paths'))) {
      throw new DesktopError('AGENT_COMMAND_DENIED', 'Agent 不能提供流程导入路径');
    }
  }
}

// 结构和体积同时限制，避免任意 IPC 命令及巨型消息占满主进程。
export function validateCommand(command: unknown, payload: unknown = {}): { command: string; payload: Record<string, unknown> } {
  if (typeof command !== 'string' || !Object.hasOwn(schemas, command)) throw new DesktopError('COMMAND_DENIED', '此操作未开放给界面');
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(payload)); } catch { throw new DesktopError('INVALID_PAYLOAD', '参数必须为可序列化数据'); }
  if (size > 8 * 1024 * 1024) throw new DesktopError('PAYLOAD_TOO_LARGE', '请求内容过大，请减少当前批次');
  const result = schemas[command].safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DesktopError('INVALID_PAYLOAD', `参数格式不正确：${issue.path.join('.') || 'payload'}`);
  }
  return { command, payload: result.data as Record<string, unknown> };
}

export const fileSelectionSchema = z.strictObject({ kind: z.enum(['images', 'video', 'model', 'python', 'ffmpeg', 'ffprobe', 'directory', 'backup', 'labels']), multiple: z.boolean().optional() });
export const saveFileSchema = z.strictObject({ title: name, defaultPath: z.string().max(32767).optional(), extension: z.string().regex(/^[a-zA-Z0-9]{1,10}$/).optional() });
export const windowActionSchema = z.enum(['minimize', 'maximize', 'close']);
