import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverManualModels,
  invalidateManualModelDiscoveryCache,
  normalizeModelCatalogResponse
} from "./model-discovery-routes.js";

afterEach(() => {
  invalidateManualModelDiscoveryCache();
  vi.restoreAllMocks();
});

describe("manual model discovery", () => {
  it("normalizes supported response shapes and filters non-text models", () => {
    const rows = [
      { id: "gpt-5-mini", owned_by: "openai" },
      { id: "text-embedding-3-small", owned_by: "openai" },
      { id: "deepseek-reasoner", provider: "deepseek" },
      { id: "image-alpha", category: "image" }
    ];
    for (const payload of [rows, { data: rows }, { models: rows }]) {
      const models = normalizeModelCatalogResponse(payload);
      expect(models.map((item) => item.id)).toEqual(["deepseek-reasoner", "gpt-5-mini"]);
      expect(models.find((item) => item.id === "gpt-5-mini")?.reasoning_efforts).toEqual(["low", "medium", "high"]);
      expect(models.find((item) => item.id === "deepseek-reasoner")?.reasoning_efforts).toEqual(["high"]);
    }
  });

  it("requests normalized /models without exposing the API key", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
      return new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const result = await discoverManualModels({
      base_url: "https://example.test/v1/chat/completions",
      api_key: "private-key"
    }, { fetchFn: fetchFn as typeof fetch, now: () => 1_000 });

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://example.test/v1/models");
    expect(JSON.stringify(result)).not.toContain("private-key");
  });

  it("caches for five minutes and supports a forced refresh", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([{ id: "model-a" }]), { status: 200 }));
    const input = { base_url: "https://example.test/v1", api_key: "key" };
    const first = await discoverManualModels(input, { fetchFn: fetchFn as typeof fetch, now: () => 5_000 });
    const cached = await discoverManualModels(input, { fetchFn: fetchFn as typeof fetch, now: () => 6_000 });
    await discoverManualModels({ ...input, force: true }, { fetchFn: fetchFn as typeof fetch, now: () => 7_000 });

    expect(first.cached).toBe(false);
    expect(cached.cached).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized model catalogs before reading the body", async () => {
    const fetchFn = vi.fn(async () => new Response("[]", {
      status: 200,
      headers: { "Content-Length": String(2 * 1024 * 1024 + 1) }
    }));
    await expect(discoverManualModels({
      base_url: "https://example.test/v1",
      api_key: "key"
    }, { fetchFn: fetchFn as typeof fetch })).rejects.toThrow("超过 2 MB");
  });
});
