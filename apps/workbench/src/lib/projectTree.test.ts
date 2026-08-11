import { describe, expect, it } from "vitest";
import type { TreeNode } from "@xiaoshuo/shared";
import { filterProjectTree } from "./projectTree.js";

describe("project tree helpers", () => {
  it("returns the original tree when the query is empty", () => {
    const tree = makeTree();
    expect(filterProjectTree(tree, "")).toBe(tree);
  });

  it("keeps parent directories for matched files", () => {
    const filtered = filterProjectTree(makeTree(), "第047章");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("02_正文");
    expect(filtered[0]?.children[0]?.name).toBe("第047章.txt");
  });

  it("matches paths case-insensitively", () => {
    const filtered = filterProjectTree(makeTree(), "WORLD");

    expect(filtered[0]?.name).toBe("03_设定");
    expect(filtered[0]?.children[0]?.path).toBe("03_设定/world.txt");
  });
});

function makeTree(): TreeNode[] {
  return [
    makeNode({
      name: "02_正文",
      path: "02_正文",
      kind: "directory",
      children: [
        makeNode({ name: "第001章.txt", path: "02_正文/第001章.txt", kind: "file" }),
        makeNode({ name: "第047章.txt", path: "02_正文/第047章.txt", kind: "file" })
      ]
    }),
    makeNode({
      name: "03_设定",
      path: "03_设定",
      kind: "directory",
      children: [makeNode({ name: "world.txt", path: "03_设定/world.txt", kind: "file" })]
    })
  ];
}

function makeNode(input: Pick<TreeNode, "name" | "path" | "kind"> & { children?: TreeNode[] }): TreeNode {
  return {
    size: 0,
    updated_at: "2026-06-07 14:00:00",
    children: [],
    ...input
  };
}
