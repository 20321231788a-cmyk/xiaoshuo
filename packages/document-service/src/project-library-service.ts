import {
  projectLibraryBundleSchema,
  projectLibraryRecordSchema,
  type ProjectLibraryBundle,
  type ProjectLibraryDomain,
  type ProjectLibraryRecord,
  type LoreRecord
} from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DIR, GENRE_DIR, SETTINGS_DIR, STYLE_DIR } from "@xiaoshuo/project-session";
import { DocumentService, type DocumentTimelineSession } from "./service.js";

const LIBRARY_DIR = `${AGENT_DIR}/libraries`;
const DRAFT_DIR = `${AGENT_DIR}/library-drafts`;
const nowIso = () => new Date().toISOString();

const masterPaths: Record<ProjectLibraryDomain, string> = {
  lore: `${LIBRARY_DIR}/lore.v1.jsonl`,
  style: `${LIBRARY_DIR}/style.v1.jsonl`,
  genre: `${LIBRARY_DIR}/genre.v1.jsonl`
};

const projectionPaths: Record<ProjectLibraryDomain, string[]> = {
  lore: [
    `${SETTINGS_DIR}/设定集/人物设定.txt`,
    `${SETTINGS_DIR}/设定集/体系设定.txt`,
    `${SETTINGS_DIR}/设定集/地图设定.txt`,
    `${SETTINGS_DIR}/设定集/道具设定.txt`
  ],
  style: [
    `${SETTINGS_DIR}/${STYLE_DIR}/写作风格.txt`,
    `${SETTINGS_DIR}/${STYLE_DIR}/风格示例.txt`,
    `${SETTINGS_DIR}/${STYLE_DIR}/参考素材.txt`
  ],
  genre: [
    `${SETTINGS_DIR}/${GENRE_DIR}/题材规则.txt`,
    `${SETTINGS_DIR}/${GENRE_DIR}/题材素材.txt`,
    `${SETTINGS_DIR}/${GENRE_DIR}/战斗模板.txt`,
    `${SETTINGS_DIR}/${GENRE_DIR}/违禁词.txt`
  ]
};

type LibraryMeta = {
  record_type: "meta";
  schema_version: 1;
  domain: ProjectLibraryDomain;
  revision: number;
  updated_at: string;
  projection_hashes: Record<string, string>;
};

export type ProjectLibraryDraft = {
  draft_id: string;
  domain: ProjectLibraryDomain;
  records: ProjectLibraryRecord[];
  source: string;
  created_at: string;
};

export class ProjectLibraryConflictError extends Error {
  readonly code: string;
  constructor(code: "LIBRARY_REVISION_CONFLICT" | "LIBRARY_PROJECTION_DRIFT", message: string) {
    super(message);
    this.code = code;
  }
}

export class ProjectLibraryCorruptedError extends Error {
  readonly code = "LIBRARY_CORRUPTED";
  constructor(message: string) {
    super(message);
  }
}

export class ProjectLibraryService {
  private readonly documents: DocumentService;
  private readonly projectRoot: string;
  private readonly now: () => string;

  constructor(options: { projectRoot: string; now?: () => string }) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.documents = new DocumentService({ projectRoot: this.projectRoot });
    this.now = options.now || nowIso;
  }

  async get(domain: ProjectLibraryDomain): Promise<ProjectLibraryBundle> {
    const loaded = await this.readMaster(domain);
    if (!loaded) {
      const preview = await this.legacyPreview(domain);
      return projectLibraryBundleSchema.parse({
        schema_version: 1,
        domain,
        revision: 0,
        updated_at: "",
        records: [],
        status: preview.records.length ? "migration_required" : "ready",
        projection_paths: projectionPaths[domain],
        migration_preview: preview.records.length ? preview : undefined
      });
    }

    const drift = await this.hasProjectionDrift(domain, loaded.meta.projection_hashes);
    return projectLibraryBundleSchema.parse({
      schema_version: 1,
      domain,
      revision: loaded.meta.revision,
      updated_at: loaded.meta.updated_at,
      records: loaded.records,
      status: drift ? "projection_drift" : "ready",
      projection_paths: projectionPaths[domain]
    });
  }

  async save(
    domain: ProjectLibraryDomain,
    input: { baseRevision: number; records: ProjectLibraryRecord[]; source?: string; summary?: string; session?: DocumentTimelineSession; allowProjectionDrift?: boolean }
  ): Promise<ProjectLibraryBundle> {
    const loaded = await this.readMaster(domain);
    if (!loaded && input.baseRevision !== 0) {
      throw new ProjectLibraryConflictError("LIBRARY_REVISION_CONFLICT", "资料库已被其他窗口更新，请重新加载后再保存。");
    }
    if (loaded && loaded.meta.revision !== input.baseRevision) {
      throw new ProjectLibraryConflictError("LIBRARY_REVISION_CONFLICT", "资料库已有新版内容，请重新加载后再保存。");
    }
    if (!input.allowProjectionDrift && loaded && await this.hasProjectionDrift(domain, loaded.meta.projection_hashes)) {
      throw new ProjectLibraryConflictError("LIBRARY_PROJECTION_DRIFT", "兼容文本已在外部修改。请先选择重建投影或重新导入。");
    }

    const records = normalizeRecords(domain, input.records, this.now());
    const projections = renderProjections(domain, records);
    const updatedAt = this.now();
    const meta: LibraryMeta = {
      record_type: "meta",
      schema_version: 1,
      domain,
      revision: (loaded?.meta.revision || 0) + 1,
      updated_at: updatedAt,
      projection_hashes: Object.fromEntries(Object.entries(projections).map(([entryPath, content]) => [entryPath, hash(content)]))
    };
    await this.documents.saveDocumentsAtomically([
      { path: masterPaths[domain], content: serializeLibrary(meta, records) },
      ...Object.entries(projections).map(([entryPath, content]) => ({ path: entryPath, content }))
    ], {
      source: input.source || "library_editor",
      summary: input.summary || `保存${libraryLabel(domain)}`,
      session: input.session
    });
    return projectLibraryBundleSchema.parse({
      schema_version: 1,
      domain,
      revision: meta.revision,
      updated_at: updatedAt,
      records,
      status: "ready",
      projection_paths: projectionPaths[domain]
    });
  }

  async migrate(domains: ProjectLibraryDomain[], session?: DocumentTimelineSession): Promise<ProjectLibraryBundle[]> {
    const results: ProjectLibraryBundle[] = [];
    for (const domain of domains) {
      const current = await this.get(domain);
      if (current.status !== "migration_required") {
        results.push(current);
        continue;
      }
      results.push(await this.save(domain, {
        baseRevision: 0,
        records: current.migration_preview?.records || [],
        source: "library_migration",
        summary: `迁移${libraryLabel(domain)}到结构化资料库`,
        session
      }));
    }
    return results;
  }

  async reconcile(
    domain: ProjectLibraryDomain,
    action: "rebuild_projection" | "reimport_projection",
    session?: DocumentTimelineSession
  ): Promise<ProjectLibraryBundle> {
    const loaded = await this.readMaster(domain);
    if (!loaded) {
      throw new ProjectLibraryCorruptedError("没有可用于修复的结构化资料库。");
    }
    if (action === "reimport_projection") {
      const preview = await this.legacyPreview(domain);
      return this.save(domain, {
        baseRevision: loaded.meta.revision,
        records: preview.records,
        source: "library_reimport",
        summary: `重新导入${libraryLabel(domain)}兼容文本`,
        session,
        allowProjectionDrift: true
      });
    }
    const projections = renderProjections(domain, loaded.records);
    const meta: LibraryMeta = {
      ...loaded.meta,
      revision: loaded.meta.revision + 1,
      updated_at: this.now(),
      projection_hashes: Object.fromEntries(Object.entries(projections).map(([entryPath, content]) => [entryPath, hash(content)]))
    };
    await this.documents.saveDocumentsAtomically([
      { path: masterPaths[domain], content: serializeLibrary(meta, loaded.records) },
      ...Object.entries(projections).map(([entryPath, content]) => ({ path: entryPath, content }))
    ], { source: "library_reconcile", summary: `重建${libraryLabel(domain)}兼容文本`, session });
    return projectLibraryBundleSchema.parse({
      schema_version: 1,
      domain,
      revision: meta.revision,
      updated_at: meta.updated_at,
      records: loaded.records,
      status: "ready",
      projection_paths: projectionPaths[domain]
    });
  }

  async createDraft(input: Omit<ProjectLibraryDraft, "draft_id" | "created_at"> & { draftId?: string }): Promise<ProjectLibraryDraft> {
    const draftId = String(input.draftId || randomUUID().replace(/-/g, "")).trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(draftId)) {
      throw new Error("资料库草稿 ID 无效");
    }
    const draftPath = `${DRAFT_DIR}/${draftId}.jsonl`;
    const existing = await this.documents.readRawText(draftPath, 5_000_000).catch(() => "");
    if (existing.trim()) {
      try {
        const parsed = JSON.parse(existing.trim()) as ProjectLibraryDraft;
        if (parsed.draft_id === draftId && parsed.domain === input.domain) {
          return {
            ...parsed,
            records: normalizeRecords(parsed.domain, parsed.records || [], parsed.created_at || this.now())
          };
        }
      } catch {
        throw new ProjectLibraryCorruptedError("同名资料库草稿无法读取，已阻止覆盖。");
      }
      throw new ProjectLibraryConflictError("LIBRARY_REVISION_CONFLICT", "资料库草稿 ID 已被其他内容占用。");
    }
    const draft: ProjectLibraryDraft = {
      draft_id: draftId,
      domain: input.domain,
      records: normalizeRecords(input.domain, input.records, this.now()),
      source: input.source,
      created_at: this.now()
    };
    await this.documents.saveDocument(draftPath, `${JSON.stringify(draft)}\n`, {
      source: "library_draft",
      summary: `保存${libraryLabel(draft.domain)}草稿`
    });
    return draft;
  }

  async listDrafts(): Promise<ProjectLibraryDraft[]> {
    const root = path.join(this.projectRoot, DRAFT_DIR);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const drafts: ProjectLibraryDraft[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const raw = await fs.readFile(path.join(root, entry.name), "utf8").catch(() => "");
      try {
        const parsed = JSON.parse(raw.trim()) as ProjectLibraryDraft;
        const records = normalizeRecords(parsed.domain, parsed.records || [], parsed.created_at || this.now());
        drafts.push({ ...parsed, records });
      } catch {
        // A damaged draft is left on disk for recovery, but never presented as valid content.
      }
    }
    return drafts.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async commitDraft(draftId: string, session?: DocumentTimelineSession): Promise<ProjectLibraryBundle> {
    const draft = (await this.listDrafts()).find((item) => item.draft_id === draftId);
    if (!draft) throw new Error("未找到资料库草稿");
    const current = await this.get(draft.domain);
    if (current.status === "projection_drift") {
      throw new ProjectLibraryConflictError("LIBRARY_PROJECTION_DRIFT", "兼容文本已在外部修改，不能确认草稿。");
    }
    const active = current.status === "migration_required"
      ? current.migration_preview?.records || []
      : current.records.filter((record) => record.status === "active");
    const merged = [...active, ...draft.records.map((record) => ({ ...record, origin: "agent_draft" as const }))];
    const saved = await this.save(draft.domain, {
      baseRevision: current.revision,
      records: merged,
      source: "library_draft_confirm",
      summary: `确认${libraryLabel(draft.domain)}草稿`,
      session
    });
    await this.documents.archiveDocument(`${DRAFT_DIR}/${draftId}.jsonl`, { source: "library_draft_confirm", summary: "归档已确认资料库草稿", session });
    return saved;
  }

  async discardDraft(draftId: string, session?: DocumentTimelineSession): Promise<void> {
    await this.documents.archiveDocument(`${DRAFT_DIR}/${draftId}.jsonl`, { source: "library_draft_discard", summary: "丢弃资料库草稿", session });
  }

  private async readMaster(domain: ProjectLibraryDomain): Promise<{ meta: LibraryMeta; records: ProjectLibraryRecord[] } | null> {
    const raw = await this.documents.readRawText(masterPaths[domain], 5_000_000).catch(() => "");
    if (!raw.trim()) return null;
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    try {
      const meta = JSON.parse(lines.shift() || "{}") as LibraryMeta;
      if (meta.record_type !== "meta" || meta.schema_version !== 1 || meta.domain !== domain || !Number.isInteger(meta.revision)) {
        throw new Error("元数据格式不正确");
      }
      const records = lines.map((line) => projectLibraryRecordSchema.parse(JSON.parse(line)));
      if (records.some((record) => !belongsToDomain(domain, record))) {
        throw new Error("记录域与资料库不匹配");
      }
      return { meta, records };
    } catch (error) {
      throw new ProjectLibraryCorruptedError(`无法读取${libraryLabel(domain)}结构化资料库：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async hasProjectionDrift(domain: ProjectLibraryDomain, expected: Record<string, string>): Promise<boolean> {
    for (const entryPath of projectionPaths[domain]) {
      const current = await this.documents.readRawText(entryPath, 5_000_000).catch(() => "");
      if ((expected[entryPath] || "") !== hash(current)) return true;
    }
    return false;
  }

  private async legacyPreview(domain: ProjectLibraryDomain): Promise<{ records: ProjectLibraryRecord[]; warnings: string[] }> {
    const contents = await Promise.all(projectionPaths[domain].map(async (entryPath) => ({
      path: entryPath,
      content: await this.documents.readRawText(entryPath, 500_000).catch(() => "")
    })));
    const records: ProjectLibraryRecord[] = [];
    const warnings: string[] = [];
    for (const item of contents) {
      const parsed = parseLegacyFile(domain, item.path, item.content, this.now());
      records.push(...parsed.records);
      warnings.push(...parsed.warnings);
    }
    return { records, warnings: [...new Set(warnings)] };
  }
}

function serializeLibrary(meta: LibraryMeta, records: ProjectLibraryRecord[]): string {
  return `${[meta, ...records].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function normalizeRecords(domain: ProjectLibraryDomain, values: ProjectLibraryRecord[], timestamp: string): ProjectLibraryRecord[] {
  const ids = new Set<string>();
  return values.map((value, index) => {
    const record = projectLibraryRecordSchema.parse({
      ...value,
      tags: uniqueStrings(value.tags || []),
      order: Number.isInteger(value.order) ? value.order : index,
      created_at: value.created_at || timestamp,
      updated_at: timestamp
    });
    if (!belongsToDomain(domain, record)) throw new Error(`记录 ${record.name} 不属于${libraryLabel(domain)}`);
    if (ids.has(record.id)) throw new Error(`资料库存在重复记录 ID: ${record.id}`);
    ids.add(record.id);
    return record;
  });
}

function belongsToDomain(domain: ProjectLibraryDomain, record: ProjectLibraryRecord): boolean {
  if (domain === "lore") return ["character", "location", "faction", "item", "world_rule", "relation", "character_arc"].includes(record.kind);
  if (domain === "style") return ["style_profile", "style_rule", "language_preference", "style_example", "style_material"].includes(record.kind);
  return ["genre_profile", "genre_rule", "genre_material", "conflict_template", "banned_expression"].includes(record.kind);
}

function renderProjections(domain: ProjectLibraryDomain, records: ProjectLibraryRecord[]): Record<string, string> {
  if (domain === "lore") return renderLore(records);
  if (domain === "style") return renderStyle(records);
  return renderGenre(records);
}

function renderLore(records: ProjectLibraryRecord[]): Record<string, string> {
  const active = records.filter((record) => record.status === "active");
  const entities = active.filter(isLoreEntity);
  const byId = new Map(entities.map((record) => [record.id, record]));
  const relations = active.filter((record) => record.kind === "relation");
  const arcs = active.filter((record) => record.kind === "character_arc");
  const grouped = (kind: string) => entities.filter((record) => record.kind === kind);
  const renderEntity = (record: LoreEntityRecord) => {
    const lines = [`### ${record.name}`];
    addLine(lines, "分类", record.role);
    addLine(lines, "身份", record.identity);
    addLine(lines, "年龄", record.age);
    addLine(lines, "简介", record.summary);
    addLine(lines, "目标", record.goal);
    addLine(lines, "恐惧", record.fear);
    addLine(lines, "外在特征", record.appearance);
    addLine(lines, "说话方式", record.speech_style);
    if (record.traits.length) addLine(lines, "特征", record.traits.join("、"));
    if (record.constraints.length) addLine(lines, "约束", record.constraints.join("；"));
    if (record.notes) addLine(lines, "备注", record.notes);
    if (record.kind === "character") {
      for (const relation of relations) {
        if (relation.kind !== "relation" || (relation.from_id !== record.id && relation.to_id !== record.id)) continue;
        const other = byId.get(relation.from_id === record.id ? relation.to_id : relation.from_id);
        addLine(lines, "关系", `${other?.name || "未知实体"} | ${relation.relation_type} | ${relation.summary}`);
      }
      const arc = arcs.find((item) => item.kind === "character_arc" && item.character_id === record.id);
      if (arc?.kind === "character_arc") {
        for (const phase of ["start", "current", "turn", "end"] as const) {
          const point = arc.points.find((item) => item.phase === phase);
          addLine(lines, `弧光·${arcPhaseLabel(phase)}`, point?.text || "");
        }
      }
    }
    return `${lines.join("\n")}\n`;
  };
  return {
    [`${SETTINGS_DIR}/设定集/人物设定.txt`]: renderSection("人物设定", "人物", grouped("character").map(renderEntity)),
    [`${SETTINGS_DIR}/设定集/体系设定.txt`]: `${renderSection("体系设定", "势力", grouped("faction").map(renderEntity))}\n${renderSection("体系设定", "世界规则", grouped("world_rule").map(renderEntity), true)}`.trimEnd() + "\n",
    [`${SETTINGS_DIR}/设定集/地图设定.txt`]: renderSection("地图设定", "地点", grouped("location").map(renderEntity)),
    [`${SETTINGS_DIR}/设定集/道具设定.txt`]: renderSection("道具设定", "物品", grouped("item").map(renderEntity))
  };
}

type LoreEntityRecord = Extract<LoreRecord, { kind: "character" | "location" | "faction" | "item" | "world_rule" }>;

function isLoreEntity(record: ProjectLibraryRecord): record is LoreEntityRecord {
  return record.kind === "character" || record.kind === "location" || record.kind === "faction" || record.kind === "item" || record.kind === "world_rule";
}

function renderStyle(records: ProjectLibraryRecord[]): Record<string, string> {
  const active = records.filter((record) => record.status === "active");
  const profile = active.find((record) => record.kind === "style_profile");
  const rules = active.filter((record) => record.kind === "style_rule");
  const preferences = active.filter((record) => record.kind === "language_preference");
  const examples = active.filter((record) => record.kind === "style_example");
  const materials = active.filter((record) => record.kind === "style_material");
  const styleLines = ["# 写作风格"];
  if (profile?.kind === "style_profile") {
    styleLines.push("", `## ${profile.name}`);
    addLine(styleLines, "视角", profile.narrative_pov);
    addLine(styleLines, "说明", profile.description || profile.summary);
  }
  if (rules.length) styleLines.push("", "## 叙事规则");
  for (const rule of rules) {
    if (rule.kind === "style_rule") styleLines.push("", `### ${rule.name}`, rule.instruction || rule.summary);
  }
  const preferred = preferences.filter((record) => record.kind === "language_preference" && record.preference === "prefer").map((record) => record.name);
  const avoided = preferences.filter((record) => record.kind === "language_preference" && record.preference === "avoid").map((record) => record.name);
  if (preferred.length || avoided.length) {
    styleLines.push("", "## 语言偏好");
    if (preferred.length) styleLines.push(`- 偏好：${preferred.join("、")}`);
    if (avoided.length) styleLines.push(`- 避免：${avoided.join("、")}`);
  }
  return {
    [`${SETTINGS_DIR}/${STYLE_DIR}/写作风格.txt`]: `${styleLines.join("\n").trim()}\n`,
    [`${SETTINGS_DIR}/${STYLE_DIR}/风格示例.txt`]: renderExamples(examples),
    [`${SETTINGS_DIR}/${STYLE_DIR}/参考素材.txt`]: renderSimpleEntries("参考素材", materials.map((record) => record.kind === "style_material" ? [record.name, record.content || record.summary] : ["", ""]))
  };
}

function renderGenre(records: ProjectLibraryRecord[]): Record<string, string> {
  const active = records.filter((record) => record.status === "active");
  const profile = active.find((record) => record.kind === "genre_profile");
  const rules = active.filter((record) => record.kind === "genre_rule");
  const materials = active.filter((record) => record.kind === "genre_material");
  const templates = active.filter((record) => record.kind === "conflict_template");
  const banned = active.filter((record) => record.kind === "banned_expression");
  const ruleLines = ["# 题材规则"];
  if (profile?.kind === "genre_profile") {
    ruleLines.push("", `## ${profile.name}`, profile.description || profile.summary);
  }
  for (const rule of rules) {
    if (rule.kind === "genre_rule") ruleLines.push("", `### ${rule.name}`, rule.instruction || rule.summary);
  }
  return {
    [`${SETTINGS_DIR}/${GENRE_DIR}/题材规则.txt`]: `${ruleLines.join("\n").trim()}\n`,
    [`${SETTINGS_DIR}/${GENRE_DIR}/题材素材.txt`]: renderSimpleEntries("题材素材", materials.map((record) => record.kind === "genre_material" ? [record.name, record.content || record.summary] : ["", ""])),
    [`${SETTINGS_DIR}/${GENRE_DIR}/战斗模板.txt`]: renderTemplates(templates),
    [`${SETTINGS_DIR}/${GENRE_DIR}/违禁词.txt`]: `${["# 违禁词", ...banned.flatMap((record) => record.kind === "banned_expression" ? ["", `- ${record.name}${record.replacement ? `，替换为：${record.replacement}` : ""}${record.reason ? `（${record.reason}）` : ""}`] : [])].join("\n").trim()}\n`
  };
}

function renderSection(title: string, section: string, entries: string[], omitTitle = false): string {
  const content = entries.filter(Boolean).join("\n");
  return `${omitTitle ? "" : `# ${title}\n\n`}## ${section}${content ? `\n\n${content}` : ""}\n`;
}

function renderSimpleEntries(title: string, entries: Array<[string, string]>): string {
  return `${["# " + title, ...entries.flatMap(([name, content]) => ["", `### ${name}`, content])].join("\n").trim()}\n`;
}

function renderExamples(records: ProjectLibraryRecord[]): string {
  const lines = ["# 风格示例"];
  for (const record of records) {
    if (record.kind !== "style_example") continue;
    lines.push("", `### ${record.name}`, "- 应用前：", record.before, "", "- 应用后：", record.after);
    if (record.explanation) lines.push("", `- 说明：${record.explanation}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderTemplates(records: ProjectLibraryRecord[]): string {
  const lines = ["# 冲突模板"];
  for (const record of records) {
    if (record.kind !== "conflict_template") continue;
    lines.push("", `### ${record.name}`);
    addLine(lines, "铺垫", record.setup);
    addLine(lines, "压迫", record.pressure);
    addLine(lines, "反转", record.reversal);
    addLine(lines, "收束", record.resolution);
  }
  return `${lines.join("\n").trim()}\n`;
}

function parseLegacyFile(domain: ProjectLibraryDomain, entryPath: string, text: string, timestamp: string): { records: ProjectLibraryRecord[]; warnings: string[] } {
  const raw = text.trim();
  if (!raw) return { records: [], warnings: [] };
  const blocks = splitLegacyBlocks(raw);
  const records: ProjectLibraryRecord[] = [];
  const warnings: string[] = [];
  for (const block of blocks) {
    const { name, body } = block;
    if (!name) continue;
    const base = legacyBase(name, body, timestamp, records.length);
    if (domain === "lore") {
      const kind = entryPath.includes("人物") ? "character" : entryPath.includes("地图") ? "location" : entryPath.includes("道具") ? "item" : body.includes("势力") || body.includes("组织") ? "faction" : "world_rule";
      records.push(projectLibraryRecordSchema.parse({ ...base, kind }));
    } else if (domain === "style") {
      if (entryPath.includes("风格示例")) {
        records.push(projectLibraryRecordSchema.parse({ ...base, kind: "style_example", before: body, after: "", explanation: "", needs_review: true }));
        warnings.push("旧风格示例无法自动区分应用前后文本，已保留原文等待确认。");
      } else if (entryPath.includes("参考素材")) {
        records.push(projectLibraryRecordSchema.parse({ ...base, kind: "style_material", content: body }));
      } else {
        records.push(projectLibraryRecordSchema.parse({ ...base, kind: "style_rule", category: "custom", instruction: body }));
      }
    } else if (entryPath.includes("题材素材")) {
      records.push(projectLibraryRecordSchema.parse({ ...base, kind: "genre_material", content: body }));
    } else if (entryPath.includes("战斗模板")) {
      records.push(projectLibraryRecordSchema.parse({ ...base, kind: "conflict_template", setup: body, pressure: "", reversal: "", resolution: "", needs_review: true }));
      warnings.push("旧冲突模板未按阶段拆分，已保留原文等待确认。");
    } else if (entryPath.includes("违禁词")) {
      for (const term of body.split(/\r?\n/).map((value) => value.replace(/^[-*•\s]+/, "").trim()).filter(Boolean)) {
        records.push(projectLibraryRecordSchema.parse({ ...legacyBase(term, "", timestamp, records.length), kind: "banned_expression", replacement: "", reason: "" }));
      }
    } else {
      records.push(projectLibraryRecordSchema.parse({ ...base, kind: "genre_rule", category: "custom", instruction: body }));
    }
  }
  return { records, warnings };
}

function splitLegacyBlocks(text: string): Array<{ name: string; body: string }> {
  const lines = text.split(/\r?\n/);
  const output: Array<{ name: string; body: string[] }> = [];
  let current: { name: string; body: string[] } | null = null;
  for (const line of lines) {
    const heading = /^(?:#{1,4}\s+)?(?:[【\[])?\s*([^#【】\[\]\n]{1,120})(?:[】\]])?\s*$/.exec(line.trim());
    const field = /^([^：:]{1,80})[：:]\s*(.+)$/.exec(line.trim());
    const name = heading && !heading[1]!.includes("：") && !heading[1]!.startsWith("-") ? heading[1]!.trim() : field?.[1]?.trim();
    if (name && (line.trim().startsWith("#") || !current || (!line.startsWith(" ") && !line.startsWith("- ") && Boolean(field)))) {
      if (current) output.push(current);
      current = { name, body: field ? [field[2]!.trim()] : [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) output.push(current);
  if (!output.length) return [{ name: "旧资料", body: text }];
  return output.map((item) => ({ name: item.name, body: item.body.join("\n").trim() }));
}

function legacyBase(name: string, summary: string, timestamp: string, order: number): Record<string, unknown> {
  return {
    id: randomUUID().replace(/-/g, ""),
    name: name.replace(/^#+\s*/, "").trim() || "未命名资料",
    summary,
    tags: [],
    order,
    status: "active",
    origin: "legacy_import",
    created_at: timestamp,
    updated_at: timestamp,
    needs_review: true,
    notes: ""
  };
}

function addLine(lines: string[], label: string, value: string | undefined): void {
  if (value?.trim()) lines.push(`- ${label}：${value.trim()}`);
}

function arcPhaseLabel(phase: "start" | "current" | "turn" | "end"): string {
  return { start: "起点", current: "当前", turn: "转折", end: "终点" }[phase];
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function libraryLabel(domain: ProjectLibraryDomain): string {
  return domain === "lore" ? "设定资料" : domain === "style" ? "风格库" : "题材库";
}
