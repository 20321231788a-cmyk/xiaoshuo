import type { AppConfig } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_EMBEDDING_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal";
export const DEFAULT_EMBEDDING_MODEL = "doubao-embedding-vision-250615";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_WEB_SEARCH_PROVIDER = "bing";

export type ConfigServiceOptions = {
  configPath?: string;
  rootDir?: string;
  cwd?: string;
  executablePath?: string;
  env?: Record<string, string | undefined>;
};

export type ModelConfig = {
  api_key: string;
  base_url: string;
  model: string;
  temperature: number;
  top_p: number;
  thinking_enabled: boolean;
  configured: boolean;
};

export type EmbeddingConfig = {
  enabled: boolean;
  api_key: string;
  base_url: string;
  model: string;
  timeout: number;
  batch_size: number;
  configured: boolean;
};

export type WebSearchConfig = {
  enabled: boolean;
  provider: "bing" | "custom" | "duckduckgo";
  api_key: string;
  base_url: string;
  max_results: number;
  timeout: number;
  context_chars: number;
};

type RawConfig = Record<string, unknown>;
type AiProfile = {
  api_key: string;
  license_account_key: string;
  base_url: string;
  model: string;
  temp: number;
  top_p: number;
  secondary_api_key: string;
  secondary_base_url: string;
  secondary_model: string;
  secondary_temp: number;
  secondary_top_p: number;
  embedding_enabled: boolean;
  embedding_api_key: string;
  embedding_base_url: string;
  embedding_model: string;
};

const publicConfigKeys = [
  "ai_config_mode",
  "manual_profile",
  "website_profile",
  "api_key",
  "license_account_key",
  "base_url",
  "model",
  "temp",
  "top_p",
  "secondary_api_key",
  "secondary_base_url",
  "secondary_model",
  "secondary_temp",
  "secondary_top_p",
  "model_thinking_enabled",
  "enable_consistency_revision",
  "consistency_revision_score",
  "context_limit_chars",
  "embedding_enabled",
  "embedding_api_key",
  "embedding_base_url",
  "embedding_model",
  "embedding_timeout",
  "embedding_batch_size",
  "vector_top_k",
  "vector_context_chars",
  "web_search_enabled",
  "web_search_provider",
  "web_search_api_key",
  "web_search_base_url",
  "web_search_max_results",
  "web_search_timeout",
  "web_search_context_chars",
  "auto_lore_extract_enabled",
  "humanizer_enabled"
] as const;

const aliases: Record<(typeof publicConfigKeys)[number], string[]> = {
  ai_config_mode: ["ai_config_mode", "aiConfigMode"],
  manual_profile: ["manual_profile", "manualProfile"],
  website_profile: ["website_profile", "websiteProfile"],
  api_key: ["api_key", "key", "relayKey", "API_KEY"],
  license_account_key: ["license_account_key", "licenseAccountKey", "accountKey", "relayKey"],
  base_url: ["base_url", "url", "relayUrl", "BASE_URL"],
  model: ["model", "textModel", "MODEL"],
  temp: ["temp"],
  top_p: ["top_p"],
  secondary_api_key: ["secondary_api_key"],
  secondary_base_url: ["secondary_base_url"],
  secondary_model: ["secondary_model"],
  secondary_temp: ["secondary_temp"],
  secondary_top_p: ["secondary_top_p"],
  model_thinking_enabled: ["model_thinking_enabled"],
  enable_consistency_revision: ["enable_consistency_revision"],
  consistency_revision_score: ["consistency_revision_score"],
  context_limit_chars: ["context_limit_chars"],
  embedding_enabled: ["embedding_enabled"],
  embedding_api_key: ["embedding_api_key"],
  embedding_base_url: ["embedding_base_url"],
  embedding_model: ["embedding_model"],
  embedding_timeout: ["embedding_timeout"],
  embedding_batch_size: ["embedding_batch_size"],
  vector_top_k: ["vector_top_k"],
  vector_context_chars: ["vector_context_chars"],
  web_search_enabled: ["web_search_enabled"],
  web_search_provider: ["web_search_provider"],
  web_search_api_key: ["web_search_api_key"],
  web_search_base_url: ["web_search_base_url"],
  web_search_max_results: ["web_search_max_results"],
  web_search_timeout: ["web_search_timeout"],
  web_search_context_chars: ["web_search_context_chars"],
  auto_lore_extract_enabled: ["auto_lore_extract_enabled"],
  humanizer_enabled: ["humanizer_enabled"]
};

const profileConfigKeys = [
  "api_key",
  "license_account_key",
  "base_url",
  "model",
  "temp",
  "top_p",
  "secondary_api_key",
  "secondary_base_url",
  "secondary_model",
  "secondary_temp",
  "secondary_top_p",
  "embedding_enabled",
  "embedding_api_key",
  "embedding_base_url",
  "embedding_model"
] as const;

type ProfileConfigKey = (typeof profileConfigKeys)[number];

export function resolveConfigPath(options: ConfigServiceOptions = {}): string {
  if (options.configPath) {
    return path.resolve(options.configPath);
  }

  const explicit = options.env?.XIAOSHUO_STUDIO_CONFIG;
  if (explicit) {
    return path.resolve(explicit);
  }

  const rootDir = path.resolve(options.rootDir || process.cwd());
  const cwd = path.resolve(options.cwd || process.cwd());
  const candidates = [path.join(rootDir, "studio_config.json"), path.join(cwd, "studio_config.json")];
  if (options.executablePath && options.executablePath.toLowerCase().endsWith(".exe")) {
    const executableDir = path.dirname(path.resolve(options.executablePath));
    candidates.push(
      path.join(executableDir, "studio_config.json"),
      path.join(path.dirname(executableDir), "studio_config.json"),
      path.join(path.dirname(path.dirname(executableDir)), "studio_config.json")
    );
  }
  return candidates[0] || path.join(rootDir, "studio_config.json");
}

export async function readRawConfig(options: ConfigServiceOptions = {}): Promise<RawConfig> {
  const configPath = resolveConfigPath(options);
  try {
    const text = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RawConfig) : {};
  } catch {
    return {};
  }
}

export function normalizePublicConfig(data: RawConfig): AppConfig {
  const mode = aiConfigModeValue(data.ai_config_mode);
  const manualProfile = normalizeProfile(
    profileRecord(data.manual_profile) || (mode === "manual" ? legacyProfileFromRaw(data) : {}),
    { defaultBaseUrl: true, tempFallback: 0.7 }
  );
  const websiteProfile = normalizeProfile(
    profileRecord(data.website_profile) || (mode === "website" ? legacyProfileFromRaw(data) : {}),
    { defaultBaseUrl: false, tempFallback: 0.7 }
  );
  const effectiveProfile = mode === "website" ? websiteProfile : manualProfile;

  return {
    ai_config_mode: mode,
    manual_profile: manualProfile,
    website_profile: websiteProfile,
    api_key: stringValue(effectiveProfile.api_key),
    license_account_key: stringValue(effectiveProfile.license_account_key || data.license_account_key || data.licenseAccountKey),
    base_url: stringValue(effectiveProfile.base_url || DEFAULT_BASE_URL),
    model: stringValue(effectiveProfile.model),
    temp: floatValue(effectiveProfile.temp, 0.7),
    top_p: topPValue(effectiveProfile.top_p, 1),
    secondary_api_key: stringValue(effectiveProfile.secondary_api_key),
    secondary_base_url: stringValue(effectiveProfile.secondary_base_url),
    secondary_model: stringValue(effectiveProfile.secondary_model),
    secondary_temp: floatValue(effectiveProfile.secondary_temp, 0.5),
    secondary_top_p: topPValue(effectiveProfile.secondary_top_p, 1),
    model_thinking_enabled: true,
    enable_consistency_revision: Boolean(data.enable_consistency_revision ?? true),
    consistency_revision_score: intValue(data.consistency_revision_score, 80),
    context_limit_chars: intValue(data.context_limit_chars, 262144),
    embedding_enabled: Boolean(effectiveProfile.embedding_enabled ?? data.embedding_enabled ?? false),
    embedding_api_key: stringValue(effectiveProfile.embedding_api_key),
    embedding_base_url: stringValue(effectiveProfile.embedding_base_url || DEFAULT_EMBEDDING_BASE_URL),
    embedding_model: stringValue(effectiveProfile.embedding_model || DEFAULT_EMBEDDING_MODEL),
    embedding_timeout: floatValue(data.embedding_timeout, 60),
    embedding_batch_size: intValue(data.embedding_batch_size, 16),
    vector_top_k: intValue(data.vector_top_k, 10),
    vector_context_chars: intValue(data.vector_context_chars, 9000),
    web_search_enabled: Boolean(data.web_search_enabled ?? false),
    web_search_provider: webSearchProviderValue(data.web_search_provider),
    web_search_api_key: stringValue(data.web_search_api_key),
    web_search_base_url: stringValue(data.web_search_base_url),
    web_search_max_results: clampInt(data.web_search_max_results, 3, 1, 5),
    web_search_timeout: clampInt(data.web_search_timeout, 10, 3, 60),
    web_search_context_chars: clampInt(data.web_search_context_chars, 3000, 800, 8000),
    auto_lore_extract_enabled: Boolean(data.auto_lore_extract_enabled ?? false),
    humanizer_enabled: Boolean(data.humanizer_enabled ?? false)
  };
}

export async function loadPublicConfig(options: ConfigServiceOptions = {}): Promise<AppConfig> {
  return normalizePublicConfig(await readRawConfig(options));
}

export async function savePublicConfig(payload: RawConfig, options: ConfigServiceOptions = {}): Promise<AppConfig> {
  const configPath = resolveConfigPath(options);
  const data = await readRawConfig(options);
  const normalizedPayload = { ...payload };

  for (const [canonical, candidates] of Object.entries(aliases)) {
    if (canonical in normalizedPayload) {
      continue;
    }
    const matchingKey = candidates.find((candidate) => candidate in normalizedPayload);
    if (matchingKey) {
      normalizedPayload[canonical] = normalizedPayload[matchingKey];
    }
  }

  seedActiveProfileFromLegacy(data);

  if (
    !("ai_config_mode" in normalizedPayload) &&
    ("relayUrl" in normalizedPayload || "relayKey" in normalizedPayload || "licenseAccountKey" in normalizedPayload)
  ) {
    normalizedPayload.ai_config_mode = "website";
  }

  const nextMode = aiConfigModeValue(normalizedPayload.ai_config_mode ?? data.ai_config_mode);
  const profileName = profileNameForMode(nextMode);
  const hasProfilePayload = "manual_profile" in normalizedPayload || "website_profile" in normalizedPayload;

  if ("manual_profile" in normalizedPayload) {
    const currentProfile = profileRecord(data.manual_profile) || {};
    data.manual_profile = normalizeProfile(
      { ...currentProfile, ...(profileRecord(normalizedPayload.manual_profile) || {}) },
      { defaultBaseUrl: true, tempFallback: 0.7 }
    );
  }
  if ("website_profile" in normalizedPayload) {
    const currentProfile = profileRecord(data.website_profile) || {};
    data.website_profile = normalizeProfile(
      { ...currentProfile, ...(profileRecord(normalizedPayload.website_profile) || {}) },
      { defaultBaseUrl: false, tempFallback: 0.7 }
    );
  }

  if (!hasProfilePayload && hasFlatProfilePayload(normalizedPayload)) {
    const currentProfile = profileRecord(data[profileName]) || {};
    data[profileName] = normalizeProfile({ ...currentProfile, ...pickProfileFields(normalizedPayload) }, { defaultBaseUrl: profileName === "manual_profile", tempFallback: 0.7 });
  }

  for (const key of publicConfigKeys) {
    if (key === "manual_profile" || key === "website_profile" || isProfileConfigKey(key)) {
      continue;
    }
    if (key in normalizedPayload) {
      data[key] = normalizedPayload[key];
    }
  }

  data.ai_config_mode = nextMode;
  materializeActiveProfile(data);

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(data, null, 4)}\n`, "utf8");
  return normalizePublicConfig(data);
}

export function loadModelConfigFromRaw(data: RawConfig, slot: "primary" | "secondary" = "primary"): ModelConfig {
  const activeProfile = activeAiProfileFromRaw(data);
  if (slot === "secondary") {
    const apiKey = stringValue(activeProfile.secondary_api_key || data.secondary_api_key).trim();
    const model = stringValue(activeProfile.secondary_model || data.secondary_model).trim();
    const baseUrl = stringValue(activeProfile.secondary_base_url || data.secondary_base_url || data.base_url || DEFAULT_BASE_URL).trim();
    const temperature = floatValue(activeProfile.secondary_temp ?? data.secondary_temp, floatValue(activeProfile.temp ?? data.temp, 0.5));
    const topP = topPValue(activeProfile.secondary_top_p ?? data.secondary_top_p, topPValue(activeProfile.top_p ?? data.top_p, 1));
    if (apiKey && model) {
      return {
        api_key: apiKey,
        base_url: baseUrl,
        model,
        temperature,
        top_p: topP,
        thinking_enabled: true,
        configured: true
      };
    }
  }

  const primaryApiKey = stringValue(activeProfile.api_key || data.api_key).trim();
  const primaryModel = stringValue(activeProfile.model || data.model).trim();
  return {
    api_key: primaryApiKey,
    base_url: stringValue(activeProfile.base_url || data.base_url || DEFAULT_BASE_URL).trim(),
    model: primaryModel,
    temperature: floatValue(activeProfile.temp ?? data.temp, 0.7),
    top_p: topPValue(activeProfile.top_p ?? data.top_p, 1),
    thinking_enabled: true,
    configured: Boolean(primaryApiKey && primaryModel)
  };
}

export async function loadModelConfig(options: ConfigServiceOptions = {}, slot: "primary" | "secondary" = "primary"): Promise<ModelConfig> {
  return loadModelConfigFromRaw(await readRawConfig(options), slot);
}

export function loadEmbeddingConfigFromRaw(data: RawConfig): EmbeddingConfig {
  const activeProfile = activeAiProfileFromRaw(data);
  const explicitKey = stringValue(activeProfile.embedding_api_key || data.embedding_api_key).trim();
  const baseUrl = stringValue(activeProfile.embedding_base_url || data.embedding_base_url || DEFAULT_EMBEDDING_BASE_URL).trim();
  const model = stringValue(activeProfile.embedding_model || data.embedding_model || DEFAULT_EMBEDDING_MODEL).trim();
  let fallbackKey = "";
  if (!explicitKey) {
    if (baseUrl.toLowerCase().includes("volces.com") || model.toLowerCase().includes("doubao")) {
      fallbackKey = stringValue(activeProfile.secondary_api_key || data.secondary_api_key).trim();
    }
    fallbackKey = fallbackKey || stringValue(activeProfile.api_key || data.api_key).trim();
  }
  const apiKey = explicitKey || fallbackKey;
  return {
    enabled: Boolean(activeProfile.embedding_enabled ?? data.embedding_enabled ?? false),
    api_key: apiKey,
    base_url: baseUrl,
    model,
    timeout: floatValue(data.embedding_timeout, 60),
    batch_size: Math.max(1, Math.min(128, intValue(data.embedding_batch_size, 16))),
    configured: Boolean(apiKey && baseUrl && model)
  };
}

export async function loadEmbeddingConfig(options: ConfigServiceOptions = {}): Promise<EmbeddingConfig> {
  return loadEmbeddingConfigFromRaw(await readRawConfig(options));
}

export function loadWebSearchConfigFromRaw(data: RawConfig): WebSearchConfig {
  return {
    enabled: Boolean(data.web_search_enabled ?? false),
    provider: webSearchProviderValue(data.web_search_provider),
    api_key: stringValue(data.web_search_api_key).trim(),
    base_url: stringValue(data.web_search_base_url).trim(),
    max_results: clampInt(data.web_search_max_results, 3, 1, 5),
    timeout: clampInt(data.web_search_timeout, 10, 3, 60),
    context_chars: clampInt(data.web_search_context_chars, 3000, 800, 8000)
  };
}

export async function loadWebSearchConfig(options: ConfigServiceOptions = {}): Promise<WebSearchConfig> {
  return loadWebSearchConfigFromRaw(await readRawConfig(options));
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function floatValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, intValue(value, fallback)));
}

function topPValue(value: unknown, fallback: number): number {
  const parsed = floatValue(value, fallback);
  return Math.max(0, Math.min(1, Math.round(parsed * 100) / 100));
}

function webSearchProviderValue(value: unknown): WebSearchConfig["provider"] {
  const provider = stringValue(value || DEFAULT_WEB_SEARCH_PROVIDER).toLowerCase();
  if (provider === "custom") {
    return "custom";
  }
  if (provider === "duckduckgo") {
    return "duckduckgo";
  }
  return "bing";
}

function aiConfigModeValue(value: unknown): AppConfig["ai_config_mode"] {
  return stringValue(value).toLowerCase() === "website" ? "website" : "manual";
}

function activeAiProfileFromRaw(data: RawConfig): AiProfile {
  const mode = aiConfigModeValue(data.ai_config_mode);
  const profileName = profileNameForMode(mode);
  const profile = profileRecord(data[profileName]) || {};
  return normalizeProfile(
    Object.keys(profile).length ? profile : legacyProfileFromRaw(data),
    { defaultBaseUrl: mode !== "website", tempFallback: mode === "website" ? 0.7 : 0.7 }
  );
}

function seedActiveProfileFromLegacy(data: RawConfig): void {
  const mode = aiConfigModeValue(data.ai_config_mode);
  const profileName = profileNameForMode(mode);
  if (profileRecord(data[profileName]) || !hasFlatProfilePayload(data)) {
    return;
  }
  data[profileName] = normalizeProfile(legacyProfileFromRaw(data), { defaultBaseUrl: profileName === "manual_profile", tempFallback: 0.7 });
}

function materializeActiveProfile(data: RawConfig): void {
  const mode = aiConfigModeValue(data.ai_config_mode);
  const profile = profileRecord(data[profileNameForMode(mode)]) || {};
  const normalized = normalizeProfile(profile, { defaultBaseUrl: mode !== "website", tempFallback: 0.7 });
  for (const key of profileConfigKeys) {
    data[key] = normalized[key] ?? (key === "embedding_enabled" ? false : "");
  }
  data.ai_config_mode = mode;
}

function normalizeProfile(data: RawConfig, options: { defaultBaseUrl: boolean; tempFallback: number }): AiProfile {
  return {
    api_key: stringValue(data.api_key),
    license_account_key: stringValue(data.license_account_key || data.licenseAccountKey),
    base_url: stringValue(data.base_url || (options.defaultBaseUrl ? DEFAULT_BASE_URL : "")),
    model: stringValue(data.model),
    temp: floatValue(data.temp, options.tempFallback),
    top_p: topPValue(data.top_p, 1),
    secondary_api_key: stringValue(data.secondary_api_key),
    secondary_base_url: stringValue(data.secondary_base_url),
    secondary_model: stringValue(data.secondary_model),
    secondary_temp: floatValue(data.secondary_temp, 0.5),
    secondary_top_p: topPValue(data.secondary_top_p, 1),
    embedding_enabled: Boolean(data.embedding_enabled ?? false),
    embedding_api_key: stringValue(data.embedding_api_key),
    embedding_base_url: stringValue(data.embedding_base_url || (options.defaultBaseUrl ? DEFAULT_EMBEDDING_BASE_URL : "")),
    embedding_model: stringValue(data.embedding_model || (options.defaultBaseUrl ? DEFAULT_EMBEDDING_MODEL : ""))
  };
}

function legacyProfileFromRaw(data: RawConfig): RawConfig {
  return pickProfileFields(data);
}

function pickProfileFields(data: RawConfig): RawConfig {
  const result: RawConfig = {};
  for (const key of profileConfigKeys) {
    if (key in data) {
      result[key] = data[key];
    }
  }
  return result;
}

function profileRecord(value: unknown): RawConfig | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawConfig) : null;
}

function profileNameForMode(mode: AppConfig["ai_config_mode"]): "manual_profile" | "website_profile" {
  return mode === "website" ? "website_profile" : "manual_profile";
}

function hasFlatProfilePayload(payload: RawConfig): boolean {
  return profileConfigKeys.some((key) => key in payload);
}

function isProfileConfigKey(key: string): key is ProfileConfigKey {
  return (profileConfigKeys as readonly string[]).includes(key);
}
