import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * classifyDrop 的分类数组必须每次全新。曾因从共享常量上展开数组引用，
 * 上一次拖入的路径清不掉：用户删掉的附件在下一次拖入时「复活」并越积越多。
 * bridge.ts 在模块初始化时读 window，所以这里先挂最小桥桩再动态导入被测模块。
 */
test('classifyDrop 每次拖入拿到全新分类，同一次内的重复路径只保留一条', async () => {
  (globalThis as unknown as { window: unknown }).window = {
    autoLabel: { pathForFile: (file: { name: string }) => file.name },
  };
  const { classifyDrop } = await import('../src/fileDrop');
  const asFile = (name: string) => ({ name }) as File;

  const first = await classifyDrop([asFile('D:\\素材\\data')]);
  assert.deepEqual(first.directories, ['D:\\素材\\data']);

  // 第二次拖入既不能带上第一次的残留，也不能把系统重复交来的同一路径挂成两枚附件。
  const second = await classifyDrop([asFile('D:\\素材\\data'), asFile('D:\\素材\\data'), asFile('D:\\素材\\a.png'), asFile('D:\\素材\\b.mp4')]);
  assert.deepEqual(second.directories, ['D:\\素材\\data']);
  assert.deepEqual(second.images, ['D:\\素材\\a.png']);
  assert.deepEqual(second.videos, ['D:\\素材\\b.mp4']);
  assert.deepEqual(second.unresolved, []);
  assert.deepEqual(second.rejected, []);
});

test('没有本地路径的剪贴板文件不应被误报为超量拖入', async () => {
  (globalThis as unknown as { window: unknown }).window = {
    autoLabel: {
      pathForFile: () => '',
      grantDroppedFiles: async (paths: string[]) => {
        assert.deepEqual(paths, []);
        return { granted: [], rejected: [], overLimit: { limit: 500, received: 0 } };
      },
    },
  };
  const { classifyDrop } = await import('../src/fileDrop');
  const result = await classifyDrop([{ name: 'clipboard.png' } as File]);
  assert.deepEqual(result.unresolved, ['clipboard.png']);
  assert.equal(result.overLimit, null);
});
