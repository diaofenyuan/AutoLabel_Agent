const eventNames: Record<string, string> = {
  'media.job.created': '素材任务已创建', 'media.job.started': '素材任务开始', 'media.job.progress': '素材任务进度更新', 'media.job.inspected': '视频检查完成', 'media.job.artifact_committed': '抽帧结果已封存', 'media.job.import_queued': '素材导入已排队', 'media.job.assets_committed': '视频素材已入库', 'media.job.screening_completed': '素材分析已完成', 'media.job.cancelled': '素材任务已取消', 'media.job.interrupted': '素材任务已中断', 'media.job.finished': '素材任务结束',
  'project.created': '项目已创建', 'project.updated': '项目已更新',
  'asset.imported': '素材已导入', 'asset.relocated': '素材位置已更新',
  'annotation.candidate': '候选标注已保存', 'annotation.saved': '标注已保存', 'annotation.rendered': '标注预览已生成', 'annotation.draft_saved': '标注草稿已保存', 'annotation.draft_discarded': '标注草稿已放弃',
  'run.created': '标注任务已创建', 'run.queued': '标注任务排队中', 'run.running': '标注任务执行中', 'run.paused': '标注任务已暂停', 'run.resumed': '标注任务已恢复', 'run.retry': '标注任务准备重试', 'run.cancelled': '标注任务已取消', 'run.completed': '标注任务已完成', 'run.completed_with_errors': '标注任务完成，存在失败样本', 'run.failed': '标注任务失败', 'run.needs_attention': '标注任务需要处理',
  'sample.queued': '样本排队中', 'sample.preparing': '正在准备样本输入', 'sample.sending': '正在发送样本请求', 'sample.waiting': '正在等待样本响应', 'sample.parsing': '正在解析样本结果', 'sample.validating': '正在校验样本标注', 'sample.saving': '正在保存样本结果', 'sample.retry_wait': '样本等待重试', 'sample.succeeded': '样本处理成功', 'sample.failed': '样本处理失败', 'sample.unknown': '样本结果未知', 'sample.cancelled': '样本处理已取消',
  'call.queued': '请求排队中', 'call.sent': '请求已发送', 'call.delta': '正在接收响应', 'call.not_sent': '请求未发送', 'call.completed': '请求已完成', 'call.failed': '请求失败', 'call.unknown': '请求结果未知',
  'flow.created': '流程已创建', 'flow.running': '流程执行中', 'flow.pausing': '流程正在暂停', 'flow.paused': '流程已暂停', 'flow.resumed': '流程已恢复', 'flow.recovered': '流程已从中断恢复', 'flow.needs_attention': '流程需要处理', 'flow.cancelling': '流程正在停止', 'flow.cancelled': '流程已停止', 'flow.completed': '流程已完成', 'flow.completed_with_errors': '流程完成，存在失败样本', 'flow.failed': '流程失败',
  'flow.step.started': '流程步骤开始', 'flow.step.progress': '流程步骤进度更新', 'flow.step.completed': '流程步骤已完成', 'flow.step.completed_with_errors': '流程步骤完成，存在失败样本', 'flow.step.failed': '流程步骤失败', 'flow.step.needs_attention': '流程步骤等待处理', 'flow.step.paused': '流程步骤已暂停', 'flow.step.cancelled': '流程步骤已停止', 'flow.step.skipped': '流程步骤已跳过',
  'budget.updated': '请求预算已更新', 'budget.cost_updated': '费用记录已更新',
  'provider.saved': '接口配置已保存', 'resource.saved': '资源已保存', 'evaluation.completed': '评测已完成',
  'review.built': '复核清单已建立', 'review.resolved': '复核问题已处理', 'review.sampled': '抽查样本已建立',
  'export.started': '数据集导出开始', 'export.completed': '数据集导出完成', 'export.failed': '数据集导出失败', 'backup.progress': '工作空间备份进度更新',
  'engine.recovered': '引擎已恢复', 'engine.resumed': '引擎已继续工作', 'engine.suspended': '引擎已暂停工作', 'engine.shutdown': '引擎已关闭',
};

export function eventName(type: string): string { return eventNames[type] ?? '其他事件'; }
