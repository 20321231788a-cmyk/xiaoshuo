import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient, canRetryWithoutStream, formatApiError } from "./openai-compatible.js";

const configuredModel = {
  api_key: "test-key",
  base_url: "https://example.test/v1",
  model: "demo-model",
  temperature: 0.2,
  top_p: 0.88,
  thinking_enabled: false,
  configured: true
};

describe("model-client", () => {
  it("streams SSE deltas in order", async () => {
    const client = new OpenAICompatibleClient({
      fetchFn: vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    'data: {"choices":[{"delta":{"content":"你"}}]}',
                    'data: {"choices":[{"delta":{"content":"好"}}]}',
                    "data: [DONE]"
                  ].join("\n")
                )
              );
              controller.close();
            }
          }),
          { status: 200 }
        )
      ) as typeof fetch
    });

    const chunks: string[] = [];
    for await (const chunk of client.streamCompletion(configuredModel, [{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["你", "好"]);
  });

  it("streams naked ndjson delta events", async () => {
    const client = new OpenAICompatibleClient({
      fetchFn: vi.fn(async () =>
        new Response(
          [
            JSON.stringify({ choices: [{ delta: { content: "裸" } }] }),
            JSON.stringify({ choices: [{ delta: { content: "流" } }] })
          ].join("\n"),
          { status: 200 }
        )
      ) as typeof fetch
    });

    const chunks: string[] = [];
    for await (const chunk of client.streamCompletion(configuredModel, [{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["裸", "流"]);
  });

  it("extracts text when stream returns one normal json payload", async () => {
    const client = new OpenAICompatibleClient({
      fetchFn: vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "一次性返回" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      ) as typeof fetch
    });

    const chunks: string[] = [];
    for await (const chunk of client.streamCompletion(configuredModel, [{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["一次性返回"]);
  });

  it("parses the final stream buffer without a trailing newline", async () => {
    const client = new OpenAICompatibleClient({
      fetchFn: vi.fn(async () =>
        new Response('data: {"choices":[{"delta":{"content":"尾段"}}]}', { status: 200 })
      ) as typeof fetch
    });

    const chunks: string[] = [];
    for await (const chunk of client.streamCompletion(configuredModel, [{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["尾段"]);
  });

  it("falls back to non-stream completion when stream is unsupported", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"streaming unsupported"}}', { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "fallback result" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    const client = new OpenAICompatibleClient({ fetchFn: fetchFn as typeof fetch });

    const result = await client.requestCompletion(configuredModel, [{ role: "user", content: "hi" }]);

    expect(result).toBe("fallback result");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body || "{}")) as Record<string, unknown>;
    expect(fallbackBody.temperature).toBe(0.2);
    expect(fallbackBody.top_p).toBe(0.88);
  });

  it("passes an abort signal to fetch and preserves caller cancellation", async () => {
    let requestInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}', { status: 200 });
    });
    const client = new OpenAICompatibleClient({ fetchFn: fetchFn as typeof fetch });
    const controller = new AbortController();

    const chunks: string[] = [];
    for await (const chunk of client.streamCompletion(configuredModel, [{ role: "user", content: "hi" }], undefined, { signal: controller.signal })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["ok"]);
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not call fetch when the caller signal is already aborted", async () => {
    const fetchFn = vi.fn();
    const client = new OpenAICompatibleClient({ fetchFn: fetchFn as typeof fetch });
    const controller = new AbortController();
    controller.abort();

    await expect(client.requestCompletion(configuredModel, [{ role: "user", content: "hi" }], undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not fall back to non-stream completion after caller abort", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      return new Response('{"error":{"message":"streaming unsupported"}}', { status: 400 });
    });
    const client = new OpenAICompatibleClient({ fetchFn: fetchFn as typeof fetch });

    await expect(client.requestCompletion(configuredModel, [{ role: "user", content: "hi" }], undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cancels an active stream reader after caller abort", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const client = new OpenAICompatibleClient({
      fetchFn: vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(streamController) {
              streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"一"}}]}\n'));
            },
            cancel() {
              cancelled = true;
            }
          }),
          { status: 200 }
        )
      ) as typeof fetch
    });
    const iterator = client.streamCompletion(configuredModel, [{ role: "user", content: "hi" }], undefined, { signal: controller.signal });

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "一" });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("formats gateway errors with desktop-friendly text", () => {
    expect(formatApiError(504, "Gateway Time-out")).toContain("模型网关超时");
    expect(formatApiError(503, "Service Unavailable")).toContain("模型网关暂时不可用");
    expect(canRetryWithoutStream("streaming unsupported")).toBe(true);
  });
});
