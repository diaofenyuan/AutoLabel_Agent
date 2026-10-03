import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TOOL_DEFINITIONS } from '../tools.ts';

type RecordValue = Record<string, unknown>;

// 工具清单以 strict: true 随每次对话发送，OpenAI 对不接受的关键字直接 400
// （曾因 uniqueItems 导致全部对话失败）。这里固化文档允许的关键字与结构规则，
// 新增 schema 字段时在测试阶段失败，而不是线上对话失败。
const ALLOWED_KEYWORDS = new Set(['type', 'description', 'enum', 'properties', 'required', 'additionalProperties',
  'items', 'anyOf', '$ref', '$defs', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'patternProperties', 'prefixItems']);

function checkSchema(node: unknown, path: string, toolName: string) {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return;
  const schema = node as RecordValue;
  for (const key of Object.keys(schema)) {
    assert.ok(ALLOWED_KEYWORDS.has(key), `${toolName}: ${path} 使用了 strict 模式不支持的关键字 "${key}"`);
  }
  for (const [name, sub] of Object.entries(schema.properties as RecordValue ?? {})) checkSchema(sub, `${path}/${name}`, toolName);
  for (const [name, sub] of Object.entries(schema.patternProperties as RecordValue ?? {})) checkSchema(sub, `${path}~${name}`, toolName);
  for (const [index, sub] of (schema.prefixItems as unknown[] ?? []).entries()) checkSchema(sub, `${path}/${index}`, toolName);
  checkSchema(schema.items, `${path}[]`, toolName);
  for (const [index, sub] of (schema.anyOf as unknown[] ?? []).entries()) checkSchema(sub, `${path}|${index}`, toolName);
  for (const [name, sub] of Object.entries(schema.$defs as RecordValue ?? {})) checkSchema(sub, `${path}$${name}`, toolName);
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${toolName}: ${path} 缺 additionalProperties: false`);
    const properties = Object.keys(schema.properties as RecordValue ?? {});
    assert.deepEqual([...(schema.required as string[]) ?? []].sort(), [...properties].sort(), `${toolName}: ${path} required 未覆盖全部字段`);
  }
}

test('全部工具 schema 只用 strict 模式接受的关键字并满足对象结构', () => {
  assert.ok(TOOL_DEFINITIONS.length > 0);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.parameters?.type, 'object', `${tool.name}: 根节点必须是 object schema`);
    checkSchema(tool.parameters, '', tool.name);
  }
});
