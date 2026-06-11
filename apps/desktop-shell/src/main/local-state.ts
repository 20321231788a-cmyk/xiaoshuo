import type {
  ConversationSummary,
  JobInfo,
  LocalStatePatchSettingsRequest,
  LocalStateGeneratedCache,
  LocalStateProject,
  LocalStateRecordProjectRequest,
  LocalStateSnapshot,
  LocalStateSyncProjectRequest,
  LocalStateTrackGeneratedCacheRequest
} from "@xiaoshuo/shared";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  desktopWorkbenchSettingsSchema,
  localStatePatchSettingsRequestSchema,
  localStateRecordProjectRequestSchema,
  localStateSyncProjectRequestSchema,
  localStateTrackGeneratedCacheRequestSchema
} from "../shared/channels.js";

type BetterSqliteDatabase = import("better-sqlite3").default;
type BetterSqliteConstructor = typeof import("better-sqlite3").default;
type NodeSqliteDatabase = import("node:sqlite").DatabaseSync;

type RecentProjectRow = {
  path: string;
  name: string;
  opened_at: string;
  conversation_count: number;
  job_count: number;
  last_synced_at?: string;
};

type GeneratedCacheRow = {
  cache_id: string;
  project_path: string;
  skill_id: string;
  source: "chat" | "skill";
  target_path: string;
  target_paths_json: string;
  status: "pending" | "saved" | "discarded";
  mode?: "replace" | "append";
  cache_path?: string;
  cache_chars: number;
  created_at: string;
  updated_at: string;
};

const conversationSummaryForCacheSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    updated_at: z.string(),
    message_count: z.number().int(),
    attachment_count: z.number().int()
  })
  .passthrough();

const jobForCacheSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    progress: z.number(),
    message: z.string()
  })
  .passthrough();

type LocalDatabase = {
  driver: "better-sqlite3" | "node:sqlite";
  exec: (source: string) => void;
  pragma?: (source: string) => unknown;
  prepare: (source: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
  close: () => void;
};

let db: LocalDatabase | null = null;
let dbPath = "";
let activeDriver: LocalDatabase["driver"] = "better-sqlite3";

async function loadDatabaseConstructor(): Promise<BetterSqliteConstructor> {
  const module = await import("better-sqlite3");
  return module.default;
}

async function createBetterSqliteDatabase(filename: string): Promise<LocalDatabase> {
  const Database = await loadDatabaseConstructor();
  const database: BetterSqliteDatabase = new Database(filename);
  database.pragma("journal_mode = WAL");
  return {
    driver: "better-sqlite3",
    exec: (source) => {
      database.exec(source);
    },
    pragma: (source) => database.pragma(source),
    prepare: (source) => database.prepare(source),
    close: () => database.close()
  };
}

async function createNodeSqliteDatabase(filename: string): Promise<LocalDatabase> {
  const module = await import("node:sqlite");
  const database: NodeSqliteDatabase = new module.DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL");
  return {
    driver: "node:sqlite",
    exec: (source) => {
      database.exec(source);
    },
    prepare: (source) => {
      const statement = database.prepare(source);
      return {
        all: (...params) => statement.all(...(params as Parameters<typeof statement.all>)),
        run: (...params) => statement.run(...(params as Parameters<typeof statement.run>))
      };
    },
    close: () => database.close()
  };
}

export async function probeLocalStateDriver(): Promise<{ available: boolean; package: "better-sqlite3" | "node:sqlite"; reason?: string }> {
  try {
    const database = await createBetterSqliteDatabase(":memory:");
    database.close();
    return { available: true, package: "better-sqlite3" };
  } catch (betterSqliteError) {
    try {
      const database = await createNodeSqliteDatabase(":memory:");
      database.close();
      const reason = betterSqliteError instanceof Error ? `better-sqlite3 unavailable: ${betterSqliteError.message}` : "better-sqlite3 unavailable";
      return { available: true, package: "node:sqlite", reason };
    } catch (nodeSqliteError) {
      return {
        available: false,
        package: "better-sqlite3",
        reason: nodeSqliteError instanceof Error ? nodeSqliteError.message : "No local SQLite driver could be loaded"
      };
    }
  }
}

async function openDatabase(): Promise<LocalDatabase> {
  if (db) {
    return db;
  }

  const stateDir = path.join(app.getPath("userData"), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  dbPath = path.join(stateDir, "xiaoshuo-local-state.sqlite3");
  const driver = await probeLocalStateDriver();
  if (!driver.available) {
    throw new Error(driver.reason || "No local SQLite driver could be loaded");
  }
  db = driver.package === "better-sqlite3" ? await createBetterSqliteDatabase(dbPath) : await createNodeSqliteDatabase(dbPath);
  activeDriver = db.driver;
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      conversation_count INTEGER NOT NULL DEFAULT 0,
      job_count INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recent_projects_opened_at
      ON recent_projects (opened_at DESC);
    CREATE TABLE IF NOT EXISTS conversation_index (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_index_project
      ON conversation_index (project_path, updated_at DESC);
    CREATE TABLE IF NOT EXISTS job_history (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_history_project
      ON job_history (project_path, synced_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generated_cache_metadata (
      cache_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      source TEXT NOT NULL,
      target_path TEXT NOT NULL,
      target_paths_json TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT,
      cache_path TEXT,
      cache_chars INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_generated_cache_project
      ON generated_cache_metadata (project_path, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_cache_status
      ON generated_cache_metadata (status, updated_at DESC);
  `);
  ensureColumn(db, "recent_projects", "conversation_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recent_projects", "job_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recent_projects", "last_synced_at", "TEXT");
  return db;
}

function ensureColumn(database: LocalDatabase, table: string, column: string, definition: string): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function getSettingsValue<T>(key: string, fallback: T): Promise<T> {
  const database = await openDatabase();
  const row = database.prepare("SELECT value_json FROM app_settings WHERE key = ?").all(key)[0] as { value_json?: unknown } | undefined;
  if (typeof row?.value_json !== "string") {
    return fallback;
  }

  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

async function setSettingsValue(key: string, value: unknown, updatedAt = new Date().toISOString()): Promise<void> {
  const database = await openDatabase();
  database
    .prepare(
      `
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `
    )
    .run(key, JSON.stringify(value), updatedAt);
}

async function getWorkbenchSettings() {
  return desktopWorkbenchSettingsSchema.parse(await getSettingsValue("workbench", {}));
}

function normalizeRows(rows: unknown[]): LocalStateProject[] {
  return rows
    .map((row) => row as Partial<RecentProjectRow>)
    .filter((row): row is RecentProjectRow => typeof row.path === "string" && typeof row.name === "string" && typeof row.opened_at === "string");
}

async function listRecentProjects(): Promise<LocalStateProject[]> {
  const database = await openDatabase();
  return normalizeRows(
    database
      .prepare(
        `
          SELECT path, name, opened_at, conversation_count, job_count, last_synced_at
          FROM recent_projects
          ORDER BY opened_at DESC
          LIMIT 12
        `
      )
      .all()
  );
}

function parseJsonStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeGeneratedCacheRows(rows: unknown[]): LocalStateGeneratedCache[] {
  return rows
    .map((row) => row as Partial<GeneratedCacheRow>)
    .filter(
      (row): row is GeneratedCacheRow =>
        typeof row.cache_id === "string" &&
        typeof row.project_path === "string" &&
        typeof row.skill_id === "string" &&
        (row.source === "chat" || row.source === "skill") &&
        typeof row.target_path === "string" &&
        typeof row.target_paths_json === "string" &&
        (row.status === "pending" || row.status === "saved" || row.status === "discarded") &&
        typeof row.created_at === "string" &&
        typeof row.updated_at === "string"
    )
    .map((row) => ({
      cache_id: row.cache_id,
      project_path: row.project_path,
      skill_id: row.skill_id,
      source: row.source,
      target_path: row.target_path,
      target_paths: parseJsonStringList(row.target_paths_json),
      status: row.status,
      mode: row.mode === "replace" || row.mode === "append" ? row.mode : undefined,
      cache_path: row.cache_path || undefined,
      cache_chars: Number(row.cache_chars || 0),
      created_at: row.created_at,
      updated_at: row.updated_at
    }));
}

async function listGeneratedCaches(): Promise<LocalStateGeneratedCache[]> {
  const database = await openDatabase();
  return normalizeGeneratedCacheRows(
    database
      .prepare(
        `
          SELECT cache_id, project_path, skill_id, source, target_path, target_paths_json, status, mode, cache_path, cache_chars, created_at, updated_at
          FROM generated_cache_metadata
          ORDER BY updated_at DESC
          LIMIT 30
        `
      )
      .all()
  );
}

export async function getLocalStateSnapshot(): Promise<LocalStateSnapshot> {
  await openDatabase();
  return {
    db_path: dbPath,
    driver: activeDriver,
    recent_projects: await listRecentProjects(),
    generated_caches: await listGeneratedCaches(),
    settings: await getWorkbenchSettings(),
    synced_at: new Date().toISOString()
  };
}

export async function recordRecentProject(request: LocalStateRecordProjectRequest): Promise<LocalStateSnapshot> {
  const project = localStateRecordProjectRequestSchema.parse(request);
  const database = await openDatabase();
  database
    .prepare(
      `
        INSERT INTO recent_projects (path, name, opened_at)
        VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          name = excluded.name,
          opened_at = excluded.opened_at
      `
    )
    .run(project.path, project.name, project.opened_at || new Date().toISOString());

  return getLocalStateSnapshot();
}

export async function patchWorkbenchSettings(request: LocalStatePatchSettingsRequest): Promise<LocalStateSnapshot> {
  const patch = localStatePatchSettingsRequestSchema.parse(request);
  const current = await getWorkbenchSettings();
  await setSettingsValue(
    "workbench",
    {
      ...current,
      ...patch,
      updated_at: new Date().toISOString()
    },
    new Date().toISOString()
  );
  return getLocalStateSnapshot();
}

export async function trackGeneratedCacheMetadata(request: LocalStateTrackGeneratedCacheRequest): Promise<LocalStateSnapshot> {
  const cache = localStateTrackGeneratedCacheRequestSchema.parse(request);
  const database = await openDatabase();
  const current = database.prepare("SELECT created_at FROM generated_cache_metadata WHERE cache_id = ?").all(cache.cache_id)[0] as
    | { created_at?: unknown }
    | undefined;
  const now = new Date().toISOString();
  const createdAt = cache.created_at || (typeof current?.created_at === "string" ? current.created_at : now);
  const updatedAt = cache.updated_at || now;

  database
    .prepare(
      `
        INSERT INTO generated_cache_metadata (
          cache_id, project_path, skill_id, source, target_path, target_paths_json, status, mode, cache_path, cache_chars, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_id) DO UPDATE SET
          project_path = excluded.project_path,
          skill_id = excluded.skill_id,
          source = excluded.source,
          target_path = excluded.target_path,
          target_paths_json = excluded.target_paths_json,
          status = excluded.status,
          mode = excluded.mode,
          cache_path = excluded.cache_path,
          cache_chars = excluded.cache_chars,
          updated_at = excluded.updated_at
      `
    )
    .run(
      cache.cache_id,
      cache.project_path,
      cache.skill_id,
      cache.source,
      cache.target_path,
      JSON.stringify(cache.target_paths.length ? cache.target_paths : [cache.target_path].filter(Boolean)),
      cache.status,
      cache.mode || null,
      cache.cache_path || null,
      cache.cache_chars,
      createdAt,
      updatedAt
    );

  return getLocalStateSnapshot();
}

function parseConversationSummaries(items: unknown[]): ConversationSummary[] {
  return items.flatMap((item) => {
    const result = conversationSummaryForCacheSchema.safeParse(item);
    return result.success ? [result.data as ConversationSummary] : [];
  });
}

function parseJobs(items: unknown[]): JobInfo[] {
  return items.flatMap((item) => {
    const result = jobForCacheSchema.safeParse(item);
    return result.success ? [result.data as JobInfo] : [];
  });
}

export async function syncProjectLocalState(request: LocalStateSyncProjectRequest): Promise<LocalStateSnapshot> {
  const syncRequest = localStateSyncProjectRequestSchema.parse(request);
  const project = syncRequest.project;
  const syncedAt = syncRequest.synced_at || new Date().toISOString();
  const conversations = parseConversationSummaries(syncRequest.conversations);
  const jobs = parseJobs(syncRequest.jobs);
  const database = await openDatabase();

  database
    .prepare(
      `
        INSERT INTO recent_projects (path, name, opened_at, conversation_count, job_count, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          name = excluded.name,
          opened_at = excluded.opened_at,
          conversation_count = excluded.conversation_count,
          job_count = excluded.job_count,
          last_synced_at = excluded.last_synced_at
      `
    )
    .run(project.path, project.name, project.opened_at || syncedAt, conversations.length, jobs.length, syncedAt);

  database.prepare("DELETE FROM conversation_index WHERE project_path = ?").run(project.path);
  const insertConversation = database.prepare(`
    INSERT INTO conversation_index (id, project_path, title, updated_at, message_count, attachment_count, payload_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const conversation of conversations) {
    insertConversation.run(
      conversation.id,
      project.path,
      conversation.title,
      conversation.updated_at,
      conversation.message_count,
      conversation.attachment_count,
      JSON.stringify(conversation),
      syncedAt
    );
  }

  database.prepare("DELETE FROM job_history WHERE project_path = ?").run(project.path);
  const insertJob = database.prepare(`
    INSERT INTO job_history (id, project_path, kind, status, progress, message, payload_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const job of jobs) {
    insertJob.run(job.id, project.path, job.kind, job.status, job.progress, job.message, JSON.stringify(job), syncedAt);
  }

  return getLocalStateSnapshot();
}

export function closeLocalState(): void {
  db?.close();
  db = null;
}
