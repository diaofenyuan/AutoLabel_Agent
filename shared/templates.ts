import type { LabelClass, TaskType } from './protocol.ts';

export type TemplateAttributeValue = string | number | boolean;

/** 只保存影响标注语义的字段，旧快照不得从活动项目回填。 */
export interface TaskTemplateSnapshot {
  snapshotVersion: 2; taskType: TaskType; classes: LabelClass[];
  settings: {
    keypointNames?: string[];
    keypointConnections?: Array<[string | number, string | number]>;
    attributes?: unknown; rules?: unknown; occlusionRules?: unknown; blurRules?: unknown;
  };
}

interface TemplateAttributeBase {
  id: string;
  name: string;
  required: boolean;
}

export type TemplateAttributeDefinition =
  | (TemplateAttributeBase & { type: 'text'; maxLength?: number })
  | (TemplateAttributeBase & { type: 'number'; min?: number; max?: number })
  | (TemplateAttributeBase & { type: 'boolean' })
  | (TemplateAttributeBase & { type: 'select'; options: string[] });

// 只有明确声明此包装的属性启用结构校验，旧说明 JSON 不应被强制转换为此类型。
export interface TemplateAttributeDefinitions {
  kind: 'attribute_definitions';
  version: 1;
  definitions: TemplateAttributeDefinition[];
}

export type TemplateAttributeIssueCode =
  | 'attribute_definition_invalid_type'
  | 'attribute_definition_unknown_field'
  | 'attribute_definition_unsupported_version'
  | 'attribute_definition_limit'
  | 'attribute_definition_invalid_id'
  | 'attribute_definition_duplicate_id'
  | 'attribute_definition_invalid_name'
  | 'attribute_definition_invalid_constraint'
  | 'attribute_definition_invalid_options'
  | 'attribute_value_required'
  | 'attribute_value_invalid_type'
  | 'attribute_value_out_of_range'
  | 'attribute_value_not_in_options';

export interface TemplateAttributeIssue {
  path: string;
  code: TemplateAttributeIssueCode;
  message: string;
  attributeId?: string;
}
