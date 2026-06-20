import * as fs from "node:fs";
import * as path from "node:path";
import { loadEmbeddingConfig } from "@xiaoshuo/config-service";
import type { VectorIndexStatus } from "@xiaoshuo/shared";
import type { VectorHit } from "./search.js";
import { EmbeddingClient } from "./embedding-client.js";
import { VectorDb } from "./vector-db.js";
import { GraphContext } from "./graph-context.js";
import {
  hashText,
  getKeywordTerms,
  searchKeywordsInChunks,
  cosineSimilarity,
  mergeHits,
  hitExcerptLimit,
  excerptText,
  prepareQuery,
  sourceWeight
} from "./search.js";

const INDEXABLE_SUFFIXES = new Set([".txt", ".md"]);
const IGNORED_DIRS = new Set([".git", ".svn", ".hg", "node_modules", "__pycache__", ".agent"]);

const BODY_DIR = "02_正文";
const OUTLINE_DIR = "01_大纲";
const SETTINGS_DIR = "00_设定集";
const STYLE_DIR = "风格库";
const GENRE_DIR = "题材库";

export function getSourceType(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith(`${BODY_DIR}/`)) {
    return "body";
  }
  if (normalized.startsWith(`${OUTLINE_DIR}/`)) {
    return "outline";
  }
  if (normalized.includes(`/${STYLE_DIR}/`)) {
    return "style";
  }
  if (normalized.includes(`/${GENRE_DIR}/`)) {
    return "genre";
  }
  if (normalized.startsWith(`${SETTINGS_DIR}/`)) {
    return "lore";
  }
  return "document";
}

export function chunkSizeFor(sourceType: string): [number, number] {
  if (sourceType === "body") {
    return [1100, 120];
  }
  return [700, 80];
}

export function splitChunks(text: string, sourceType: string): Array<[number, number, string]> {
  const [target, overlap] = chunkSizeFor(sourceType);
  const paragraphs = (text || "")
    .split(/\r?\n\s*\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    const compact = (text || "").trim();
    return compact ? [[0, compact.length, compact]] : [];
  }

  const chunks: Array<[number, number, string]> = [];
  let cursor = 0;
  let current: string[] = [];
  let start = 0;

  function flush(endHint: number) {
    const body = current.join("\n\n").trim();
    if (body) {
      chunks.push([start, endHint, body]);
    }
    if (body && overlap > 0) {
      const tail = body.slice(-overlap);
      current = [tail];
      start = Math.max(0, endHint - tail.length);
    } else {
      current = [];
      start = endHint;
    }
  }

  for (const paragraph of paragraphs) {
    let paraStart = text.indexOf(paragraph, cursor);
    if (paraStart < 0) {
      paraStart = cursor;
    }
    const paraEnd = paraStart + paragraph.length;
    if (current.length === 0) {
      start = paraStart;
    }

    const currentLen = current.reduce((sum, item) => sum + item.length, 0);
    if (currentLen + paragraph.length > target && current.length > 0) {
      flush(paraStart);
    }

    if (paragraph.length > target * 1.4) {
      // Chunk overly long paragraph
      for (let offset = 0; offset < paragraph.length; offset += target - overlap) {
        const piece = paragraph.slice(offset, offset + target).trim();
        if (piece) {
          chunks.push([paraStart + offset, paraStart + offset + piece.length, piece]);
        }
      }
      current = [];
      start = paraEnd;
    } else {
      current.push(paragraph);
    }
    cursor = paraEnd;
  }

  if (current.length > 0) {
    flush(text.length);
  }

  return chunks;
}

export function readManifestPaths(projectPath: string, suffixes: Set<string>): string[] {
  const manifestPath = path.join(projectPath, "00_设定集", ".agent", "project_manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const rawEntries = data?.entries;
    if (!Array.isArray(rawEntries)) {
      return [];
    }
    const paths: string[] = [];
    for (const item of rawEntries) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rel = String(item.path || "");
      const suffix = String(item.suffix || path.extname(rel)).toLowerCase();
      if (!rel || !suffixes.has(suffix)) {
        continue;
      }
      const absPath = path.join(projectPath, rel);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        paths.push(absPath);
      }
    }
    return paths.sort();
  } catch {
    return [];
  }
}

export class VectorIndex {
  private readonly projectPath: string;
  private readonly db: VectorDb;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.db = new VectorDb(projectPath);
  }

  close(): void {
    this.db.close();
  }

  async status(): Promise<VectorIndexStatus> {
    const config = await loadEmbeddingConfig({ rootDir: this.projectPath });
    let embeddingKey = "";
    if (config.configured) {
      const client = new EmbeddingClient(config);
      embeddingKey = client.storageModel();
    }

    if (!this.db.exists()) {
      return {
        enabled: config.enabled,
        configured: config.configured,
        db: this.db.getDbPath(),
        chunks: 0,
        embedded_chunks: 0,
        current_embedded_chunks: 0,
        pending_files: 0,
        embedding_model: embeddingKey,
        ready: false,
        updated_at: ""
      };
    }

    this.db.init();
    const conn = this.db.db;

    const chunks = (conn.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }).count;
    const embedded = (conn.prepare("SELECT COUNT(*) as count FROM embeddings").get() as { count: number }).count; // This counts total embeddings entries
    const pendingFiles = (conn.prepare("SELECT COUNT(*) as count FROM pending_files").get() as { count: number }).count; // pending files

    let currentEmbedded = 0;
    if (embeddingKey) {
      currentEmbedded = (
        conn.prepare(`
          SELECT COUNT(*) as count
          FROM embeddings e
          JOIN chunks c ON c.id = e.chunk_id
          WHERE e.model = ?
        `).get(embeddingKey) as { count: number }
      ).count;
    }

    const updatedAt = this.db.getMeta("updated_at");

    return {
      enabled: config.enabled,
      configured: config.configured,
      db: this.db.getDbPath(),
      chunks,
      embedded_chunks: embedded,
      current_embedded_chunks: currentEmbedded,
      pending_files: pendingFiles,
      embedding_model: embeddingKey,
      ready: Boolean(embeddingKey && chunks > 0 && currentEmbedded >= chunks),
      updated_at: updatedAt
    };
  }

  async rebuild(progress?: (value: number, message: string) => void): Promise<VectorIndexStatus & { files?: number; changed_chunks?: number }> {
    this.db.init();
    const files = this.collectFiles();
    const config = await loadEmbeddingConfig({ rootDir: this.projectPath });
    let embedder: EmbeddingClient | null = null;
    let embeddingKey = "";
    if (config.configured) {
      embedder = new EmbeddingClient(config);
      embeddingKey = embedder.storageModel();
    }

    const batchSize = Math.max(1, Math.min(128, config.batch_size || 16));
    const changedChunks: Array<[number, string]> = [];

    this.db.transaction(() => {
      this.deleteMissing(files);
      this.deleteOrphanEmbeddings();
      
      const total = Math.max(files.length, 1);
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const rel = path.relative(this.projectPath, file).replace(/\\/g, "/");
        const mtime = fs.statSync(file).mtimeMs / 1000;

        if (this.isFileCurrent(rel, mtime, embeddingKey, config.configured)) {
          progress?.((i + 1) / total * 0.45, `Index unchanged ${i + 1}/${files.length}`);
          continue;
        }

        const fileChunks = this.indexFile(file, rel, mtime);
        changedChunks.push(...fileChunks);
        progress?.((i + 1) / total * 0.45, `Chunk ${i + 1}/${files.length}`);
      }
    });

    if (embedder && changedChunks.length > 0) {
      const conn = this.db.db;
      const totalChunks = changedChunks.length;
      for (let offset = 0; offset < totalChunks; offset += batchSize) {
        const batch = changedChunks.slice(offset, offset + batchSize);
        const vectors = await embedder.embed(batch.map((item) => item[1]));

        this.db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            const [chunkId] = batch[j]!;
            const vector = vectors[j]!;
            conn.prepare(`
              INSERT OR REPLACE INTO embeddings(chunk_id, model, dim, vector_json)
              VALUES (?, ?, ?, ?)
            `).run(chunkId, embeddingKey, vector.length, JSON.stringify(vector));
          }
        });

        const progressVal = 0.45 + Math.min(0.5, (offset + batch.length) / totalChunks * 0.5);
        progress?.(progressVal, `Embed ${offset + batch.length}/${totalChunks}`);
      }
    }

    this.db.transaction(() => {
      this.db.setMeta("updated_at", String(Math.floor(Date.now() / 1000)));
      this.db.setMeta("embedding_model", embeddingKey);
      this.deleteOrphanEmbeddings();
      this.db.db.prepare("DELETE FROM pending_files").run();
    });

    // rebuild graph context
    let graph: GraphContext | null = null;
    try {
      graph = new GraphContext(this.projectPath);
      graph.rebuildGraph();
    } catch (err) {
      console.error("Failed to rebuild graph database:", err);
    } finally {
      graph?.close();
    }

    progress?.(1.0, "Vector index ready");
    const finalStatus = await this.status();
    return {
      ...finalStatus,
      files: files.length,
      changed_chunks: changedChunks.length
    };
  }

  markChanged(paths: string[], action: "upsert" | "delete" = "upsert"): { queued: number; paths: string[]; action: string } {
    if (action !== "upsert" && action !== "delete") {
      throw new Error(`Unsupported vector pending action: ${action}`);
    }

    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const p of paths) {
      const rel = this.normalizeIndexPath(p);
      if (!rel || seen.has(rel)) {
        continue;
      }
      seen.add(rel);
      normalized.push(rel);
    }

    if (normalized.length === 0) {
      return { queued: 0, paths: [], action };
    }

    this.db.init();
    const conn = this.db.db;
    const now = Math.floor(Date.now() / 1000);

    this.db.transaction(() => {
      const stmt = conn.prepare(`
        INSERT OR REPLACE INTO pending_files(path, action, updated_at)
        VALUES (?, ?, ?)
      `);
      for (const rel of normalized) {
        stmt.run(rel, action, now);
      }
    });

    return { queued: normalized.length, paths: normalized, action };
  }

  async processPending(
    progress?: (value: number, message: string) => void,
    options: { limit?: number } = {}
  ): Promise<
    VectorIndexStatus & {
      pending_before?: number;
      processed_files?: number;
      indexed_files?: number;
      deleted_files?: number;
      skipped_files?: number;
      failed_files?: Array<{ path: string; error: string }>;
      changed_chunks?: number;
      embedded_chunks?: number;
    }
  > {
    this.db.init();
    const conn = this.db.db;
    const config = await loadEmbeddingConfig({ rootDir: this.projectPath });
    let embedder: EmbeddingClient | null = null;
    let embeddingKey = "";
    if (config.configured) {
      embedder = new EmbeddingClient(config);
      embeddingKey = embedder.storageModel();
    }

    const pendingBefore = (conn.prepare("SELECT COUNT(*) as count FROM pending_files").get() as { count: number }).count;
    if (pendingBefore <= 0) {
      progress?.(1.0, "Vector index has no pending files");
      const st = await this.status();
      return {
        ...st,
        pending_before: 0,
        processed_files: 0,
        indexed_files: 0,
        deleted_files: 0,
        skipped_files: 0,
        failed_files: [],
        changed_chunks: 0,
        embedded_chunks: 0
      };
    }

    const limit = options.limit && options.limit > 0 ? options.limit : pendingBefore;
    const rows = conn
      .prepare(`
        SELECT path, action
        FROM pending_files
        ORDER BY updated_at ASC, path ASC
        LIMIT ?
      `)
      .all(limit) as Array<{ path: string; action: string }>;

    const total = Math.max(rows.length, 1);
    let processedFiles = 0;
    let indexedFiles = 0;
    let deletedFiles = 0;
    let skippedFiles = 0;
    const failedFiles: Array<{ path: string; error: string }> = [];
    const changedChunks: Array<[number, string]> = [];
    const pendingEmbeddingPaths = new Set<string>();

    const batchSize = Math.max(1, Math.min(128, config.batch_size || 16));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rel = row.path;
      const action = row.action;
      processedFiles++;

      try {
        const normalized = this.normalizeIndexPath(rel);
        if (!normalized) {
          this.db.transaction(() => {
            conn.prepare("DELETE FROM pending_files WHERE path = ?").run(rel);
          });
          skippedFiles++;
        } else if (action === "delete") {
          this.db.transaction(() => {
            this.deleteChunksForPath(normalized);
            conn.prepare("DELETE FROM pending_files WHERE path = ?").run(rel);
          });
          deletedFiles++;
        } else {
          const absPath = this.resolveIndexPath(normalized);
          if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            this.db.transaction(() => {
              this.deleteChunksForPath(normalized);
              conn.prepare("DELETE FROM pending_files WHERE path = ?").run(rel);
            });
            deletedFiles++;
          } else {
            const mtime = fs.statSync(absPath).mtimeMs / 1000;
            if (this.isFileCurrent(normalized, mtime, embeddingKey, config.configured)) {
              this.db.transaction(() => {
                conn.prepare("DELETE FROM pending_files WHERE path = ?").run(rel);
              });
              skippedFiles++;
            } else {
              this.db.transaction(() => {
                const fileChunks = this.indexFile(absPath, normalized, mtime);
                changedChunks.push(...fileChunks);
                indexedFiles++;
                if (embedder && fileChunks.length > 0) {
                  pendingEmbeddingPaths.add(normalized);
                } else {
                  conn.prepare("DELETE FROM pending_files WHERE path = ?").run(rel);
                }
              });
            }
          }
        }

        progress?.((i + 1) / total * 0.45, `Index pending ${i + 1}/${rows.length}`);
      } catch (err) {
        failedFiles.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
      }
    }

    let embeddedChunksCount = 0;
    if (embedder && changedChunks.length > 0) {
      for (let offset = 0; offset < changedChunks.length; offset += batchSize) {
        const batch = changedChunks.slice(offset, offset + batchSize);
        const vectors = await embedder.embed(batch.map((item) => item[1]));

        this.db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            const [chunkId] = batch[j]!;
            const vector = vectors[j]!;
            conn.prepare(`
              INSERT OR REPLACE INTO embeddings(chunk_id, model, dim, vector_json)
              VALUES (?, ?, ?, ?)
            `).run(chunkId, embeddingKey, vector.length, JSON.stringify(vector));
          }
        });

        embeddedChunksCount += batch.length;
        const progressVal = 0.45 + Math.min(0.5, embeddedChunksCount / changedChunks.length * 0.5);
        progress?.(progressVal, `Embed pending ${embeddedChunksCount}/${changedChunks.length}`);
      }

      this.db.transaction(() => {
        const stmt = conn.prepare("DELETE FROM pending_files WHERE path = ?");
        for (const rel of pendingEmbeddingPaths) {
          stmt.run(rel);
        }
      });
    }

    this.db.transaction(() => {
      this.db.setMeta("updated_at", String(Math.floor(Date.now() / 1000)));
      this.db.setMeta("embedding_model", embeddingKey);
      this.deleteOrphanEmbeddings();
    });

    // rebuild graph context
    let graph: GraphContext | null = null;
    try {
      graph = new GraphContext(this.projectPath);
      graph.rebuildGraph();
    } catch (err) {
      console.error("Failed to rebuild graph database:", err);
    } finally {
      graph?.close();
    }

    progress?.(1.0, "Vector pending index ready");
    const st = await this.status();
    return {
      ...st,
      pending_before: pendingBefore,
      processed_files: processedFiles,
      indexed_files: indexedFiles,
      deleted_files: deletedFiles,
      skipped_files: skippedFiles,
      failed_files: failedFiles,
      changed_chunks: changedChunks.length,
      embedded_chunks: embeddedChunksCount
    };
  }

  async search(query: string, options: { topK?: number; maxChars?: number } = {}): Promise<VectorHit[]> {
    const prepared = prepareQuery(query);
    if (!prepared || !this.db.exists()) {
      return [];
    }

    this.db.init();
    const conn = this.db.db;

    const config = await loadEmbeddingConfig({ rootDir: this.projectPath });
    const topK = options.topK && options.topK > 0 ? options.topK : 12;
    const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : 18000;

    let vectorHits: VectorHit[] = [];
    if (config.enabled && config.configured) {
      try {
        const embedder = new EmbeddingClient(config);
        const storageModel = embedder.storageModel();
        if (this.hasEmbeddings(storageModel)) {
          const vectors = await embedder.embed([prepared]);
          const queryVector = vectors[0];
          if (queryVector) {
            vectorHits = this.searchVector(queryVector, topK * 3, storageModel);
          }
        }
      } catch {
        vectorHits = [];
      }
    }

    const allChunks = conn.prepare("SELECT path, source_type, title, text FROM chunks").all() as Array<{
      path: string;
      source_type: string;
      title: string;
      text: string;
    }>;

    const keywordHits = searchKeywordsInChunks(allChunks, prepared, topK * 3);
    const merged = mergeHits(vectorHits, keywordHits, topK);

    const clipped: VectorHit[] = [];
    let usedChars = 0;

    for (const hit of merged) {
      if (usedChars >= maxChars) {
        break;
      }
      const remaining = maxChars - usedChars;
      const limit = hitExcerptLimit(hit, topK, maxChars);
      const text = excerptText(hit.text, Math.min(remaining, limit));
      clipped.push({
        path: hit.path,
        source_type: hit.source_type,
        title: hit.title,
        text,
        score: hit.score
      });
      usedChars += text.length;
    }

    return clipped;
  }

  formatHits(hits: VectorHit[]): string {
    const parts: string[] = [];
    for (const hit of hits) {
      parts.push(`[${hit.source_type}] ${hit.path}  score=${hit.score.toFixed(3)}\n${hit.text}`);
    }
    return parts.join("\n\n").trim();
  }

  async buildContext(query: string, options: { topK?: number; maxChars?: number } = {}): Promise<string> {
    const hits = await this.search(query, options);
    return this.formatHits(hits) || "None";
  }

  private collectFiles(): string[] {
    const manifestPaths = readManifestPaths(this.projectPath, INDEXABLE_SUFFIXES);
    if (manifestPaths.length > 0) {
      return manifestPaths;
    }

    const files: string[] = [];
    const walk = (dir: string) => {
      const list = fs.readdirSync(dir);
      for (const file of list) {
        if (IGNORED_DIRS.has(file)) {
          continue;
        }
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          const ext = path.extname(file).toLowerCase();
          if (INDEXABLE_SUFFIXES.has(ext)) {
            files.push(full);
          }
        }
      }
    };

    if (fs.existsSync(this.projectPath)) {
      walk(this.projectPath);
    }
    return files.sort();
  }

  private deleteMissing(files: string[]): void {
    const conn = this.db.db;
    const rels = new Set(files.map((file) => path.relative(this.projectPath, file).replace(/\\/g, "/")));
    const rows = conn.prepare("SELECT DISTINCT path FROM chunks").all() as Array<{ path: string }>;
    for (const row of rows) {
      if (!rels.has(row.path)) {
        this.deleteChunksForPath(row.path);
      }
    }
  }

  private indexFile(filePath: string, rel: string, mtime: number): Array<[number, string]> {
    const conn = this.db.db;
    this.deleteChunksForPath(rel);
    const text = fs.readFileSync(filePath, "utf8");
    const sourceType = getSourceType(rel);
    const chunks = splitChunks(text, sourceType);

    const changedChunks: Array<[number, string]> = [];
    const stmt = conn.prepare(`
      INSERT INTO chunks(path, source_type, title, chunk_index, start_char, end_char, text, text_hash, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < chunks.length; i++) {
      const [start, end, chunkText] = chunks[i]!;
      const hash = hashText(chunkText);
      const res = stmt.run(rel, sourceType, path.basename(filePath, path.extname(filePath)), i, start, end, chunkText, hash, mtime);
      changedChunks.push([Number(res.lastInsertRowid), chunkText]);
    }

    return changedChunks;
  }

  private normalizeIndexPath(relPath: string): string {
    let rel = (relPath || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
    if (!rel) {
      return "";
    }
    rel = path.normalize(rel).replace(/\\/g, "/");
    if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../") || /^[A-Za-z]:/.test(rel)) {
      return "";
    }
    const parts = rel.split("/");
    if (parts.some((part) => IGNORED_DIRS.has(part))) {
      return "";
    }
    const ext = path.extname(rel).toLowerCase();
    if (!INDEXABLE_SUFFIXES.has(ext)) {
      return "";
    }
    return rel;
  }

  private resolveIndexPath(relPath: string): string | null {
    try {
      const root = path.resolve(this.projectPath);
      const target = path.resolve(root, relPath);
      if (target === root || !target.startsWith(root)) {
        return null;
      }
      return target;
    } catch {
      return null;
    }
  }

  private deleteChunksForPath(rel: string): void {
    const conn = this.db.db;
    conn.prepare("DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)").run(rel);
    conn.prepare("DELETE FROM chunks WHERE path = ?").run(rel);
  }

  private deleteOrphanEmbeddings(): void {
    const conn = this.db.db;
    conn.prepare("DELETE FROM embeddings WHERE chunk_id NOT IN (SELECT id FROM chunks)").run();
  }

  private isFileCurrent(rel: string, mtime: number, model: string, requiresEmbedding: boolean): boolean {
    const conn = this.db.db;
    const row = conn.prepare("SELECT COUNT(*) as count, MAX(mtime) as max_mtime FROM chunks WHERE path = ?").get(rel) as
      | { count: number; max_mtime: number | null }
      | undefined;

    if (!row || row.count <= 0 || row.max_mtime === null) {
      return false;
    }
    if (Math.abs(row.max_mtime - mtime) > 0.001) {
      return false;
    }
    if (!requiresEmbedding) {
      return true;
    }
    const missing = (
      conn
        .prepare(`
          SELECT COUNT(*) as count
          FROM chunks c
          LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?
          WHERE c.path = ? AND e.chunk_id IS NULL
        `)
        .get(model, rel) as { count: number }
    ).count;

    return missing === 0;
  }

  private hasEmbeddings(model: string): boolean {
    if (!model) {
      return false;
    }
    const conn = this.db.db;
    const row = conn.prepare("SELECT 1 FROM embeddings WHERE model = ? LIMIT 1").get(model);
    return Boolean(row);
  }

  private searchVector(queryVector: number[], limit: number, model: string): VectorHit[] {
    const conn = this.db.db;
    const rows = conn
      .prepare(`
        SELECT c.path, c.source_type, c.title, c.text, e.vector_json
        FROM embeddings e
        JOIN chunks c ON c.id = e.chunk_id
        WHERE e.model = ? AND e.dim = ?
      `)
      .all(model, queryVector.length) as Array<{
      path: string;
      source_type: string;
      title: string;
      text: string;
      vector_json: string;
    }>;

    const hits: VectorHit[] = [];
    for (const row of rows) {
      let vector: number[];
      try {
        vector = JSON.parse(row.vector_json);
      } catch {
        continue;
      }
      if (vector.length !== queryVector.length) {
        continue;
      }
      const score = Math.min(1.0, cosineSimilarity(queryVector, vector) * sourceWeight(row.source_type));
      hits.push({
        path: row.path,
        source_type: row.source_type,
        title: row.title,
        text: row.text,
        score
      });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
