import assert from 'node:assert/strict';
import test from 'node:test';
import { referencePrices, referencePriceFor, referencePriceRows, REFERENCE_PRICE_NOTICE } from '../shared/pricing';

// 参考价表是「未手填单价也不大片金额未知」的底数：每一行都必须能指回官方公开价目页。
// 宁缺毋滥——查不到稳定官方价目的服务商/模型就不收录，绝不猜价。
test('参考单价表每行都有官方价目来源与完整三价', () => {
  assert.ok(referencePrices.length >= 1);
  const keys = new Set<string>();
  for (const row of referencePrices) {
    assert.match(row.source, /^https:\/\/\S+$/, `参考价来源必须是官方页地址：${row.model}`);
    assert.match(row.asOf, /^\d{4}-\d{2}-\d{2}$/, '参考价必须带整理日期');
    assert.match(row.currency, /^[A-Z]{3}$/);
    assert.match(row.host, /^[a-z0-9.-]+$/, '主机名匹配要精确到小写域名');
    assert.ok(row.provider.length > 0);
    assert.ok(row.note && row.note.includes('官网为准'), '参考价必须带口径说明（如峰谷价）并指向官网');
    for (const rate of [row.inputPerMillion, row.cachedInputPerMillion, row.outputPerMillion]) {
      assert.ok(Number.isFinite(rate) && rate >= 0, `单价必须是非负有限数：${row.model}`);
    }
    const key = `${row.host}/${row.model}`;
    assert.ok(!keys.has(key), `参考价行重复：${key}`);
    keys.add(key);
    assert.equal(referencePriceFor(`https://${row.host}/v1`, row.model), row, '主机名 + 精确模型名必须命中');
    assert.equal(referencePriceFor('https://api.example-mirror.test/v1', row.model), undefined, '中转站同名模型不套用官方参考价');
    assert.equal(referencePriceFor(`https://${row.host}/v1`, `${row.model}-other`), undefined, '不做前缀猜测');
  }
  assert.deepEqual(referencePriceRows().map(row => row.model), referencePrices.map(row => row.model), '引擎下发行与表一致');
  assert.ok(REFERENCE_PRICE_NOTICE.includes('手填') && REFERENCE_PRICE_NOTICE.includes('参考价'), '必须明示参考价口径与手填优先');
});
