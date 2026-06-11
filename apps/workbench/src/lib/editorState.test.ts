import { describe, expect, it } from "vitest";
import type { OpenDocumentTab } from "../hooks/useWorkbenchController.js";
import { applyDocumentContent, markDocumentStale } from "./editorState.js";

describe("editor state helpers", () => {
  it("marks a tab as stale without mutating unrelated tabs", () => {
    const tabs = makeTabs();
    const next = markDocumentStale(tabs, "01_大纲/大纲.txt");

    expect(next[0]?.stale).toBe(true);
    expect(next[1]?.stale).toBe(false);
  });

  it("applies fresh content and clears dirty/stale flags", () => {
    const tabs = makeTabs();
    const next = applyDocumentContent(tabs, "01_大纲/大纲.txt", {
      content: "新的内容",
      updatedAt: "2026-05-28 22:10:00"
    });

    expect(next[0]).toMatchObject({
      content: "新的内容",
      updatedAt: "2026-05-28 22:10:00",
      chars: 4,
      dirty: false,
      stale: false,
      saving: false
    });
  });
});

function makeTabs(): OpenDocumentTab[] {
  return [
    {
      path: "01_大纲/大纲.txt",
      title: "大纲.txt",
      content: "旧内容",
      updatedAt: "2026-05-28 21:00:00",
      chars: 3,
      dirty: true,
      saving: false,
      stale: false
    },
    {
      path: "02_正文/正文.txt",
      title: "正文.txt",
      content: "正文",
      updatedAt: "2026-05-28 21:00:00",
      chars: 2,
      dirty: false,
      saving: false,
      stale: false
    }
  ];
}
