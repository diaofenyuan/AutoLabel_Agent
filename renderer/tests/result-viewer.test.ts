import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAnnotationClasses } from '../src/ResultViewer';

test('运行中候选缺少当前类别时使用候选冻结模板显示类别', () => {
  const classes = mergeAnnotationClasses([], {
    annotationTemplate: {
      classes: [{ id: 'vehicle', name: '车辆', color: '#4a83ff' }],
    },
  });

  assert.deepEqual(classes, [{ id: 'vehicle', name: '车辆', color: '#4a83ff' }]);
});

test('当前项目类别优先，冻结模板只补充缺失的类别', () => {
  const classes = mergeAnnotationClasses(
    [{ id: 'vehicle', name: '交通工具', color: '#ff0000' }],
    { annotationTemplate: { classes: [{ id: 'vehicle', name: '车辆', color: '#4a83ff' }, { id: 'person', name: '行人', color: '#ba6de2' }] } },
  );

  assert.deepEqual(classes, [
    { id: 'vehicle', name: '交通工具', color: '#ff0000' },
    { id: 'person', name: '行人', color: '#ba6de2' },
  ]);
});
