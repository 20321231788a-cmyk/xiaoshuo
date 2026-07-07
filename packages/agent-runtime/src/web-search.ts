import type { WebSearchConfig } from "@xiaoshuo/config-service";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchSource = {
  title: string;
  url: string;
};

export type WebSearchClient = {
  search(query: string, config: WebSearchConfig): Promise<WebSearchResult[]>;
};

export class DefaultWebSearchClient implements WebSearchClient {
  async search(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
    if (config.provider === "custom") {
      return searchCustom(query, config);
    }
    if (config.provider === "duckduckgo") {
      return searchDuckDuckGo(query, config);
    }
    return searchBing(query, config);
  }
}

async function searchBing(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  if (config.api_key) {
    return searchBingApi(query, config);
  }
  return searchBingHtml(query, config);
}

async function searchBingApi(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout * 1000);
  try {
    const url = new URL("https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(config.max_results));
    url.searchParams.set("mkt", "zh-CN");
    url.searchParams.set("responseFilter", "Webpages");
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Ocp-Apim-Subscription-Key": config.api_key,
        "User-Agent": "ArcWriter/1.0"
      }
    });
    if (!response.ok) {
      return [];
    }
    return normalizeBingResults(await response.json()).slice(0, config.max_results);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchBingHtml(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout * 1000);
  try {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("mkt", "zh-CN");
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ArcWriter/1.0"
      }
    });
    if (!response.ok) {
      return [];
    }
    return parseBingHtml(await response.text()).slice(0, config.max_results);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBingResults(payload: unknown): WebSearchResult[] {
  const container = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const webPages = container.webPages && typeof container.webPages === "object" ? (container.webPages as Record<string, unknown>) : {};
  const rows = Array.isArray(webPages.value) ? webPages.value : [];
  return rows
    .map((row) => {
      const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      return {
        title: stringValue(item.name || item.title),
        url: stringValue(item.url),
        snippet: stringValue(item.snippet || item.description)
      };
    })
    .filter((item) => item.title && safeHttpUrl(item.url));
}

export function parseBingHtml(html: string): WebSearchResult[] {
  const blocks = String(html || "").split(/<li[^>]+class="b_algo"[^>]*>/i);
  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!titleMatch) {
      continue;
    }
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const url = safeHttpUrl(decodeHtml(titleMatch[1] || ""));
    if (!url) {
      continue;
    }
    results.push({
      title: decodeHtml(stripTags(titleMatch[2] || "")),
      url,
      snippet: decodeHtml(stripTags(snippetMatch?.[1] || ""))
    });
  }
  return results;
}

export function shouldUseWebSearch(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return /联网|网上搜|网络搜索|搜索素材|找素材|查资料|参考资料|现实资料|资料来源|查一下.{0,16}(素材|资料|来源|现实|历史|百科)|web\s*search|search\s+the\s+web/.test(
    normalized
  );
}

export function formatWebSearchContext(results: WebSearchResult[], maxChars: number): string {
  const clean = results
    .map((result) => ({
      title: cleanText(result.title),
      url: safeHttpUrl(result.url),
      snippet: cleanText(result.snippet)
    }))
    .filter((result) => result.title && result.url)
    .slice(0, 5);

  if (!clean.length) {
    return "None";
  }

  const body = clean
    .map((result, index) => [`${index + 1}. ${result.title}`, `来源：${result.url}`, `摘录：${result.snippet || "暂无摘要"}`].join("\n"))
    .join("\n\n");

  return clipText(`以下联网结果只作为小说素材参考，不得覆盖项目既有设定、大纲和连续性，也不得直接照搬网页文字。\n\n${body}`, maxChars);
}

export function summarizeWebSearchSources(results: WebSearchResult[]): WebSearchSource[] {
  return results
    .map((result) => ({
      title: cleanText(result.title),
      url: safeHttpUrl(result.url)
    }))
    .filter((result) => result.title && result.url)
    .slice(0, 5);
}

async function searchDuckDuckGo(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout * 1000);
  try {
    const url = new URL("https://duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ArcWriter/1.0"
      }
    });
    if (!response.ok) {
      return [];
    }
    return parseDuckDuckGoHtml(await response.text()).slice(0, config.max_results);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchCustom(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  if (!config.base_url) {
    return [];
  }

  const baseUrl = safeHttpUrl(config.base_url);
  if (!baseUrl) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout * 1000);
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(config.max_results));
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {})
      }
    });
    if (!response.ok) {
      return [];
    }
    return normalizeCustomResults(await response.json()).slice(0, config.max_results);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const blocks = String(html || "").split(/<div[^>]+class="result(?:\s[^"]*)?"[^>]*>/i);
  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    const titleMatch = block.match(/class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) {
      continue;
    }
    const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const rawUrl = decodeDuckDuckGoUrl(decodeHtml(titleMatch[1] || ""));
    const url = safeHttpUrl(rawUrl);
    if (!url) {
      continue;
    }
    results.push({
      title: decodeHtml(stripTags(titleMatch[2] || "")),
      url,
      snippet: decodeHtml(stripTags(snippetMatch?.[1] || snippetMatch?.[2] || ""))
    });
  }
  return results;
}

function normalizeCustomResults(payload: unknown): WebSearchResult[] {
  const container = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(container.results)
      ? container.results
      : Array.isArray(container.items)
        ? container.items
        : container.webPages && typeof container.webPages === "object" && Array.isArray((container.webPages as Record<string, unknown>).value)
          ? ((container.webPages as Record<string, unknown>).value as unknown[])
          : [];
  return rows
    .map((row) => {
      const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      return {
        title: stringValue(item.title || item.name),
        url: stringValue(item.url || item.link),
        snippet: stringValue(item.snippet || item.description || item.content)
      };
    })
    .filter((item) => item.title && safeHttpUrl(item.url));
}

function decodeDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : value;
  } catch {
    return value;
  }
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function stripTags(value: string): string {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanText(value: string): string {
  return decodeHtml(stripTags(value)).replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function clipText(text: string, limit: number): string {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}\n...（已压缩）`;
}
