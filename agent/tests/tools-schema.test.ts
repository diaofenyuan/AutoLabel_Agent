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

/**
 * 必须声明为枚举、且需要写明取值语义的参数（工具名 → 参数名 → 示例取值）。
 *
 * 模型只能看到工具 schema：枚举参数若只留自由字符串，模型无从得知合法取值，
 * 只能猜或照抄校验报错文案——曾因此把「hint、template 或 none」当成 reuseScope 传回，
 * 触发一个必然失败的自触发循环。取值语义复杂时（不是从参数名就能推出）还须写明各档差异。
 */
const ENUM_SEMANTICS: Record<string, Record<string, string>> = {
  run_annotation: { reuseScope: 'hint' },
  list_assets: { status: 'unlabeled' },
  list_review_items: { status: 'pending', source: 'hard' }
};

test('枚举参数在 schema 中声明 enum 且写明取值语义', () => {
  const byTool = new Map<string, RecordValue>();
  for (const tool of TOOL_DEFINITIONS) byTool.set(tool.name, tool.parameters as RecordValue);

  for (const tool of TOOL_DEFINITIONS) {
    const properties = (tool.parameters as RecordValue).properties as RecordValue;
    for (const [name, sub] of Object.entries(properties)) {
      const schema = sub as RecordValue;
      if (!Array.isArray(schema.enum)) continue;
      const key = `${tool.name}.${name}`;
      // 可空枚举必须把 null 一起列进 enum，否则模型传 null 表示「用默认值」时会与 schema 冲突。
      const nullable = Array.isArray(schema.type) && schema.type.includes('null');
      assert.equal(schema.enum.includes(null), nullable, `${key}: 可空枚举未把 null 列入 enum`);
      if (ENUM_SEMANTICS[tool.name]?.[name]) assert.ok(schema.description, `${key}: 枚举参数缺少 description`);
    }
  }

  // 定向清单里的参数不能被悄悄改回自由字符串：这类回退会让模型重新开始猜值。
  for (const [toolName, params] of Object.entries(ENUM_SEMANTICS)) {
    const properties = (byTool.get(toolName)?.properties ?? {}) as RecordValue;
    for (const [name, sample] of Object.entries(params))
      assert.ok(Array.isArray((properties[name] as RecordValue | undefined)?.enum),
        `${toolName}.${name}: 应声明为枚举参数（示例取值 ${sample}），实际未声明 enum`);
  }
});
