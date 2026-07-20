import {
  manualModelDiscoveryRequestSchema,
  normalizeAiModelOption,
  type AiModelOption,
  type ManualModelDiscoveryResponse,
  type ReasoningEffort
} from "@xiaoshuo/shared";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type JsonRecord = Record<string, unknown>;
type CacheEntry = { expiresAt: number; response: ManualModelDiscoveryResponse };

const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_MAX_BYTES = 2 * 1024 * 1024;
const DISCOVERY_CACHE_MS = 5 * 60_000;
const discoveryCache = new Map<string, CacheEntry>();

type ModelDiscoveryRouteDeps = {
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
};

export async function handleModelDiscoveryRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  deps: ModelDiscoveryRouteDeps
): Promise<boolean> {
  if (pathname !== "/api/config/models/discover" || request.method !== "POST") {
    return false;
  }

  try {
    const payload = manualModelDiscoveryRequestSchema.parse(await deps.readJsonBody(request));
    const result = await discoverManualModels(payload, { fetchFn: deps.fetchFn, now: deps.now });
    deps.writeJson(response, 200, result);
  } catch (error) {
    deps.writeJson(response, 400, {
      detail: error instanceof Error ? error.message : "模型列表刷新失败，请检查接口地址后重试。"
    });
  }
  return true;
}

export async function discoverManualModels(
  payload: { base_url: string; api_key: string; force?: boolean },
  options: { fetchFn?: typeof fetch; now?: () => number } = {}
): Promise<ManualModelDiscoveryResponse> {
  const fetchFn = options.fetchFn || fetch;
  const now = options.now || Date.now;
  const modelsUrl = normalizeModelsUrl(payload.base_url);
  const cacheKey = `${modelsUrl.toString()}::${createHash("sha256").update(payload.api_key).digest("hex")}`;
  const cached = discoveryCache.get(cacheKey);
  if (!payload.force && cached && cached.expiresAt > now()) {
    return { ...cached.response, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload.api_key) {
      headers.Authorization = `Bearer ${payload.api_key}`;
    }
    const response = await fetchFn(modelsUrl, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`模型接口返回 ${response.status}，请检查 API Key 与接口地址。`);
    }
    const parsed = JSON.parse(await readLimitedResponseText(response, DISCOVERY_MAX_BYTES)) as unknown;
    const normalized = normalizeModelCatalogResponse(parsed);
    if (!normalized.length) {
      throw new Error("接口没有返回可用于文本生成的模型。仍可继续使用已填写的默认模型。");
    }
    const result: ManualModelDiscoveryResponse = {
      models: normalized,
      cached: false,
      discovered_at: new Date(now()).toISOString()
    };
    discoveryCache.set(cacheKey, { expiresAt: now() + DISCOVERY_CACHE_MS, response: result });
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("模型列表请求超时，请检查接口地址后重试。");
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|econnrefused|enotfound|network/i.test(message)) {
      throw new Error("无法连接模型接口，请检查 Base URL、网络或本地中转服务状态。");
    }
    if (error instanceof SyntaxError) {
      throw new Error("模型接口没有返回有效 JSON，请确认该地址兼容 OpenAI /models。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function invalidateManualModelDiscoveryCache(): void {
  discoveryCache.clear();
}

export function normalizeModelCatalogResponse(payload: unknown): AiModelOption[] {
  const root = asRecord(payload);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : [];
  const unique = new Map<string, AiModelOption>();
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const id = stringValue(record.id || record.model || record.name).trim();
    if (!id) continue;
    const capabilities = asRecord(record.capabilities);
    const reasoningEfforts = readReasoningEfforts(
      record.reasoning_efforts || record.supported_reasoning_efforts || capabilities?.reasoning_efforts
    );
    const option = normalizeAiModelOption({
      id,
      name: stringValue(record.display_name || record.displayName || record.name || id),
      provider: stringValue(record.provider || record.owned_by || record.ownedBy),
      category: stringValue(record.category || record.type || "text"),
      selectable: record.enabled !== false && record.selectable !== false,
      reasoningEfforts,
      supportsReasoning: record.supports_reasoning === true || capabilities?.reasoning === true
    });
    if (option.capabilities.text_generation && option.selectable) {
      unique.set(option.id, option);
    }
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function normalizeModelsUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("API 地址格式无效，请填写完整的 http:// 或 https:// 地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API 地址只支持 http:// 或 https://。");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|models)\/?$/i, "").replace(/\/+$/, "");
  url.pathname = `${url.pathname}/models`.replace(/\/+/g, "/");
  return url;
}

async function readLimitedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new Error("模型列表响应超过 2 MB，已停止读取。");
  }
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("模型列表响应超过 2 MB，已停止读取。");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function readReasoningEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ReasoningEffort => item === "low" || item === "medium" || item === "high");
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
