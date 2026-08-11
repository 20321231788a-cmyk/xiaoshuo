import { AGENT_DIR, BODY_DIR, GENRE_DIR, OUTLINE_DIR, SETTINGS_DIR, STYLE_DIR } from "@xiaoshuo/project-session";
import type { CurrentProject, DocumentInfo, LibraryCard, ProjectChromeSnapshot, ProjectManifestStatus, TimelineEntry, TreeNode } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createProjectId, parseProjectId } from "./project-identity.js";

export const MANIFEST_REL_PATH = `${AGENT_DIR}/project_manifest.json`;
export const TRASH_DIR = "99_回收站";

export const IGNORED_DIRS = new Set([
  ".codex",
  ".gemini",
  ".agent",
  ".git",
  ".gradle",
  ".idea",
  ".vscode",
  ".venv",
  "__pycache__",
  "dist",
  "env",
  "memory_db",
  "build",
  "release",
  "venv",
  "onefile_cache",
  "node_modules",
  TRASH_DIR
]);

export const BROWSABLE_EXTENSIONS = new Set([".txt", ".md"]);

/** Read the persisted identity without rebuilding or repairing the manifest. */
export async function readExistingProjectId(projectPath: string): Promise<string | null> {
  const manifestPath = path.join(path.resolve(projectPath), MANIFEST_REL_PATH);
  const raw = await fs.readFile(manifestPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { project_id?: unknown };
    return parseProjectId(parsed.project_id);
  } catch {
    return null;
  }
}

const GROUP_RULES = [
  [SETTINGS_DIR, "设定集"],
  [OUTLINE_DIR, "大纲"],
  [BODY_DIR, "正文"],
  [STYLE_DIR, "风格库"],
  [GENRE_DIR, "题材库"]
] as const;

const LIBRARY_SPECS = [
  ["character_lore", "人物设定", "设定集", `${SETTINGS_DIR}/设定集/人物设定.txt`],
  ["system_lore", "体系设定", "设定集", `${SETTINGS_DIR}/设定集/体系设定.txt`],
  ["map_lore", "地图设定", "设定集", `${SETTINGS_DIR}/设定集/地图设定.txt`],
  ["item_lore", "道具设定", "设定集", `${SETTINGS_DIR}/设定集/道具设定.txt`],
  ["style_rules", "写作风格", "风格库", `${SETTINGS_DIR}/${STYLE_DIR}/写作风格.txt`],
  ["style_examples", "风格示例", "风格库", `${SETTINGS_DIR}/${STYLE_DIR}/风格示例.txt`],
  ["reference_materials", "参考素材", "风格库", `${SETTINGS_DIR}/${STYLE_DIR}/参考素材.txt`],
  ["genre_rules", "题材规则", "题材库", `${SETTINGS_DIR}/${GENRE_DIR}/题材规则.txt`],
  ["genre_materials", "题材素材", "题材库", `${SETTINGS_DIR}/${GENRE_DIR}/题材素材.txt`],
  ["battle_templates", "战斗模板", "题材库", `${SETTINGS_DIR}/${GENRE_DIR}/战斗模板.txt`],
  ["banned_words", "违禁词", "题材库", `${SETTINGS_DIR}/${GENRE_DIR}/违禁词.txt`]
] as const;

type ManifestEntry = {
  path: string;
  name: string;
  suffix: string;
  group: string;
  size: number;
  mtime: number;
  updated_at: string;
};

type ManifestDiskPayload = {
  project_path: string;
  project_id?: unknown;
  version?: number;
  generated_at?: string;
  entries?: unknown[];
};

type LoadedManifest = {
  project_id: string;
  entries: ManifestEntry[];
  version: number;
  generated_at: string;
};

// Several runtime routes may request a first manifest at once. Coalesce the
// initial scan per manifest path so concurrent callers cannot mint distinct
// project IDs and race the atomic rename.
const inFlightManifestRebuilds = new Map<string, Promise<ManifestEntry[]>>();

export class ProjectManifestService {
  private readonly projectPath: string;
  private readonly manifestPath: string;

  constructor(projectPath: string) {
    this.projectPath = path.resolve(projectPath);
    this.manifestPath = path.join(this.projectPath, MANIFEST_REL_PATH);
  }

  async getProjectId(): Promise<string> {
    const loaded = await this.loadFromDisk();
    if (loaded) {
      return loaded.project_id;
    }
    await this.rebuild();
    const rebuilt = await this.loadFromDisk();
    if (!rebuilt) {
      throw new Error("无法创建项目身份记录");
    }
    return rebuilt.project_id;
  }

  async listDocuments(options: { limit?: number; force?: boolean } = {}): Promise<DocumentInfo[]> {
    const entries = await this.entries(Boolean(options.force));
    return entries.slice(0, Math.max(1, options.limit ?? 2000)).map(toDocumentInfo);
  }

  async tree(options: { force?: boolean } = {}): Promise<TreeNode[]> {
    return buildTreeChildren(await this.entries(Boolean(options.force)), "");
  }

  async subtree(relativePath: string, rootName: string): Promise<TreeNode> {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) {
      return {
        path: "",
        name: rootName,
        kind: "directory",
        size: 0,
        updated_at: "",
        children: await this.tree()
      };
    }

    const entries = await this.entries(false);
    const exact = entries.find((entry) => entry.path === rel);
    if (exact) {
      return {
        path: exact.path,
        name: path.posix.basename(exact.path),
        kind: "file",
        size: exact.size,
        updated_at: exact.updated_at,
        children: []
      };
    }

    const target = path.resolve(this.projectPath, rel);
    if (!isWithinProject(this.projectPath, target)) {
      throw new Error("路径越过项目目录");
    }
    const stats = await fs.stat(target).catch(() => null);
    if (!stats) {
      throw new Error(`路径不存在: ${rel}`);
    }
    if (!stats.isDirectory()) {
      throw new Error("路径不是可读取的文件或目录");
    }
    if (IGNORED_DIRS.has(path.basename(target))) {
      throw new Error("禁止读取系统目录");
    }

    return {
      path: rel,
      name: path.basename(target),
      kind: "directory",
      size: 0,
      updated_at: "",
      children: buildTreeChildren(entries, rel)
    };
  }

  async status(options: { force?: boolean } = {}): Promise<ProjectManifestStatus> {
    const loaded = await this.loadFromDisk();
    const entries = loaded && !options.force ? loaded.entries : await this.rebuild();
    const version = loaded && !options.force ? loaded.version : 1;
    const generatedAt = loaded && !options.force ? loaded.generated_at : formatNow(new Date());
    const manifestSource = loaded && !options.force ? "disk" : "scan";

    return {
      ready: true,
      files: entries.length,
      version,
      generated_at: generatedAt,
      source: manifestSource,
      path: this.manifestPath
    };
  }

  async listLibraryCards(): Promise<LibraryCard[]> {
    const cards = await Promise.all(
      LIBRARY_SPECS.map(async ([key, title, group, relativePath]) => {
        const absolutePath = path.join(this.projectPath, relativePath);
        const text = await readText(absolutePath);
        const stats = await fs.stat(absolutePath).catch(() => null);
        return {
          key,
          title,
          group,
          path: relativePath,
          exists: Boolean(stats),
          chars: text.length,
          summary: text.trim() ? text.trim().replace(/\n/g, " ").slice(0, 120) : "未创建",
          updated_at: stats ? formatMtime(stats.mtimeMs) : ""
        } satisfies LibraryCard;
      })
    );
    return cards;
  }

  async projectChromeSnapshot(currentProject: CurrentProject, timeline: TimelineEntry[], options: { force?: boolean; includeTree?: boolean } = {}): Promise<ProjectChromeSnapshot> {
    return {
      tree: options.includeTree === false ? [] : await this.tree({ force: Boolean(options.force) }),
      libraries: await this.listLibraryCards(),
      timeline,
      current: currentProject,
      version: (await this.status({ force: Boolean(options.force) })).version,
      generated_at: formatNow(new Date())
    };
  }

  async rebuild(): Promise<ManifestEntry[]> {
    const existing = inFlightManifestRebuilds.get(this.manifestPath);
    if (existing) {
      return existing;
    }
    const rebuild = this.rebuildInternal();
    inFlightManifestRebuilds.set(this.manifestPath, rebuild);
    try {
      return await rebuild;
    } finally {
      if (inFlightManifestRebuilds.get(this.manifestPath) === rebuild) {
        inFlightManifestRebuilds.delete(this.manifestPath);
      }
    }
  }

  private async rebuildInternal(): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];
    await walkProject(this.projectPath, async (absolutePath) => {
      const suffix = path.extname(absolutePath).toLowerCase();
      if (!BROWSABLE_EXTENSIONS.has(suffix)) {
        return;
      }
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats?.isFile()) {
        return;
      }
      const relativePath = path.relative(this.projectPath, absolutePath).replace(/\\/g, "/");
      entries.push({
        path: relativePath,
        name: path.parse(absolutePath).name,
        suffix,
        group: groupForPath(relativePath),
        size: stats.size,
        mtime: stats.mtimeMs,
        updated_at: formatMtime(stats.mtimeMs)
      });
    });

    entries.sort((left, right) => compareManifestEntries(left, right));
    const loaded = await this.loadFromDisk();
    if (loaded && manifestEntriesEqual(loaded.entries, entries)) {
      return entries;
    }

    await writeManifestDisk(this.manifestPath, {
      project_path: this.projectPath,
      project_id: loaded?.project_id ?? createProjectId(),
      version: 1,
      generated_at: formatNow(new Date()),
      entries: entries.map((entry) => ({ ...entry }))
    });
    return entries;
  }

  private async entries(force: boolean): Promise<ManifestEntry[]> {
    if (!force) {
      const loaded = await this.loadFromDisk();
      if (loaded) {
        return loaded.entries;
      }
    }
    return this.rebuild();
  }

  private async loadFromDisk(): Promise<LoadedManifest | null> {
    const raw = await fs.readFile(this.manifestPath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as ManifestDiskPayload;
      if (!Array.isArray(parsed.entries)) {
        return null;
      }
      const entries = parsed.entries
        .map(parseManifestEntry)
        .filter((entry): entry is ManifestEntry => entry !== null && BROWSABLE_EXTENSIONS.has(entry.suffix))
        .sort((left, right) => compareManifestEntries(left, right));
      const projectId = parseProjectId(parsed.project_id) ?? createProjectId();
      const version = typeof parsed.version === "number" ? parsed.version : 1;
      const generatedAt = typeof parsed.generated_at === "string" ? parsed.generated_at : "";

      if (parsed.project_path !== this.projectPath || parsed.project_id !== projectId) {
        await writeManifestDisk(this.manifestPath, {
          project_path: this.projectPath,
          project_id: projectId,
          version,
          generated_at: generatedAt,
          entries: entries.map((entry) => ({ ...entry }))
        });
      }

      return {
        project_id: projectId,
        entries,
        version,
        generated_at: generatedAt
      };
    } catch {
      return null;
    }
  }
}

async function walkProject(rootPath: string, onFile: (absolutePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walkProject(absolutePath, onFile);
      continue;
    }
    await onFile(absolutePath);
  }
}

function buildTreeChildren(entries: ManifestEntry[], prefix: string): TreeNode[] {
  const cleanPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
  const prefixParts = cleanPrefix ? cleanPrefix.split("/") : [];
  const directoryChildren = new Map<string, ManifestEntry[]>();
  const fileChildren: ManifestEntry[] = [];

  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (prefixParts.length && parts.slice(0, prefixParts.length).join("/") !== prefixParts.join("/")) {
      continue;
    }
    const remaining = parts.slice(prefixParts.length);
    if (!remaining.length) {
      continue;
    }
    if (remaining.length === 1) {
      fileChildren.push(entry);
      continue;
    }
    const key = remaining[0] || "";
    directoryChildren.set(key, [...(directoryChildren.get(key) || []), entry]);
  }

  const nodes: TreeNode[] = [];
  for (const [name, nestedEntries] of [...directoryChildren.entries()].sort((left, right) => left[0].localeCompare(right[0], "zh-CN", { sensitivity: "base" }))) {
    const nextPath = [...prefixParts, name].filter(Boolean).join("/");
    const children = buildTreeChildren(nestedEntries, nextPath);
    if (children.length) {
      nodes.push({
        path: nextPath,
        name,
        kind: "directory",
        size: 0,
        updated_at: "",
        children
      });
    }
  }

  for (const entry of [...fileChildren].sort((left, right) => path.posix.basename(left.path).localeCompare(path.posix.basename(right.path), "zh-CN", { sensitivity: "base" }))) {
    nodes.push({
      path: entry.path,
      name: path.posix.basename(entry.path),
      kind: "file",
      size: entry.size,
      updated_at: entry.updated_at,
      children: []
    });
  }

  return nodes;
}

function toDocumentInfo(entry: ManifestEntry): DocumentInfo {
  return {
    path: entry.path,
    name: entry.name,
    group: entry.group,
    size: entry.size,
    updated_at: entry.updated_at
  };
}

function parseManifestEntry(value: unknown): ManifestEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const relativePath = typeof record.path === "string" ? record.path : "";
  if (!relativePath) {
    return null;
  }
  return {
    path: relativePath,
    name: typeof record.name === "string" ? record.name : path.parse(relativePath).name,
    suffix: typeof record.suffix === "string" ? record.suffix.toLowerCase() : path.extname(relativePath).toLowerCase(),
    group: typeof record.group === "string" ? record.group : "其他",
    size: typeof record.size === "number" ? record.size : 0,
    mtime: typeof record.mtime === "number" ? record.mtime : 0,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : ""
  };
}

function groupForPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const [marker, group] of GROUP_RULES) {
    if (normalized.includes(marker)) {
      return group;
    }
  }
  return "其他";
}

function compareManifestEntries(left: ManifestEntry, right: ManifestEntry): number {
  const groupCompare = left.group.localeCompare(right.group, "zh-CN", { sensitivity: "base" });
  if (groupCompare !== 0) {
    return groupCompare;
  }
  return left.path.localeCompare(right.path, "zh-CN", { sensitivity: "base" });
}

function manifestEntriesEqual(left: ManifestEntry[], right: ManifestEntry[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.path !== b.path ||
      a.name !== b.name ||
      a.suffix !== b.suffix ||
      a.group !== b.group ||
      a.size !== b.size ||
      a.mtime !== b.mtime ||
      a.updated_at !== b.updated_at
    ) {
      return false;
    }
  }
  return true;
}

function normalizeRelativePath(relativePath: string): string {
  const trimmed = (relativePath || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed === ".") {
    return "";
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("非法项目路径");
  }
  if (normalized.split("/").some((part) => IGNORED_DIRS.has(part))) {
    throw new Error("禁止读取系统目录");
  }
  return normalized;
}

function isWithinProject(projectPath: string, targetPath: string): boolean {
  const root = path.resolve(projectPath);
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function readText(filePath: string): Promise<string> {
  return (await fs.readFile(filePath, "utf8").catch(() => "")).slice(0, 200_000);
}

async function writeManifestDisk(filePath: string, payload: ManifestDiskPayload): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function formatMtime(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatNow(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
