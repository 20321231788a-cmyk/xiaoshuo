import { createHash, randomUUID } from "node:crypto";
import { AGENT_DIR, OUTLINE_DIR } from "@xiaoshuo/project-session";
import {
  storyOutlineNodeSchema,
  storyPlanningBundleSchema,
  storyTimelineEventSchema,
  type StoryOutlineNode,
  type StoryPlanningBundle,
  type StoryTimelineEvent
} from "@xiaoshuo/shared";
import { DocumentService, type DocumentTimelineSession } from "./service.js";

const MASTER_PATH = `${AGENT_DIR}/story-planning.jsonl`;
const OUTLINE_PATH = `${OUTLINE_DIR}/故事大纲.md`;
const TIMELINE_PATH = `${OUTLINE_DIR}/故事时间线.md`;
const projectionPaths = [OUTLINE_PATH, TIMELINE_PATH];

type Meta = {
  record_type: "meta";
  schema_version: 1;
  revision: number;
  updated_at: string;
  projection_hashes: Record<string, string>;
};

export class StoryPlanningConflictError extends Error {
  readonly code: "STORY_PLANNING_REVISION_CONFLICT" | "STORY_PLANNING_PROJECTION_DRIFT";
  constructor(code: StoryPlanningConflictError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export class StoryPlanningService {
  private readonly documents: DocumentService;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: { projectRoot: string; now?: () => string; idFactory?: () => string }) {
    this.documents = new DocumentService({ projectRoot: options.projectRoot });
    this.now = options.now || (() => new Date().toISOString());
    this.idFactory = options.idFactory || (() => randomUUID().replace(/-/g, ""));
  }

  async get(): Promise<StoryPlanningBundle> {
    const master = await this.readMaster();
    if (!master) {
      const hasLegacy = Boolean((await this.documents.readRawText(OUTLINE_PATH, 2_000_000).catch(() => "")).trim() || (await this.documents.readRawText(TIMELINE_PATH, 2_000_000).catch(() => "")).trim());
      return storyPlanningBundleSchema.parse({ schema_version: 1, revision: 0, updated_at: "", outline: [], timeline: [], projection_paths: projectionPaths, status: hasLegacy ? "migration_required" : "ready" });
    }
    const projections = renderProjections(master.outline, master.timeline);
    return storyPlanningBundleSchema.parse({
      schema_version: 1,
      revision: master.meta.revision,
      updated_at: master.meta.updated_at,
      outline: master.outline,
      timeline: master.timeline,
      projection_paths: projectionPaths,
      status: await this.hasProjectionDrift(master.meta, projections) ? "projection_drift" : "ready"
    });
  }

  async save(input: { baseRevision: number; outline: StoryOutlineNode[]; timeline: StoryTimelineEvent[]; session?: DocumentTimelineSession }): Promise<StoryPlanningBundle> {
    const current = await this.get();
    if (current.revision !== input.baseRevision) {
      throw new StoryPlanningConflictError("STORY_PLANNING_REVISION_CONFLICT", "故事规划已被其他窗口更新，请重新加载后再保存。");
    }
    if (current.status === "projection_drift") {
      throw new StoryPlanningConflictError("STORY_PLANNING_PROJECTION_DRIFT", "大纲或时间线文本已在外部修改，请先迁移或重建投影。");
    }
    const now = this.now();
    const outline = normalizeOutline(input.outline, now);
    const timeline = normalizeTimeline(input.timeline, now);
    const projections = renderProjections(outline, timeline);
    const meta: Meta = {
      record_type: "meta",
      schema_version: 1,
      revision: current.revision + 1,
      updated_at: now,
      projection_hashes: Object.fromEntries(Object.entries(projections).map(([entryPath, content]) => [entryPath, hash(content)]))
    };
    const records = [meta, ...outline.map((item) => ({ record_type: "outline", ...item })), ...timeline.map((item) => ({ record_type: "timeline", ...item }))];
    await this.documents.saveDocumentsAtomically([
      { path: MASTER_PATH, content: `${records.map((item) => JSON.stringify(item)).join("\n")}\n` },
      ...Object.entries(projections).map(([entryPath, content]) => ({ path: entryPath, content }))
    ], { source: "story_planning", summary: "保存故事大纲与时间线", session: input.session });
    return storyPlanningBundleSchema.parse({ schema_version: 1, revision: meta.revision, updated_at: now, outline, timeline, projection_paths: projectionPaths, status: "ready" });
  }

  async migrate(session?: DocumentTimelineSession): Promise<StoryPlanningBundle> {
    const current = await this.get();
    if (current.revision > 0) return current;
    const outlineText = await this.documents.readRawText(OUTLINE_PATH, 2_000_000).catch(() => "");
    const timelineText = await this.documents.readRawText(TIMELINE_PATH, 2_000_000).catch(() => "");
    const now = this.now();
    const outline = outlineText.trim() ? [{ id: this.idFactory(), kind: "main_arc" as const, title: "导入的大纲", summary: outlineText.trim(), order: 0, parent_id: null, chapter_paths: [], entity_ids: [], status: "active" as const, created_at: now, updated_at: now }] : [];
    const timeline = timelineText.trim() ? [{ id: this.idFactory(), title: "导入的故事时间线", summary: timelineText.trim(), story_time: "待整理", sort_key: "0000", order: 0, chapter_paths: [], entity_ids: [], clue_ids: [], status: "planned" as const, created_at: now, updated_at: now }] : [];
    return this.save({ baseRevision: 0, outline, timeline, session });
  }

  private async readMaster(): Promise<{ meta: Meta; outline: StoryOutlineNode[]; timeline: StoryTimelineEvent[] } | null> {
    const raw = await this.documents.readRawText(MASTER_PATH, 5_000_000).catch(() => "");
    if (!raw.trim()) return null;
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    try {
      const first = JSON.parse(lines.shift() || "{}") as Meta;
      if (first.record_type !== "meta" || first.schema_version !== 1 || !Number.isInteger(first.revision)) throw new Error("元数据格式不正确");
      const outline: StoryOutlineNode[] = [];
      const timeline: StoryTimelineEvent[] = [];
      for (const line of lines) {
        const record = JSON.parse(line) as { record_type?: string };
        if (record.record_type === "outline") outline.push(storyOutlineNodeSchema.parse(record));
        if (record.record_type === "timeline") timeline.push(storyTimelineEventSchema.parse(record));
      }
      return { meta: first, outline: normalizeOutline(outline, first.updated_at), timeline: normalizeTimeline(timeline, first.updated_at) };
    } catch (error) {
      throw new Error(`无法读取结构化故事规划：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async hasProjectionDrift(meta: Meta, projections: Record<string, string>): Promise<boolean> {
    for (const entryPath of projectionPaths) {
      const current = await this.documents.readRawText(entryPath, 2_000_000).catch(() => "");
      if ((meta.projection_hashes[entryPath] || hash(projections[entryPath] || "")) !== hash(current)) return true;
    }
    return false;
  }
}

function normalizeOutline(values: StoryOutlineNode[], timestamp: string): StoryOutlineNode[] {
  const ids = new Set<string>();
  return values.map((value, index) => {
    const record = storyOutlineNodeSchema.parse({ ...value, order: Number.isInteger(value.order) ? value.order : index, created_at: value.created_at || timestamp, updated_at: timestamp });
    if (ids.has(record.id)) throw new Error("故事大纲包含重复 ID");
    ids.add(record.id);
    return record;
  }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-CN"));
}

function normalizeTimeline(values: StoryTimelineEvent[], timestamp: string): StoryTimelineEvent[] {
  const ids = new Set<string>();
  return values.map((value, index) => {
    const record = storyTimelineEventSchema.parse({ ...value, order: Number.isInteger(value.order) ? value.order : index, created_at: value.created_at || timestamp, updated_at: timestamp });
    if (ids.has(record.id)) throw new Error("故事时间线包含重复 ID");
    ids.add(record.id);
    return record;
  }).sort((a, b) => a.sort_key.localeCompare(b.sort_key) || a.order - b.order);
}

function renderProjections(outline: StoryOutlineNode[], timeline: StoryTimelineEvent[]): Record<string, string> {
  const byParent = new Map<string | null, StoryOutlineNode[]>();
  for (const item of outline) byParent.set(item.parent_id, [...(byParent.get(item.parent_id) || []), item]);
  const outlineLines = ["# 故事大纲"];
  const renderNode = (item: StoryOutlineNode, level: number) => {
    outlineLines.push("", `${"#".repeat(Math.min(4, level + 1))} ${item.title}`);
    if (item.summary) outlineLines.push(item.summary);
    if (item.chapter_paths.length) outlineLines.push(`- 关联章节：${item.chapter_paths.join("、")}`);
    for (const child of byParent.get(item.id) || []) renderNode(child, level + 1);
  };
  for (const item of byParent.get(null) || []) renderNode(item, 1);
  const timelineLines = ["# 故事时间线"];
  for (const item of timeline) {
    timelineLines.push("", `## ${item.story_time} · ${item.title}`);
    if (item.summary) timelineLines.push(item.summary);
    if (item.chapter_paths.length) timelineLines.push(`- 关联章节：${item.chapter_paths.join("、")}`);
  }
  return { [OUTLINE_PATH]: `${outlineLines.join("\n").trim()}\n`, [TIMELINE_PATH]: `${timelineLines.join("\n").trim()}\n` };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
