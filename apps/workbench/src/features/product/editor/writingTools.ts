export type WritingMark = {
  label: string;
  value: string;
  preview: string;
  close?: string;
};

export type WritingMarkResult = {
  content: string;
  selectionStart: number;
  selectionEnd: number;
};

export const writingMarks: WritingMark[] = [
  { label: "逗号", value: "，", preview: "，" },
  { label: "句号", value: "。", preview: "。" },
  { label: "分号", value: "；", preview: "；" },
  { label: "冒号", value: "：", preview: "：" },
  { label: "问号", value: "？", preview: "？" },
  { label: "感叹号", value: "！", preview: "！" },
  { label: "顿号", value: "、", preview: "、" },
  { label: "省略号", value: "……", preview: "……" },
  { label: "破折号", value: "——", preview: "——" },
  { label: "中文双引号", value: "“", close: "”", preview: "“”" },
  { label: "中文单引号", value: "‘", close: "’", preview: "‘’" },
  { label: "书名号", value: "《", close: "》", preview: "《》" },
  { label: "圆括号", value: "（", close: "）", preview: "（）" },
  { label: "方括号", value: "【", close: "】", preview: "【】" },
  { label: "直角引号", value: "「", close: "」", preview: "「」" },
  { label: "双直角引号", value: "『", close: "』", preview: "『』" }
];

export function applyWritingMark(content: string, start: number, end: number, mark: WritingMark): WritingMarkResult {
  const safeStart = Math.max(0, Math.min(start, content.length));
  const safeEnd = Math.max(safeStart, Math.min(end, content.length));
  const selected = content.slice(safeStart, safeEnd);
  const insertion = mark.close ? `${mark.value}${selected}${mark.close}` : mark.value;
  const nextContent = `${content.slice(0, safeStart)}${insertion}${content.slice(safeEnd)}`;
  if (mark.close && !selected) {
    const cursor = safeStart + mark.value.length;
    return { content: nextContent, selectionStart: cursor, selectionEnd: cursor };
  }
  const cursor = safeStart + insertion.length;
  return { content: nextContent, selectionStart: cursor, selectionEnd: cursor };
}

export function countCharacters(value: string): number {
  return Array.from(value).length;
}
