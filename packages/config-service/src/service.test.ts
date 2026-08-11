import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_MODEL,
  loadEmbeddingConfig,
  loadModelConfig,
  loadPublicConfig,
  normalizePublicConfig,
  resolveConfigPath,
  savePublicConfig
} from "./service.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-config-service-"));
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("config-service", () => {
  it("matches Python public config defaults", async () => {
    const config = await loadPublicConfig({ rootDir: tempDir, cwd: tempDir });

    expect(config).toMatchObject({
      ai_config_mode: "manual",
      api_key: "",
      license_account_key: "",
      base_url: "https://api.openai.com/v1",
      model: "",
      temp: 0.7,
      top_p: 1,
      secondary_temp: 0.5,
      secondary_top_p: 1,
      model_thinking_enabled: true,
      enable_consistency_revision: true,
      consistency_revision_score: 80,
      context_limit_chars: 262144,
      embedding_enabled: false,
      embedding_base_url: DEFAULT_EMBEDDING_BASE_URL,
      embedding_model: DEFAULT_EMBEDDING_MODEL,
      embedding_timeout: 60,
      embedding_batch_size: 16,
      vector_top_k: 10,
      vector_context_chars: 9000,
      web_search_enabled: false,
      web_search_provider: "bing",
      web_search_api_key: "",
      web_search_base_url: "",
      web_search_max_results: 3,
      web_search_timeout: 10,
      web_search_context_chars: 3000,
      auto_lore_extract_enabled: false,
      humanizer_enabled: false
    });
  });

  it("normalizes numeric strings like the Python loader", () => {
    const config = normalizePublicConfig({
      temp: "0.25",
      top_p: "1.4",
      secondary_temp: "",
      secondary_top_p: "0.44",
      consistency_revision_score: "93",
      embedding_batch_size: "32",
      vector_context_chars: "12000",
      web_search_max_results: "99",
      web_search_timeout: "1",
      web_search_context_chars: "12000"
    });

    expect(config.temp).toBe(0.25);
    expect(config.top_p).toBe(1);
    expect(config.secondary_temp).toBe(0.5);
    expect(config.secondary_top_p).toBe(0.44);
    expect(config.consistency_revision_score).toBe(93);
    expect(config.embedding_batch_size).toBe(32);
    expect(config.vector_context_chars).toBe(12000);
    expect(config.web_search_max_results).toBe(5);
    expect(config.web_search_timeout).toBe(3);
    expect(config.web_search_context_chars).toBe(8000);
  });

  it("saves only public config keys and supports legacy aliases", async () => {
    const configPath = path.join(tempDir, "studio_config.json");
    await fs.writeFile(configPath, JSON.stringify({ untouched: "keep", api_key: "old" }), "utf8");

    const saved = await savePublicConfig(
      {
        relayKey: "alias-key",
        relayUrl: "https://example.test/v1",
        textModel: "demo-model",
        ignored_secret: "drop"
      },
      { configPath }
    );
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;

    expect(saved.api_key).toBe("alias-key");
    expect(saved.license_account_key).toBe("alias-key");
    expect(saved.ai_config_mode).toBe("website");
    expect(saved.base_url).toBe("https://example.test/v1");
    expect(saved.model).toBe("demo-model");
    expect(raw.untouched).toBe("keep");
    expect(raw.ai_config_mode).toBe("website");
    expect(raw.ignored_secret).toBeUndefined();
  });

  it("keeps manual and website AI profiles isolated when switching modes", async () => {
    const configPath = path.join(tempDir, "studio_config.json");

    await savePublicConfig(
      {
        api_key: "manual-key",
        base_url: "https://manual.example.test/v1",
        model: "manual-model",
        temp: 0.21,
        top_p: 0.81
      },
      { configPath }
    );
    await savePublicConfig(
      {
        ai_config_mode: "website",
        website_profile: {
          api_key: "website-token",
          base_url: "https://matian.example.test/v1",
          license_account_key: "website-token",
          model: "website-model",
          temp: 0.33,
          top_p: 0.77
        }
      },
      { configPath }
    );

    const websiteRuntime = await loadModelConfig({ configPath });
    expect(websiteRuntime).toMatchObject({ api_key: "website-token", model: "website-model", temperature: 0.33, top_p: 0.77 });

    const manualConfig = await savePublicConfig({ ai_config_mode: "manual" }, { configPath });
    const manualRuntime = await loadModelConfig({ configPath });
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;

    expect(manualConfig).toMatchObject({ ai_config_mode: "manual", api_key: "manual-key", model: "manual-model", temp: 0.21, top_p: 0.81 });
    expect(manualRuntime).toMatchObject({ api_key: "manual-key", model: "manual-model", temperature: 0.21, top_p: 0.81 });
    expect(raw.manual_profile).toMatchObject({ api_key: "manual-key", model: "manual-model" });
    expect(raw.website_profile).toMatchObject({ api_key: "website-token", model: "website-model" });
  });

  it("persists public web search settings through the whitelist", async () => {
    const configPath = path.join(tempDir, "studio_config.json");

    const saved = await savePublicConfig(
      {
        web_search_enabled: true,
        web_search_provider: "custom",
        web_search_api_key: "search-key",
        web_search_base_url: "https://search.example.test/api",
        web_search_max_results: 4,
        web_search_timeout: 12,
        web_search_context_chars: 3600,
        hidden_web_search_secret: "drop"
      },
      { configPath }
    );
    const loaded = await loadPublicConfig({ configPath });
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;

    expect(saved.web_search_enabled).toBe(true);
    expect(loaded.web_search_provider).toBe("custom");
    expect(loaded.web_search_api_key).toBe("search-key");
    expect(loaded.web_search_max_results).toBe(4);
    expect(loaded.web_search_context_chars).toBe(3600);
    expect(raw.hidden_web_search_secret).toBeUndefined();
  });

  it("falls back to empty config for invalid JSON", async () => {
    const configPath = path.join(tempDir, "studio_config.json");
    await fs.writeFile(configPath, "{not-json", "utf8");

    const config = await loadPublicConfig({ configPath });

    expect(config.base_url).toBe("https://api.openai.com/v1");
    expect(config.model).toBe("");
  });

  it("loads primary and secondary model configs with configured flags", async () => {
    const configPath = path.join(tempDir, "studio_config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        api_key: "primary-key",
        model: "primary-model",
        temp: 0.2,
        top_p: 0.91,
        secondary_api_key: "secondary-key",
        secondary_model: "secondary-model",
        secondary_temp: 0.4,
        secondary_top_p: 0.82,
        model_thinking_enabled: true
      }),
      "utf8"
    );

    const primary = await loadModelConfig({ configPath }, "primary");
    const secondary = await loadModelConfig({ configPath }, "secondary");

    expect(primary).toMatchObject({ model: "primary-model", temperature: 0.2, top_p: 0.91, configured: true, thinking_enabled: true });
    expect(secondary).toMatchObject({ model: "secondary-model", temperature: 0.4, top_p: 0.82, configured: true, thinking_enabled: true });
  });

  it("keeps runtime thinking enabled even when legacy config disables it", async () => {
    const configPath = path.join(tempDir, "studio_config.json");
    await fs.writeFile(configPath, JSON.stringify({ api_key: "primary-key", model: "primary-model", model_thinking_enabled: false }), "utf8");

    const publicConfig = await loadPublicConfig({ configPath });
    const modelConfig = await loadModelConfig({ configPath }, "primary");

    expect(publicConfig.model_thinking_enabled).toBe(true);
    expect(modelConfig.thinking_enabled).toBe(true);
  });

  it("falls back to primary model when secondary is incomplete", async () => {
    const configPath = path.join(tempDir, "studio_config.json");
    await fs.writeFile(configPath, JSON.stringify({ api_key: "primary-key", model: "primary-model", secondary_api_key: "secondary-key" }), "utf8");

    const secondary = await loadModelConfig({ configPath }, "secondary");

    expect(secondary.model).toBe("primary-model");
    expect(secondary.configured).toBe(true);
  });

  it("uses embedding key fallback and clamps batch size", async () => {
    const configPath = path.join(tempDir, "studio_config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        embedding_enabled: true,
        secondary_api_key: "secondary-key",
        api_key: "primary-key",
        embedding_batch_size: 999
      }),
      "utf8"
    );

    const embedding = await loadEmbeddingConfig({ configPath });

    expect(embedding.api_key).toBe("secondary-key");
    expect(embedding.batch_size).toBe(128);
    expect(embedding.configured).toBe(true);
  });

  it("resolves explicit env config path first", () => {
    const configPath = path.join(tempDir, "custom.json");

    expect(resolveConfigPath({ rootDir: "ignored", env: { XIAOSHUO_STUDIO_CONFIG: configPath } })).toBe(path.resolve(configPath));
  });
});
