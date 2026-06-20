import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";

const requireFn = createRequire(import.meta.url);

export class VectorDb {
  private readonly dbPath: string;
  private _db: any = null;
  private isBetterSqlite = false;

  constructor(projectPath: string) {
    this.dbPath = path.join(projectPath, "00_设定集", ".agent", "vector_index.sqlite3");
  }

  get db(): any {
    if (!this._db) {
      this.init();
    }
    return this._db;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  init(): void {
    if (this._db) {
      return;
    }
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      // 1. 尝试使用 better-sqlite3
      const Database = requireFn("better-sqlite3");
      const conn = new Database(this.dbPath);
      conn.pragma("foreign_keys=ON");
      conn.pragma("journal_mode=WAL");
      conn.pragma("synchronous=NORMAL");
      conn.pragma("temp_store=MEMORY");
      conn.pragma("busy_timeout=5000");
      this._db = conn;
      this.isBetterSqlite = true;
    } catch {
      // ignore and try fallback
    }

    if (!this._db) {
      try {
        // 2. 尝试退化使用 node:sqlite
        const { DatabaseSync } = requireFn("node:sqlite");
        const conn = new DatabaseSync(this.dbPath);
        conn.exec("PRAGMA foreign_keys=ON");
        conn.exec("PRAGMA journal_mode=WAL");
        conn.exec("PRAGMA synchronous=NORMAL");
        conn.exec("PRAGMA temp_store=MEMORY");
        conn.exec("PRAGMA busy_timeout=5000");
        this._db = conn;
        this.isBetterSqlite = false;
      } catch (err) {
        throw new Error(`无法载入任何 SQLite 驱动 (better-sqlite3 或 node:sqlite): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 直接使用 this._db，避免通过 getter 产生二次 init 循环
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS chunks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        mtime REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(text_hash);

      CREATE TABLE IF NOT EXISTS embeddings(
        chunk_id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS pending_files(
        path TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_files_updated ON pending_files(updated_at);

      CREATE TABLE IF NOT EXISTS graph_entities(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        source_path TEXT,
        status TEXT DEFAULT 'confirmed',
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_graph_entities_type ON graph_entities(type);

      CREATE TABLE IF NOT EXISTS graph_relations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entity_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        description TEXT,
        source_path TEXT,
        status TEXT DEFAULT 'confirmed',
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_graph_relations_source ON graph_relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_graph_relations_target ON graph_relations(target_entity_id);

      CREATE TABLE IF NOT EXISTS graph_claims(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_entity_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_text TEXT,
        object_entity_id TEXT,
        source_path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        chapter_number INTEGER,
        status TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        evidence_chunk_id INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        FOREIGN KEY(evidence_chunk_id) REFERENCES chunks(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_claims_subject ON graph_claims(subject_entity_id);
      CREATE INDEX IF NOT EXISTS idx_graph_claims_status ON graph_claims(status);

      CREATE TABLE IF NOT EXISTS graph_communities(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT UNIQUE NOT NULL,
        summary TEXT NOT NULL,
        updated_at INTEGER
      );
    `);
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  getMeta(key: string): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : "";
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  }

  transaction<T>(fn: () => T): T {
    if (this.isBetterSqlite) {
      return this.db.transaction(fn)();
    } else {
      const db = this.db;
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  }
}
