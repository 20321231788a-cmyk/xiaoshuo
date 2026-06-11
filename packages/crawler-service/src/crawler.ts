import * as cheerio from "cheerio";
import { type NovelCrawlRequest } from "@xiaoshuo/shared";

export type NovelSourceResolverResult = {
  title?: string;
  url: string;
  source?: string;
};

export type NovelSourceResolverContext = {
  source: string;
};

export type NovelSourceResolver = (
  query: string,
  context: NovelSourceResolverContext
) => Promise<NovelSourceResolverResult[]>;

export type NovelCrawlerServiceOptions = {
  resolver?: NovelSourceResolver;
};

export class NovelSearchResult {
  constructor(
    public readonly title: string,
    public readonly url: string,
    public readonly source: string
  ) {}
}

export class CrawledChapter {
  constructor(
    public readonly title: string,
    public readonly url: string,
    public readonly content: string
  ) {}
}

export class CrawledNovel {
  constructor(
    public readonly title: string,
    public readonly source: string,
    public readonly source_url: string,
    public readonly chapters: CrawledChapter[]
  ) {}

  toText(): string {
    const parts = [
      `《${this.title}》`,
      `来源：${this.source}`,
      `目录：${this.source_url}`,
      `章节数：${this.chapters.length}`
    ];
    this.chapters.forEach((chapter, index) => {
      parts.push(`\n\n## ${index + 1}. ${chapter.title}\n来源：${chapter.url}\n\n${chapter.content}`);
    });
    return parts.join("\n").trim() + "\n";
  }
}

type SourceConfig = {
  name: string;
  base: string;
  search_urls: string[];
};

const SOURCES: Record<string, SourceConfig> = {
  shuhaige_mobile: {
    name: "书海阁",
    base: "https://m.shuhaige.net",
    search_urls: []
  },
  novel543: {
    name: "Novel543",
    base: "https://www.novel543.com",
    search_urls: []
  },
  shukuge: {
    name: "书库阁",
    base: "http://www.shukuge.com",
    search_urls: [
      "http://www.shukuge.com/Search?searchkey={query}",
      "http://www.shukuge.com/Search?keyword={query}"
    ]
  },
  zxtyz: {
    name: "zxtyz",
    base: "https://www.zxtyz.com",
    search_urls: [
      "https://www.zxtyz.com/search.html?searchkey={query}",
      "https://www.zxtyz.com/search.html?keyword={query}",
      "https://www.zxtyz.com/search.html?q={query}"
    ]
  },
  biquge: {
    name: "22biqu",
    base: "https://m.22biqu.net",
    search_urls: [
      "https://m.22biqu.net/ss/?searchkey={query}",
      "https://m.22biqu.net/ss/?keyword={query}",
      "https://m.22biqu.net/ss/{query}/"
    ]
  }
};

const SOURCE_ORDER = ["shuhaige_mobile", "novel543", "shukuge", "zxtyz", "biquge"];
const RESOLVER_SOURCE_ORDER = ["shuhaige_mobile", "novel543"];

export function normalizeNovelDirectoryUrl(rawUrl: string, sourceHint = ""): NovelSourceResolverResult | null {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/{2,}/g, "/");
    const hint = sourceHint.trim();

    if ((!hint || hint === "shuhaige_mobile") && host === "m.shuhaige.net") {
      const match = path.match(/^\/(\d+)\/?$/);
      if (!match?.[1]) {
        return null;
      }
      return {
        source: "shuhaige_mobile",
        url: `https://m.shuhaige.net/${match[1]}/`
      };
    }

    if ((!hint || hint === "novel543") && (host === "www.novel543.com" || host === "novel543.com")) {
      const match = path.match(/^\/(\d+)(?:\/dir)?\/?$/);
      if (!match?.[1]) {
        return null;
      }
      return {
        source: "novel543",
        url: `https://www.novel543.com/${match[1]}/dir`
      };
    }
  } catch {
    return null;
  }
  return null;
}

export class NovelCrawlerService {
  private readonly resolver?: NovelSourceResolver;
  private readonly headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6"
  };

  constructor(options: NovelCrawlerServiceOptions = {}) {
    this.resolver = options.resolver;
  }

  async crawl(
    request: NovelCrawlRequest,
    progress?: (value: number, message: string) => void
  ): Promise<CrawledNovel> {
    const query = (request.query || "").trim();
    if (!query) {
      throw new Error("请输入书名或目录 URL");
    }
    const requestedSource = request.source || "auto";
    const isDirectUrl = this.isUrl(query);
    const urlSource = isDirectUrl ? this.sourceForUrl(query, requestedSource) : "";
    const usedResolver = !isDirectUrl && Boolean(this.resolver) && this.supportedResolverSources(requestedSource).length > 0;
    const sources = urlSource
      ? [urlSource]
      : requestedSource === "auto"
        ? usedResolver
          ? SOURCE_ORDER.filter((source) => !RESOLVER_SOURCE_ORDER.includes(source))
          : SOURCE_ORDER
        : [requestedSource];
    const errors: string[] = [];

    if (usedResolver && this.resolver) {
      progress?.(0.03, "联网搜索目录 URL");
      try {
        const resolved = await this.resolver(query, { source: requestedSource });
        const candidates = this.normalizeResolvedResults(resolved, requestedSource);
        if (!candidates.length) {
          errors.push("Bing/自定义搜索未定位到可用目录 URL");
        }
        for (const candidate of candidates) {
          try {
            progress?.(0.08, `定位目录：${SOURCES[candidate.source]?.name || candidate.source}`);
            const novel = await this.crawlResolvedSource(candidate, query, request, progress);
            if (novel.chapters.length > 0) {
              return novel;
            }
          } catch (exc) {
            errors.push(`${SOURCES[candidate.source]?.name || candidate.source}: ${exc instanceof Error ? exc.message : exc}`);
          }
        }
      } catch (exc) {
        errors.push(`Bing/自定义搜索: ${exc instanceof Error ? exc.message : exc}`);
      }
      if (requestedSource !== "auto") {
        throw new Error("小说拆书素材获取失败：" + (errors.length ? errors.join("；") : "未找到可用来源"));
      }
    }

    for (const source of sources) {
      try {
        const sourceConfig = SOURCES[source];
        if (!sourceConfig) {
          continue;
        }
        progress?.(0.03, `搜索 ${sourceConfig.name}`);
        const novel = await this.crawlSource(source, query, request, progress);
        if (novel.chapters.length > 0) {
          return novel;
        }
      } catch (exc) {
        errors.push(`${SOURCES[source]?.name || source}: ${exc instanceof Error ? exc.message : exc}`);
      }
    }
    throw new Error("小说拆书素材获取失败：" + (errors.length ? errors.join("；") : "未找到可用来源"));
  }

  close(): void {
    // No-op for fetch
  }

  private async crawlSource(
    source: string,
    query: string,
    request: NovelCrawlRequest,
    progress?: (value: number, message: string) => void
  ): Promise<CrawledNovel> {
    let result: NovelSearchResult;

    if (this.isUrl(query)) {
      const normalized = normalizeNovelDirectoryUrl(query, source);
      result = new NovelSearchResult(this.titleFromUrl(query), normalized?.url || query, normalized?.source || source);
    } else {
      const results = await this.search(source, query);
      if (!results.length) {
        throw new Error(`未搜索到《${query}》`);
      }
      result = results[0]!;
    }

    return this.crawlResolvedSource(result, query, request, progress);
  }

  private async crawlResolvedSource(
    result: NovelSearchResult,
    query: string,
    request: NovelCrawlRequest,
    progress?: (value: number, message: string) => void
  ): Promise<CrawledNovel> {
    const source = result.source;
    progress?.(0.12, `读取目录：${result.title}`);
    const chapters = await this.getChapters(source, result.url);
    if (!chapters.length) {
      throw new Error("目录页未解析到章节");
    }

    const start = Math.max(0, request.start_chapter - 1);
    const selected = chapters.slice(start, start + request.max_chapters);
    if (!selected.length) {
      throw new Error("章节范围为空");
    }

    const crawled: CrawledChapter[] = [];
    const total = selected.length;

    for (let index = 0; index < total; index++) {
      const chapter = selected[index]!;
      progress?.(0.16 + (index / Math.max(total, 1)) * 0.52, `获取第 ${request.start_chapter + index} 章`);
      try {
        const content = await this.getChapterContent(source, chapter.url);
        if (content.trim()) {
          crawled.push(new CrawledChapter(chapter.title, chapter.url, content));
        }
      } catch (error) {
        // continue even if one chapter fails
      }
    }

    if (!crawled.length) {
      throw new Error("章节内容为空");
    }

    return new CrawledNovel(
      result.title || query,
      SOURCES[source]?.name || source,
      result.url,
      crawled
    );
  }

  async search(source: string, query: string): Promise<NovelSearchResult[]> {
    const sourceConfig = SOURCES[source];
    if (!sourceConfig) {
      return [];
    }
    const found: NovelSearchResult[] = [];
    // encodeURIComponent matches Python's quote_plus for ascii
    const encoded = encodeURIComponent(query);

    for (const template of sourceConfig.search_urls) {
      try {
        const url = template.replace("{query}", encoded);
        const html = await this.getText(url);
        const results = this.parseSearchResults(source, sourceConfig.base, html, query);
        found.push(...results);
        if (found.length > 0) {
          break;
        }
      } catch {
        continue;
      }
    }
    return this.dedupeResults(found);
  }

  supportedResolverSources(source: string): string[] {
    if (source === "auto") {
      return [...RESOLVER_SOURCE_ORDER];
    }
    return RESOLVER_SOURCE_ORDER.includes(source) ? [source] : [];
  }

  async getChapters(source: string, bookUrl: string): Promise<NovelSearchResult[]> {
    const sourceConfig = SOURCES[source];
    if (!sourceConfig) {
      return [];
    }
    const html = await this.getText(bookUrl);
    const $ = cheerio.load(html);
    const base = sourceConfig.base;
    const chapters: NovelSearchResult[] = [];

    const headingRegex = /第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节回]/;

    $("a").each((_, anchor) => {
      const text = this.cleanInline($(anchor).text());
      const href = ($(anchor).attr("href") || "").trim();
      if (!text || !href || !headingRegex.test(text)) {
        return;
      }
      try {
        const url = new URL(href, bookUrl).href;
        if (!this.sameSiteOrRelative(base, url)) {
          return;
        }
        chapters.push(new NovelSearchResult(text, url, source));
      } catch {
        // ignore invalid URL
      }
    });

    const deduped = this.dedupeResults(chapters);
    return this.sortChapters(deduped);
  }

  async getChapterContent(source: string, chapterUrl: string): Promise<string> {
    const html = await this.getText(chapterUrl);
    const $ = cheerio.load(html);

    // remove script, style, noscript, iframe, form
    $("script, style, noscript, iframe, form").remove();

    const candidates = [
      "#chaptercontent",
      "#content",
      ".chaptercontent",
      ".content",
      ".read-content",
      ".article-content",
      ".bookreadercontent",
      ".Readarea",
      "article"
    ];

    for (const selector of candidates) {
      const node = $(selector).first();
      if (node.length) {
        const text = this.cleanContent(node.text());
        if (text.length >= 80) {
          return text;
        }
      }
    }

    const bodyText = $("body").first().text() || $.text();
    return this.cleanContent(bodyText);
  }

  private parseSearchResults(
    source: string,
    base: string,
    html: string,
    query: string
  ): NovelSearchResult[] {
    const $ = cheerio.load(html);
    const scored: Array<{ score: number; order: number; result: NovelSearchResult }> = [];
    const headingRegex = /第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节回]/;

    $("a").each((order, anchor) => {
      const title = this.cleanInline($(anchor).text());
      const href = ($(anchor).attr("attr") || $(anchor).attr("href") || "").trim();
      if (!title || !href || href.startsWith("javascript:") || href.startsWith("#")) {
        return;
      }
      if (headingRegex.test(title)) {
        return;
      }
      try {
        const url = new URL(href, base).href;
        if (!this.sameSiteOrRelative(base, url)) {
          return;
        }

        let score = 0;
        if (query && title.includes(query)) {
          score += 100;
        }
        if (["/book/", "/novel/", "/info/", "/txt/", "/b/"].some((part) => url.toLowerCase().includes(part))) {
          score += 20;
        }
        if (/\/\d+\/?$/.test(url) || /\/\d+\.html?$/.test(url)) {
          score += 10;
        }

        if (score > 0) {
          scored.push({
            score,
            order,
            result: new NovelSearchResult(title, url, source)
          });
        }
      } catch {
        // ignore
      }
    });

    // Sort descending by score, then ascending by order
    scored.sort((left, right) => right.score - left.score || left.order - right.order);
    return scored.map((item) => item.result);
  }

  private normalizeResolvedResults(
    results: NovelSourceResolverResult[],
    requestedSource: string
  ): NovelSearchResult[] {
    const allowedSources = new Set(this.supportedResolverSources(requestedSource));
    return this.dedupeResults(
      results
        .map((item) => {
          const normalized = normalizeNovelDirectoryUrl(item.url, item.source);
          if (!normalized?.source || !normalized.url || !allowedSources.has(normalized.source)) {
            return null;
          }
          return new NovelSearchResult(item.title?.trim() || this.titleFromUrl(normalized.url), normalized.url, normalized.source);
        })
        .filter((item): item is NovelSearchResult => Boolean(item))
    );
  }

  private sourceForUrl(url: string, requestedSource: string): string {
    const normalized = normalizeNovelDirectoryUrl(url);
    return normalized?.source || (requestedSource === "auto" ? "" : requestedSource);
  }

  private async getText(url: string): Promise<string> {
    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const contentType = response.headers.get("content-type") || "";
    const match = contentType.match(/charset=([\w\-]+)/i);
    let encoding = match ? match[1]!.toLowerCase() : "";

    if (encoding && encoding !== "ascii" && encoding !== "iso-8859-1") {
      try {
        return new TextDecoder(encoding).decode(bytes);
      } catch {
        // ignore
      }
    }

    for (const candidate of ["utf-8", "gb18030", "gbk"]) {
      try {
        const decoder = new TextDecoder(candidate, { fatal: true });
        return decoder.decode(bytes);
      } catch {
        // continue
      }
    }

    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  private dedupeResults(results: NovelSearchResult[]): NovelSearchResult[] {
    const seen = new Set<string>();
    const deduped: NovelSearchResult[] = [];
    results.forEach((item) => {
      const key = item.url.split("#")[0]!.replace(/\/+$/, "");
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      deduped.push(item);
    });
    return deduped;
  }

  private sortChapters(chapters: NovelSearchResult[]): NovelSearchResult[] {
    const indexed = chapters.map((item, index) => ({
      num: this.chapterNumber(item.title, item.url),
      index,
      item
    }));

    const validNumCount = indexed.filter((x) => x.num > 0).length;
    if (validNumCount >= Math.max(2, Math.floor(chapters.length / 2))) {
      indexed.sort((left, right) => {
        const leftVal = left.num > 0 ? left.num : 10 ** 9;
        const rightVal = right.num > 0 ? right.num : 10 ** 9;
        return leftVal - rightVal || left.index - right.index;
      });
      return indexed.map((x) => x.item);
    }
    return chapters;
  }

  private chapterNumber(title: string, url: string): number {
    const text = `${title} ${url}`;
    const numMatch = text.match(/第\s*(\d+)\s*[章节回]/);
    if (numMatch && numMatch[1]) {
      return parseInt(numMatch[1], 10);
    }
    const urlMatch = url.match(/\/(\d+)\.html?$/);
    if (urlMatch && urlMatch[1]) {
      return parseInt(urlMatch[1], 10);
    }
    return 0;
  }

  private cleanContent(text: string): string {
    const lines: string[] = [];
    const blocked = /(上一章|下一章|返回目录|加入书签|最新网址|手机阅读|请收藏|推荐票|月票|本章未完|点击|广告)/;
    const splitLines = (text || "").split(/[\r\n]+/);
    for (const raw of splitLines) {
      const line = this.cleanInline(raw);
      if (!line || blocked.test(line)) {
        continue;
      }
      lines.push(line);
    }
    const compact = lines.join("\n");
    return compact.replace(/\n{3,}/g, "\n\n").trim();
  }

  private cleanInline(text: string): string {
    return (text || "")
      .replace(/\u3000/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private sameSiteOrRelative(base: string, url: string): boolean {
    try {
      const parsedBase = new URL(base);
      const parsedUrl = new URL(url, base);
      return !parsedUrl.host || parsedUrl.host.endsWith(parsedBase.host);
    } catch {
      return false;
    }
  }

  private isUrl(value: string): boolean {
    return value.startsWith("http://") || value.startsWith("https://");
  }

  private titleFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const last = parsed.pathname.replace(/\/+$/, "").split("/").at(-1);
      return last || "未命名小说";
    } catch {
      return "未命名小说";
    }
  }
}
