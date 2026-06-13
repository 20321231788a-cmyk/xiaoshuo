import type { AgentStreamEvent } from "@xiaoshuo/shared";
import type { ModelConfig } from "@xiaoshuo/config-service";
import { canRetryWithoutStream, type ChatCompletionMessage, type OpenAICompatibleClient } from "@xiaoshuo/model-client";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import type { GeneratedCacheMeta, GeneratedSavePlan } from "@xiaoshuo/shared";

export function encodeNdjsonEvent(event: AgentStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export type StreamingModelClient = Pick<OpenAICompatibleClient, "requestCompletion"> &
  Partial<Pick<OpenAICompatibleClient, "streamCompletion">>;

export async function* streamModelText({
  modelClient,
  config,
  messages,
  temperature,
  fallbackMessages
}: {
  modelClient: StreamingModelClient;
  config: ModelConfig;
  messages: ChatCompletionMessage[];
  temperature?: number;
  fallbackMessages?: ChatCompletionMessage[];
}): AsyncGenerator<string> {
  const streamCompletion = modelClient.streamCompletion?.bind(modelClient);
  const parts: string[] = [];
  if (streamCompletion) {
    try {
      for await (const chunk of streamCompletion(config, messages, temperature ?? config.temperature)) {
        if (!chunk) {
          continue;
        }
        parts.push(chunk);
        yield chunk;
      }
      if (parts.join("").trim()) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (parts.length || (!canRetryWithoutStream(message) && !looksGatewayTimeoutMessage(message))) {
        throw error;
      }
      const fallback = await modelClient.requestCompletion(
        config,
        looksGatewayTimeoutMessage(message) && fallbackMessages ? fallbackMessages : messages,
        temperature ?? config.temperature
      );
      if (fallback) {
        yield fallback;
      }
      return;
    }
  }

  try {
    const fallback = await modelClient.requestCompletion(config, messages, temperature ?? config.temperature);
    if (fallback) {
      yield fallback;
    }
  } catch (error) {
    if (!looksGatewayTimeoutMessage(error instanceof Error ? error.message : String(error)) || !fallbackMessages) {
      throw error;
    }
    const fallback = await modelClient.requestCompletion(config, fallbackMessages, temperature ?? config.temperature);
    if (fallback) {
      yield fallback;
    }
  }
}

export class StreamingGenerationSession {
  private readonly cache: GeneratedCacheService;
  private readonly flushChars: number;
  private cacheId = "";
  private buffer = "";
  private content = "";

  constructor(cache: GeneratedCacheService, options: { flushChars?: number } = {}) {
    this.cache = cache;
    this.flushChars = options.flushChars ?? 2048;
  }

  get id(): string {
    return this.cacheId;
  }

  get text(): string {
    return this.content;
  }

  async start(options: {
    source: string;
    target_paths: string[];
    skill_id: string;
    mode: "replace" | "append";
    conversation_id?: string;
    summary?: string;
    save_plan?: GeneratedSavePlan;
  }): Promise<GeneratedCacheMeta> {
    const meta = await this.cache.create(options);
    this.cacheId = meta.cache_id;
    return meta;
  }

  async append(text: string): Promise<void> {
    const chunk = String(text || "");
    if (!chunk || !this.cacheId) {
      return;
    }
    this.content += chunk;
    this.buffer += chunk;
    if (this.buffer.length >= this.flushChars) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.cacheId || !this.buffer) {
      return;
    }
    const pending = this.buffer;
    this.buffer = "";
    await this.cache.append(this.cacheId, pending);
  }

  async finalize(finalText?: string): Promise<GeneratedCacheMeta> {
    if (!this.cacheId) {
      throw new Error("流式缓存尚未创建");
    }
    if (finalText !== undefined) {
      this.content = String(finalText || "");
      this.buffer = "";
      return this.cache.replace(this.cacheId, this.content);
    }
    await this.flush();
    return this.cache.replace(this.cacheId, this.content);
  }

  async fail(error: unknown): Promise<void> {
    if (!this.cacheId) {
      return;
    }
    await this.flush().catch(() => {});
    await this.cache.markFailed(this.cacheId, error instanceof Error ? error.message : String(error)).catch(() => {});
  }
}

function looksGatewayTimeoutMessage(message: string): boolean {
  const text = String(message || "").toLowerCase();
  return text.includes("504") || text.includes("gateway") || text.includes("网关超时") || text.includes("请求超时") || text.includes("timed out") || text.includes("timeout");
}
