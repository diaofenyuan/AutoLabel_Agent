import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VideoTranscoder } from './transcode';
import { PathGrants } from './security';

const exists = async (value: string) => { try { await stat(value); return true; } catch { return false; } };
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test('转码兜底只接受已授权的视频来源，缺少 FFmpeg 时给出可识别错误码', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-transcode-'));
  try {
    const directory = path.join(root, 'out');
    const source = path.join(root, 'source.mp4');
    await writeFile(source, 'not-a-real-video');
    const grants = new PathGrants();
    // 还没配置媒体工具：走的就是这条分支。
    const transcoder = new VideoTranscoder(async () => ({}), directory, () => {});
    // 未授权来源必须先被拒：转码不能成为绕过文件选择器读取任意本机文件的手段。
    await assert.rejects(() => transcoder.run(source, grants), code('PATH_DENIED'));
    const granted = await grants.add(source, 'video');
    // 已授权但没有 FFmpeg：必须是「媒体运行时未配置」，界面据此给出直达设置的动作。
    await assert.rejects(() => transcoder.run(granted, grants), code('media_runtime_missing'));
    assert.equal(await exists(directory), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('转码副本清理只作用于自己的临时目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autolabel-transcode-'));
  const directory = path.join(root, 'autolabel-transcode');
  const outsider = path.join(root, 'keep.mp4');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(outsider, 'keep');
    await writeFile(path.join(directory, 'a.mp4'), 'a');
    await writeFile(path.join(directory, 'b.mp4'), 'b');
    const transcoder = new VideoTranscoder(async () => ({}), directory, () => {});
    // 这个方法由渲染进程传路径进来，因此必须拒绝目录之外（含用 .. 绕出）的任何路径。
    await transcoder.discard(outsider);
    await transcoder.discard(path.join(directory, '..', 'keep.mp4'));
    assert.equal(await exists(outsider), true);
    await transcoder.sweep();
    assert.deepEqual(await readdir(directory), []);
    assert.equal(await exists(outsider), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
