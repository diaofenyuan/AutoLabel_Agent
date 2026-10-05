import assert from 'node:assert/strict';
import test from 'node:test';
import { pickReviewTarget } from '../src/reviewTarget';

const options = { evaluations: ['e-new', 'e-old'], runs: ['r-new', 'r-old'] };

test('从某次历史评测切到难例队列时保留那份评测，而不是退回最新一条', () => {
  assert.equal(pickReviewTarget('hard', 'e-old', options), 'evaluation:e-old');
});

test('从某次运行切到难例队列时保留那次运行并补回 run 前缀', () => {
  assert.equal(pickReviewTarget('hard', 'r-old', options), 'run:r-old');
});

test('难例队列切回评测或运行来源时沿用同一条记录', () => {
  assert.equal(pickReviewTarget('evaluation', 'e-old', options), 'e-old');
  assert.equal(pickReviewTarget('run', 'r-old', options), 'r-old');
});

test('评测与运行互切时退回该类最新一条，不把另一类的 ID 当成本类记录', () => {
  assert.equal(pickReviewTarget('run', 'e-old', options), 'r-new');
  assert.equal(pickReviewTarget('evaluation', 'r-old', options), 'e-new');
});

test('当前记录已不在新来源的候选里时退回最新一条，空列表返回空串', () => {
  assert.equal(pickReviewTarget('evaluation', 'gone', options), 'e-new');
  assert.equal(pickReviewTarget('hard', 'gone', options), 'evaluation:e-new');
  assert.equal(pickReviewTarget('hard', '', { evaluations: [], runs: ['r-only'] }), 'run:r-only');
  assert.equal(pickReviewTarget('evaluation', '', { evaluations: [], runs: [] }), '');
});
