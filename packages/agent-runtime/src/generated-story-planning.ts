import { StoryPlanningService } from "@xiaoshuo/document-service";
import type { StoryOutlineNode } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";

export type StoryPlanningGeneratedSkillId = "outline_generate" | "detail_outline_generate" | "chapter_outline_generate";

export function isStoryPlanningGeneratedSkillId(value: string): value is StoryPlanningGeneratedSkillId {
  return value === "outline_generate" || value === "detail_outline_generate" || value === "chapter_outline_generate";
}

export async function commitGeneratedStoryPlanning(input: {
  projectRoot: string;
  skillId: StoryPlanningGeneratedSkillId;
  content: string;
  mode: "replace" | "append";
}): Promise<{ savedPaths: string[]; revision: number; nodes: number }> {
  const content = String(input.content || "").trim();
  if (!content) {
    throw new Error("故事大纲生成内容为空，不能写入。" );
  }
  const planning = new StoryPlanningService({ projectRoot: input.projectRoot });
  let current = await planning.get();
  if (current.status === "migration_required") {
    current = await planning.migrate();
  }
  if (current.status === "projection_drift") {
    throw new Error("故事大纲兼容文本已被外部修改，请先在故事大纲页迁移或重建后再写入。" );
  }
  const node = generatedNode(input.skillId, content, input.mode === "replace" ? 0 : nextOrder(current.outline));
  const outline = input.mode === "replace" ? [node] : [...current.outline, node];
  const saved = await planning.save({
    baseRevision: current.revision,
    outline,
    timeline: current.timeline
  });
  return { savedPaths: saved.projection_paths, revision: saved.revision, nodes: outline.length };
}

function generatedNode(skillId: StoryPlanningGeneratedSkillId, content: string, order: number): StoryOutlineNode {
  const now = new Date().toISOString();
  return {
    id: randomUUID().replace(/-/g, ""),
    kind: skillId === "outline_generate" ? "main_arc" : skillId === "detail_outline_generate" ? "beat" : "chapter",
    title: titleFromContent(content, skillId),
    summary: content,
    order,
    parent_id: null,
    chapter_paths: [],
    entity_ids: [],
    status: "planned",
    created_at: now,
    updated_at: now
  };
}

function titleFromContent(content: string, skillId: StoryPlanningGeneratedSkillId): string {
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*•]|\d+[.、])\s*/, "").trim())
    .find(Boolean) || "";
  const label = first.replace(/[：:].*$/, "").trim();
  const fallback = skillId === "outline_generate" ? "AI 生成故事大纲" : skillId === "detail_outline_generate" ? "AI 生成剧情细纲" : "AI 生成章节章纲";
  return (label || fallback).slice(0, 180);
}

function nextOrder(outline: StoryOutlineNode[]): number {
  return outline.length ? Math.max(...outline.map((item) => item.order)) + 1 : 0;
}
