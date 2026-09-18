import assert from 'node:assert/strict';
import test from 'node:test';
import { explain, glossary, glossaryKeys } from '../src/glossary';

/**
 * 术语人话化的守卫：这张表的价值全在「不糊弄」上——只写术语本身、或把术语换个说法再说一遍，
 * 对第一次用软件的人等于没有。所以逐条断言人话与术语不同、说明写成了完整句子。
 */
test('每条术语都给出了人话与用处', () => {
  assert.ok(glossaryKeys.length >= 6, `术语表至少应覆盖首屏会遇到的词，实际 ${glossaryKeys.length} 条`);
  for (const key of glossaryKeys) {
    const entry = glossary[key];
    assert.ok(entry.term.trim(), `${key} 缺少术语原文`);
    assert.ok(entry.plain.trim(), `${key} 缺少一句话人话`);
    assert.ok(entry.detail.trim(), `${key} 缺少「什么时候用得上」`);
    assert.notEqual(entry.plain.trim(), entry.term.trim(), `${key} 的人话不能只是把术语重复一遍`);
    assert.ok(entry.plain.includes('，') || entry.plain.length >= 6, `${key} 的人话太短，读不出所以然：${entry.plain}`);
    assert.ok(/[。！]$/.test(entry.detail), `${key} 的说明应写成完整句子：${entry.detail}`);
    // 悬浮提示由三段拼成：任何一段丢了，用户看到的解释就不完整。
    const hint = explain(key);
    for (const part of [entry.term, entry.plain, entry.detail]) assert.ok(hint.includes(part), `${key} 的悬浮提示漏了「${part}」`);
  }
});

test('术语原文不重复，同一个词不会有两套解释', () => {
  const terms = glossaryKeys.map(key => glossary[key].term);
  assert.equal(new Set(terms).size, terms.length, `存在重复术语：${terms.join('、')}`);
});
