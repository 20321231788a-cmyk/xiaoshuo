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

  it("formats gateway errors with desktop-friendly text", () => {
    expect(formatApiError(504, "Gateway Time-out")).toContain("模型网关超时");
    expect(formatApiError(503, "Service Unavailable")).toContain("模型网关暂时不可用");
    expect(canRetryWithoutStream("streaming unsupported")).toBe(true);
  });
});
