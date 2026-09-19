export interface ModelPricing {
  model: string; currency: string;
  inputPerMillion?: number; cachedInputPerMillion?: number; outputPerMillion?: number;
}
export interface UsageCost {
  status: 'known' | 'unknown'; currency: string | null; amount: number | null;
  reason?: string; basis: 'reported_usage_user_prices'; providerBilledAmount: null;
  tokens?: { input: number; cachedInput: number | null; output: number };
}
export interface BudgetCost {
  currency: string | null; knownCost: number; knownCalls: number; unknownCalls: number;
  inFlightCalls: number; limit: number | null; control: 'observed_cost_stop'; hardLimit: false;
  basis: 'reported_usage_user_prices'; providerBilledAmount: null;
}
/**
 * 本机推理的成本：不经过任何接口，也就没有调用费，按 0 元计入。
 *
 * 单独成一个显式形状而不是「currency 为空的 BudgetCost」：后者会被读成「没配单价所以金额未知」，
 * 恰好把「本机本来就不花钱」说反了。
 */
export interface LocalMachineCost {
  status: 'free'; currency: null; amount: 0; basis: 'local_machine';
  knownCalls: 0; unknownCalls: 0; inFlightCalls: 0; limit: null;
  control: 'observed_cost_stop'; hardLimit: false; providerBilledAmount: null;
}
export type SchemeCost = BudgetCost | LocalMachineCost;
export function isLocalCost(cost?: SchemeCost): cost is LocalMachineCost {
  return !!cost && (cost as LocalMachineCost).basis === 'local_machine';
}
export interface RequestBudget {
  budgetScopeId: string; requestsUsed: number; maxRequests: number | null; remaining: number | null;
  cost?: BudgetCost;
}
export interface CostEstimate {
  source: 'explicit_token_assumptions'; requests: number;
  assumptions: { inputTokensPerRequest: number; cachedInputTokensPerRequest: number | null; outputTokensPerRequest: number };
  priceSnapshot: Partial<ModelPricing> & { requestedModel: string; providerId: string; providerRevision: number };
  currency: string | null; estimatedCost: number | null; reason: string | null; hardLimit: false;
}
