export function buildConsistencyCheckPrompt(input: {
  chapterOutline: string;
  continuityContext: string;
  recentText: string;
  draftText: string;
}): string {
  return [
    "请检查正文是否违背章纲、人物设定、体系设定、地图设定、道具设定、风格库、题材库和上一章承接。",
    '输出 JSON：{"score": 0-100, "risks": ["问题"], "reason": "简短说明"}。',
    "低于 80 分代表必须回炉。",
    "",
    `【章纲】\n${clipForConsistency(input.chapterOutline, 5000)}`,
    "",
    `【连续性上下文】\n${clipForConsistency(input.continuityContext, 14000)}`,
    "",
    `【最近正文】\n${clipForConsistency(input.recentText, 8000)}`,
    "",
    `【待审查正文】\n${clipForConsistency(input.draftText, 18000)}`
  ].join("\n");
}

export function parseConsistencyCheckResult(
  raw: unknown,
  modelLine: "secondary" | "primary-fallback"
): { score: number; risks: string[]; reason: string; model_line: "secondary" | "primary-fallback" } {
  const rawText = String(raw || "");
  const parsed = safeJsonObject(rawText);
  return {
    score: clampScore(Number(parsed.score || 0)),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((item) => String(item)).slice(0, 12) : [],
    reason: String(parsed.reason || rawText.slice(0, 1000)),
    model_line: modelLine
  };
}

export function clipForConsistency(text: string, limit: number): string {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return normalized.slice(0, limit).trimEnd();
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(value)));
}
