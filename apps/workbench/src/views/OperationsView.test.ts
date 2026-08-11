import { describe, expect, it } from "vitest";
import { formatRawJobResult, formatSkillResultData } from "./OperationsView.js";

describe("OperationsView helpers", () => {
  it("formats falsey raw job results", () => {
    expect(formatRawJobResult(false)).toBe("false");
    expect(formatRawJobResult(0)).toBe("0");
    expect(formatRawJobResult("")).toBe("\"\"");
    expect(formatRawJobResult([])).toBe("[]");
  });

  it("truncates very large raw job results", () => {
    const formatted = formatRawJobResult({ text: "x".repeat(40000) });

    expect(formatted.length).toBeLessThan(31000);
    expect(formatted).toContain("已截断");
  });

  it("omits web search source payload from raw skill result fallback", () => {
    const formatted = formatSkillResultData({
      web_search_sources: [
        {
          title: "宋代市井参考",
          url: "https://example.test/song-market",
          snippet: "不应展示"
        }
      ],
      cache_id: "body_1"
    });

    expect(formatted).toContain("body_1");
    expect(formatted).not.toContain("web_search_sources");
    expect(formatted).not.toContain("不应展示");
  });

  it("uses an empty result message when skill data only contains sources", () => {
    expect(
      formatSkillResultData({
        web_search_sources: [{ title: "来源", url: "https://example.test/source" }]
      })
    ).toBe("这次技能运行没有返回额外文本。");
  });
});
