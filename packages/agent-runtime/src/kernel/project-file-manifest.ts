import { DocumentService } from "@xiaoshuo/document-service";
import { AGENT_DIR } from "@xiaoshuo/project-session";
import fs from "node:fs/promises";
import path from "node:path";

const MANIFEST_VERSION = 1;
const MANIFEST_RELATIVE_PATH = `${AGENT_DIR}/file-manifest.json`;
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".jsonl"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const SKIPPED_AGENT_SUBDIRS = new Set(["cache", "traces"]);
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const EXCERPT_CHARS = 300;

export type ProjectFileManifestEntry = {
  path: string;
  name: string;
  stem: string;
  extension: string;
  size: number;
  updatedAt: string;
  updatedAtMs: number;
  title: string;
  excerpt: string;
  keywords: string[];
};

export type ProjectFileManifest = {
  version: 1;
  projectRoot: string;
  generatedAt: string;
  entries: ProjectFileManifestEntry[];
};

export type ProjectFileManifestServiceOptions = {
  projectRoot: string;
  documents?: DocumentService;
  now?: () => string;
};

export class ProjectFileManifestService {
  readonly projectRoot: string;
  private readonly documents: DocumentService;
  private readonly now: () => string;

  constructor(options: ProjectFileManifestServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.documents = options.documents || new DocumentService({ projectRoot: this.projectRoot });
    this.now = options.now || (() => new Date().toISOString());
  }

  manifestRelativePath(): string {
    return MANIFEST_RELATIVE_PATH;
  }

  manifestPath(): string {
    return path.join(this.projectRoot, MANIFEST_RELATIVE_PATH);
  }

  async readOrBuild(): Promise<ProjectFileManifest> {
    const existing = await this.read();
    if (existing) {
      return existing;
    }
    return this.rebuild();
  }

  async read(): Promise<ProjectFileManifest | null> {
    const raw = await fs.readFile(this.manifestPath(), "utf8").catch(() => "");
    if (!raw.trim()) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ProjectFileManifest>;
      if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
        return null;
      }
      return {
        version: MANIFEST_VERSION,
        projectRoot: String(parsed.projectRoot || this.projectRoot),
        generatedAt: String(parsed.generatedAt || ""),
        entries: parsed.entries.flatMap((entry) => normalizeManifestEntry(entry))
      };
    } catch {
      return null;
    }
  }

  async rebuild(): Promise<ProjectFileManifest> {
    const entries = await this.scanDirectory("");
    const manifest: ProjectFileManifest = {
      version: MANIFEST_VERSION,
      projectRoot: this.projectRoot,
      generatedAt: this.now(),
      entries: entries.sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"))
    };
    const target = this.manifestPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  private async scanDirectory(relativeDir: string): Promise<ProjectFileManifestEntry[]> {
    const absoluteDir = path.join(this.projectRoot, relativeDir);
    const dirents = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    const entries: ProjectFileManifestEntry[] = [];

    for (const dirent of dirents) {
      const relativePath = toPosixPath(path.join(relativeDir, dirent.name));
      if (dirent.isDirectory()) {
        if (shouldSkipDirectory(relativePath, dirent.name)) {
          continue;
        }
        entries.push(...(await this.scanDirectory(relativePath)));
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }

      const extension = path.extname(dirent.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        continue;
      }

      let normalized = "";
      try {
        normalized = this.documents.normalizeRelativePath(relativePath);
      } catch {
        continue;
      }

      const target = path.join(this.projectRoot, normalized);
      const stats = await fs.stat(target).catch(() => null);
      if (!stats?.isFile() || stats.size > MAX_FILE_SIZE) {
        continue;
      }

      const content = await fs.readFile(target, "utf8").catch(() => "");
      const parsed = path.posix.parse(normalized);
      const title = extractTitle(content, extension);
      const excerpt = normalizeWhitespace(content).slice(0, EXCERPT_CHARS);
      entries.push({
        path: normalized,
        name: parsed.base,
        stem: parsed.name,
        extension,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        updatedAtMs: stats.mtimeMs,
        title,
        excerpt,
        keywords: buildKeywords(normalized, parsed.name, title, excerpt)
      });
    }

    return entries;
  }
}

function normalizeManifestEntry(entry: unknown): ProjectFileManifestEntry[] {
  if (!entry || typeof entry !== "object") {
    return [];
  }
  const value = entry as Partial<ProjectFileManifestEntry>;
  const filePath = String(value.path || "").trim();
  if (!filePath) {
    return [];
  }
  return [
    {
      path: filePath,
      name: String(value.name || path.posix.basename(filePath)),
      stem: String(value.stem || path.posix.parse(filePath).name),
      extension: String(value.extension || path.posix.extname(filePath)).toLowerCase(),
      size: toFiniteNumber(value.size),
      updatedAt: String(value.updatedAt || ""),
      updatedAtMs: toFiniteNumber(value.updatedAtMs),
      title: String(value.title || ""),
      excerpt: String(value.excerpt || ""),
      keywords: Array.isArray(value.keywords) ? value.keywords.map((item) => String(item)).filter(Boolean) : []
    }
  ];
}

function shouldSkipDirectory(relativePath: string, name: string): boolean {
  if (SKIPPED_DIRECTORIES.has(name)) {
    return true;
  }
  const agentPrefix = `${AGENT_DIR}/`;
  if (relativePath.startsWith(agentPrefix)) {
    const rest = relativePath.slice(agentPrefix.length);
    const firstSegment = rest.split("/")[0] || "";
    return SKIPPED_AGENT_SUBDIRS.has(firstSegment);
  }
  return false;
}

function extractTitle(content: string, extension: string): string {
  const normalized = normalizeWhitespace(content);
  if (extension === ".md") {
    const heading = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#{1,6}\s+\S/.test(line));
    if (heading) {
      return heading.replace(/^#{1,6}\s+/, "").trim().slice(0, 80);
    }
  }
  return normalized.slice(0, 40);
}

function buildKeywords(relativePath: string, stem: string, title: string, excerpt: string): string[] {
  const values = [
    ...relativePath.split(/[\\/_.\-\s]+/),
    ...stem.split(/[_.\-\s]+/),
    ...extractChineseTerms(stem),
    ...extractChineseTerms(title),
    ...extractChineseTerms(excerpt.slice(0, 120))
  ];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    keywords.push(normalized);
  }
  return keywords.slice(0, 40);
}

function extractChineseTerms(text: string): string[] {
  const terms = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const expanded: string[] = [];
  for (const term of terms) {
    expanded.push(term);
    if (term.length > 4) {
      for (let index = 0; index <= term.length - 2; index += 1) {
        expanded.push(term.slice(index, index + 2));
      }
    }
  }
  return expanded;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
