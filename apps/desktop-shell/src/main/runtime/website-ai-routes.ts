import { loadPublicConfig, savePublicConfig } from "@xiaoshuo/config-service";
import {
  websiteAiApplyRequestSchema,
  websiteAiLoginRequestSchema,
  websiteAiRechargeCreateRequestSchema,
  websiteAiRedeemRequestSchema,
  websiteImageConfigRequestSchema,
  normalizeAiModelOption,
  aiModelOptionSchema,
  type AppConfig,
  type AiConfigProfile,
  type WebsiteAiConfigProfile,
  type WebsiteAiDashboard,
  type WebsiteAiModelOption,
  type WebsiteAiRechargeOption,
  type WebsiteAiRechargeOrder,
  type ReasoningEffort
} from "@xiaoshuo/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type WebsiteAiRouteDeps = {
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

type WebsiteDashboardPayload = JsonRecord & {
  token?: JsonRecord;
  providers?: unknown[];
  maxConcurrency?: unknown;
  maxRpm?: unknown;
  maxTpm?: unknown;
  lowBalanceThreshold?: unknown;
  isLowBalance?: unknown;
  rechargeQr?: unknown;
  rechargeOptions?: unknown;
};

const DEFAULT_WEBSITE_BASE_URL = "https://matian.online";

export async function handleWebsiteAiRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: WebsiteAiRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/website-ai")) {
    return false;
  }

  try {
    if (pathname === "/api/website-ai/login" && request.method === "POST") {
      const payload = websiteAiLoginRequestSchema.parse(await deps.readJsonBody(request));
      const websiteBaseUrl = resolveWebsiteBaseUrl(process.env);
      const login = await fetchWebsiteJson<JsonRecord>(`${websiteBaseUrl}/api/relay/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: payload.email, password: payload.password })
      });
      const tokenKey = stringValue(readRecord(login.token)?.key).trim();
      if (!tokenKey) {
        deps.writeJson(response, 502, { detail: "网站登录成功，但没有返回可用于软件的模型令牌。" });
        return true;
      }

      const dashboard = await fetchWebsiteDashboard(websiteBaseUrl, tokenKey);
      const currentConfig = await loadPublicConfig({ rootDir: context.projectRoot });
      const currentWebsiteProfile: Partial<AiConfigProfile> = currentConfig.website_profile || {};
      const textModels = getModelsByCategory(dashboard.providers, "text");
      const embeddingModels = getModelsByCategory(dashboard.providers, "vector");
      const imageModels = getModelsByCategory(dashboard.providers, "image");
      const selectedModel = pickSelectedModel(stringValue(currentWebsiteProfile.model || currentConfig.model), textModels);
      const selectedEmbeddingModel = pickSelectedModel(stringValue(currentWebsiteProfile.embedding_model || currentConfig.embedding_model), embeddingModels);
      const selectedImageModel = pickSelectedModel(stringValue((currentWebsiteProfile as Partial<WebsiteAiConfigProfile>).image_model), imageModels);
      const saved = await savePublicConfig(
        {
          ai_config_mode: currentConfig.ai_config_mode,
          website_profile: {
            ...currentWebsiteProfile,
            api_key: tokenKey,
            base_url: makeRelayBaseUrl(websiteBaseUrl),
            license_account_key: tokenKey,
            model: selectedModel,
            temp: numberValue(currentWebsiteProfile.temp, currentConfig.temp ?? 0.7),
            top_p: numberValue(currentWebsiteProfile.top_p, currentConfig.top_p ?? 1),
            embedding_enabled: selectedEmbeddingModel ? true : Boolean(currentWebsiteProfile.embedding_enabled),
            embedding_api_key: selectedEmbeddingModel ? tokenKey : stringValue(currentWebsiteProfile.embedding_api_key),
            embedding_base_url: selectedEmbeddingModel ? makeRelayBaseUrl(websiteBaseUrl) : stringValue(currentWebsiteProfile.embedding_base_url),
            embedding_model: selectedEmbeddingModel || stringValue(currentWebsiteProfile.embedding_model),
            image_model: selectedImageModel
          }
        },
        { rootDir: context.projectRoot }
      );

      const redeemConfig = await fetchRedeemConfig(websiteBaseUrl);
      deps.writeJson(response, 200, buildWebsiteAiDashboard(dashboard, saved, websiteBaseUrl, redeemConfig.purchaseUrl, "网站账号已登录，模型配置已写入软件。"));
      return true;
    }

    if (pathname === "/api/website-ai/dashboard" && request.method === "GET") {
      const config = await loadPublicConfig({ rootDir: context.projectRoot });
      const websiteProfile: Partial<AiConfigProfile> = config.website_profile || {};
      const tokenKey = getWebsiteTokenKey(websiteProfile);
      if (!tokenKey) {
        deps.writeJson(response, 200, {
          logged_in: false,
          message: "尚未登录网站配置。",
          account: null,
          models: [],
          embedding_models: [],
          image_models: [],
          selected_model: stringValue(websiteProfile.model),
          selected_embedding_model: stringValue(websiteProfile.embedding_model),
          selected_image_model: stringValue((websiteProfile as Partial<WebsiteAiConfigProfile>).image_model),
          temp: numberValue(websiteProfile.temp, 0.7),
          top_p: numberValue(websiteProfile.top_p, 1),
          max_concurrency: 0,
          max_rpm: 0,
          max_tpm: 0,
          low_balance_threshold: 0,
          recharge_options: [],
          recharge_qr: "",
          redeem_purchase_url: "",
          config
        } satisfies WebsiteAiDashboard);
        return true;
      }

      const websiteBaseUrl = resolveWebsiteBaseUrl(process.env);
      const dashboard = await fetchWebsiteDashboard(websiteBaseUrl, tokenKey);
      const redeemConfig = await fetchRedeemConfig(websiteBaseUrl);
      deps.writeJson(response, 200, buildWebsiteAiDashboard(dashboard, config, websiteBaseUrl, redeemConfig.purchaseUrl));
      return true;
    }

    if (pathname === "/api/website-ai/apply" && request.method === "POST") {
      const payload = websiteAiApplyRequestSchema.parse(await deps.readJsonBody(request));
      const currentConfig = await loadPublicConfig({ rootDir: context.projectRoot });
      const currentWebsiteProfile: Partial<AiConfigProfile> = currentConfig.website_profile || {};
      const tokenKey = getWebsiteTokenKey(currentWebsiteProfile);
      if (!tokenKey) {
        deps.writeJson(response, 400, { detail: "请先在网站配置里登录账号。" });
        return true;
      }

      const websiteBaseUrl = resolveWebsiteBaseUrl(process.env);
      const saved = await savePublicConfig(
        {
          ai_config_mode: "website",
          website_profile: {
            ...currentWebsiteProfile,
            api_key: tokenKey,
            base_url: makeRelayBaseUrl(websiteBaseUrl),
            license_account_key: tokenKey,
            model: payload.model,
            temp: payload.temp,
            top_p: payload.top_p,
            embedding_enabled: Boolean(payload.embedding_model),
            embedding_api_key: payload.embedding_model ? tokenKey : "",
            embedding_base_url: payload.embedding_model ? makeRelayBaseUrl(websiteBaseUrl) : "",
            embedding_model: payload.embedding_model
          }
        },
        { rootDir: context.projectRoot }
      );
      const dashboard = await fetchWebsiteDashboard(websiteBaseUrl, tokenKey);
      const redeemConfig = await fetchRedeemConfig(websiteBaseUrl);
      deps.writeJson(response, 200, buildWebsiteAiDashboard(dashboard, saved, websiteBaseUrl, redeemConfig.purchaseUrl, "网站模型配置已应用。"));
      return true;
    }

    if (pathname === "/api/website-ai/image-config" && request.method === "PUT") {
      const payload = websiteImageConfigRequestSchema.parse(await deps.readJsonBody(request));
      const currentConfig = await loadPublicConfig({ rootDir: context.projectRoot });
      const currentWebsiteProfile: Partial<WebsiteAiConfigProfile> = currentConfig.website_profile || {};
      const tokenKey = getWebsiteTokenKey(currentWebsiteProfile);
      if (!tokenKey) {
        deps.writeJson(response, 400, { detail: "请先在网站配置里登录账号。" });
        return true;
      }
      const websiteBaseUrl = resolveWebsiteBaseUrl(process.env);
      const dashboard = await fetchWebsiteDashboard(websiteBaseUrl, tokenKey);
      const imageModels = getModelsByCategory(dashboard.providers, "image");
      if (!imageModels.some((model) => model.id === payload.image_model)) {
        deps.writeJson(response, 400, { detail: "所选模型不在网站提供的生图模型列表中，请刷新后重试。" });
        return true;
      }
      const saved = await savePublicConfig({
        ai_config_mode: currentConfig.ai_config_mode,
        website_profile: {
          ...currentWebsiteProfile,
          api_key: tokenKey,
          base_url: makeRelayBaseUrl(websiteBaseUrl),
          license_account_key: tokenKey,
          image_model: payload.image_model
        }
      }, { rootDir: context.projectRoot });
      const redeemConfig = await fetchRedeemConfig(websiteBaseUrl);
      deps.writeJson(response, 200, buildWebsiteAiDashboard(dashboard, saved, websiteBaseUrl, redeemConfig.purchaseUrl, "网站生图模型已保存。"));
      return true;
    }

    if (pathname === "/api/website-ai/redeem" && request.method === "POST") {
      const payload = websiteAiRedeemRequestSchema.parse(await deps.readJsonBody(request));
      const { tokenKey, websiteBaseUrl } = await readWebsiteToken(context);
      const result = await fetchWebsiteJson<JsonRecord>(`${websiteBaseUrl}/api/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearerAuthHeaders(tokenKey) },
        body: JSON.stringify({ code: payload.code })
      });
      deps.writeJson(response, 200, normalizeRedeemResult(result));
      return true;
    }

    if (pathname === "/api/website-ai/recharge-orders" && request.method === "POST") {
      const payload = websiteAiRechargeCreateRequestSchema.parse(await deps.readJsonBody(request));
      const { tokenKey, websiteBaseUrl } = await readWebsiteToken(context);
      const result = await fetchWebsiteJson<JsonRecord>(`${websiteBaseUrl}/api/relay/recharge-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearerAuthHeaders(tokenKey) },
        body: JSON.stringify({ optionIndex: payload.option_index })
      });
      deps.writeJson(response, 200, {
        message: stringValue(result.message),
        order: normalizeRechargeOrder(readRecord(result.order), websiteBaseUrl)
      });
      return true;
    }

    const rechargeOrderMatch = pathname.match(/^\/api\/website-ai\/recharge-orders\/([^/]+)$/);
    if (rechargeOrderMatch && request.method === "GET") {
      const orderId = decodeURIComponent(rechargeOrderMatch[1] || "");
      const { tokenKey, websiteBaseUrl } = await readWebsiteToken(context);
      const result = await fetchWebsiteJson<JsonRecord>(
        `${websiteBaseUrl}/api/relay/recharge-orders/${encodeURIComponent(orderId)}`,
        { headers: bearerAuthHeaders(tokenKey) }
      );
      deps.writeJson(response, 200, {
        message: stringValue(result.message),
        order: normalizeRechargeOrder(readRecord(result.order), websiteBaseUrl),
        balance: numberOrUndefined(result.balance)
      });
      return true;
    }

    deps.writeJson(response, 404, { detail: `未找到该接口: ${request.method} ${pathname}` });
    return true;
  } catch (error) {
    deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

async function fetchWebsiteDashboard(websiteBaseUrl: string, tokenKey: string): Promise<WebsiteDashboardPayload> {
  return fetchWebsiteJson<WebsiteDashboardPayload>(`${websiteBaseUrl}/api/relay/dashboard`, {
    headers: bearerAuthHeaders(tokenKey)
  });
}

function bearerAuthHeaders(tokenKey: string): Record<string, string> {
  return { Authorization: `Bearer ${tokenKey}` };
}

async function fetchRedeemConfig(websiteBaseUrl: string): Promise<{ purchaseUrl: string }> {
  try {
    const payload = await fetchWebsiteJson<JsonRecord>(`${websiteBaseUrl}/api/redeem/config`);
    return { purchaseUrl: stringValue(payload.purchaseUrl).trim() };
  } catch {
    return { purchaseUrl: "" };
  }
}

async function fetchWebsiteJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      throw new Error(extractWebsiteError(payload) || response.statusText || `网站接口请求失败：${response.status}`);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("连接网站超时，请稍后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildWebsiteAiDashboard(payload: WebsiteDashboardPayload, config: AppConfig, websiteBaseUrl: string, redeemPurchaseUrl: string, message = ""): WebsiteAiDashboard {
  const token = readRecord(payload.token);
  const textModels = getModelsByCategory(payload.providers, "text");
  const embeddingModels = getModelsByCategory(payload.providers, "vector");
  const imageModels = getModelsByCategory(payload.providers, "image");
  const websiteProfile: Partial<WebsiteAiConfigProfile> = config.website_profile || {};
  return {
    logged_in: true,
    message,
    account: {
      name: stringValue(token?.name),
      email: stringValue(token?.email || token?.username),
      balance: numberValue(token?.balance, 0),
      used: numberValue(token?.used, 0),
      request_count: intValue(token?.requestCount, 0),
      token_count: intValue(token?.tokenCount, 0),
      enabled: token?.enabled !== false,
      is_low_balance: Boolean(payload.isLowBalance)
    },
    models: textModels,
    embedding_models: embeddingModels,
    image_models: imageModels,
    selected_model: pickSelectedModel(stringValue(websiteProfile.model), textModels),
    selected_embedding_model: pickSelectedModel(stringValue(websiteProfile.embedding_model), embeddingModels),
    selected_image_model: pickSelectedModel(stringValue(websiteProfile.image_model), imageModels),
    temp: numberValue(websiteProfile.temp, 0.7),
    top_p: numberValue(websiteProfile.top_p, 1),
    max_concurrency: numberValue(payload.maxConcurrency, 0),
    max_rpm: numberValue(payload.maxRpm, 0),
    max_tpm: numberValue(payload.maxTpm, 0),
    low_balance_threshold: numberValue(payload.lowBalanceThreshold, 0),
    recharge_options: normalizeRechargeOptions(payload.rechargeOptions),
    recharge_qr: normalizeWebsiteUrl(stringValue(payload.rechargeQr), websiteBaseUrl),
    redeem_purchase_url: normalizeWebsiteUrl(redeemPurchaseUrl, websiteBaseUrl),
    config
  };
}

async function readWebsiteToken(context: RuntimeContext): Promise<{ config: AppConfig; tokenKey: string; websiteBaseUrl: string }> {
  const config = await loadPublicConfig({ rootDir: context.projectRoot });
  const websiteProfile: Partial<AiConfigProfile> = config.website_profile || {};
  const tokenKey = getWebsiteTokenKey(websiteProfile);
  if (!tokenKey) {
    throw new Error("请先在网站配置里登录账号。");
  }
  return { config, tokenKey, websiteBaseUrl: resolveWebsiteBaseUrl(process.env) };
}

function getWebsiteTokenKey(websiteProfile: Partial<AiConfigProfile>): string {
  return stringValue(websiteProfile.license_account_key || websiteProfile.api_key).trim();
}

function normalizeRedeemResult(result: JsonRecord): JsonRecord {
  return {
    ...result,
    ok: Boolean(result.ok ?? true),
    status: stringValue(result.status || (result.ok ? "redeemed" : "")),
    type: stringValue(result.type),
    code: stringValue(result.code),
    message: stringValue(result.message || "兑换成功。"),
    balance: numberOrUndefined(result.balance),
    already_redeemed: Boolean(result.alreadyRedeemed || result.already_redeemed)
  };
}

function normalizeRechargeOptions(value: unknown): WebsiteAiRechargeOption[] {
  return Array.isArray(value)
    ? value
        .map((item, index) => {
          const record = readRecord(item);
          return {
            option_index: index,
            amount: numberValue(record?.amount, 0),
            real_price: numberValue(record?.realPrice ?? record?.real_price, numberValue(record?.amount, 0))
          };
        })
        .filter((item) => item.amount > 0)
    : [];
}

function normalizeRechargeOrder(order: JsonRecord | null, websiteBaseUrl: string): WebsiteAiRechargeOrder | null {
  if (!order) {
    return null;
  }
  return {
    order_id: stringValue(order.orderId || order.order_id),
    amount: numberValue(order.amount, 0),
    real_price: numberValue(order.realPrice ?? order.real_price, 0),
    option_index: intValue(order.optionIndex ?? order.option_index, 0),
    status: stringValue(order.status),
    payment_qr: normalizeWebsiteUrl(stringValue(order.paymentQr || order.payment_qr), websiteBaseUrl),
    payment_code: stringValue(order.paymentCode || order.payment_code),
    payment_url: normalizeWebsiteUrl(stringValue(order.paymentUrl || order.payment_url), websiteBaseUrl),
    provider: stringValue(order.provider),
    payment_error: stringValue(order.paymentError || order.payment_error),
    created_at: stringValue(order.createdAt || order.created_at),
    expire_at: stringValue(order.expireAt || order.expire_at),
    paid_at: order.paidAt || order.paid_at ? stringValue(order.paidAt || order.paid_at) : null
  };
}

export function getModelsByCategory(providers: unknown, category: "text" | "vector" | "image"): WebsiteAiModelOption[] {
  const options: WebsiteAiModelOption[] = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerRecord = readRecord(provider);
    const providerName = stringValue(providerRecord?.name || providerRecord?.id);
    const models = Array.isArray(providerRecord?.models) ? providerRecord.models : [];
    for (const model of models) {
      const modelRecord = readRecord(model);
      if (!modelRecord || modelRecord.enabled === false) {
        continue;
      }
      const name = getModelDisplayName(modelRecord);
      if (!name) {
        continue;
      }
      const detectedCategory = detectModelCategory(modelRecord);
      if (detectedCategory !== category) {
        continue;
      }
      if (!options.some((item) => item.id === name)) {
        const capabilities = readRecord(modelRecord.capabilities);
        options.push(category === "text"
          ? normalizeAiModelOption({
              id: name,
              name,
              provider: providerName,
              category,
              reasoningEfforts: readReasoningEfforts(modelRecord.reasoning_efforts || readRecord(modelRecord.capabilities)?.reasoning_efforts),
              supportsReasoning: modelRecord.supports_reasoning === true || readRecord(modelRecord.capabilities)?.reasoning === true
            })
          : aiModelOptionSchema.parse({
              id: name,
              name,
              provider: providerName,
              category,
              selectable: true,
              capabilities: {
                text_generation: false,
                streaming: false,
                reasoning: false,
                image_generation: category === "image",
                image_edit: category === "image" && modelRecord.supports_image_edit !== false && capabilities?.image_edit !== false
              },
              reasoning_efforts: [],
              supported_sizes: readSupportedSizes(modelRecord.supported_sizes || modelRecord.sizes || capabilities?.supported_sizes || capabilities?.sizes)
            }));
      }
    }
  }
  return options;
}

function readReasoningEfforts(value: unknown): ReasoningEffort[] {
  return Array.isArray(value)
    ? value.filter((item): item is ReasoningEffort => item === "low" || item === "medium" || item === "high")
    : [];
}

export function detectModelCategory(model: JsonRecord): "text" | "vector" | "image" | "other" {
  const capabilities = readRecord(model.capabilities);
  const category = stringValue(model.category || model.type).trim().toLowerCase().replace(/[- ]+/g, "_");
  if (capabilities?.image_generation === true || ["image", "image_generation", "text_to_image", "image_edit"].includes(category)) {
    return "image";
  }
  if (["vector", "embedding", "embeddings", "rerank"].includes(category)) {
    return "vector";
  }
  const name = stringValue(model.name || model.model || model.displayName).toLowerCase();
  if (name.includes("embedding") || name.includes("embed") || name.includes("vector") || name.includes("bge") || name.includes("jina")) {
    return "vector";
  }
  if (/(?:gpt-image|dall-e|imagen|flux|stable[-_. ]?diffusion|sdxl|seedream|qwen[-_. ]?image|recraft|ideogram|wanx)/i.test(name)) {
    return "image";
  }
  if (category && !["text", "chat", "language", "llm"].includes(category)) return "other";
  return "text";
}

function readSupportedSizes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => stringValue(item).trim()).filter((item) => /^\d+x\d+$/.test(item)))];
}

export type WebsiteImageRuntimeConfig = {
  tokenKey: string;
  relayBaseUrl: string;
  model: WebsiteAiModelOption;
};

export async function resolveWebsiteImageRuntimeConfig(context: RuntimeContext): Promise<WebsiteImageRuntimeConfig> {
  const { config, tokenKey, websiteBaseUrl } = await readWebsiteToken(context);
  const websiteProfile: Partial<WebsiteAiConfigProfile> = config.website_profile || {};
  const selected = stringValue(websiteProfile.image_model).trim();
  if (!selected) throw new Error("请先在设置的“网站服务”中选择生图模型。");
  const dashboard = await fetchWebsiteDashboard(websiteBaseUrl, tokenKey);
  const models = getModelsByCategory(dashboard.providers, "image");
  const model = models.find((item) => item.id === selected);
  if (!model) throw new Error("已保存的生图模型当前不可用，请刷新网站配置后重新选择。");
  return { tokenKey, relayBaseUrl: makeRelayBaseUrl(websiteBaseUrl), model };
}

function getModelDisplayName(model: JsonRecord): string {
  return stringValue(model.displayName || model.name || model.model || model.id).trim();
}

function pickSelectedModel(current: string | undefined, options: WebsiteAiModelOption[]): string {
  const value = stringValue(current).trim();
  if (value && (!options.length || options.some((item) => item.id === value))) {
    return value;
  }
  return options[0]?.id || value;
}

function resolveWebsiteBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = stringValue(env.XIAOSHUO_WEBSITE_BASE_URL || DEFAULT_WEBSITE_BASE_URL).trim() || DEFAULT_WEBSITE_BASE_URL;
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  return withoutTrailingSlash.replace(/\/v1$/i, "");
}

function makeRelayBaseUrl(websiteBaseUrl: string): string {
  return `${websiteBaseUrl.replace(/\/+$/, "")}/v1`;
}

function normalizeWebsiteUrl(value: string, websiteBaseUrl: string): string {
  const text = value.trim();
  if (!text) {
    return "";
  }
  if (/^https?:\/\//i.test(text) || text.startsWith("data:")) {
    return text;
  }
  try {
    return new URL(text.replace(/^\/+/, ""), `${websiteBaseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return text;
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return { message: text };
  }
}

function extractWebsiteError(payload: unknown): string {
  const record = readRecord(payload);
  return stringValue(record?.message || record?.detail || record?.error).trim();
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function intValue(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
