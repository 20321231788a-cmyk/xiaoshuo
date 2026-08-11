import type { OpenDocumentTab } from "../hooks/useWorkbenchController.js";

export function markDocumentStale(tabs: OpenDocumentTab[], path: string): OpenDocumentTab[] {
  return tabs.map((item) => (item.path === path ? { ...item, stale: true } : item));
}

export function applyDocumentContent(
  tabs: OpenDocumentTab[],
  path: string,
  next: {
    content: string;
    updatedAt: string;
    updatedAtMs?: number;
  }
): OpenDocumentTab[] {
  return tabs.map((item) =>
    item.path === path
      ? {
          ...item,
          content: next.content,
          updatedAt: next.updatedAt,
          updatedAtMs: next.updatedAtMs,
          chars: next.content.length,
          dirty: false,
          saving: false,
          stale: false
        }
      : item
  );
}
