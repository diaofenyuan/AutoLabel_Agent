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
