import type { ModelConfig } from "@xiaoshuo/config-service";
import { z } from "zod";
import { OpenAICompatibleClient, type ChatCompletionMessage } from "./openai-compatible.js";
import { ModelRetryPolicy } from "./retry-policy.js";
import { StructuredOutputManager } from "./structured-output.js";
import { estimateCost, type ModelCallMetrics, type ModelUsage } from "./usage.js";

export type DataClassification = "public" | "project" | "private_local";

export type GatewayRequestOptions = {
  purpose: "chat" | "planning" | "routing" | "verification" | "writing";
  dataClassification?: DataClassification;
  signal?: AbortSignal;
  fallbackConfigs?: ModelConfig[];
  runId?: string;
  stepId?: string;
  attemptId?: string;
  disableRateLimiter?: boolean;
};

export type GatewayRequestHook = (data: {
  attemptId: string;
  runId?: string;
  stepId?: string;
  attemptIdFromOption?: string;
  provider: string;
  model: string;
  purpose: string;
  messages: ChatCompletionMessage[];
}) => void;

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly threshold = 3;
  private readonly cooldownMs = 15000;

  recordSuccess() {
    this.state = "closed";
    this.failureCount = 0;
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = "open";
    }
  }

  canExecute(): boolean {
    if (this.state === "closed") {
      return true;
    }
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }
    return true;
  }
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens = 5;
  private readonly refillRate = 1;

  constructor() {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) {
        throw new Error("操作已取消");
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens--;
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export class ModelGateway {
  private readonly client: OpenAICompatibleClient;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly limiters = new Map<string, TokenBucketRateLimiter>();
  private onMetricsCallback?: (metrics: ModelCallMetrics) => void;

  constructor(client?: OpenAICompatibleClient) {
    this.client = client ?? new OpenAICompatibleClient();
  }

  private onBeforeRequestCallback?: GatewayRequestHook;

  registerBeforeRequestCallback(callback: GatewayRequestHook) {
    this.onBeforeRequestCallback = callback;
  }

  registerMetricsCallback(callback: (metrics: ModelCallMetrics) => void) {
    this.onMetricsCallback = callback;
  }

  private getBreaker(model: string): CircuitBreaker {
    let breaker = this.breakers.get(model);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(model, breaker);
    }
    return breaker;
  }

  private getLimiter(model: string): TokenBucketRateLimiter {
    let limiter = this.limiters.get(model);
    if (!limiter) {
      limiter = new TokenBucketRateLimiter();
      this.limiters.set(model, limiter);
    }
    return limiter;
  }

  private verifyPrivacyBoundary(config: ModelConfig, classification?: DataClassification) {
    if (classification === "private_local") {
      const url = String(config.base_url || "").toLowerCase();
      const isLocal =
        url.includes("localhost") ||
        url.includes("127.0.0.1") ||
        url.includes("[::1]") ||
        url.includes("local");
      if (!isLocal) {
        throw new Error(`隐私安全策略拦截：禁止向云端模型发送本地私密数据 (DataClassification: private_local)`);
      }
    }
  }

  async completeText(
    config: ModelConfig,
    messages: ChatCompletionMessage[],
    options: GatewayRequestOptions
  ): Promise<string> {
    return this.executeRequest(config, messages, options, async (activeConfig, activeMessages) => {
      return this.client.requestCompletion(activeConfig, activeMessages, activeConfig.temperature, { signal: options.signal });
    });
  }

  async completeStructured<T>(
    config: ModelConfig,
    messages: ChatCompletionMessage[],
    schema: z.ZodType<T>,
    options: GatewayRequestOptions
  ): Promise<T> {
    const rawText = await this.executeRequest(config, messages, options, async (activeConfig, activeMessages) => {
      const strictMessages = [...activeMessages];
      const lastMsg = strictMessages[strictMessages.length - 1];
      if (lastMsg) {
        strictMessages[strictMessages.length - 1] = {
          role: lastMsg.role,
          content: StructuredOutputManager.buildStrictPrompt(schema, lastMsg.content)
        };
      }
      return this.client.requestCompletion(activeConfig, strictMessages, 0.1, { signal: options.signal });
    });

    try {
      return StructuredOutputManager.parseWithSchema(rawText, schema);
    } catch (parseError) {
      const repairPrompt = `请修复以下损坏的 JSON 文本，使其完全符合标准的 JSON 语法规范，并且包含与原损坏文本同等的数据。只能输出纯 JSON，不要带有 markdown 包裹或任何多余文字。
损坏文本如下：
${rawText}`;
      
      try {
        const repairedText = await this.executeRequest(config, [
          { role: "user", content: repairPrompt }
        ], { ...options, purpose: "verification" }, async (activeConfig, activeMessages) => {
          return this.client.requestCompletion(activeConfig, activeMessages, 0.1, { signal: options.signal });
        });
        return StructuredOutputManager.parseWithSchema(repairedText, schema);
      } catch {
        throw parseError;
      }
    }
  }

  async *streamText(
    config: ModelConfig,
    messages: ChatCompletionMessage[],
    options: GatewayRequestOptions
  ): AsyncGenerator<string> {
    const attemptId = `model_attempt_${Math.random().toString(36).slice(2, 10)}`;
    const breaker = this.getBreaker(config.model);
    const limiter = this.getLimiter(config.model);

    if (!breaker.canExecute()) {
      if (options.fallbackConfigs && options.fallbackConfigs.length > 0) {
        const fallback = options.fallbackConfigs[0]!;
        const nextFallbacks = options.fallbackConfigs.slice(1);
        yield* this.streamText(fallback, messages, { ...options, fallbackConfigs: nextFallbacks });
        return;
      }
      throw new Error(`模型熔断器已开启，快速失败: ${config.model}`);
    }

    if (!options.disableRateLimiter) {
      await limiter.acquire(options.signal);
    }
    this.verifyPrivacyBoundary(config, options.dataClassification);

    if (this.onBeforeRequestCallback) {
      this.onBeforeRequestCallback({
        attemptId,
        runId: options.runId,
        stepId: options.stepId,
        attemptIdFromOption: options.attemptId,
        provider: config.base_url || "unknown",
        model: config.model,
        purpose: options.purpose,
        messages
      });
    }

    let started = false;
    let tokensCount = 0;
    const startedAt = Date.now();

    try {
      for await (const chunk of this.client.streamCompletion(config, messages, config.temperature, { signal: options.signal })) {
        started = true;
        tokensCount++;
        yield chunk;
      }
      breaker.recordSuccess();
      
      if (this.onMetricsCallback) {
        const usage: ModelUsage = {
          promptTokens: messages.reduce((sum, m) => sum + m.content.length, 0) / 2,
          completionTokens: tokensCount * 1.5,
          totalTokens: (messages.reduce((sum, m) => sum + m.content.length, 0) / 2) + (tokensCount * 1.5)
        };
        this.onMetricsCallback({
          modelAttemptId: attemptId,
          provider: config.base_url || "unknown",
          model: config.model,
          purpose: options.purpose,
          usage,
          durationMs: Date.now() - startedAt,
          retryCount: 0,
          fallbackUsed: false,
          costUSD: estimateCost(config.model, usage)
        });
      }
    } catch (error) {
      breaker.recordFailure();
      if (started) {
        throw error;
      }
      
      if (options.fallbackConfigs && options.fallbackConfigs.length > 0) {
        const fallback = options.fallbackConfigs[0]!;
        const nextFallbacks = options.fallbackConfigs.slice(1);
        yield* this.streamText(fallback, messages, { ...options, fallbackConfigs: nextFallbacks });
        return;
      }
      throw error;
    }
  }

  async requestCompletion(
    config: ModelConfig,
    messages: ChatCompletionMessage[],
    temperature?: number,
    options: { signal?: AbortSignal } = {}
  ): Promise<string> {
    const activeConfig = { ...config };
    if (temperature !== undefined) {
      activeConfig.temperature = temperature;
    }
    return this.completeText(activeConfig, messages, { purpose: "chat", signal: options.signal });
  }

  async *streamCompletion(
    config: ModelConfig,
    messages: ChatCompletionMessage[],
    temperature?: number,
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<string> {
    const activeConfig = { ...config };
    if (temperature !== undefined) {
      activeConfig.temperature = temperature;
    }
    yield* this.streamText(activeConfig, messages, { purpose: "chat", signal: options.signal });
  }

  private async executeRequest(
    config: ModelConfig,
    messages: ChatCompletionMessage[],
    options: GatewayRequestOptions,
    caller: (activeConfig: ModelConfig, activeMessages: ChatCompletionMessage[]) => Promise<string>
  ): Promise<string> {
    const attemptId = `model_attempt_${Math.random().toString(36).slice(2, 10)}`;
    const breaker = this.getBreaker(config.model);
    const limiter = this.getLimiter(config.model);

    if (!breaker.canExecute()) {
      if (options.fallbackConfigs && options.fallbackConfigs.length > 0) {
        const fallback = options.fallbackConfigs[0]!;
        const nextFallbacks = options.fallbackConfigs.slice(1);
        return this.executeRequest(fallback, messages, { ...options, fallbackConfigs: nextFallbacks }, caller);
      }
      throw new Error(`模型熔断器已开启，快速失败: ${config.model}`);
    }

    if (!options.disableRateLimiter) {
      await limiter.acquire(options.signal);
    }
    this.verifyPrivacyBoundary(config, options.dataClassification);

    if (this.onBeforeRequestCallback) {
      this.onBeforeRequestCallback({
        attemptId,
        runId: options.runId,
        stepId: options.stepId,
        attemptIdFromOption: options.attemptId,
        provider: config.base_url || "unknown",
        model: config.model,
        purpose: options.purpose,
        messages
      });
    }

    const startedAt = Date.now();
    let retryCount = 0;

    try {
      const result = await ModelRetryPolicy.executeWithRetry(async (attempt) => {
        retryCount = attempt - 1;
        return await caller(config, messages);
      }, {
        signal: options.signal,
        ...(options.disableRateLimiter ? { maxRetries: 0 } : {})
      });

      breaker.recordSuccess();

      if (this.onMetricsCallback) {
        const usage: ModelUsage = {
          promptTokens: messages.reduce((sum, m) => sum + m.content.length, 0) / 2,
          completionTokens: result.length / 2,
          totalTokens: (messages.reduce((sum, m) => sum + m.content.length, 0) / 2) + (result.length / 2)
        };
        this.onMetricsCallback({
          modelAttemptId: attemptId,
          provider: config.base_url || "unknown",
          model: config.model,
          purpose: options.purpose,
          usage,
          durationMs: Date.now() - startedAt,
          retryCount,
          fallbackUsed: options.fallbackConfigs && options.fallbackConfigs.length > 0 ? true : false,
          costUSD: estimateCost(config.model, usage)
        });
      }

      return result;
    } catch (error) {
      breaker.recordFailure();

      if (options.fallbackConfigs && options.fallbackConfigs.length > 0) {
        const fallback = options.fallbackConfigs[0]!;
        const nextFallbacks = options.fallbackConfigs.slice(1);
        return this.executeRequest(fallback, messages, { ...options, fallbackConfigs: nextFallbacks }, caller);
      }
      throw error;
    }
  }
}
