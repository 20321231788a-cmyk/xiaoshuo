import { loadTaskModelConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { StoryPlanningService } from "@xiaoshuo/document-service";
import type { StoryOutlineNode } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import type { StreamingModelClient } from "./stream.js";

export type StoryPlanningGeneratedSkillId = "outline_generate" | "detail_outline_generate" | "chapter_outline_generate";

type GeneratedOutlineDraft = {
  kind: StoryOutlineNode["kind"];
  title: string;
  summary: string;
  parent_title?: string;
  chapter_paths?: string[];
};

type GeneratedStoryPlanningInput = {
  projectRoot: string;
  skillId: StoryPlanningGeneratedSkillId;
  content: string;
  mode: "replace" | "append";
  modelClient?: StreamingModelClient;
  config?: ConfigServiceOptions;
  signal?: AbortSignal;
  forceModelClassification?: boolean;
};

export type GeneratedStoryPlanningCommit = {
  savedPaths: string[];
  revision: number;
  nodes: number;
  classified: number;
};

export function isStoryPlanningGeneratedSkillId(value: string): value is StoryPlanningGeneratedSkillId {
  return value === "outline_generate" || value === "detail_outline_generate" || value === "chapter_outline_generate";
}

/**
 * Turns a saved outline document into the nodes read by the story-outline UI.
 * The source document remains the complete generated text; nodes are compact,
 * separately editable planning records rather than copies of that document.
 */
export async function commitGeneratedStoryPlanning(input: GeneratedStoryPlanningInput): Promise<GeneratedStoryPlanningCommit> {
  const content = String(input.content || "").trim();
  if (!content) {
    throw new Error("故事大纲生成内容为空，不能写入。");
  }

  const planning = new StoryPlanningService({ projectRoot: input.projectRoot });
  let current = await planning.get();
  if (current.status === "migration_required") {
    current = await planning.migrate();
  }
  if (current.status === "projection_drift") {
    throw new Error("故事大纲兼容文本已被外部修改，请先在故事大纲页迁移或重建后再写入。");
  }

  // A retried durable save may arrive after the structured master has already
  // been committed but before its cache metadata was finalized. In that case
  // do not spend another model call; the deterministic splitter is enough to
  // keep the retry idempotent.
  const allowModelClassification = input.forceModelClassification || !(
    input.mode === "replace" && current.outline.some((item) => ownedKindsFor(input.skillId).has(item.kind))
  );
  const drafts = await classifyStoryPlanning(content, input, allowModelClassification);
  if (!drafts.length) {
    throw new Error("无法从已保存的大纲中整理出结构化节点。");
  }

  const ownedKinds = ownedKindsFor(input.skillId);
  const base = input.mode === "replace"
    ? current.outline.filter((item) => !ownedKinds.has(item.kind))
    : [...current.outline];
  const outline = applyDrafts(base, drafts);
  const saved = await planning.save({
    baseRevision: current.revision,
    outline,
    timeline: current.timeline
  });
  return {
    savedPaths: saved.projection_paths,
    revision: saved.revision,
    nodes: outline.length,
    classified: drafts.length
  };
}

/** A body is intentionally represented by one concise factual recap only. */
export async function commitGeneratedBodySummary(input: {
  projectRoot: string;
  content: string;
  chapter: number;
  outputPath: string;
  modelClient?: StreamingModelClient;
  config?: ConfigServiceOptions;
  signal?: AbortSignal;
}): Promise<GeneratedStoryPlanningCommit | null> {
  const content = String(input.content || "").trim();
  if (!content || input.chapter <= 0) {
    return null;
  }
  const planning = new StoryPlanningService({ projectRoot: input.projectRoot });
  let current = await planning.get();
  if (current.status === "migration_required") {
    current = await planning.migrate();
  }
  if (current.status === "projection_drift") {
    return null;
  }
  const bodySummary = await summarizeBody(content, input);
  if (!bodySummary) {
    return null;
  }

  const chapterPattern = new RegExp(`第\\s*0*${input.chapter}\\s*章`);
  const existing = current.outline.find((item) =>
    item.kind === "chapter" && (item.chapter_paths.includes(input.outputPath) || chapterPattern.test(item.title))
  );
  const now = new Date().toISOString();
  const outline = existing
    ? current.outline.map((item) => item.id === existing.id
      ? { ...item, body_summary: bodySummary, chapter_paths: uniqueStrings([...item.chapter_paths, input.outputPath]), updated_at: now }
      : item)
    : [...current.outline, {
      id: randomUUID().replace(/-/g, ""),
      kind: "chapter" as const,
      title: `第${input.chapter}章`,
      summary: "",
      body_summary: bodySummary,
      order: nextOrder(current.outline),
      parent_id: null,
      chapter_paths: [input.outputPath],
      entity_ids: [],
      status: "done" as const,
      created_at: now,
      updated_at: now
    }];
  const saved = await planning.save({ baseRevision: current.revision, outline, timeline: current.timeline });
  return {
    savedPaths: saved.projection_paths,
    revision: saved.revision,
    nodes: outline.length,
    classified: 1
  };
}

async function classifyStoryPlanning(
  content: string,
  input: GeneratedStoryPlanningInput,
  allowModelClassification: boolean
): Promise<GeneratedOutlineDraft[]> {
  const allowed = ownedKindsFor(input.skillId);
  const modelDrafts = allowModelClassification ? await classifyWithModel(content, input, allowed) : [];
  const drafts = modelDrafts.length ? modelDrafts : classifyWithHeadings(content, input.skillId);
  return dedupeDrafts(drafts.filter((item) => allowed.has(item.kind)));
}

async function classifyWithModel(
  content: string,
  input: GeneratedStoryPlanningInput,
  allowedKinds: Set<StoryOutlineNode["kind"]>
): Promise<GeneratedOutlineDraft[]> {
  if (!input.modelClient) {
    return [];
  }
  try {
    const config = await loadTaskModelConfig(input.config);
    if (!config.configured) {
      return [];
    }
    const allowed = [...allowedKinds].join("、");
    const result = await input.modelClient.requestCompletion(
      config,
      [
        {
          role: "system",
          content: "你是小说大纲结构化编辑。只可依据原文拆分，绝不能补写剧情、人物或设定。只输出有效 JSON，不要 Markdown。"
        },
        {
          role: "user",
          content: [
            "把下面已保存的文本整理成可编辑的故事规划节点。每个节点摘要只保留该节点需要的信息，不得复制全文。",
            `允许 kind：${allowed}。`,
            "输出格式：{\"nodes\":[{\"kind\":\"...\",\"title\":\"...\",\"summary\":\"...\",\"parent_title\":\"可选父节点标题\",\"chapter_paths\":[\"可选章节路径\"]}]}。",
            "如果文本没有明确分段，仍输出一个最贴切的节点，摘要不超过 1200 字。",
            "",
            "【已保存文本】",
            content.slice(0, 60_000)
          ].join("\n")
        }
      ],
      0.1,
      { signal: input.signal }
    );
    return parseModelDrafts(result, allowedKinds);
  } catch {
    // The document has already been saved.  A deterministic splitter keeps
    // the planning view usable if classification is temporarily unavailable.
    return [];
  }
}

function parseModelDrafts(value: string, allowed: Set<StoryOutlineNode["kind"]>): GeneratedOutlineDraft[] {
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.search(/[\[{]/);
  if (start < 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw.slice(start)) as { nodes?: unknown } | unknown[];
    const entries = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { nodes?: unknown }).nodes) ? (parsed as { nodes: unknown[] }).nodes : [];
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as Record<string, unknown>;
      const kind = String(item.kind || "") as StoryOutlineNode["kind"];
      const title = cleanTitle(item.title);
      const summary = compactSummary(String(item.summary || ""));
      if (!allowed.has(kind) || !title) return [];
      return [{
        kind,
        title,
        summary,
        parent_title: cleanTitle(item.parent_title),
        chapter_paths: stringList(item.chapter_paths)
      }];
    });
  } catch {
    return [];
  }
}

function classifyWithHeadings(content: string, skillId: StoryPlanningGeneratedSkillId): GeneratedOutlineDraft[] {
  const sections = splitOutlineSections(content);
  const defaultKind = skillId === "outline_generate" ? "main_arc" : skillId === "detail_outline_generate" ? "beat" : "chapter";
  return sections.map((section) => ({
    kind: skillId === "outline_generate" && /(人物|角色|主角|反派).{0,12}(?:线|弧|设定|成长|关系)|(?:人物线|人物弧|角色线|主角线|反派线)/.test(section.title)
      ? "character_arc"
      : defaultKind,
    title: section.title,
    summary: compactSummary(section.summary)
  }));
}

function splitOutlineSections(content: string): Array<{ title: string; summary: string }> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const sourceLine of lines) {
    const line = sourceLine.trim();
    const title = outlineHeading(line);
    if (title) {
      current = { title, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(sourceLine);
    }
  }
  if (!sections.length) {
    const first = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "AI 整理的故事节点";
    return [{ title: cleanTitle(first) || "AI 整理的故事节点", summary: content }];
  }
  return sections.map((item) => ({
    title: item.title,
    summary: item.lines.join("\n").trim() || item.title
  }));
}

function outlineHeading(line: string): string {
  const cleaned = line
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*(?:[-*•]|\d{1,4}[.、])\s+/, "")
    .replace(/^\*{1,2}|\*{1,2}$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 180) return "";
  if (/^#{1,6}\s+/.test(line) || /^\*{1,2}(?:第?[一二三四五六七八九十百千0-9]+[、.：:]|[一二三四五六七八九十]+、)/.test(line)) {
    return cleanTitle(cleaned);
  }
  if (/^(?:第\s*\d+\s*[章节卷]|[一二三四五六七八九十]+、|\d{1,3}[.、])/.test(cleaned)) {
    return cleanTitle(cleaned);
  }
  if (/^(?:核心卖点|主线冲突|人物线|角色线|分卷|世界观|剧情线|章节规划|大纲|细纲|章纲)/.test(cleaned) && cleaned.length <= 100) {
    return cleanTitle(cleaned);
  }
  return "";
}

function applyDrafts(base: StoryOutlineNode[], drafts: GeneratedOutlineDraft[]): StoryOutlineNode[] {
  const outline = [...base];
  const now = new Date().toISOString();
  for (const draft of drafts) {
    const titleKey = normalizeTitle(draft.title);
    const index = outline.findIndex((item) => item.kind === draft.kind && normalizeTitle(item.title) === titleKey);
    const parent = draft.parent_title
      ? outline.find((item) => normalizeTitle(item.title) === normalizeTitle(draft.parent_title || ""))
      : undefined;
    if (index >= 0) {
      const previous = outline[index]!;
      outline[index] = {
        ...previous,
        summary: mergeSummary(previous.summary, draft.summary),
        parent_id: parent?.id || previous.parent_id,
        chapter_paths: uniqueStrings([...previous.chapter_paths, ...(draft.chapter_paths || [])]),
        updated_at: now
      };
      continue;
    }
    outline.push({
      id: randomUUID().replace(/-/g, ""),
      kind: draft.kind,
      title: draft.title,
      summary: draft.summary,
      body_summary: "",
      order: nextOrder(outline),
      parent_id: parent?.id || null,
      chapter_paths: uniqueStrings(draft.chapter_paths || []),
      entity_ids: [],
      status: "planned",
      created_at: now,
      updated_at: now
    });
  }
  return outline;
}

async function summarizeBody(content: string, input: { modelClient?: StreamingModelClient; config?: ConfigServiceOptions; signal?: AbortSignal }): Promise<string> {
  void input;
  // Body text must never trigger detailed setting extraction or an additional
  // model pass. Its contract is intentionally only a factual one-sentence
  // chapter recap.
  return oneSentence(content);
}

function ownedKindsFor(skillId: StoryPlanningGeneratedSkillId): Set<StoryOutlineNode["kind"]> {
  if (skillId === "outline_generate") return new Set(["main_arc", "character_arc", "volume"]);
  return new Set([skillId === "detail_outline_generate" ? "beat" : "chapter"]);
}

function dedupeDrafts(drafts: GeneratedOutlineDraft[]): GeneratedOutlineDraft[] {
  const seen = new Set<string>();
  return drafts.filter((item) => {
    const key = `${item.kind}:${normalizeTitle(item.title)}`;
    if (!item.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanTitle(value: unknown): string {
  return String(value || "")
    .replace(/^\s*(?:#{1,6}|[-*•]|\d+[.、])\s*/, "")
    .replace(/^\*+|\*+$/g, "")
    .trim()
    .slice(0, 180);
}

function compactSummary(value: string): string {
  const compact = String(value || "").replace(/\n{3,}/g, "\n\n").trim();
  return compact.length <= 1_200 ? compact : `${compact.slice(0, 1_197).trimEnd()}…`;
}

function oneSentence(value: string): string {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const sentence = compact.split(/(?<=[。！？!?])/)[0]?.trim() || compact;
  return sentence.slice(0, 280);
}

function mergeSummary(previous: string, next: string): string {
  if (!previous) return next;
  if (!next || previous.includes(next)) return previous;
  return compactSummary(`${previous}\n\n${next}`);
}

function normalizeTitle(value: string): string {
  return String(value || "").replace(/\s+/g, "").replace(/[：:、，,.。]/g, "").toLowerCase();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.map((item) => String(item || "").trim())) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function nextOrder(outline: StoryOutlineNode[]): number {
  return outline.length ? Math.max(...outline.map((item) => item.order)) + 1 : 0;
}
