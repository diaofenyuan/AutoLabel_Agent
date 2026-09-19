/**
 * 工具名 → 中文步骤名。
 *
 * 映射必须与 agent 侧的工具定义一一对应：漏一个，那一行就会在对话里显示英文原名，
 * 用户看到 `preview_image_screening` 并不知道刚才发生了什么。这里的键取所有 tool 定义文件里的 name，
 * 不再保留已经改名的旧键——留着它们只会掩盖「新工具没人加映射」这件事。
 */
export const toolNames: Record<string, string> = {
  project_summary: '读取项目概况', set_project_classes: '新增标注类别', list_assets: '读取素材列表', inspect_asset: '查看素材标注', open_asset: '定位素材',
  list_runs: '读取任务列表', run_annotation: '提交标注任务', control_run: '控制标注任务',
  export_preflight: '检查导出条件', export_dataset: '导出数据集', list_export_formats: '读取导出格式',
  dataset_preflight: '检查数据集版本条件', list_dataset_versions: '读取数据集版本',
  list_evaluation_sets: '读取评测集', list_evaluations: '读取评测', inspect_evaluation: '查看评测指标',
  preflight_comparison: '预检评测比较', compare_results: '建立评测比较', inspect_comparison: '查询比较进度', finish_comparison: '固定比较指标',
  inspect_budget: '读取请求预算', estimate_cost: '估算费用', list_review_items: '读取待复核问题',
  list_model_configurations: '读取接口与模型', preflight_evaluation_rerun: '预检评测重跑', run_evaluation: '提交评测重跑',
  list_local_models: '读取本地模型', get_local_runtime: '读取本地运行环境', list_builtin_models: '读取内置模型库',
  create_video_job: '提交抽帧任务', get_media_job: '查看媒体任务', get_video_frames: '读取视频帧',
  preview_image_screening: '预览筛选', get_screening_result: '查看筛选结果',
  list_media_jobs: '读取媒体任务',
  list_video_timelines: '读取视频时间轴', get_video_timeline: '查看时间轴', list_video_tracks: '读取对象轨迹',
  get_video_track: '查看轨迹关键帧', get_track_generation: '查看轨迹生成结果',
  preview_track_generation: '预检轨迹生成', generate_track_candidates: '生成轨迹候选', cancel_track_generation: '取消轨迹生成',
  list_track_generations: '读取轨迹生成记录',
  preflight_flow: '预检流程', start_flow: '启动流程', list_flows: '读取流程运行', inspect_flow: '查看流程进度',
  inspect_flow_artifact: '读取流程产物', control_flow: '控制流程', retry_flow: '重试流程', rerun_flow: '重跑流程',
  list_training_datasets: '读取训练快照', create_training_dataset: '建立训练快照',
  preflight_training: '预检训练', start_training: '提交训练任务', list_training_jobs: '读取训练任务',
  inspect_training_job: '查看训练进度', cancel_training_job: '取消训练任务',
};
export const toolLabel = (name: string) => toolNames[name] ?? name;
