export type RichTextBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; code: string };

export function parseRichText(input: string): RichTextBlock[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const blocks: RichTextBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let codeLanguage = "";
  let codeLines: string[] | null = null;

  function flushParagraph() {
    const next = paragraph.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    if (next.length) {
      blocks.push({ type: "paragraph", lines: next });
    }
    paragraph = [];
  }

  function flushList() {
    if (listItems.length) {
      blocks.push({ type: "list", ordered: listOrdered, items: listItems });
    }
    listItems = [];
    listOrdered = false;
  }

  for (const line of lines) {
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      if (codeLines !== null) {
        blocks.push({ type: "code", language: codeLanguage, code: codeLines.join("\n") });
        codeLines = null;
        codeLanguage = "";
      } else {
        flushParagraph();
        flushList();
        codeLanguage = fence[1] || "";
        codeLines = [];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const marker = heading[1] || "#";
      const text = heading[2] || "";
      blocks.push({ type: "heading", level: marker.length as 1 | 2 | 3, text: text.trim() });
      continue;
    }

    const bullet = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      const ordered = Boolean(bullet[1]);
      if (listItems.length && listOrdered !== ordered) {
        flushList();
      }
      listOrdered = ordered;
      listItems.push((bullet[2] || "").trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (codeLines !== null) {
    blocks.push({ type: "code", language: codeLanguage, code: codeLines.join("\n") });
  }
  flushParagraph();
  flushList();

  return blocks;
}

export function previewText(input: string, maxChars = 1800): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n...（预览已截断，完整内容仍会按原文写入）`;
}
