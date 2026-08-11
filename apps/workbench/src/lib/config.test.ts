import { describe, expect, it } from "vitest";
import { describeConfigReadiness, normalizeConfigDraft } from "./config.js";

describe("normalizeConfigDraft", () => {
  it("clamps config values into the supported ranges", () => {
    const normalized = normalizeConfigDraft({
      ai_config_mode: "manual",
      api_key: "",
      license_account_key: "",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      temp: 9,
      top_p: 9,
      secondary_api_key: "",
      secondary_base_url: "",
      secondary_model: "",
      secondary_temp: -5,
      secondary_top_p: -5,
      model_thinking_enabled: false,
      enable_consistency_revision: true,
      consistency_revision_score: 999,
      context_limit_chars: 1,
      embedding_enabled: false,
      embedding_api_key: "",
      embedding_base_url: "",
      embedding_model: "",
      embedding_timeout: 999,
      embedding_batch_size: 0,
      vector_top_k: 1000,
      vector_context_chars: 10,
      web_search_enabled: true,
      web_search_provider: "other" as "bing",
      web_search_api_key: "",
      web_search_base_url: "",
      web_search_max_results: 100,
      web_search_timeout: 1,
      web_search_context_chars: 99,
      auto_lore_extract_enabled: true,
      humanizer_enabled: true
    });

    expect(normalized.temp).toBe(2);
    expect(normalized.top_p).toBe(1);
    expect(normalized.secondary_temp).toBe(0);
    expect(normalized.secondary_top_p).toBe(0);
    expect(normalized.consistency_revision_score).toBe(100);
    expect(normalized.context_limit_chars).toBe(8192);
    expect(normalized.embedding_timeout).toBe(300);
    expect(normalized.embedding_batch_size).toBe(1);
    expect(normalized.vector_top_k).toBe(40);
    expect(normalized.vector_context_chars).toBe(1000);
    expect(normalized.web_search_provider).toBe("bing");
    expect(normalized.web_search_max_results).toBe(5);
    expect(normalized.web_search_timeout).toBe(3);
    expect(normalized.web_search_context_chars).toBe(800);
    expect(normalized.auto_lore_extract_enabled).toBe(true);
    expect(normalized.humanizer_enabled).toBe(true);
  });

  it("falls back from non-finite numeric values", () => {
    const normalized = normalizeConfigDraft({
      ...makeConfig(),
      temp: Number.NaN,
      top_p: Number.NaN,
      embedding_timeout: Number.NaN,
      vector_top_k: Number.POSITIVE_INFINITY
    });

    expect(normalized.temp).toBe(0.7);
    expect(normalized.top_p).toBe(1);
    expect(normalized.embedding_timeout).toBe(5);
    expect(normalized.vector_top_k).toBe(1);
  });

  it("describes readiness for required model and embedding settings", () => {
    const missing = describeConfigReadiness(makeConfig());
    expect(missing.find((item) => item.title === "主线路模型")?.status).toBe("warn");

    const ready = describeConfigReadiness({
      ...makeConfig(),
      api_key: "key",
      base_url: "https://api.example.test/v1",
      model: "model",
      embedding_enabled: true,
      embedding_api_key: "embedding-key",
      embedding_base_url: "https://embedding.example.test/v1",
      embedding_model: "embedding-model"
    });

    expect(ready.find((item) => item.title === "主线路模型")?.status).toBe("ready");
    expect(ready.find((item) => item.title === "向量召回")?.status).toBe("ready");
    expect(missing.find((item) => item.title === "联网素材搜索")?.status).toBe("idle");
    expect(describeConfigReadiness({ ...makeConfig(), web_search_enabled: true }).find((item) => item.title === "联网素材搜索")?.status).toBe("ready");
    const customMissing = describeConfigReadiness({ ...makeConfig(), web_search_enabled: true, web_search_provider: "custom" }).find(
      (item) => item.title === "联网素材搜索"
    );
    expect(customMissing?.status).toBe("warn");
    expect(customMissing?.detail).toContain("Base URL");
  });
});

function makeConfig() {
  return {
    ai_config_mode: "manual" as const,
    api_key: "",
    license_account_key: "",
    base_url: "",
    model: "",
    temp: 0.7,
    top_p: 1,
    secondary_api_key: "",
    secondary_base_url: "",
    secondary_model: "",
    secondary_temp: 0.5,
    secondary_top_p: 1,
    model_thinking_enabled: false,
    enable_consistency_revision: true,
    consistency_revision_score: 80,
    context_limit_chars: 262144,
    embedding_enabled: false,
    embedding_api_key: "",
    embedding_base_url: "",
    embedding_model: "",
    embedding_timeout: 60,
    embedding_batch_size: 16,
    vector_top_k: 10,
    vector_context_chars: 9000,
    web_search_enabled: false,
    web_search_provider: "bing" as const,
    web_search_api_key: "",
    web_search_base_url: "",
    web_search_max_results: 3,
    web_search_timeout: 10,
    web_search_context_chars: 3000,
    auto_lore_extract_enabled: false,
    humanizer_enabled: false
  };
}
