import { describe, expect, it } from "vitest";
import type { TreeNode } from "@xiaoshuo/shared";
import { findStarterDocumentPath } from "./projectWorkspace.js";

describe("findStarterDocumentPath", () => {
  it("prefers the latest numbered body chapter before outlines", () => {
    const tree = makeTree([
      "00_设定集/风格库/写作风格.txt",
      "01_大纲/章纲.txt",
      "01_大纲/大纲.txt",
      "02_正文/第001章.txt",
      "02_正文/第012章.txt"
    ]);

    expect(findStarterDocumentPath(tree)).toBe("02_正文/第012章.txt");
  });

  it("prefers the last active document when it still exists", () => {
    const tree = makeTree(["01_大纲/大纲.txt", "02_正文/第001章.txt", "02_正文/第012章.txt"]);

    expect(findStarterDocumentPath(tree, { lastActivePath: "01_大纲/大纲.txt" })).toBe("01_大纲/大纲.txt");
  });

  it("falls back to the first useful text document when starter files are missing", () => {
    const tree = makeTree(["03_资料/世界观.txt", "03_资料/人物.md"]);

    expect(findStarterDocumentPath(tree)).toBe("03_资料/世界观.txt");
  });
});

function makeTree(paths: string[]): TreeNode[] {
  type MutableNode = TreeNode & { children: MutableNode[] };
  const root: MutableNode[] = [];

  for (const path of paths) {
    const parts = path.split("/");
    let cursor = root;
    let currentPath = "";

    for (const [index, part] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      let node = cursor.find((item) => item.name === part);

      if (!node) {
        node = {
          path: currentPath,
          name: part,
          kind: isFile ? "file" : "directory",
          size: 0,
          updated_at: "2026-05-28T00:00:00",
          children: []
        };
        cursor.push(node);
      }

      cursor = node.children;
    }
  }

  return root;
}
