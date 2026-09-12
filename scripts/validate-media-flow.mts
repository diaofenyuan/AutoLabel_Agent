import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentController } from '../agent/orchestrator.ts';
import type { EngineClient } from '../agent/types.ts';
import { findTool } from '../agent/tools.ts';
import type { FlowArtifact, FlowRun } from '../shared/flow.ts';
import type { LoadedLocalModel, LocalModel, LocalRuntimeState } from '../shared/inference.ts';
import type { MediaJob, ScreeningResult, VideoFrameList, VideoInspection } from '../shared/media.ts';
import type { Asset } from '../shared/protocol.ts';

interface Context {
  command: EngineClient['request'];
  controller: AgentController;
  providerId: string;
  dataDir: string;
  modelPath: string;
  videoPath: string;
  setFlowRequest(value: Record<string, unknown>): void;
  counts(): { requests: number; annotationRequests: number };
}

export async function validateMediaFlow(context: Context) {
  const { command, controller, dataDir } = context;
  async function completedJob(id: string) {
    const deadline = Date.now() + 180000;
    let job: MediaJob;
    do {
      job = await command<MediaJob>('media.job.get', { jobId: id });
      if (!['queued', 'running', 'cancelling'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 120));
    } while (Date.now() < deadline);
    assert.equal(job!.status, 'completed', JSON.stringify(job!.error));
    return job!;
  }
  const project = await command<{ id: string }>('project.create', {
    name: '真实视频与筛选集成', taskType: 'detect', classes: [{ id: 'person', name: '行人', color: '#4081ed' }],
  });
  const inspected = await command<VideoInspection>('media.video.inspect', { sourcePath: context.videoPath });
  assert.equal(inspected.width, 768); assert.equal(inspected.height, 576);
  assert.equal(inspected.durationSeconds, 79.5);
  assert.equal(inspected.sampleAspectRatioAssumed, true);
  assert.ok(inspected.geometryNotice, '缺像素宽高比时必须明确解释来源');
  const requested = await command<MediaJob>('media.video.create', {
    projectId: project.id, sourcePath: context.videoPath, expectedSourceHash: inspected.sourceHash,
    parameters: { mode: 'interval', intervalSeconds: 0.2, ranges: [{ start: 0, end: 0.5 }, { start: 1, end: 1.5 }],
      outputSize: { width: 640, height: 480, fit: 'contain' }, format: 'png', maxFrames: 100, timeoutMs: 120000 },
  });
  const extracted = await completedJob(requested.id);
  assert.equal(extracted.stage, 'ready'); assert.equal(extracted.artifactCommitted, true);
  assert.equal(extracted.assetsCommitted, false); assert.equal(extracted.canImport, true);
  const frames = await command<VideoFrameList>('media.video.frames', { jobId: requested.id, limit: 100 });
  assert.equal(frames.total, 6);
  assert.deepEqual(frames.items.map(frame => frame.relativePts), ['0', '2', '4', '10', '12', '14']);
  assert.ok(frames.items.every(frame => frame.width === 640 && frame.height === 480 && !frame.assetId));
  assert.ok(frames.items.every(frame => frame.sourceVideoId === inspected.sourceVideoId));

  // 从空项目开始，由助手编排完整抽帧产物导入；没有可供模型猜测的文件路径参数。
  context.setFlowRequest({ definition: { version: 1, name: '视频素材导入', steps: [
    { id: 'import_video', kind: 'import', enabled: true, parameters: { mediaJobId: requested.id } },
    { id: 'screen', kind: 'filter', enabled: true, parameters: { screening: { nearEnabled: true, maxComparisons: 1 } } },
  ] }, input: { source: 'project', selection: 'all' }, execution: null, failurePolicy: 'continue' });
  const before = context.counts();
  const answer = await controller.run({ sessionId: randomUUID(), projectId: project.id,
    providerId: context.providerId, model: 'protocol-test', context: { maxRequests: 4 },
    messages: [{ role: 'user', content: '导入已完成的视频抽帧产物并预览筛选，保留所有帧，不请求标注接口。' }],
  });
  assert.equal(answer.status, 'completed');
  const action = answer.actions.find(item => item.name === 'start_flow');
  assert.equal(action?.status, 'completed', JSON.stringify(action));
  const started = action!.result as { started: boolean; run: FlowRun };
  assert.equal(started.started, true);
  let flow: FlowRun;
  const deadline = Date.now() + 180000;
  do {
    flow = await command<FlowRun>('flow.get', { flowRunId: started.run.id });
    if (!['queued', 'running'].includes(flow.status)) break;
    await new Promise(resolve => setTimeout(resolve, 120));
  } while (Date.now() < deadline);
  assert.equal(flow!.status, 'completed', JSON.stringify(flow!.steps));
  assert.equal(context.counts().annotationRequests, before.annotationRequests);
  assert.equal(context.counts().requests - before.requests, 2);
  const artifact = await command<FlowArtifact>('flow.artifact', { artifactId: flow!.steps[1].outputArtifactId });
  assert.equal(artifact.total, 6); assert.ok(artifact.items.every(item => item.outcome === 'included'));
  const imported = await command<MediaJob>('media.job.get', { jobId: requested.id });
  assert.equal(imported.assetsCommitted, true); assert.equal(imported.stage, 'done');
  await command('media.video.import', { jobId: requested.id });
  const assets = await command<{ items: Asset[]; total: number }>('asset.list', { projectId: project.id, limit: 100 });
  assert.equal(assets.total, 6, '重复导入不得复制素材');
  const bound = await command<VideoFrameList>('media.video.frames', { jobId: requested.id });
  assert.equal(new Set(bound.items.map(frame => frame.assetId)).size, 6);
  for (const frame of bound.items) {
    const asset = assets.items.find(item => item.id === frame.assetId)!;
    assert.equal(asset.metadata?.sourceVideoId, inspected.sourceVideoId);
    assert.equal(asset.metadata?.relativePts, frame.relativePts);
    assert.equal(asset.metadata?.videoSourceHash, inspected.sourceHash);
  }

  const runtime = await command<LocalRuntimeState>('local.runtime.probe');
  assert.equal(runtime.available, true);
  const model = await command<LocalModel>('local.model.register', {
    name: '真实视频行人 CPU 模型', taskType: 'detect', modelPath: context.modelPath,
  });
  const loaded = await command<LoadedLocalModel>('local.model.load', {
    modelId: model.id, modelVersion: model.version, device: 'cpu', timeoutMs: 120000,
  });
  const classMap = Object.fromEntries(loaded.classes.map(item => [item.id, item.name === 'person' ? 'person' : null]));
  assert.ok(Object.values(classMap).includes('person'));
  const local = await command<{ id: string }>('local.run.create', { projectId: project.id,
    assetIds: assets.items.map(asset => asset.id), modelId: model.id, modelVersion: model.version,
    device: 'cpu', classMap, confidence: 0.25, failurePolicy: 'continue', forceRerun: true,
  });
  let run: { status: string; statistics: Record<string, number> };
  const inferDeadline = Date.now() + 180000;
  do {
    run = await command('run.get', { runId: local.id });
    if (['completed', 'completed_with_errors', 'failed', 'cancelled', 'paused'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 120));
  } while (Date.now() < inferDeadline);
  assert.equal(run!.status, 'completed', JSON.stringify(run!.statistics));
  assert.equal(run!.statistics.succeeded, 6); assert.equal(run!.statistics.requestsUsed, 0);
  const results = await command<{ items: Asset[] }>('asset.list', { projectId: project.id, limit: 100 });
  const edited = results.items.find(asset => asset.annotations.length > 0);
  assert.ok(edited, '实际视频模型没有返回行人，不能宣称验证非空结果链路');
  await command('annotation.save', { assetId: edited.id, baseVersion: edited.version, annotations: edited.annotations });
  const protectedAsset = await command<Asset>('asset.get', { assetId: edited.id });
  const env = { engine: { request: command }, projectId: project.id,
    context: { assetIds: assets.items.map(asset => asset.id) }, openAsset() {} };
  const submitted = await findTool('preview_image_screening').execute({ assetIds: env.context.assetIds,
    parameters: { nearEnabled: true, maxComparisons: 1, blurEnabled: true, blurThreshold: 100000 } }, env) as { submitted: boolean; job: { id: string } };
  assert.equal(submitted.submitted, true);
  await completedJob(submitted.job.id);
  const screening = await command<ScreeningResult>('media.screening.result', { jobId: submitted.job.id, limit: 100 });
  assert.equal(screening.summary.status, 'incomplete');
  assert.ok(screening.summary.nearCheck.unexaminedContentPairs > 0);
  assert.equal(screening.items.find(item => item.assetId === edited.id)?.protected, true);
  assert.equal(screening.summary.changesApplied, false);
  const preserved = await command<Asset>('asset.get', { assetId: edited.id });
  assert.deepEqual({ version: preserved.version, annotations: preserved.annotations },
    { version: protectedAsset.version, annotations: protectedAsset.annotations });
  const page = await findTool('get_screening_result').execute({ jobId: submitted.job.id, section: 'items', limit: 2, offset: 0 }, env) as { total: number; items: unknown[] };
  assert.equal(page.total, 6); assert.equal(page.items.length, 2);
  assert.equal(JSON.stringify(page).includes('inputPath'), false);
  const exported = await command<{ id: string; path: string; status: string }>('export.create', {
    projectId: project.id, outputDir: path.join(dataDir, 'video-exports'), trainRatio: 0.8,
  });
  assert.equal(exported.status, 'completed');
  const manifest = JSON.parse(await readFile(path.join(exported.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets.length, 6);
  assert.equal(new Set(manifest.assets.map((asset: { split: string }) => asset.split)).size, 1, '同一视频不能跨训练与验证集合');
  assert.equal(new Set(manifest.assets.map((asset: { group: string }) => asset.group)).size, 1);
  for (const asset of manifest.assets) {
    const frame = bound.items.find(item => item.assetId === asset.assetId)!;
    assert.equal(asset.videoFrame.sourceVideoId, inspected.sourceVideoId);
    assert.equal(asset.videoFrame.videoSourceHash, inspected.sourceHash);
    assert.equal(asset.videoFrame.relativePts, frame.relativePts);
    assert.deepEqual(asset.videoFrame.timeBase, frame.timeBase);
  }
  return { projectId: project.id, mediaJobId: requested.id, flowRunId: flow!.id, localRunId: local.id,
    frames: 6, actualTimes: bound.items.map(frame => frame.timeSeconds), importedOnce: true,
    detectedObjects: results.items.reduce((sum, asset) => sum + asset.annotations.length, 0),
    screeningJobId: submitted.job.id, unexaminedContentPairs: screening.summary.nearCheck.unexaminedContentPairs,
    manualVersionProtected: true, annotationApiRequests: context.counts().annotationRequests - before.annotationRequests,
    agentRequests: 2, exportDir: exported.path, sourceGroupPreserved: true };
}
