import { describe, it, expect, vi, beforeEach } from "vitest";
import { NovelCrawlerService, CrawledNovel, normalizeNovelDirectoryUrl } from "./crawler.js";
import { type NovelCrawlRequest } from "@xiaoshuo/shared";

describe("NovelCrawlerService", () => {
  let crawler: NovelCrawlerService;

  beforeEach(() => {
    crawler = new NovelCrawlerService();
  });

  describe("CrawledNovel", () => {
    it("formats output to text format", () => {
      const novel = new CrawledNovel("测试小说", "zxtyz", "https://example.com/dir", [
        { title: "第一章：起风了", url: "https://example.com/1", content: "第一章正文内容。" },
        { title: "第二章：下雨了", url: "https://example.com/2", content: "第二章正文内容。" }
      ]);
      const text = novel.toText();
      expect(text).toContain("《测试小说》");
      expect(text).toContain("来源：zxtyz");
      expect(text).toContain("目录：https://example.com/dir");
      expect(text).toContain("## 1. 第一章：起风了");
      expect(text).toContain("## 2. 第二章：下雨了");
    });
  });

  describe("Encoding Decoding", () => {
    it("decodes UTF-8 and GBK responses correctly", async () => {
      // Mock global fetch
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("gbk")) {
          // GBK buffer for "测试"
          const gbkBuffer = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4]);
          return new Response(gbkBuffer, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=gbk" }
          });
        }
        return new Response("测试utf-8", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      });

      vi.stubGlobal("fetch", mockFetch);

      const gbkText = await (crawler as any).getText("https://example.com/gbk");
      const utf8Text = await (crawler as any).getText("https://example.com/utf8");

      expect(gbkText).toBe("测试");
      expect(utf8Text).toBe("测试utf-8");

      vi.unstubAllGlobals();
    });
  });

  describe("search", () => {
    it("parses and scores search results correctly", async () => {
      const html = `
        <html>
          <body>
            <a href="/book/123.html">剑来</a>
            <a href="/novel/456/">雪中悍刀行</a>
            <a href="/chapter/789.html">第一章：起风了</a>
            <a href="http://other.com/book/999">无关书</a>
          </body>
        </html>
      `;

      vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));

      const results = await crawler.search("zxtyz", "剑来");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.title).toBe("剑来");
      expect(results[0]?.url).toContain("/book/123.html");

      vi.unstubAllGlobals();
    });
  });

  describe("source URL normalization", () => {
    it("recognizes supported directory URLs", () => {
      expect(normalizeNovelDirectoryUrl("https://m.shuhaige.net/335652/")).toEqual({
        source: "shuhaige_mobile",
        url: "https://m.shuhaige.net/335652/"
      });
      expect(normalizeNovelDirectoryUrl("https://www.novel543.com/1206606479/")).toEqual({
        source: "novel543",
        url: "https://www.novel543.com/1206606479/dir"
      });
      expect(normalizeNovelDirectoryUrl("https://www.novel543.com/1206606479/dir")).toEqual({
        source: "novel543",
        url: "https://www.novel543.com/1206606479/dir"
      });
      expect(normalizeNovelDirectoryUrl("https://example.com/book/1")).toBeNull();
    });
  });

  describe("getChapters", () => {
    it("extracts and sorts chapters correctly", async () => {
      const html = `
        <html>
          <body>
            <a href="/book/123/2.html">第二章：雨夜</a>
            <a href="/book/123/1.html">第一章：风起</a>
            <a href="/book/123/10.html">第十章：终章</a>
            <a href="/outside">外部无关联</a>
          </body>
        </html>
      `;

      vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));

      const chapters = await crawler.getChapters("zxtyz", "https://www.zxtyz.com/book/123/");
      expect(chapters.length).toBe(3);
      expect(chapters[0]?.title).toBe("第一章：风起");
      expect(chapters[1]?.title).toBe("第二章：雨夜");
      expect(chapters[2]?.title).toBe("第十章：终章");

      vi.unstubAllGlobals();
    });
  });

  describe("getChapterContent", () => {
    it("extracts content from best element and cleans blocked phrases", async () => {
      const html = `
        <html>
          <body>
            <div id="content">
              <p>第一章正文。</p>
              <p>广告：请加入书签，最新网址！</p>
              <p>这里没有AI味。</p>
            </div>
            <script>console.log('unwanted');</script>
          </body>
        </html>
      `;

      vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));

      const content = await crawler.getChapterContent("zxtyz", "https://www.zxtyz.com/book/123/1.html");
      expect(content).toContain("第一章正文。");
      expect(content).toContain("这里没有AI味。");
      expect(content).not.toContain("广告：");

      vi.unstubAllGlobals();
    });
  });

  describe("crawl", () => {
    it("downloads chapters from a direct custom URL", async () => {
      const indexHtml = `
        <html>
          <body>
            <a href="https://www.zxtyz.com/book/123/1.html">第一章：飞仙</a>
            <a href="https://www.zxtyz.com/book/123/2.html">第二章：凡尘</a>
          </body>
        </html>
      `;
      const chapter1Html = `<html><body><div id="content">第一章内容。</div></body></html>`;
      const chapter2Html = `<html><body><div id="content">第二章内容。</div></body></html>`;

      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.endsWith("/book/123/") || url.endsWith("/book/123")) {
          return new Response(indexHtml, { status: 200 });
        }
        if (url.endsWith("1.html")) {
          return new Response(chapter1Html, { status: 200 });
        }
        if (url.endsWith("2.html")) {
          return new Response(chapter2Html, { status: 200 });
        }
        return new Response("", { status: 404 });
      }));

      const req: NovelCrawlRequest = {
        query: "https://www.zxtyz.com/book/123/",
        source: "custom",
        start_chapter: 1,
        max_chapters: 2,
        min_chars: 0
      };

      const novel = await crawler.crawl(req);
      expect(novel.title).toBe("123");
      expect(novel.source).toBe("自定义来源");
      expect(novel.chapters.length).toBe(2);
      expect(novel.chapters[0]?.title).toBe("第一章：飞仙");
      expect(novel.chapters[0]?.content).toBe("第一章内容。");

      vi.unstubAllGlobals();
    });

    it("imports plain txt files and keeps crawling until the minimum character target", async () => {
      const txt = [
        "第一章 风起",
        "甲".repeat(24),
        "第二章 雨落",
        "乙".repeat(24),
        "第三章 收束",
        "丙".repeat(24)
      ].join("\n");

      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url === "https://example.com/book.txt") {
          return new Response(txt, {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
        return new Response("", { status: 404 });
      }));

      const novel = await crawler.crawl({
        query: "https://example.com/book.txt",
        source: "custom",
        start_chapter: 1,
        max_chapters: 1,
        min_chars: 40
      } as NovelCrawlRequest);

      expect(novel.source).toBe("自定义来源");
      expect(novel.chapters.map((chapter) => chapter.title)).toEqual(["第一章 风起", "第二章 雨落"]);
      expect(novel.toText()).toContain("乙".repeat(24));
      expect(novel.toText()).not.toContain("丙".repeat(24));

      vi.unstubAllGlobals();
    });

    it("imports all available txt content when the novel is shorter than the minimum target", async () => {
      const txt = [
        "第一章 短篇",
        "甲".repeat(12),
        "第二章 终章",
        "乙".repeat(12)
      ].join("\n");

      vi.stubGlobal("fetch", vi.fn(async () => new Response(txt, { status: 200 })));

      const novel = await crawler.crawl({
        query: "https://example.com/short.txt",
        source: "custom",
        start_chapter: 1,
        max_chapters: 1,
        min_chars: 1000
      } as NovelCrawlRequest);

      expect(novel.chapters).toHaveLength(2);
      expect(novel.toText()).toContain("乙".repeat(12));

      vi.unstubAllGlobals();
    });

    it("auto-detects shuhaige directory URLs and downloads chapters", async () => {
      const indexHtml = `
        <html>
          <body>
            <a href="/335652/129498252.html">第一章 旧雨</a>
            <a href="/335652/129498253.html">第二章 新潮</a>
          </body>
        </html>
      `;
      const chapterHtml = `<html><body><div class="content">这是一段足够长的章节正文，用于模拟书海阁移动站的内容区域。人物走进雨里，灯火在街边慢慢散开，故事从这里开始。</div></body></html>`;

      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url === "https://m.shuhaige.net/335652/") {
          return new Response(indexHtml, { status: 200 });
        }
        if (url.includes("/335652/12949825")) {
          return new Response(chapterHtml, { status: 200 });
        }
        return new Response("", { status: 404 });
      }));

      const novel = await crawler.crawl({
        query: "https://m.shuhaige.net/335652/",
        source: "auto",
        start_chapter: 1,
        max_chapters: 2,
        min_chars: 0
      });

      expect(novel.source).toBe("书海阁");
      expect(novel.source_url).toBe("https://m.shuhaige.net/335652/");
      expect(novel.chapters.length).toBe(2);

      vi.unstubAllGlobals();
    });

    it("normalizes novel543 root URLs to the directory page", async () => {
      const indexHtml = `
        <html>
          <body>
            <a href="/1206606479/8096_1.html">第一章 开局</a>
          </body>
        </html>
      `;
      const chapterHtml = `<html><body><div class="content">这是一段足够长的章节正文，用于模拟 Novel543 的正文区域。主角停在门口，听见城里的钟声，新的故事由此展开。</div></body></html>`;
      const fetchMock = vi.fn(async (url: string) => {
        if (url === "https://www.novel543.com/1206606479/dir") {
          return new Response(indexHtml, { status: 200 });
        }
        if (url.endsWith("/1206606479/8096_1.html")) {
          return new Response(chapterHtml, { status: 200 });
        }
        return new Response("", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const novel = await crawler.crawl({
        query: "https://www.novel543.com/1206606479/",
        source: "auto",
        start_chapter: 1,
        max_chapters: 1,
        min_chars: 0
      });

      expect(fetchMock).toHaveBeenCalledWith("https://www.novel543.com/1206606479/dir", expect.any(Object));
      expect(novel.source).toBe("Novel543");
      expect(novel.source_url).toBe("https://www.novel543.com/1206606479/dir");

      vi.unstubAllGlobals();
    });

    it("uses Bing resolver hits for book-name crawl without legacy source fallback", async () => {
      const resolver = vi.fn(async () => [
        { title: "示例书", url: "https://not-allowed.example/book/1" },
        { title: "示例书", url: "https://www.novel543.com/1206606479/" }
      ]);
      const crawlerWithResolver = new NovelCrawlerService({ resolver });
      const indexHtml = `<html><body><a href="/1206606479/8096_1.html">第一章 开局</a></body></html>`;
      const chapterHtml = `<html><body><div class="content">这是一段足够长的章节正文，用于模拟通过 Bing 定位 Novel543 后抓取成功。场景、人物和行动都在这里展开。</div></body></html>`;

      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url === "https://www.novel543.com/1206606479/dir") {
          return new Response(indexHtml, { status: 200 });
        }
        if (url.endsWith("/1206606479/8096_1.html")) {
          return new Response(chapterHtml, { status: 200 });
        }
        return new Response("", { status: 404 });
      }));

      const novel = await crawlerWithResolver.crawl({
        query: "示例书",
        source: "bing",
        start_chapter: 1,
        max_chapters: 1,
        min_chars: 0
      });

      expect(resolver).toHaveBeenCalledWith("示例书", { source: "bing" });
      expect(novel.source).toBe("Novel543");
      expect(novel.source_url).toBe("https://www.novel543.com/1206606479/dir");

      vi.unstubAllGlobals();
    });

    it("reports Bing resolver failure clearly when there is no directory hit", async () => {
      const crawlerWithResolver = new NovelCrawlerService({ resolver: async () => [] });
      await expect(
        crawlerWithResolver.crawl({
          query: "不存在的书",
          source: "bing",
          start_chapter: 1,
          max_chapters: 1,
          min_chars: 0
        })
      ).rejects.toThrow("Bing 未定位到可用目录 URL");
    });
  });
});
