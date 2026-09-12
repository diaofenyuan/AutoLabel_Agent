import { strict as assert } from 'node:assert';
import { findTool } from '../agent/tools.ts';
import { AgentError } from '../agent/validation.ts';
import type { EngineClient } from '../agent/types.ts';
import type { Asset } from '../shared/protocol.ts';
import type { Track, TrackFramePage, TrackGeneration, TrackTimelineDetail } from '../shared/tracks.ts';

// 连接由父进程通过 stdin 传入，不将本地会话令牌写入命令行或验证报告。
let input = '';
for await (const chunk of process.stdin) input += chunk;
const connection = JSON.parse(input) as { url: string; token: string; projectId: string; timelineId: string; trackId: string };
assert.match(connection.url, /^http:\/\/127\.0\.0\.1:\d+\/command$/);
let generated = 0;
const command: EngineClient['request'] = async <T>(name: string, payload: Record<string, unknown> = {}): Promise<T> => {
  if (name === 'track.generate') generated++;
  const response = await fetch(connection.url, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: name, payload }), signal: AbortSignal.timeout(20000) });
  const value = await response.json() as { ok: boolean; data: T; error: { code: string; message: string } };
  if (!value.ok) throw new AgentError(value.error.code, value.error.message);
  return value.data;
};
const timeline = await command<TrackTimelineDetail>('track.timeline.get', { timelineId: connection.timelineId });
const frames = await command<TrackFramePage>('track.timeline.frames', { timelineId: timeline.id, limit: 100 });
const track = await command<Track>('track.get', { trackId: connection.trackId });
assert.equal(frames.total, frames.items.length);
const env = { engine: { request: command }, projectId: connection.projectId,
  context: { assetIds: frames.items.map(frame => frame.assetId) }, openAsset() {} };
const checked: string[] = [];
async function tool(name: string, args: Record<string, unknown>) {
  const result = await findTool(name).execute(args, env);
  assert.doesNotMatch(JSON.stringify(result), /"(?:inputImage|imagePath|sourcePath|template|annotations)"\s*:/);
  checked.push(name);
  return result as Record<string, any>;
}
await tool('list_video_timelines', { offset: 0, limit: 100 });
const detail = await tool('get_video_timeline', { timelineId: timeline.id, trackId: track.id, offset: 0, limit: 3 });
assert.equal(detail.frames.items.length, 3);
assert.ok(detail.frames.items.every((frame: { sourcePts: unknown }) => typeof frame.sourcePts === 'string'));
await tool('list_video_tracks', { timelineId: timeline.id, includeArchived: true, offset: 0, limit: 100 });
await tool('get_video_track', { trackId: track.id, aroundFrameId: frames.items[2].frameId, offset: 0, limit: 2 });
const histories = await tool('list_track_generations', { trackId: track.id, offset: 0, limit: 100 });
assert.ok(histories.items.length > 0);
for (const section of ['frames', 'intervals', 'skipped'])
  await tool('get_track_generation', { generationId: histories.items[0].id, section, offset: 0, limit: 2 });
const parameters = { trackId: track.id, baseVersion: track.version, timelineVersion: timeline.version, parameters: null, scope: 'all' };
const plan = await tool('preview_track_generation', parameters);
assert.equal(plan.canGenerate, true);
const protectedBefore = await Promise.all(frames.items.filter(frame => frame.protected).map(frame => command<Asset>('asset.get', { assetId: frame.assetId })));
const submitted = await tool('generate_track_candidates', { ...parameters, expectedPlanHash: plan.planHash });
assert.equal(submitted.submitted, true);
let generation: TrackGeneration;
const deadline = Date.now() + 60000;
do {
  generation = await command<TrackGeneration>('track.generation.get', { generationId: submitted.generation.id });
  if (!['queued', 'running', 'cancelling'].includes(generation.status)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
} while (Date.now() < deadline);
assert.equal(generation!.status, 'completed');
assert.equal(generation!.requestsUsed, 0);
const cancel = await tool('cancel_track_generation', { generationId: generation!.id });
assert.equal(cancel.submitted, false);
for (const before of protectedBefore) {
  const after = await command<Asset>('asset.get', { assetId: before.id });
  assert.deepEqual({ version: after.version, annotations: after.annotations }, { version: before.version, annotations: before.annotations });
}
assert.equal(generated, 1);
console.log(JSON.stringify({ passed: true, directAgentTools: true, checked: [...new Set(checked)], newGenerations: generated,
  generationId: generation!.id, status: generation!.status, protectedFramesPreserved: protectedBefore.length,
  annotationApiRequests: 0, agentChatRequests: 0, publicSummariesSanitized: true }));
