import test from 'node:test';
import assert from 'node:assert/strict';
import { obbCorners } from '../src/ResultViewer';

/**
 * 只读预览里旋转框的取角点口径。
 *
 * 这条断言针对一个具体回归：预览过去按 bbox 直出 rect、同时又画 points 多边形，
 * 对象一旦同时带两套字段就会显示两个框；points 形态（模型产出）则根本没有 rotation，
 * 旋转角被当成 0。这里锁定「角点优先、缺省才展开、且两者不会同时绘制」。
 */

const bbox = { x: 200, y: 180, width: 200, height: 120 };

test('旋转框优先使用角点，bbox 与 rotation 不参与渲染', () => {
  const corners = obbCorners({
    points: [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }],
    bbox,
    rotation: 30,
  });

  assert.deepEqual(corners, [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }]);
});

test('没有角点时按 bbox 与 rotation 展开出四角', () => {
  // 0° 展开后应还原成未旋转的矩形本身。
  assert.deepEqual(obbCorners({ bbox, rotation: 0 }), [
    { x: 200, y: 180 }, { x: 400, y: 180 }, { x: 400, y: 300 }, { x: 200, y: 300 },
  ]);

  const rotated = obbCorners({ bbox, rotation: 90 });
  assert.equal(rotated.length, 4);
  // 旋转不改变矩形自身：中心与四个角到中心的半对角线长都必须与未旋转时一致。
  const centerX = rotated.reduce((sum, p) => sum + p.x, 0) / 4;
  const centerY = rotated.reduce((sum, p) => sum + p.y, 0) / 4;
  assert.ok(Math.abs(centerX - 300) < 1e-9 && Math.abs(centerY - 240) < 1e-9, '旋转后中心偏移');
  const halfDiagonal = Math.hypot(bbox.width / 2, bbox.height / 2);
  for (const corner of rotated) {
    assert.ok(Math.abs(Math.hypot(corner.x - 300, corner.y - 240) - halfDiagonal) < 1e-9, '角点到中心的距离应等于半对角线');
  }
  // 角点确实偏离了原矩形位置，否则说明 rotation 没生效。
  assert.ok(rotated.some(p => Math.abs(p.x - 200) > 1e-9 || Math.abs(p.y - 180) > 1e-9), '90° 旋转后不应与原矩形重合');
});

test('退化几何按没有角点处理，不返回零面积矩形', () => {
  assert.deepEqual(obbCorners({ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }), []);
  assert.deepEqual(obbCorners({ bbox: { ...bbox, width: 0 } }), []);
  assert.deepEqual(obbCorners({}), []);
});