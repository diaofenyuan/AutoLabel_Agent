/**
 * 参考单价表（宁缺毋滥）：只收录能核实到服务商官方公开价目页的行。
 *
 * 用途：用户没有手填单价时，用参考价把「金额未知」变成可见的预估，费用预算不再直接停摆。
 * 口径：参考价仅用于预估，实际以服务商账单为准；在「在线接口」里手填的单价逐字段优先生效。
 * 没有收录的服务商/模型（聚合站、自建中转、官网取不到稳定价目页的）一律不猜——保持「金额未知」并提示手填。
 */
export interface ReferencePrice {
  /** 展示名（与「在线接口」预设一致）。 */
  provider: string;
  /** 匹配接口基础地址的主机名（精确匹配；中转站同名模型不套用官方价，避免误估）。 */
  host: string;
  /** 精确模型名，不做前缀猜测。 */
  model: string;
  currency: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  /** 官方价目页地址。 */
  source: string;
  /** 整理日期（YYYY-MM-DD）。 */
  asOf: string;
  note?: string;
}

export const REFERENCE_PRICE_NOTICE =
  '参考价整理自各服务商官方公开价目页（2026-09），仅用于预估，实际以账单为准；在「在线接口」手填单价会逐字段优先生效。';

export const referencePrices: ReferencePrice[] = [
  { provider: 'OpenAI', host: 'api.openai.com', model: 'gpt-4o-mini', currency: 'USD',
    inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6,
    source: 'https://openai.com/api/pricing/', asOf: '2026-09-23',
    note: '缓存输入按官方自动缓存折扣（输入半价）计；实际价以官网为准。' },
  { provider: 'OpenAI', host: 'api.openai.com', model: 'gpt-4o', currency: 'USD',
    inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10,
    source: 'https://openai.com/api/pricing/', asOf: '2026-09-23',
    note: '缓存输入按官方自动缓存折扣（输入半价）计；实际价以官网为准。' },
  { provider: 'DeepSeek', host: 'api.deepseek.com', model: 'deepseek-flash', currency: 'USD',
    inputPerMillion: 0.3, cachedInputPerMillion: 0.006, outputPerMillion: 1.2,
    source: 'https://api-docs.deepseek.com/quick_start/pricing/', asOf: '2026-09-23',
    note: '峰时价（保守口径）；空闲时段半价，峰谷时段与最终价以官网为准。' },
  { provider: 'DeepSeek', host: 'api.deepseek.com', model: 'deepseek-v4-pro', currency: 'USD',
    inputPerMillion: 1.32, cachedInputPerMillion: 0.044, outputPerMillion: 3.96,
    source: 'https://api-docs.deepseek.com/quick_start/pricing/', asOf: '2026-09-23',
    note: '峰时价（保守口径）；空闲时段半价，峰谷时段与最终价以官网为准。' },
];

/** 引擎侧接收的行形状（经桌面启动参数下发，引擎不内置、不联网取价）。 */
export interface EngineReferencePrice {
  host: string; model: string; currency: string;
  inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number;
  source: string; asOf: string; note?: string;
}

export function referencePriceRows(): EngineReferencePrice[] {
  return referencePrices.map(({ host, model, currency, inputPerMillion, cachedInputPerMillion, outputPerMillion, source, asOf, note }) =>
    ({ host, model, currency, inputPerMillion, cachedInputPerMillion, outputPerMillion, source, asOf, ...(note ? { note } : {}) }));
}

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host.toLowerCase(); } catch { return ''; }
}

/** 按「接口主机名 + 精确模型名」查参考价；查不到就是没有参考价（不猜）。 */
export function referencePriceFor(baseUrl: string, model: string): ReferencePrice | undefined {
  const host = hostOf(baseUrl);
  return referencePrices.find(row => row.host === host && row.model === model);
}
