import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfiguration } from '../../shared/configuration.ts';

test('步骤覆盖项目，项目覆盖全局，角色模型分别解析', () => {
  const global = { chatProviderId: 'chat-global', chatModel: 'chat-model', annotationProviderId: 'annotation-global', annotationModel: 'base-model', concurrency: 4, maxRequests: 50 };
  const project = { providerId: 'annotation-project', model: 'project-model', chatProviderId: 'chat-project', chatModel: 'project-chat', prompt: '项目规则', concurrency: 2 };
  const annotation = resolveConfiguration('annotation', global, project, { model: 'step-model', concurrency: 1 });
  assert.equal(annotation.providerId, 'annotation-project');
  assert.equal(annotation.model, 'step-model');
  assert.equal(annotation.prompt, '项目规则');
  assert.equal(annotation.concurrency, 1);
  assert.equal(annotation.maxRequests, 50);
  assert.deepEqual(annotation.sources, { providerId: 'project', model: 'step', prompt: 'project', concurrency: 'step', maxRequests: 'global' });
  const chat = resolveConfiguration('chat', global, project);
  assert.equal(chat.providerId, 'chat-project');
  assert.equal(chat.model, 'project-chat');
  assert.equal(global.annotationModel, 'base-model');
  assert.equal(project.model, 'project-model');
});

test('接口改变不串用下层模型，同一接口可以继承模型', () => {
  const global = { annotationProviderId: 'first', annotationModel: 'first-model' };
  const changed = resolveConfiguration('annotation', global, { providerId: 'second' });
  assert.equal(changed.model, undefined);
  assert.equal(changed.issues[0]?.code, 'model_required');
  assert.equal(resolveConfiguration('annotation', global, { providerId: 'first' }).model, 'first-model');
  assert.equal(resolveConfiguration('annotation', global, {}, { providerId: 'third', model: 'third-model' }).model, 'third-model');
  const staleAliases = resolveConfiguration('annotation', {}, { annotationProviderId: 'new', providerId: 'old', model: 'old-model' });
  assert.equal(staleAliases.model, undefined);
  assert.equal(staleAliases.issues[0]?.code, 'model_required');
});

test('显式无请求上限保留，非法上层参数不能悄悄退回默认值', () => {
  const result = resolveConfiguration('annotation', { maxRequests: 100, concurrency: 4 }, { maxRequests: null, concurrency: 0 });
  assert.equal(result.maxRequests, null);
  assert.equal(result.concurrency, undefined);
  assert.deepEqual(result.issues.map(issue => issue.field), ['concurrency']);
  const repaired = resolveConfiguration('annotation', {}, { concurrency: 0 }, { concurrency: 3 });
  assert.equal(repaired.concurrency, 3);
  assert.deepEqual(repaired.issues, []);
  assert.equal(resolveConfiguration('annotation', { maxRequests: 5 }, {}, { maxRequests: NaN }).maxRequests, undefined);
});
