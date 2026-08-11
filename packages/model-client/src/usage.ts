export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type PricingSnapshot = {
  promptTokenPriceUSD: number;
  completionTokenPriceUSD: number;
};

export const DEFAULT_PRICING: Record<string, PricingSnapshot> = {
  "gpt-4o": { promptTokenPriceUSD: 5.0, completionTokenPriceUSD: 15.0 },
  "gpt-4o-mini": { promptTokenPriceUSD: 0.15, completionTokenPriceUSD: 0.60 },
  "claude-3-5-sonnet": { promptTokenPriceUSD: 3.0, completionTokenPriceUSD: 15.0 },
  "deepseek-chat": { promptTokenPriceUSD: 0.14, completionTokenPriceUSD: 0.28 },
  "deepseek-coder": { promptTokenPriceUSD: 0.14, completionTokenPriceUSD: 0.28 },
  "default": { promptTokenPriceUSD: 1.0, completionTokenPriceUSD: 2.0 }
};

export function estimateCost(model: string, usage: ModelUsage): number {
  let pricing: PricingSnapshot = DEFAULT_PRICING.default!;
  const lowerModel = model.toLowerCase();
  for (const [key, price] of Object.entries(DEFAULT_PRICING)) {
    if (lowerModel.includes(key)) {
      pricing = price!;
      break;
    }
  }
  const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptTokenPriceUSD;
  const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionTokenPriceUSD;
  return promptCost + completionCost;
}

export type ModelCallMetrics = {
  modelAttemptId: string;
  provider: string;
  model: string;
  purpose: string;
  usage?: ModelUsage;
  ttftMs?: number;
  durationMs: number;
  retryCount: number;
  fallbackUsed: boolean;
  costUSD: number;
  error?: string;
};
