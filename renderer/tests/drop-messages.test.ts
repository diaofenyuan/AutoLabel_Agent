import test from 'node:test';
import assert from 'node:assert/strict';
import { dropRejectionNotice, emptyDroppedFiles, type DroppedFiles } from '../src/dropMessages';

/**
 * 拖入拒绝提示是纯函数，直接断言最省事，也最容易在有人重新引入原始错误码时立刻失败。
 * 走查里用户看到的是「暂不支持这些文件：images」和「[INVALID_PAYLOAD] 拖入的文件数量无效」——两句都无法据此行动。
 */
const files = (value: Partial<DroppedFiles>): DroppedFiles => ({ ...emptyDroppedFiles, ...value });

test('拖入拒绝按原因分组，给出可执行下一步且不出现内部错误码', () => {
  // 四类输入必须给出互不相同的提示。
  const folder = dropRejectionNotice(files({ rejected: [{ name: 'images', reason: 'unsupported_extension' }] }))!;
  const text = dropRejectionNotice(files({ rejected: [{ name: '测试使用.txt', reason: 'unsupported_extension' }] }))!;
  const over = dropRejectionNotice(files({ overLimit: { limit: 500, received: 501 } }))!;
  const stale = dropRejectionNotice(files({ rejected: [{ name: 'a.png', reason: 'invalid_path' }] }))!;
  assert.equal(new Set([folder, text, over, stale]).size, 4, '四类原因应给出不同的提示');
  // 数量上限要说清上限与本次数量，而不是抛错误码。
  assert.ok(over.includes('一次最多拖入 500 个文件，本次 501 个'), over);
  assert.ok(over.includes('导入图片文件夹'), '超量时应该给出替代入口');
  // 格式不支持要带上可拖入格式清单。
  assert.ok(text.includes('测试使用.txt') && text.includes('JPG / JPEG / PNG'), text);
  assert.ok(text.includes('文件夹会被整目录导入'), '既然支持文件夹，提示里就该写明');
  // 路径失效要区分于格式问题。
  assert.ok(stale.includes('路径无效或已失效'), stale);
  for (const message of [folder, text, over, stale]) assert.doesNotMatch(message, /INVALID_PAYLOAD|unsupported_extension|invalid_path|PAYLOAD_TOO_LARGE/);
  // 只报文件名、不报数量，是原先最含糊的一条。
  const many = dropRejectionNotice(files({ rejected: Array.from({ length: 7 }, (_, index) => ({ name: `f${index}.txt`, reason: 'unsupported_extension' })) }))!;
  assert.ok(many.includes('等 7 个文件'), many);

  assert.equal(dropRejectionNotice(files({})), null, '没有问题时不产生提示');
  assert.equal(dropRejectionNotice(files({ unresolved: ['a.png', 'b.png'] }))?.includes('没有拿到磁盘路径'), true);
});
