import { describe, expect, it } from "vitest";
import { parseRichText, previewText } from "./richText.js";

describe("rich text helpers", () => {
  it("parses headings, paragraphs, lists, and fenced code", () => {
    const blocks = parseRichText(`# 标题

第一段
第二行

- 人物 A
- 人物 B

\`\`\`txt
正文片段
\`\`\``);

    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "标题" });
    expect(blocks[1]).toEqual({ type: "paragraph", lines: ["第一段", "第二行"] });
    expect(blocks[2]).toEqual({ type: "list", ordered: false, items: ["人物 A", "人物 B"] });
    expect(blocks[3]).toEqual({ type: "code", language: "txt", code: "正文片段" });
  });

  it("parses ordered lists", () => {
    expect(parseRichText("1. 起\n2. 承")[0]).toEqual({ type: "list", ordered: true, items: ["起", "承"] });
  });

  it("truncates long previews without changing short text", () => {
    expect(previewText("短内容", 10)).toBe("短内容");
    expect(previewText("abcdefghijkl", 5)).toContain("预览已截断");
  });
});
