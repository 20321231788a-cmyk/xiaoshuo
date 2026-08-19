import type { ModelConfig } from "@xiaoshuo/config-service";
import { resolveModelRequestCapability, type ReasoningEffort } from "@xiaoshuo/shared";
import type { ModelUsage } from "./usage.js";

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenAICompatibleClientOptions = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export type ModelRequestOptions = {
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  /** Trusted hard cap applied to the provider request; never supplied by model text. */
  maxOutputTokens?: number;
  /** Request provider usage in stream terminal events when the provider supports it. */
  captureUsage?: boolean;
  /**
   * Lifecycle callbacks for each physical HTTP dispatch. They intentionally
   * live below requestCompletion so stream fallback and retry paths cannot
   * hide an outbound call from a durable budget governor.
   */
  dispatchLifecycle?: ModelDispatchLifecycle;
};

export type ModelStreamChunk = {
  channel: "reasoning" | "answer";
  text: string;
  /** Normalized provider terminal reason, present on the final stream item. */
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "unknown";
  /** Original provider value, retained for trace and recovery diagnostics. */
  provider_finish_reason?: string;
};

export type ModelCompletionResult = {
  reasoning: string;
  answer: string;
};

export type ModelDispatchInput = {
  config: Pick<ModelConfig, "base_url" | "model">;
  messages: ChatCompletionMessage[];
  stream: boolean;
  maxOutputTokens?: number;
};

export type ModelDispatchLifecycle = {
  beforeDispatch?: (input: ModelDispatchInput) => unknown | Promise<unknown>;
  onDispatchStarted?: (input: ModelDispatchInput & { context: unknown }) => void | Promise<void>;
  onUsage?: (input: ModelDispatchInput & { context: unknown; usage: ModelUsage }) => void | Promise<void>;
  onDispatchFinished?: (input: ModelDispatchInput & {
    context: unknown;
    usage?: ModelUsage;
    error?: unknown;
  }) => void | Promise<void>;
};

type DispatchRecord = {
  input: ModelDispatchInput;
  context: unknown;
  lifecycle: ModelDispatchLifecycle;
  usage?: ModelUsage;
};

export class OpenAICompatibleClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly dispatchRecords = new WeakMap<Response, DispatchRecord>();

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 240_000;
  }

  async requestCompletion(config: ModelConfig, messages: ChatCompletionMessage[], temperature?: number, options: ModelRequestOptions = {}): Promise<string> {
    let streamError = "";
    try {
      const chunks: string[] = [];
      for await (const chunk of this.streamCompletion(config, messages, temperature, options)) {
        chunks.push(chunk);
      }
      const streamed = chunks.join("").trim();
      if (streamed) {
        return streamed;
      }
    } catch (error) {
      if (isAbortLike(error, options.signal)) {
        throw createAbortError();
      }
      streamError = error instanceof Error ? error.message : String(error);
      if (!canRetryWithoutStream(streamError)) {
        throw error;
      }
    }

    const response = await this.fetchChatCompletions(config, buildRequestBody(config, messages, temperature, options), options);

    try {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(formatApiError(response.status, text));
      }

      const payload = await response.json();
      const usage = extractProviderUsage(payload);
      if (usage) {
        await this.recordDispatchUsage(response, usage);
      }
      const result = extractMessageText(payload).trim();
      if (result) {
        return result;
      }
      throw new Error(streamError ? `模型返回空内容（流式错误：${streamError}）` : "模型返回空内容");
    } catch (error) {
      await this.finishDispatch(response, error);
      throw error;
    } finally {
      await this.finishDispatch(response);
    }
  }

  async requestDetailedCompletion(config: ModelConfig, messages: ChatCompletionMessage[], temperature?: number, options: ModelRequestOptions = {}): Promise<ModelCompletionResult> {
    let streamError = "";
    try {
      const reasoningParts: string[] = [];
      const answerParts: string[] = [];
      for await (const chunk of this.streamDetailedCompletion(config, messages, temperature, options)) {
        (chunk.channel === "reasoning" ? reasoningParts : answerParts).push(chunk.text);
      }
      const answer = answerParts.join("").trim();
      if (answer) {
        return { reasoning: reasoningParts.join("").trim(), answer };
      }
    } catch (error) {
      if (isAbortLike(error, options.signal)) throw createAbortError();
      streamError = error instanceof Error ? error.message : String(error);
      if (!canRetryWithoutStream(streamError)) throw error;
    }

    const response = await this.fetchChatCompletions(config, buildRequestBody(config, messages, temperature, options), options);
    try {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(formatApiError(response.status, text));
      }
      const payload = await response.json();
      const usage = extractProviderUsage(payload);
      if (usage) await this.recordDispatchUsage(response, usage);
      const result = extractMessageParts(payload);
      if (result.answer.trim()) return { reasoning: result.reasoning.trim(), answer: result.answer.trim() };
      throw new Error(streamError ? `模型返回空内容（流式错误：${streamError}）` : "模型返回空内容");
    } catch (error) {
      await this.finishDispatch(response, error);
      throw error;
    } finally {
      await this.finishDispatch(response);
    }
  }

  async *streamCompletion(config: ModelConfig, messages: ChatCompletionMessage[], temperature?: number, options: ModelRequestOptions = {}): AsyncGenerator<string> {
    for await (const chunk of this.streamDetailedCompletion(config, messages, temperature, options)) {
      if (chunk.channel === "answer") yield chunk.text;
    }
  }

  async *streamDetailedCompletion(config: ModelConfig, messages: ChatCompletionMessage[], temperature?: number, options: ModelRequestOptions = {}): AsyncGenerator<ModelStreamChunk> {
    const response = await this.fetchChatCompletions(config, {
      ...buildRequestBody(config, messages, temperature, options),
      stream: true,
      ...(options.captureUsage ? { stream_options: { include_usage: true } } : {})
    }, options);

    let cancelReader: (() => void) | undefined;
    let dispatchError: unknown;
    try {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(formatApiError(response.status, text));
      }
      if (!response.body) {
        throw new Error("模型流式响应不可用");
      }

      const reader = response.body.getReader();
      cancelReader = () => {
        void reader.cancel().catch(() => {});
      };
      options.signal?.addEventListener("abort", cancelReader, { once: true });
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        throwIfSignalAborted(options.signal);
        const { done, value } = await reader.read();
        throwIfSignalAborted(options.signal);
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          const parsed = parseStreamLinePayload(line);
          if (parsed?.usage) {
            await this.recordDispatchUsage(response, parsed.usage);
          }
          for (const chunk of parsed?.chunks || []) {
            yield chunk;
          }
        }
        if (done) {
          break;
        }
      }
      const finalPayload = parseStreamLinePayload(buffer);
      if (finalPayload?.usage) {
        await this.recordDispatchUsage(response, finalPayload.usage);
      }
      for (const chunk of finalPayload?.chunks || []) {
        throwIfSignalAborted(options.signal);
        yield chunk;
      }
    } catch (error) {
      dispatchError = error;
      if (isAbortLike(error, options.signal)) {
        throw createAbortError();
      }
      throw error;
    } finally {
      if (cancelReader) {
        options.signal?.removeEventListener("abort", cancelReader);
      }
      await this.finishDispatch(response, dispatchError);
    }
  }

  private async fetchChatCompletions(
    config: ModelConfig,
    body: {
      model: string;
      messages: ChatCompletionMessage[];
      temperature?: number;
      top_p?: number;
      reasoning_effort?: ReasoningEffort;
      thinking?: { type: "enabled" };
      stream?: boolean;
      stream_options?: { include_usage: boolean };
    },
    options: ModelRequestOptions = {}
  ): Promise<Response> {
    if (!config.configured) {
      throw new Error("未配置可用的大模型 API");
    }
    throwIfSignalAborted(options.signal);
    const maxOutputTokens = normalizeMaxOutputTokens(options.maxOutputTokens);
    const dispatchInput: ModelDispatchInput = {
      config: { base_url: config.base_url, model: config.model },
      messages: body.messages,
      stream: body.stream === true,
      ...(maxOutputTokens ? { maxOutputTokens } : {})
    };
    const lifecycle = options.dispatchLifecycle;
    const dispatchContext = lifecycle?.beforeDispatch ? await lifecycle.beforeDispatch(dispatchInput) : undefined;
    const baseUrl = normalizeBaseUrl(config.base_url);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      if (lifecycle?.onDispatchStarted) {
        await lifecycle.onDispatchStarted({ ...dispatchInput, context: dispatchContext });
      }
      const response = await this.fetchFn(new URL("chat/completions", baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.api_key}`
        },
        body: JSON.stringify({
          ...body,
          ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {})
        }),
        signal: controller.signal
      });
      if (lifecycle) {
        this.dispatchRecords.set(response, { input: dispatchInput, context: dispatchContext, lifecycle });
      }
      return response;
    } catch (error) {
      if (lifecycle?.onDispatchFinished) {
        await lifecycle.onDispatchFinished({ ...dispatchInput, context: dispatchContext, error });
      }
      if (timedOut) {
        throw new Error("接口请求超时，请检查网络或降低单次生成长度。");
      }
      if (isAbortLike(error, options.signal) || options.signal?.aborted) {
        throw createAbortError();
      }
      throw new Error(formatNetworkError(error));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async recordDispatchUsage(response: Response, usage: ModelUsage): Promise<void> {
    const record = this.dispatchRecords.get(response);
    if (!record) {
      return;
    }
    record.usage = usage;
    if (record.lifecycle.onUsage) {
      await record.lifecycle.onUsage({ ...record.input, context: record.context, usage });
    }
  }

  private async finishDispatch(response: Response, error?: unknown): Promise<void> {
    const record = this.dispatchRecords.get(response);
    if (!record) {
      return;
    }
    this.dispatchRecords.delete(response);
    if (record.lifecycle.onDispatchFinished) {
      await record.lifecycle.onDispatchFinished({
        ...record.input,
        context: record.context,
        ...(record.usage ? { usage: record.usage } : {}),
        ...(error === undefined ? {} : { error })
      });
    }
  }
}

function buildRequestBody(
  config: ModelConfig,
  messages: ChatCompletionMessage[],
  temperature: number | undefined,
  options: ModelRequestOptions
): {
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  top_p?: number;
  reasoning_effort?: ReasoningEffort;
  thinking?: { type: "enabled" };
} {
  const capability = resolveModelRequestCapability(config.model, config.base_url);
  const requestedEffort = options.reasoningEffort;
  const effectiveEffort = requestedEffort && capability.supportsReasoning
    ? capability.reasoningEfforts.includes(requestedEffort)
      ? requestedEffort
      : capability.reasoningEfforts.length === 1
        ? capability.reasoningEfforts[0]
        : undefined
    : undefined;
  const omitSampling = Boolean(effectiveEffort && capability.omitSamplingParameters);
  return {
    model: config.model,
    messages,
    ...(!omitSampling ? {
      temperature: temperature ?? config.temperature,
      top_p: config.top_p
    } : {}),
    ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
    ...(effectiveEffort && capability.enableDeepSeekThinking ? { thinking: { type: "enabled" as const } } : {})
  };
}

function createAbortError(): Error {
  const error = new Error("操作已取消");
  error.name = "AbortError";
  return error;
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return String(value.name || "") === "AbortError" || String(value.code || "") === "ABORT_ERR";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function extractMessageText(payload: unknown): string {
  return extractMessageParts(payload).answer;
}

function extractMessageParts(payload: unknown): ModelCompletionResult {
  const choices = asArray((payload as { choices?: unknown })?.choices);
  const answer = choices
    .flatMap((choice) => {
      const record = asRecord(choice);
      const message = asRecord(record?.message);
      return [...normalizeContent(message?.content), ...normalizeContent(record?.text)];
    })
    .join("");
  const reasoning = choices
    .flatMap((choice) => {
      const record = asRecord(choice);
      const message = asRecord(record?.message);
      return [
        ...normalizeContent(message?.reasoning_content),
        ...normalizeContent(message?.reasoning),
        ...normalizeThinkingContent(message?.content)
      ];
    })
    .join("");
  return { answer: answer || extractTopLevelText(payload), reasoning };
}

function extractDeltaText(payload: unknown): string {
  const choices = asArray((payload as { choices?: unknown })?.choices);
  const content = choices
    .flatMap((choice) => {
      const record = asRecord(choice);
      const delta = asRecord(record?.delta);
      const message = asRecord(record?.message);
      return [
        ...normalizeContent(delta?.content),
        ...normalizeContent(delta?.text),
        ...normalizeContent(message?.content),
        ...normalizeContent(record?.text)
      ];
    })
    .join("");
  return content || extractTopLevelText(payload);
}

function extractDetailedDelta(payload: unknown): ModelStreamChunk[] {
  const choices = asArray((payload as { choices?: unknown })?.choices);
  const chunks: ModelStreamChunk[] = [];
  for (const choice of choices) {
    const record = asRecord(choice);
    const delta = asRecord(record?.delta);
    const message = asRecord(record?.message);
    const reasoning = [
      ...normalizeContent(delta?.reasoning_content),
      ...normalizeContent(delta?.reasoning),
      ...normalizeContent(message?.reasoning_content),
      ...normalizeContent(message?.reasoning),
      ...normalizeThinkingContent(delta?.content),
      ...normalizeThinkingContent(message?.content)
    ].join("");
    const answer = [
      ...normalizeContent(delta?.content),
      ...normalizeContent(delta?.text),
      ...normalizeContent(message?.content),
      ...normalizeContent(record?.text)
    ].join("");
    const providerFinishReason = String(record?.finish_reason || "").trim();
    const finishReason = normalizeFinishReason(providerFinishReason);
    if (reasoning) chunks.push({ channel: "reasoning", text: reasoning, ...(finishReason ? { finish_reason: finishReason, provider_finish_reason: providerFinishReason } : {}) });
    if (answer) chunks.push({ channel: "answer", text: answer, ...(finishReason ? { finish_reason: finishReason, provider_finish_reason: providerFinishReason } : {}) });
    if (!reasoning && !answer && finishReason) {
      chunks.push({ channel: "answer", text: "", finish_reason: finishReason, provider_finish_reason: providerFinishReason });
    }
  }
  if (!chunks.length) {
    const answer = extractTopLevelText(payload);
    if (answer) chunks.push({ channel: "answer", text: answer });
  }
  return chunks;
}

function normalizeFinishReason(value: string): ModelStreamChunk["finish_reason"] | undefined {
  const normalized = value.toLowerCase();
  if (!normalized) return undefined;
  if (["stop", "end_turn", "completed"].includes(normalized)) return "stop";
  if (["length", "max_tokens", "max_output_tokens"].includes(normalized)) return "length";
  if (["tool_calls", "function_call"].includes(normalized)) return "tool_calls";
  if (["content_filter", "safety"].includes(normalized)) return "content_filter";
  if (["error", "failed"].includes(normalized)) return "error";
  return "unknown";
}

function parseStreamLinePayload(line: string): { chunks: ModelStreamChunk[]; usage?: ModelUsage } | null {
  const payloadText = normalizeStreamPayloadLine(line);
  if (!payloadText) {
    return null;
  }
  try {
    const parsed = JSON.parse(payloadText);
    const chunks = extractDetailedDelta(parsed);
    const usage = extractProviderUsage(parsed);
    return {
      chunks,
      ...(usage ? { usage } : {})
    };
  } catch {
    return null;
  }
}

function extractProviderUsage(payload: unknown): ModelUsage | null {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) {
    return null;
  }
  const promptTokens = integerUsageValue(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = integerUsageValue(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = integerUsageValue(usage.total_tokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function integerUsageValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeMaxOutputTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : undefined;
}

function normalizeStreamPayloadLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!data || data === "[DONE]") {
    return "";
  }
  return data;
}

function normalizeContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  const recordValue = asRecord(value);
  if (recordValue) {
    return [
      ...normalizeContent(recordValue.content),
      ...normalizeContent(recordValue.text)
    ];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return [record.text];
      }
      return [];
    });
  }
  return [];
}

function normalizeThinkingContent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const type = String(record?.type || "").toLowerCase();
    if (!record || !["thinking", "reasoning", "reasoning_content"].includes(type)) return [];
    return [...normalizeContent(record.text), ...normalizeContent(record.content), ...normalizeContent(record.thinking)];
  });
}

function extractTopLevelText(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) {
    return "";
  }
  return [
    ...normalizeContent(record.content),
    ...normalizeContent(record.text),
    ...normalizeContent(record.delta)
  ].join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatNetworkError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lowered = text.toLowerCase();
  if (lowered.includes("timed out") || lowered.includes("timeout")) {
    return "接口请求超时，请检查网络或降低单次生成长度。";
  }
  if (lowered.includes("fetch failed") || lowered.includes("econnrefused") || lowered.includes("network")) {
    return "接口连接失败，请检查网络、API 地址或中转服务状态。";
  }
  return text;
}

export function formatApiError(status: number, text: string): string {
  const compact = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (status === 504 || compact.includes("504 Gateway Time-out") || compact.includes("Gateway Time-out")) {
    return "模型网关超时（504）。上游服务在本次请求时间内没有返回结果，请稍后重试、切换模型，或缩短输入/减少上下文后再试。";
  }
  if (status === 502 || status === 503 || compact.includes("Bad Gateway") || compact.includes("Service Unavailable")) {
    return `模型网关暂时不可用（${status}）。请稍后重试或切换模型/接口。`;
  }
  if (status === 429 || compact.toLowerCase().includes("rate limit")) {
    return "接口限流，请稍后重试或切换模型。";
  }
  if (status > 0) {
    return `接口返回错误 ${status}：${compact || text}`;
  }
  return compact || text;
}

export function canRetryWithoutStream(message: string): boolean {
  const lowered = (message || "").toLowerCase();
  const retryMarkers = ["stream", "streaming", "不支持流", "does not support", "unsupported", "not implemented", "invalid parameter", "unknown parameter"];
  const timeoutMarkers = ["504", "timeout", "超时", "gateway"];
  return retryMarkers.some((marker) => lowered.includes(marker)) && !timeoutMarkers.some((marker) => lowered.includes(marker));
}
