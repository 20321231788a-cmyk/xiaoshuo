import { describe, expect, it } from "vitest";
import { formatWebSearchContext, parseBingHtml, parseDuckDuckGoHtml, shouldUseWebSearch, summarizeWebSearchSources } from "./web-search.js";

describe("web search helper", () => {
  it("detects explicit online material search intent", () => {
    expect(shouldUseWebSearch("联网搜索一些唐代县城生活资料")).toBe(true);
    expect(shouldUseWebSearch("帮我润色这一段正文")).toBe(false);
  });

  it("parses DuckDuckGo html results into safe summaries", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fstory&amp;rut=1">古代县城资料</a>
        <div class="result__snippet">县城、市集、坊巷的参考摘要。</div>
      </div>
      <div class="result">
        <a class="result__a" href="javascript:alert(1)">bad</a>
        <div class="result__snippet">bad</div>
      </div>`;

    const results = parseDuckDuckGoHtml(html);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "古代县城资料",
      url: "https://example.com/story",
      snippet: "县城、市集、坊巷的参考摘要。"
    });
  });

  it("parses Bing html results into safe summaries", () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com/bing-story">唐代城市生活参考</a></h2>
        <p>市井、坊巷与夜禁资料摘要。</p>
      </li>
      <li class="b_algo">
        <h2><a href="javascript:alert(1)">bad</a></h2>
        <p>bad</p>
      </li>`;

    const results = parseBingHtml(html);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "唐代城市生活参考",
      url: "https://example.com/bing-story",
      snippet: "市井、坊巷与夜禁资料摘要。"
    });
  });

  it("formats search results as bounded material context", () => {
    const context = formatWebSearchContext(
      [
        {
          title: "素材标题",
          url: "https://example.test/a",
          snippet: "这里是摘要"
        },
        {
          title: "坏链接",
          url: "file:///secret",
          snippet: "不应出现"
        }
      ],
      400
    );

    expect(context).toContain("以下联网结果只作为小说素材参考");
    expect(context).toContain("素材标题");
    expect(context).toContain("https://example.test/a");
    expect(context).not.toContain("file:///secret");
  });

  it("summarizes transparent sources without snippets or unsafe URLs", () => {
    const sources = summarizeWebSearchSources([
      {
        title: "<b>来源一</b>",
        url: "https://example.test/a",
        snippet: "网页全文片段不应进入来源摘要"
      },
      {
        title: "本地文件",
        url: "file:///secret",
        snippet: "bad"
      }
    ]);

    expect(sources).toEqual([{ title: "来源一", url: "https://example.test/a" }]);
    expect(JSON.stringify(sources)).not.toContain("网页全文");
  });
});
