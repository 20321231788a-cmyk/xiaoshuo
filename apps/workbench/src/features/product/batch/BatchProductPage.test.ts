import type { TreeNode } from "@xiaoshuo/shared";
import { describe, expect, it } from "vitest";
import { buildBatchChapterRows } from "./BatchProductPage.js";

describe("batch chapter plan", () => {
  it("derives titles and outline availability from the real project tree", () => {
    const tree = [
      { kind: "directory", name: "01_大纲", path: "01_大纲", children: [
        { kind: "file", name: "第1章 相遇.md", path: "01_大纲/第1章 相遇.md" }
      ] },
      { kind: "directory", name: "02_正文", path: "02_正文", children: [
        { kind: "file", name: "第1章 相遇.txt", path: "02_正文/第1章 相遇.txt" },
        { kind: "file", name: "第2章 离城.txt", path: "02_正文/第2章 离城.txt" }
      ] }
    ] as TreeNode[];

    expect(buildBatchChapterRows(tree, 1, 2)).toEqual([
      { ch: 1, title: "相遇", status: "章纲可用" },
      { ch: 2, title: "离城", status: "未找到章纲" }
    ]);
  });
});
