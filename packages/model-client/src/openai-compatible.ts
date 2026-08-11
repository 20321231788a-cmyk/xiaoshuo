import type { ModelConfig } from "@xiaoshuo/config-service";

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
};

export class OpenAICompatibleClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

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

    const response = await this.fetchChatCompletions(
      config,
      {
        model: config.model,
        messages,
        temperature: temperature ?? config.temperature,
        top_p: config.top_p
      },
      options
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(formatApiError(response.status, text));
    }

    const payload = await response.json();
    const result = extractMessageText(payload).trim();
    if (result) {
      return result;
    }
    throw new Error(streamError ? `模型返回空内容（流式错误：${streamError}）` : "模型返回空内容");
  }

  async *streamCompletion(config: ModelConfig, messages: ChatCompletionMessage[], temperature?: number, options: ModelRequestOptions = {}): AsyncGenerator<string> {
    const response = await this.fetchChatCompletions(
      config,
      {
        model: config.model,
        messages,
        temperature: temperature ?? config.temperature,
        top_p: config.top_p,
        stream: true
      },
      options
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(formatApiError(response.status, text));
    }
    if (!response.body) {
      throw new Error("模型流式响应不可用");
    }

    const reader = response.body.getReader();
    const cancelReader = () => {
      void reader.cancel().catch(() => {});
    };
    options.signal?.addEventListener("abort", cancelReader, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        throwIfSignalAborted(options.signal);
        const { done, value } = await reader.read();
        throwIfSignalAborted(options.signal);
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          for (const chunk of extractStreamLineChunks(line)) {
            yield chunk;
          }
        }
        if (done) {
          break;
        }
      }
      for (const chunk of extractStreamLineChunks(buffer)) {
        throwIfSignalAborted(options.signal);
        yield chunk;
      }
    } catch (error) {
      if (isAbortLike(error, options.signal)) {
        throw createAbortError();
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancelReader);
    }
  }

  private async fetchChatCompletions(
    config: ModelConfig,
    body: {
      model: string;
      messages: ChatCompletionMessage[];
      temperature: number;
      top_p: number;
      stream?: boolean;
    },
    options: ModelRequestOptions = {}
  ): Promise<Response> {
    if (!config.configured) {
      throw new Error("未配置可用的大模型 API");
    }
    throwIfSignalAborted(options.signal);
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
      return await this.fetchFn(new URL("chat/completions", baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.api_key}`
        },
        body: JSON.stringify({
          ...body
        }),
        signal: controller.signal
      });
    } catch (error) {
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
  const choices = asArray((payload as { choices?: unknown })?.choices);
  const content = choices
    .flatMap((choice) => {
      const record = asRecord(choice);
      const message = asRecord(record?.message);
      return [...normalizeContent(message?.content), ...normalizeContent(record?.text)];
    })
    .join("");
  return content || extractTopLevelText(payload);
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

function extractStreamLineChunks(line: string): string[] {
  const payloadText = normalizeStreamPayloadLine(line);
  if (!payloadText) {
    return [];
  }
  try {
    const parsed = JSON.parse(payloadText);
    const chunk = extractDeltaText(parsed);
    return chunk ? [chunk] : [];
  } catch {
    return [];
  }
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
