import { describe, expect, it } from "vitest";
import { applyWritingMark, writingMarks } from "./writingTools.js";

describe("editor writing marks", () => {
  it("exposes the complete 16-item Chinese punctuation toolbar", () => {
    expect(writingMarks).toHaveLength(16);
    expect(writingMarks.map((mark) => mark.preview).join(" ")).toBe("， 。 ； ： ？ ！ 、 …… —— “” ‘’ 《》 （） 【】 「」 『』");
  });

  it("inserts a single mark at the cursor", () => {
    expect(applyWritingMark("甲乙", 1, 1, writingMarks[0]!)).toEqual({
      content: "甲，乙",
      selectionStart: 2,
      selectionEnd: 2
    });
  });

  it("places the cursor inside an empty pair", () => {
    const quote = writingMarks.find((mark) => mark.label === "中文双引号")!;
    expect(applyWritingMark("他说", 2, 2, quote)).toEqual({
      content: "他说“”",
      selectionStart: 3,
      selectionEnd: 3
    });
  });

  it("wraps the current selection with paired punctuation", () => {
    const title = writingMarks.find((mark) => mark.label === "书名号")!;
    expect(applyWritingMark("阅读长夜", 2, 4, title)).toEqual({
      content: "阅读《长夜》",
      selectionStart: 6,
      selectionEnd: 6
    });
  });
});
