import type { AiConfigProfile, AppConfig } from "@xiaoshuo/shared";

export const defaultEmbeddingBaseUrl = "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal";
export const defaultEmbeddingModel = "doubao-embedding-vision-250615";
const defaultBaseUrl = "https://api.openai.com/v1";

export type ConfigReadinessItem = {
  status: "ready" | "warn" | "idle";
  title: string;
  detail: string;
};

export function normalizeConfigDraft(next: AppConfig): AppConfig {
  const mode: AppConfig["ai_config_mode"] = next.ai_config_mode === "website" ? "website" : "manual";
  const manualProfile = normalizeAiProfile(next.manual_profile ?? (mode === "manual" ? next : null), {
    defaultBaseUrl: true,
    tempFallback: 0.7
  });
  const websiteProfile = normalizeAiProfile(next.website_profile ?? (mode === "website" ? next : null), {
    defaultBaseUrl: false,
    tempFallback: 0.7
  });
  const activeProfile = mode === "website" ? websiteProfile : manualProfile;

  return {
    ...next,
    ai_config_mode: mode,
    manual_profile: manualProfile,
    website_profile: websiteProfile,
    api_key: activeProfile.api_key || "",
    license_account_key: activeProfile.license_account_key || "",
    base_url: activeProfile.base_url || (mode === "manual" ? defaultBaseUrl : ""),
    model: activeProfile.model || "",
    temp: clampTemperature(activeProfile.temp ?? 0.7),
    top_p: clampTopP(activeProfile.top_p ?? 1),
    secondary_api_key: activeProfile.secondary_api_key || "",
    secondary_base_url: activeProfile.secondary_base_url || "",
    secondary_model: activeProfile.secondary_model || "",
    secondary_temp: clampTemperature(activeProfile.secondary_temp ?? 0.5),
    secondary_top_p: clampTopP(activeProfile.secondary_top_p ?? 1),
    consistency_revision_score: clampScoreThreshold(next.consistency_revision_score ?? 80),
    context_limit_chars: clampRange(next.context_limit_chars ?? 262144, 8192, 1048576),
    embedding_enabled: Boolean(activeProfile.embedding_enabled ?? false),
    embedding_api_key: activeProfile.embedding_api_key || "",
    embedding_base_url: activeProfile.embedding_base_url || (mode === "manual" ? defaultEmbeddingBaseUrl : ""),
    embedding_model: activeProfile.embedding_model || (mode === "manual" ? defaultEmbeddingModel : ""),
    embedding_timeout: clampRange(next.embedding_timeout ?? 60, 5, 300),
    embedding_batch_size: clampRange(next.embedding_batch_size ?? 16, 1, 128),
    vector_top_k: clampRange(next.vector_top_k ?? 10, 1, 40),
    vector_context_chars: clampRange(next.vector_context_chars ?? 9000, 1000, 80000),
    web_search_enabled: Boolean(next.web_search_enabled ?? false),
    web_search_provider: next.web_search_provider === "custom" || next.web_search_provider === "duckduckgo" ? next.web_search_provider : "bing",
    web_search_api_key: next.web_search_api_key || "",
    web_search_base_url: next.web_search_base_url || "",
    web_search_max_results: clampRange(next.web_search_max_results ?? 3, 1, 5),
    web_search_timeout: clampRange(next.web_search_timeout ?? 10, 3, 60),
    web_search_context_chars: clampRange(next.web_search_context_chars ?? 3000, 800, 8000),
    auto_lore_extract_enabled: Boolean(next.auto_lore_extract_enabled ?? false),
    humanizer_enabled: Boolean(next.humanizer_enabled ?? false)
  };
}

function normalizeAiProfile(
  profile: Partial<AiConfigProfile> | Partial<AppConfig> | null | undefined,
  options: { defaultBaseUrl: boolean; tempFallback: number }
): AiConfigProfile {
  const data = profile || {};
  return {
    api_key: stringValue(data.api_key),
    license_account_key: stringValue(data.license_account_key),
    base_url: stringValue(data.base_url || (options.defaultBaseUrl ? defaultBaseUrl : "")),
    model: stringValue(data.model),
    temp: clampTemperature(data.temp ?? options.tempFallback),
    top_p: clampTopP(data.top_p ?? 1),
    secondary_api_key: stringValue(data.secondary_api_key),
    secondary_base_url: stringValue(data.secondary_base_url),
    secondary_model: stringValue(data.secondary_model),
    secondary_temp: clampTemperature(data.secondary_temp ?? 0.5),
    secondary_top_p: clampTopP(data.secondary_top_p ?? 1),
    embedding_enabled: Boolean(data.embedding_enabled ?? false),
    embedding_api_key: stringValue(data.embedding_api_key),
    embedding_base_url: stringValue(data.embedding_base_url || (options.defaultBaseUrl ? defaultEmbeddingBaseUrl : "")),
    embedding_model: stringValue(data.embedding_model || (options.defaultBaseUrl ? defaultEmbeddingModel : ""))
  };
}

export function describeConfigReadiness(config: AppConfig): ConfigReadinessItem[] {
  const hasMainModel = Boolean(config.api_key.trim() && config.base_url.trim() && config.model.trim());
  const hasSecondaryModel = Boolean(config.secondary_api_key.trim() && config.secondary_base_url.trim() && config.secondary_model.trim());
  const hasEmbedding = Boolean(config.embedding_api_key.trim() && config.embedding_base_url.trim() && config.embedding_model.trim());
  const webSearchReady = config.web_search_provider === "custom" ? Boolean(config.web_search_base_url?.trim()) : true;

  return [
    {
      status: hasMainModel ? "ready" : "warn",
      title: "主线路模型",
      detail: hasMainModel ? `已配置 ${config.model}` : "发送消息和执行技能前，需要补齐 API Key、Base URL 和模型名。"
    },
    {
      status: config.license_account_key.trim() ? "ready" : "idle",
      title: "授权账号",
      detail: config.license_account_key.trim() ? "已填写授权账号 Key，可刷新授权状态。" : "未填写授权账号 Key，保存后仍可能显示未授权。"
    },
    {
      status: config.embedding_enabled ? (hasEmbedding ? "ready" : "warn") : "idle",
      title: "向量召回",
      detail: config.embedding_enabled
        ? hasEmbedding
          ? `已配置 ${config.embedding_model}`
          : "已开启向量召回，但 Embedding API Key、Base URL 或模型名还没补齐。"
        : "当前关闭；不影响基础写作，但长期记忆召回不会启用。"
    },
    {
      status: config.web_search_enabled ? (webSearchReady ? "ready" : "warn") : "idle",
      title: "联网素材搜索",
      detail: config.web_search_enabled
        ? webSearchReady
          ? `已开启 ${describeWebSearchProvider(config.web_search_provider)}，最多读取 ${config.web_search_max_results ?? 3} 条搜索结果。`
          : "已开启自定义搜索，但 Base URL 还没填写。"
        : "当前关闭；聊天不会主动访问网络素材。"
    },
    {
      status: hasSecondaryModel ? "ready" : "idle",
      title: "副线路模型",
      detail: hasSecondaryModel ? `已配置 ${config.secondary_model}` : "未配置副线路；主线路可用时可以先不填。"
    }
  ];
}

function describeWebSearchProvider(provider: AppConfig["web_search_provider"]): string {
  if (provider === "custom") {
    return "自定义接口";
  }
  if (provider === "duckduckgo") {
    return "DuckDuckGo";
  }
  return "Bing";
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function clampTemperature(value: unknown): number {
  const finite = finiteNumber(value, 0.7);
  return Math.max(0, Math.min(2, Math.round(finite * 100) / 100));
}

function clampTopP(value: unknown): number {
  const finite = finiteNumber(value, 1);
  return Math.max(0, Math.min(1, Math.round(finite * 100) / 100));
}

function clampScoreThreshold(value: unknown): number {
  return Math.max(1, Math.min(100, Math.round(finiteNumber(value, 80))));
}

function clampRange(value: unknown, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(finiteNumber(value, min))));
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
