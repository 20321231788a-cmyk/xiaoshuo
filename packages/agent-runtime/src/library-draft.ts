import { ProjectLibraryService, type ProjectLibraryDraft } from "@xiaoshuo/document-service";
import type { ProjectLibraryDomain, ProjectLibraryRecord } from "@xiaoshuo/shared";
import { createHash } from "node:crypto";
import { prepareSectionedGeneratedSave, type SectionedGeneratedSkillId } from "./sectioned-generated-save.js";

const LORE_KIND_BY_SECTION = {
  人物设定: "character",
  体系设定: "world_rule",
  地图设定: "location",
  道具设定: "item"
} as const;

export async function createGeneratedLibraryDraft(input: {
  projectRoot: string;
  cacheId: string;
  skillId: SectionedGeneratedSkillId;
  result: string;
  mode: "replace" | "append";
  source: string;
  groupId?: string;
  commitMode?: "replace" | "merge";
  baseRevision?: number;
  targetPaths?: string[];
  conversationId?: string;
  messageId?: string;
  runId?: string;
}): Promise<ProjectLibraryDraft | null> {
  const records = recordsFromGeneratedSections(input.skillId, input.result, input.mode);
  if (!records.length) return null;
  const domain = domainForSkill(input.skillId);
  const draftId = `generated-${createHash("sha256").update(`${input.cacheId}:${input.skillId}`).digest("hex").slice(0, 32)}`;
  return new ProjectLibraryService({ projectRoot: input.projectRoot }).createDraft({
    draftId,
    domain,
    records,
    source: input.source,
    group_id: input.groupId,
    // Standalone extraction drafts retain the historic merge-on-confirm behavior.
    // Compound workflows explicitly persist their replacement/merge intent.
    commit_mode: input.groupId ? (input.commitMode || (input.mode === "replace" ? "replace" : "merge")) : undefined,
    base_revision: input.baseRevision,
    target_paths: input.targetPaths,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    run_id: input.runId
  });
}

export function recordsFromGeneratedSections(
  skillId: SectionedGeneratedSkillId,
  result: string,
  mode: "replace" | "append"
): ProjectLibraryRecord[] {
  const prepared = prepareSectionedGeneratedSave({
    skillId,
    result,
    mode,
    summaryPrefix: "AI 生成资料草稿"
  });
  const now = new Date().toISOString();
  const records: ProjectLibraryRecord[] = [];
  for (const section of prepared) {
    if (skillId === "lore_extract") {
      records.push(...loreRecords(section.title, section.content, now, records.length));
    } else if (skillId === "style_extract") {
      records.push(...styleRecords(section.title, section.content, now, records.length));
    } else {
      records.push(...genreRecords(section.title, section.content, now, records.length));
    }
  }
  return records;
}

function domainForSkill(skillId: SectionedGeneratedSkillId): ProjectLibraryDomain {
  if (skillId === "lore_extract") return "lore";
  return skillId === "style_extract" ? "style" : "genre";
}

function recordBase(name: string, summary: string, now: string, order: number) {
  return {
    id: `draft-${createHash("sha256").update(`${now}:${order}:${name}:${summary}`).digest("hex").slice(0, 24)}`,
    name: safeName(name, "未命名资料"),
    summary: summary.trim(),
    tags: [],
    order,
    status: "active" as const,
    origin: "agent_draft" as const,
    created_at: now,
    updated_at: now,
    needs_review: true,
    notes: "由 AI 生成，需在资料库中确认后才会写入项目设定。"
  };
}

function loreRecords(title: string, content: string, now: string, startOrder: number): ProjectLibraryRecord[] {
  const kind = LORE_KIND_BY_SECTION[title as keyof typeof LORE_KIND_BY_SECTION];
  if (!kind) return [];
  return namedBlocks(content).map(({ name, body }, index) => ({
    ...recordBase(name, body, now, startOrder + index),
    kind,
    role: "",
    aliases: [],
    age: "",
    identity: "",
    goal: "",
    fear: "",
    traits: [],
    appearance: "",
    speech_style: "",
    constraints: []
  }));
}

function styleRecords(title: string, content: string, now: string, startOrder: number): ProjectLibraryRecord[] {
  if (title === "写作风格") {
    const [name, description] = titledContent(content, "AI 生成写作风格");
    return [{
      ...recordBase(name, description, now, startOrder),
      kind: "style_profile",
      narrative_pov: "",
      description,
      active: true
    }];
  }
  if (title === "风格示例") {
    return numberedBlocks(content).map((body, index) => ({
      ...recordBase(`风格示例 ${index + 1}`, body, now, startOrder + index),
      kind: "style_example",
      before: "",
      after: body,
      explanation: "AI 生成示例，确认后可继续补充原句与说明。",
      source_ref: ""
    }));
  }
  return [{
    ...recordBase("AI 生成参考素材", content, now, startOrder),
    kind: "style_material",
    content
  }];
}

function genreRecords(title: string, content: string, now: string, startOrder: number): ProjectLibraryRecord[] {
  if (title === "题材规则") {
    return namedBlocks(content).map(({ name, body }, index) => ({
      ...recordBase(name, body, now, startOrder + index),
      kind: "genre_rule",
      category: "custom",
      instruction: body,
      severity: "hard",
      enabled: true
    }));
  }
  if (title === "题材素材") {
    return [{
      ...recordBase("AI 生成题材素材", content, now, startOrder),
      kind: "genre_material",
      content
    }];
  }
  if (title === "战斗模板") {
    return numberedBlocks(content).map((body, index) => ({
      ...recordBase(`冲突模板 ${index + 1}`, body, now, startOrder + index),
      kind: "conflict_template",
      setup: body,
      pressure: "",
      reversal: "",
      resolution: ""
    }));
  }
  return numberedBlocks(content).map((name, index) => ({
    ...recordBase(name, "", now, startOrder + index),
    kind: "banned_expression",
    replacement: "",
    reason: "AI 生成禁用表达，确认后生效。"
  }));
}

function namedBlocks(content: string): Array<{ name: string; body: string }> {
  const text = String(content || "").trim();
  if (!text) return [];
  const blocks: Array<{ name: string; body: string }> = [];
  const heading = /^#{2,6}\s+(.+)$/gm;
  const matches = [...text.matchAll(heading)];
  if (matches.length) {
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const end = matches[index + 1]?.index ?? text.length;
      blocks.push({ name: cleanLabel(match[1] || ""), body: text.slice((match.index || 0) + match[0].length, end).trim() });
    }
  } else {
    for (const block of text.split(/\n{2,}/)) {
      const clean = block.trim().replace(/^[-*]\s*/, "");
      if (!clean) continue;
      const match = /^([^：:\n]{1,80})[：:]\s*([\s\S]*)$/.exec(clean);
      blocks.push(match ? { name: cleanLabel(match[1] || ""), body: (match[2] || "").trim() } : { name: cleanLabel(clean.slice(0, 40)), body: clean });
    }
  }
  return blocks.filter((item) => item.name).map((item) => ({ ...item, body: item.body || item.name }));
}

function numberedBlocks(content: string): string[] {
  const blocks = String(content || "").split(/\n{2,}|\r?\n(?=[-*•]\s*|\d+[.、]\s*)/);
  return blocks.map((item) => item.trim().replace(/^(?:[-*•]|\d+[.、])\s*/, "")).filter(Boolean);
}

function titledContent(content: string, fallbackName: string): [string, string] {
  const firstLine = String(content || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (firstLine.length > 2 && firstLine.length <= 80 && !/[。；;，,]$/.test(firstLine)) {
    return [cleanLabel(firstLine), String(content).slice(String(content).indexOf(firstLine) + firstLine.length).trim() || firstLine];
  }
  return [fallbackName, String(content || "").trim()];
}

function cleanLabel(value: string): string {
  return safeName(value.replace(/[【】#*_`]/g, "").trim(), "未命名资料");
}

function safeName(value: string, fallback: string): string {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 160);
}
