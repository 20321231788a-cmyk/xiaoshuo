import { describe, expect, it } from "vitest";
import type { TreeNode } from "@xiaoshuo/shared";
import { childProjectPath, normalizeNewProjectFileName, parentDirectoryPath, treePathExists } from "./projectTreeActions.js";

describe("projectTreeActions", () => {
  it("normalizes new project file names", () => {
    expect(normalizeNewProjectFileName("第一章")).toBe("第一章.txt");
    expect(normalizeNewProjectFileName("设定.md")).toBe("设定.md");
    expect(() => normalizeNewProjectFileName("bad/name.txt")).toThrow("文件名不能包含");
    expect(() => normalizeNewProjectFileName("data.json")).toThrow("只支持 .txt 或 .md");
  });

  it("builds sibling and child project paths", () => {
    expect(parentDirectoryPath("02_正文/第一章.txt")).toBe("02_正文");
    expect(childProjectPath("02_正文", "第二章.txt")).toBe("02_正文/第二章.txt");
    expect(childProjectPath("", "README.md")).toBe("README.md");
  });

  it("checks existing tree paths recursively", () => {
    const tree: TreeNode[] = [
      makeNode({
        path: "02_正文",
        name: "02_正文",
        kind: "directory",
        children: [makeNode({ path: "02_正文/第一章.txt", name: "第一章.txt", kind: "file" })]
      })
    ];
    expect(treePathExists(tree, "02_正文/第一章.txt")).toBe(true);
    expect(treePathExists(tree, "02_正文/第二章.txt")).toBe(false);
  });
});

function makeNode(input: Pick<TreeNode, "name" | "path" | "kind"> & { children?: TreeNode[] }): TreeNode {
  return {
    ...input,
    size: 0,
    updated_at: "",
    children: input.children || []
  };
}
