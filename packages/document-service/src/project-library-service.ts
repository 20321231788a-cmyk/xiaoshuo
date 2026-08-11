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
  group_id?: string;
  commit_mode?: "replace" | "merge";
  base_revision?: number;
  target_paths?: string[];
  conversation_id?: string;
  message_id?: string;
  run_id?: string;
  status?: "pending" | "committed" | "discarded";
  committed_at?: string;
  discarded_at?: string;
};

export type ProjectLibraryDraftGroup = {
  group_id: string;
  mode: "replace" | "merge";
  drafts: ProjectLibraryDraft[];
  domains: ProjectLibraryDomain[];
  draft_ids: string[];
  source: string;
  created_at: string;
  conversation_id?: string;
  message_id?: string;
  run_id?: string;
};

export type ProjectLibrarySaveManyInput = {
  domain: ProjectLibraryDomain;
  baseRevision: number;
  records: ProjectLibraryRecord[];
  source?: string;
  summary?: string;
  session?: DocumentTimelineSession;
  /** Explicit rebuilds may intentionally replace legacy/projection drift. */
  allowProjectionDrift?: boolean;
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
    return (await this.saveMany([{ domain, ...input }]))[0]!;
  }

  /**
   * Validates every requested library before writing anything.  This is used
   * by combined AI actions such as "create style and genre libraries" so a
   * partial result can never leave the two domains out of sync.
   */
  async saveMany(
    inputs: ProjectLibrarySaveManyInput[],
    options: { additionalDocuments?: Array<{ path: string; content: string }> } = {}
  ): Promise<ProjectLibraryBundle[]> {
    if (!inputs.length) return [];
    const domains = new Set<ProjectLibraryDomain>();
    for (const input of inputs) {
      if (domains.has(input.domain)) {
        throw new Error(`资料库批量保存包含重复域：${libraryLabel(input.domain)}`);
      }
      domains.add(input.domain);
    }

    const prepared: Array<{ input: ProjectLibrarySaveManyInput; meta: LibraryMeta; records: ProjectLibraryRecord[]; projections: Record<string, string> }> = [];
    for (const input of inputs) {
      const loaded = await this.readMaster(input.domain);
      if (!loaded && input.baseRevision !== 0) {
        throw new ProjectLibraryConflictError("LIBRARY_REVISION_CONFLICT", "资料库已被其他窗口更新，请重新加载后再保存。");
      }
      if (loaded && loaded.meta.revision !== input.baseRevision) {
        throw new ProjectLibraryConflictError("LIBRARY_REVISION_CONFLICT", "资料库已有新版内容，请重新加载后再保存。");
      }
      if (!input.allowProjectionDrift && loaded && await this.hasProjectionDrift(input.domain, loaded.meta.projection_hashes)) {
        throw new ProjectLibraryConflictError("LIBRARY_PROJECTION_DRIFT", "兼容文本已在外部修改。请先选择重建投影或重新导入。");
      }
      const updatedAt = this.now();
      const records = normalizeRecords(input.domain, input.records, updatedAt);
      const projections = renderProjections(input.domain, records);
      prepared.push({
        input,
        records,
        projections,
        meta: {
          record_type: "meta",
          schema_version: 1,
          domain: input.domain,
          revision: (loaded?.meta.revision || 0) + 1,
          updated_at: updatedAt,
          projection_hashes: Object.fromEntries(Object.entries(projections).map(([entryPath, content]) => [entryPath, hash(content)]))
        }
      });
    }

    await this.documents.saveDocumentsAtomically(
      prepared.flatMap(({ input, meta, records, projections }) => [
        { path: masterPaths[input.domain], content: serializeLibrary(meta, records) },
        ...Object.entries(projections).map(([entryPath, content]) => ({ path: entryPath, content }))
      ]).concat(options.additionalDocuments || []),
      {
        source: prepared.map((item) => item.input.source).find(Boolean) || "library_editor",
        summary: prepared.map((item) => item.input.summary).filter(Boolean).join("；") || "批量保存项目资料库",
        session: prepared.map((item) => item.input.session).find(Boolean)
      }
    );

    return prepared.map(({ input, meta, records }) => projectLibraryBundleSchema.parse({
      schema_version: 1,
      domain: input.domain,
      revision: meta.revision,
      updated_at: meta.updated_at,
      records,
      status: "ready",
      projection_paths: projectionPaths[input.domain]
    }));
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
      created_at: this.now(),
      group_id: normalizeDraftGroupId(input.group_id),
      commit_mode: input.commit_mode === "merge" ? "merge" : input.commit_mode === "replace" ? "replace" : undefined,
      base_revision: Number.isInteger(input.base_revision) && Number(input.base_revision) >= 0 ? Number(input.base_revision) : undefined,
      target_paths: normalizeDraftPaths(input.target_paths),
      conversation_id: String(input.conversation_id || "").trim() || undefined,
      message_id: String(input.message_id || "").trim() || undefined,
      run_id: String(input.run_id || "").trim() || undefined,
      status: "pending"
    };
    await this.documents.saveDocument(draftPath, `${JSON.stringify(draft)}\n`, {
      source: "library_draft",
      summary: `保存${libraryLabel(draft.domain)}草稿`
    });
    return draft;
  }

  async listDrafts(): Promise<ProjectLibraryDraft[]> {
    return (await this.listAllDrafts()).filter((draft) => (draft.status || "pending") === "pending");
  }

  async listDraftGroups(): Promise<ProjectLibraryDraftGroup[]> {
    const drafts = await this.listDrafts();
    const grouped = new Map<string, ProjectLibraryDraft[]>();
    for (const draft of drafts) {
      const groupId = normalizeDraftGroupId(draft.group_id) || `draft-${draft.draft_id}`;
      grouped.set(groupId, [...(grouped.get(groupId) || []), draft]);
    }
    return [...grouped.entries()].map(([groupId, entries]) => this.toDraftGroup(groupId, entries));
  }

  async getDraftGroup(groupId: string): Promise<ProjectLibraryDraftGroup> {
    const normalized = String(groupId || "").trim();
    const drafts = await this.listDrafts();
    const entries = drafts.filter((draft) => (normalizeDraftGroupId(draft.group_id) || `draft-${draft.draft_id}`) === normalized);
    if (!entries.length) throw new Error("未找到待确认资料草稿组");
    return this.toDraftGroup(normalized, entries);
  }

  async previewDraftGroup(groupId: string): Promise<ProjectLibraryDraftGroup & { preview: Array<{ domain: ProjectLibraryDomain; base_revision: number; current_revision: number; target_paths: string[]; added: ProjectLibraryRecord[]; changed: ProjectLibraryRecord[]; removed: ProjectLibraryRecord[] }> }> {
    const group = await this.getDraftGroup(groupId);
    const preview = await Promise.all(group.drafts.map(async (draft) => {
      const current = await this.get(draft.domain);
      const active = activeRecords(current);
      const incoming = draft.records;
      const mode = draft.commit_mode || group.mode;
      const activeByKey = new Map(active.map((record) => [draftRecordKey(record), record]));
      const incomingByKey = new Map(incoming.map((record) => [draftRecordKey(record), record]));
      const added = incoming.filter((record) => !activeByKey.has(draftRecordKey(record)));
      const changed = incoming.filter((record) => {
        const currentRecord = activeByKey.get(draftRecordKey(record));
        return currentRecord ? !sameDraftRecord(currentRecord, record) : false;
      });
      const removed = mode === "replace" ? active.filter((record) => !incomingByKey.has(draftRecordKey(record))) : [];
      return {
        domain: draft.domain,
        base_revision: draft.base_revision ?? current.revision,
        current_revision: current.revision,
        target_paths: draft.target_paths?.length ? draft.target_paths : current.projection_paths,
        added,
        changed,
        removed
      };
    }));
    return { ...group, preview };
  }

  async setDraftGroupOrigin(groupId: string, origin: { conversation_id?: string; message_id?: string; run_id?: string }): Promise<ProjectLibraryDraftGroup> {
    const group = await this.getDraftGroup(groupId);
    const documents = group.drafts.map((draft) => ({
      path: `${DRAFT_DIR}/${draft.draft_id}.jsonl`,
      content: `${JSON.stringify({
        ...draft,
        conversation_id: String(origin.conversation_id || draft.conversation_id || "").trim() || undefined,
        message_id: String(origin.message_id || draft.message_id || "").trim() || undefined,
        run_id: String(origin.run_id || draft.run_id || "").trim() || undefined
      })}\n`
    }));
    await this.documents.saveDocumentsAtomically(documents, { source: "library_draft_origin", summary: "关联资料草稿来源会话" });
    return this.getDraftGroup(groupId);
  }

  async commitDraftGroup(groupId: string, session?: DocumentTimelineSession): Promise<ProjectLibraryBundle[]> {
    let group: ProjectLibraryDraftGroup;
    try {
      group = await this.getDraftGroup(groupId);
    } catch (error) {
      const settled = await this.findSettledDraftGroup(groupId, "committed");
      if (!settled) throw error;
      return Promise.all(settled.domains.map((domain) => this.get(domain)));
    }
    const current = await Promise.all(group.drafts.map((draft) => this.get(draft.domain)));
    const saved = await this.saveMany(group.drafts.map((draft, index) => {
      const library = current[index]!;
      const baseRevision = draft.base_revision ?? library.revision;
      if (library.revision !== baseRevision) {
        throw new ProjectLibraryConflictError("LIBRARY_REVISION_CONFLICT", `${libraryLabel(draft.domain)}已有新版内容，请刷新预览后再确认。`);
      }
      if (library.status === "projection_drift") {
        throw new ProjectLibraryConflictError("LIBRARY_PROJECTION_DRIFT", "兼容文本已在外部修改，请先修复后再确认草稿。");
      }
      const records = (draft.commit_mode || group.mode) === "replace"
        ? draft.records
        : mergeDraftRecords(activeRecords(library), draft.records);
      return {
        domain: draft.domain,
        baseRevision,
        records,
        source: "library_draft_group_confirm",
        summary: `确认${libraryLabel(draft.domain)}草稿组`,
        session,
        allowProjectionDrift: (draft.commit_mode || group.mode) === "replace"
      };
    }), {
      additionalDocuments: group.drafts.map((draft) => ({
        path: `${DRAFT_DIR}/${draft.draft_id}.jsonl`,
        content: `${JSON.stringify({ ...draft, status: "committed", committed_at: this.now() })}\n`
      }))
    });
    return saved;
  }

  async discardDraftGroup(groupId: string): Promise<void> {
    let group: ProjectLibraryDraftGroup;
    try {
      group = await this.getDraftGroup(groupId);
    } catch (error) {
      if (await this.findSettledDraftGroup(groupId, "discarded")) return;
      throw error;
    }
    await this.documents.saveDocumentsAtomically(group.drafts.map((draft) => ({
      path: `${DRAFT_DIR}/${draft.draft_id}.jsonl`,
      content: `${JSON.stringify({ ...draft, status: "discarded", discarded_at: this.now() })}\n`
    })), { source: "library_draft_group_discard", summary: "丢弃资料草稿组" });
  }

  private async listAllDrafts(): Promise<ProjectLibraryDraft[]> {
    const root = path.join(this.projectRoot, DRAFT_DIR);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const drafts: ProjectLibraryDraft[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const raw = await fs.readFile(path.join(root, entry.name), "utf8").catch(() => "");
      try {
        const parsed = JSON.parse(raw.trim()) as ProjectLibraryDraft;
        const records = normalizeRecords(parsed.domain, parsed.records || [], parsed.created_at || this.now());
        drafts.push({
          ...parsed,
          records,
          group_id: normalizeDraftGroupId(parsed.group_id),
          commit_mode: parsed.commit_mode === "merge" ? "merge" : parsed.commit_mode === "replace" ? "replace" : undefined,
          base_revision: Number.isInteger(parsed.base_revision) && Number(parsed.base_revision) >= 0 ? Number(parsed.base_revision) : undefined,
          target_paths: normalizeDraftPaths(parsed.target_paths),
          status: parsed.status === "committed" || parsed.status === "discarded" ? parsed.status : "pending"
        });
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
    if (draft.base_revision !== undefined && draft.base_revision !== current.revision) {
      throw new ProjectLibraryConflictError("LIBRARY_REVISION_CONFLICT", "资料库已有新版内容，请刷新预览后再确认。 ");
    }
    const merged = (draft.commit_mode || "merge") === "replace"
      ? draft.records
      : mergeDraftRecords(activeRecords(current), draft.records);
    const saved = await this.save(draft.domain, {
      baseRevision: draft.base_revision ?? current.revision,
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

  private toDraftGroup(groupId: string, drafts: ProjectLibraryDraft[]): ProjectLibraryDraftGroup {
    const sorted = [...drafts].sort((left, right) => left.created_at.localeCompare(right.created_at));
    const first = sorted[0]!;
    return {
      group_id: groupId,
      mode: sorted.length > 0 && sorted.every((draft) => draft.commit_mode === "replace") ? "replace" : "merge",
      drafts: sorted,
      domains: sorted.map((draft) => draft.domain),
      draft_ids: sorted.map((draft) => draft.draft_id),
      source: first.source,
      created_at: first.created_at,
      conversation_id: first.conversation_id,
      message_id: first.message_id,
      run_id: first.run_id
    };
  }

  private async findSettledDraftGroup(groupId: string, status: "committed" | "discarded"): Promise<ProjectLibraryDraftGroup | null> {
    const normalized = String(groupId || "").trim();
    const entries = (await this.listAllDrafts()).filter((draft) => {
      const id = normalizeDraftGroupId(draft.group_id) || `draft-${draft.draft_id}`;
      return id === normalized && draft.status === status;
    });
    return entries.length ? this.toDraftGroup(normalized, entries) : null;
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

function normalizeDraftGroupId(value: unknown): string | undefined {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,160}$/.test(id) ? id : undefined;
}

function normalizeDraftPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = [...new Set(value.map((path) => String(path || "").trim()).filter(Boolean))];
  return paths.length ? paths : undefined;
}

function activeRecords(bundle: ProjectLibraryBundle): ProjectLibraryRecord[] {
  return bundle.status === "migration_required"
    ? bundle.migration_preview?.records || []
    : bundle.records.filter((record) => record.status === "active");
}

function draftRecordKey(record: ProjectLibraryRecord): string {
  return `${record.kind}:${record.name.replace(/\s+/g, "").toLocaleLowerCase("zh-CN")}`;
}

function sameDraftRecord(left: ProjectLibraryRecord, right: ProjectLibraryRecord): boolean {
  const normalize = (record: ProjectLibraryRecord) => {
    const { id, order, created_at, updated_at, origin, needs_review, notes, ...content } = record as ProjectLibraryRecord & Record<string, unknown>;
    return content;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function mergeDraftRecords(existing: ProjectLibraryRecord[], incoming: ProjectLibraryRecord[]): ProjectLibraryRecord[] {
  const next = [...existing];
  const indexByKey = new Map(next.map((record, index) => [draftRecordKey(record), index]));
  for (const record of incoming) {
    const key = draftRecordKey(record);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, next.length);
      next.push({ ...record, order: next.length, origin: "agent_draft" });
      continue;
    }
    next[index] = { ...record, id: next[index]!.id, order: index, origin: "agent_draft" };
  }
  return next;
}

function libraryLabel(domain: ProjectLibraryDomain): string {
  return domain === "lore" ? "设定资料" : domain === "style" ? "风格库" : "题材库";
}
