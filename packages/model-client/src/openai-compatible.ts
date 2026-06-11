import type { ModelConfig } from "@xiaoshuo/config-service";

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenAICompatibleClientOptions = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export class OpenAICompatibleClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 240_000;
  }

  async requestCompletion(config: ModelConfig, messages: ChatCompletionMessage[], temperature?: number): Promise<string> {
    let streamError = "";
    try {
      const chunks: string[] = [];
      for await (const chunk of this.streamCompletion(config, messages, temperature)) {
        chunks.push(chunk);
      }
      const streamed = chunks.join("").trim();
      if (streamed) {
        return streamed;
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
      if (!canRetryWithoutStream(streamError)) {
        throw error;
      }
    }

    const response = await this.fetchChatCompletions(config, {
      model: config.model,
      messages,
      temperature: temperature ?? config.temperature,
      top_p: config.top_p
    });

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

  async *streamCompletion(config: ModelConfig, messages: ChatCompletionMessage[], temperature?: number): AsyncGenerator<string> {
    const response = await this.fetchChatCompletions(config, {
      model: config.model,
      messages,
      temperature: temperature ?? config.temperature,
      top_p: config.top_p,
      stream: true
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(formatApiError(response.status, text));
    }
    if (!response.body) {
      throw new Error("模型流式响应不可用");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const chunk = extractDeltaText(parsed);
        if (chunk) {
          yield chunk;
        }
      }
      if (done) {
        break;
      }
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
    }
  ): Promise<Response> {
    if (!config.configured) {
      throw new Error("未配置可用的大模型 API");
    }
    const baseUrl = normalizeBaseUrl(config.base_url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
      if (controller.signal.aborted) {
        throw new Error("接口请求超时，请检查网络或降低单次生成长度。");
      }
      throw new Error(formatNetworkError(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function extractMessageText(payload: unknown): string {
  const choices = asArray((payload as { choices?: unknown })?.choices);
  const content = choices
    .flatMap((choice) => {
      const message = (choice as { message?: unknown })?.message as { content?: unknown } | undefined;
      return normalizeContent(message?.content);
    })
    .join("");
  return content;
}

function extractDeltaText(payload: unknown): string {
  const choices = asArray((payload as { choices?: unknown })?.choices);
  return choices
    .flatMap((choice) => {
      const delta = (choice as { delta?: unknown })?.delta as { content?: unknown } | undefined;
      return normalizeContent(delta?.content);
    })
    .join("");
}

function normalizeContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
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
