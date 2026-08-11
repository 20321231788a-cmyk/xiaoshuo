import { DocumentService } from "@xiaoshuo/document-service";
import type { ProjectFileReferenceCandidate, ProjectFileResolveResponse } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { ProjectFileManifestService, type ProjectFileManifestEntry } from "./project-file-manifest.js";

const AUTO_REFERENCE_THRESHOLD = 0.85;
const CANDIDATE_THRESHOLD = 0.55;
const DEFAULT_MAX_CANDIDATES = 8;
const MAX_AUTO_REFERENCES = 5;
const PATH_EXTENSION_PATTERN = /\.(?:txt|md|jsonl)$/i;

type FileAlias = {
  pattern: RegExp;
  paths?: string[];
  query?: string;
  confidence: number;
};

const FILE_ALIASES: FileAlias[] = [
  { pattern: /章纲(?:文件|文档)?/, paths: ["01_大纲/章纲.txt"], confidence: 0.98 },
  { pattern: /细纲(?:文件|文档)?/, paths: ["01_大纲/细纲.txt"], confidence: 0.98 },
  { pattern: /大纲(?:文件|文档)?/, paths: ["01_大纲/大纲.txt"], confidence: 0.95 },
  { pattern: /风格(?:样本|文件|文档)?/, paths: ["02_设定/风格.txt", "00_设定/风格.txt"], confidence: 0.75 },
  { pattern: /人物(?:设定|档案|小传)?/, query: "人物 设定", confidence: 0.7 },
  { pattern: /角色(?:设定|档案|小传)?/, query: "角色 人物", confidence: 0.65 },
  { pattern: /世界观|设定集|背景设定/, query: "世界观 设定", confidence: 0.7 },
  { pattern: /正文(?:文件|文档)?/, query: "正文", confidence: 0.65 }
];

const CURRENT_DOCUMENT_PATTERN = /当前(?:文档|文件)|这篇|这章|本文/;
const NEGATED_PREFIX_PATTERN = /(?:不要|不用|无需|别|不必|不参考)\s*$/;

export type ProjectFileResolverInput = {
  text: string;
  currentPath?: string;
  selection?: string;
  attachmentIds?: string[];
  explicitPaths?: string[];
  confirmedPaths?: string[];
  disableAutoReferences?: boolean;
  maxCandidates?: number;
};

export type ProjectFileResolverOptions = {
  projectRoot: string;
  documents?: DocumentService;
  manifest?: ProjectFileManifestService;
};

type CandidateDraft = {
  label: string;
  path: string;
  kind: ProjectFileReferenceCandidate["kind"];
  confidence: number;
  reason: string;
  matched_text: string;
  exists?: boolean;
  readable?: boolean;
  chars?: number;
  updated_at?: string;
};

export class ProjectFileResolver {
  readonly projectRoot: string;
  private readonly documents: DocumentService;
  private readonly manifest: ProjectFileManifestService;

  constructor(options: ProjectFileResolverOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.documents = options.documents || new DocumentService({ projectRoot: this.projectRoot });
    this.manifest = options.manifest || new ProjectFileManifestService({ projectRoot: this.projectRoot, documents: this.documents });
  }

  async resolve(input: ProjectFileResolverInput): Promise<ProjectFileResolveResponse> {
    const warnings: string[] = [];
    const drafts: CandidateDraft[] = [];
    const text = String(input.text || "");
    const maxCandidates = clampInt(input.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 1, 20);

    await this.addPathDrafts(drafts, warnings, input.confirmedPaths || [], "explicit_path", 1, "用户已确认引用路径", "");
    await this.addPathDrafts(drafts, warnings, input.explicitPaths || [], "explicit_path", 0.99, "用户显式选择引用路径", "");
    await this.addAtPathDrafts(drafts, warnings, text);
    await this.addQuotedPathDrafts(drafts, warnings, text);
    await this.addInlinePathDrafts(drafts, warnings, text);

    if (!input.disableAutoReferences) {
      await this.addAliasDrafts(drafts, warnings, text);
      await this.addCurrentDocumentDraft(drafts, warnings, text, input.currentPath);
      await this.addQuotedManifestDrafts(drafts, warnings, text);
    }

    const hydrated = await this.hydrateAndDedupe(drafts, warnings);
    const references = hydrated
      .filter((candidate) => candidate.readable && candidate.confidence >= AUTO_REFERENCE_THRESHOLD)
      .sort(sortCandidates)
      .slice(0, MAX_AUTO_REFERENCES);
    const referencePaths = new Set(references.map((candidate) => candidate.path));
    const candidates = hydrated
      .filter((candidate) => !referencePaths.has(candidate.path))
      .filter((candidate) => candidate.confidence >= CANDIDATE_THRESHOLD && candidate.confidence < AUTO_REFERENCE_THRESHOLD)
      .sort(sortCandidates)
      .slice(0, maxCandidates);

    return {
      references,
      candidates,
      ambiguous: candidates.length > 0,
      warnings
    };
  }

  private async addPathDrafts(
    drafts: CandidateDraft[],
    warnings: string[],
    rawPaths: string[],
    kind: ProjectFileReferenceCandidate["kind"],
    confidence: number,
    reason: string,
    matchedText: string
  ): Promise<void> {
    for (const rawPath of rawPaths) {
      const normalized = this.safeNormalizeInputPath(rawPath, warnings);
      if (!normalized) {
        continue;
      }
      drafts.push({
        label: path.posix.basename(normalized),
        path: normalized,
        kind,
        confidence,
        reason,
        matched_text: matchedText || rawPath
      });
    }
  }

  private async addAtPathDrafts(drafts: CandidateDraft[], warnings: string[], text: string): Promise<void> {
    const matches = text.matchAll(/@([^\s，。；;："'`“”]+(?:\.(?:txt|md|jsonl))?)/gi);
    for (const match of matches) {
      const rawPath = match[1] || "";
      const normalized = this.safeNormalizeInputPath(rawPath, warnings);
      if (!normalized) {
        continue;
      }
      drafts.push({
        label: path.posix.basename(normalized),
        path: normalized,
        kind: "at_path",
        confidence: 0.99,
        reason: `用户使用 @ 引用了 ${normalized}`,
        matched_text: match[0] || rawPath
      });
    }
  }

  private async addQuotedPathDrafts(drafts: CandidateDraft[], warnings: string[], text: string): Promise<void> {
    for (const quoted of extractQuotedSegments(text)) {
      if (!looksLikePath(quoted)) {
        continue;
      }
      const normalized = this.safeNormalizeInputPath(quoted, warnings);
      if (!normalized) {
        continue;
      }
      drafts.push({
        label: path.posix.basename(normalized),
        path: normalized,
        kind: "explicit_path",
        confidence: 0.97,
        reason: `用户在引号中提到路径 ${normalized}`,
        matched_text: quoted
      });
    }
  }

  private async addInlinePathDrafts(drafts: CandidateDraft[], warnings: string[], text: string): Promise<void> {
    const matches = text.matchAll(/(?:^|[\s，。；;：])([A-Za-z]:[\\/][^\s，。；;："'`“”]+?\.(?:txt|md|jsonl)|[^\s，。；;："'`“”]+?\.(?:txt|md|jsonl))/gi);
    for (const match of matches) {
      const rawPath = match[1] || "";
      const normalized = this.safeNormalizeInputPath(rawPath, warnings);
      if (!normalized) {
        continue;
      }
      drafts.push({
        label: path.posix.basename(normalized),
        path: normalized,
        kind: "explicit_path",
        confidence: 0.96,
        reason: `用户显式提到路径 ${normalized}`,
        matched_text: rawPath
      });
    }
  }

  private async addAliasDrafts(drafts: CandidateDraft[], warnings: string[], text: string): Promise<void> {
    const searchableText = scrubExplicitPaths(text);
    for (const alias of FILE_ALIASES) {
      const match = alias.pattern.exec(searchableText);
      if (!match) {
        continue;
      }
      if (isNegated(searchableText, match.index)) {
        continue;
      }
      const matchedText = match[0] || "";
      if (alias.paths?.length) {
        let addedReadablePath = false;
        for (const aliasPath of alias.paths) {
          const normalized = this.safeNormalizeInputPath(aliasPath, warnings);
          if (!normalized) {
            continue;
          }
          const status = await this.probePath(normalized);
          if (status.readable) {
            drafts.push({
              label: matchedText,
              path: normalized,
              kind: "alias",
              confidence: alias.confidence,
              reason: `用户提到“${matchedText}”`,
              matched_text: matchedText
            });
            addedReadablePath = true;
            break;
          }
        }
        if (!addedReadablePath) {
          await this.addManifestDrafts(drafts, alias.query || matchedText, matchedText, alias.confidence, `用户提到“${matchedText}”，固定路径不存在，改用 manifest 检索`);
        }
        continue;
      }
      if (alias.query) {
        await this.addManifestDrafts(drafts, alias.query, matchedText, alias.confidence, `用户提到“${matchedText}”`);
      }
    }
  }

  private async addCurrentDocumentDraft(drafts: CandidateDraft[], warnings: string[], text: string, currentPath?: string): Promise<void> {
    if (!CURRENT_DOCUMENT_PATTERN.test(text)) {
      return;
    }
    if (!currentPath) {
      warnings.push("用户提到当前文档，但请求中没有 current_path。");
      return;
    }
    const normalized = this.safeNormalizeInputPath(currentPath, warnings);
    if (!normalized) {
      return;
    }
    drafts.push({
      label: "当前文档",
      path: normalized,
      kind: "current_document",
      confidence: 0.95,
      reason: "用户提到当前文档",
      matched_text: "当前文档"
    });
  }

  private async addQuotedManifestDrafts(drafts: CandidateDraft[], warnings: string[], text: string): Promise<void> {
    for (const quoted of extractQuotedSegments(text)) {
      const query = quoted.trim();
      if (!query || looksLikePath(query) || query.length > 40) {
        continue;
      }
      await this.addManifestDrafts(drafts, query, query, 0.68, `用户在引号中提到“${query}”`);
    }
  }

  private async addManifestDrafts(
    drafts: CandidateDraft[],
    query: string,
    matchedText: string,
    baseConfidence: number,
    reason: string
  ): Promise<void> {
    const manifest = await this.manifest.readOrBuild();
    const matches = searchManifest(manifest.entries, query, baseConfidence);
    for (const match of matches) {
      drafts.push({
        label: match.entry.title || match.entry.stem || match.entry.name,
        path: match.entry.path,
        kind: "manifest_match",
        confidence: match.confidence,
        reason,
        matched_text: matchedText,
        exists: true,
        readable: true,
        chars: Math.trunc(match.entry.size),
        updated_at: match.entry.updatedAt
      });
    }
  }

  private async hydrateAndDedupe(drafts: CandidateDraft[], warnings: string[]): Promise<ProjectFileReferenceCandidate[]> {
    const byPath = new Map<string, ProjectFileReferenceCandidate>();
    for (const draft of drafts) {
      if (!draft.path) {
        continue;
      }
      const status = draft.readable === true ? {
        exists: draft.exists ?? true,
        readable: true,
        chars: draft.chars ?? 0,
        updated_at: draft.updated_at ?? ""
      } : await this.probePath(draft.path);
      const candidate: ProjectFileReferenceCandidate = {
        label: draft.label || path.posix.basename(draft.path),
        path: draft.path,
        kind: draft.kind,
        confidence: draft.confidence,
        reason: draft.reason,
        matched_text: draft.matched_text,
        exists: status.exists,
        readable: status.readable,
        chars: status.chars,
        updated_at: status.updated_at
      };
      if (!candidate.readable && candidate.confidence >= AUTO_REFERENCE_THRESHOLD) {
        candidate.confidence = Math.min(0.84, candidate.confidence);
      }
      const previous = byPath.get(candidate.path);
      if (!previous || sortCandidates(candidate, previous) < 0) {
        byPath.set(candidate.path, candidate);
      }
    }
    return [...byPath.values()].filter((candidate) => {
      if (candidate.confidence >= CANDIDATE_THRESHOLD) {
        return true;
      }
      warnings.push(`低置信度文件候选已忽略: ${candidate.path}`);
      return false;
    });
  }

  private safeNormalizeInputPath(rawPath: string, warnings: string[]): string {
    const cleaned = stripPathPunctuation(rawPath);
    if (!cleaned) {
      return "";
    }
    try {
      const maybeAbsolute = cleaned.replace(/\//g, path.sep);
      if (path.isAbsolute(maybeAbsolute) || /^[A-Za-z]:[\\/]/.test(cleaned)) {
        const absolute = path.resolve(maybeAbsolute);
        if (!isInsideProject(absolute, this.projectRoot)) {
          warnings.push(`已拒绝项目外路径: ${cleaned}`);
          return "";
        }
        const relative = toPosixPath(path.relative(this.projectRoot, absolute));
        return this.documents.normalizeRelativePath(relative);
      }
      return this.documents.normalizeRelativePath(cleaned);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return "";
    }
  }

  private async probePath(relativePath: string): Promise<{ exists: boolean; readable: boolean; chars: number; updated_at: string }> {
    try {
      const target = await this.documents.resolveSafePath(relativePath);
      const stats = await fs.stat(target).catch(() => null);
      if (!stats?.isFile()) {
        return { exists: false, readable: false, chars: 0, updated_at: "" };
      }
      return {
        exists: true,
        readable: true,
        chars: stats.size,
        updated_at: stats.mtime.toISOString()
      };
    } catch {
      try {
        await this.documents.resolveSafePath(relativePath, { allowMissing: true });
        return { exists: false, readable: false, chars: 0, updated_at: "" };
      } catch {
        return { exists: false, readable: false, chars: 0, updated_at: "" };
      }
    }
  }
}

function searchManifest(entries: ProjectFileManifestEntry[], query: string, baseConfidence: number): Array<{ entry: ProjectFileManifestEntry; confidence: number }> {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = tokenizeQuery(query);
  if (!normalizedQuery && !tokens.length) {
    return [];
  }
  return entries
    .map((entry) => {
      const confidence = scoreManifestEntry(entry, normalizedQuery, tokens, baseConfidence);
      return { entry, confidence };
    })
    .filter((match) => match.confidence >= CANDIDATE_THRESHOLD)
    .sort((left, right) => right.confidence - left.confidence || left.entry.path.localeCompare(right.entry.path, "zh-Hans-CN"))
    .slice(0, 6);
}

function scoreManifestEntry(entry: ProjectFileManifestEntry, normalizedQuery: string, tokens: string[], baseConfidence: number): number {
  const haystack = normalizeSearchText([entry.path, entry.name, entry.stem, entry.title, entry.excerpt, ...entry.keywords].join(" "));
  let score = 0;
  if (normalizedQuery && normalizeSearchText(entry.stem) === normalizedQuery) {
    score = Math.max(score, 0.82);
  }
  if (normalizedQuery && normalizeSearchText(entry.name).includes(normalizedQuery)) {
    score = Math.max(score, 0.78);
  }
  if (normalizedQuery && normalizeSearchText(entry.title).includes(normalizedQuery)) {
    score = Math.max(score, 0.74);
  }
  if (normalizedQuery && normalizeSearchText(entry.path).includes(normalizedQuery)) {
    score = Math.max(score, 0.72);
  }
  if (tokens.length) {
    const matched = tokens.filter((token) => haystack.includes(token)).length;
    score = Math.max(score, 0.45 + (matched / tokens.length) * 0.32);
  }
  if (score === 0) {
    return 0;
  }
  return Math.min(0.84, Math.max(CANDIDATE_THRESHOLD, score * 0.7 + baseConfidence * 0.3));
}

function tokenizeQuery(query: string): string[] {
  const normalized = normalizeSearchText(query);
  const tokens = normalized.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter((token) => token.length >= 2);
  const chineseTerms = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return uniqueStrings([...tokens, ...chineseTerms]);
}

function normalizeSearchText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function stripPathPunctuation(rawPath: string): string {
  return String(rawPath || "")
    .trim()
    .replace(/^[@`"'“”‘’]+/, "")
    .replace(/[`"'“”‘’，。；;：:]+$/g, "")
    .replace(/\\/g, "/");
}

function extractQuotedSegments(text: string): string[] {
  const segments: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    if (match[1]) {
      segments.push(match[1]);
    }
  }
  for (const match of text.matchAll(/[“"]([^“”"]+)[”"]/g)) {
    if (match[1]) {
      segments.push(match[1]);
    }
  }
  return segments;
}

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  return PATH_EXTENSION_PATTERN.test(trimmed) || trimmed.includes("/") || trimmed.includes("\\") || /^[A-Za-z]:[\\/]/.test(trimmed);
}

function scrubExplicitPaths(text: string): string {
  return String(text || "")
    .replace(/@([^\s，。；;："'`“”]+(?:\.(?:txt|md|jsonl))?)/gi, " ")
    .replace(/`([^`]+?\.(?:txt|md|jsonl))`/gi, " ")
    .replace(/[“"]([^“”"]+?\.(?:txt|md|jsonl))[”"]/gi, " ")
    .replace(/[A-Za-z]:[\\/][^\s，。；;："'`“”]+?\.(?:txt|md|jsonl)/gi, " ")
    .replace(/[^\s，。；;："'`“”]+?\.(?:txt|md|jsonl)/gi, " ");
}

function isNegated(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 8), index);
  return NEGATED_PREFIX_PATTERN.test(prefix);
}

function isInsideProject(absolutePath: string, projectRoot: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedTarget = path.resolve(absolutePath);
  if (process.platform === "win32") {
    const root = resolvedRoot.toLowerCase();
    const target = resolvedTarget.toLowerCase();
    return target === root || target.startsWith(`${root.toLowerCase()}${path.sep}`);
  }
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function sortCandidates(left: ProjectFileReferenceCandidate, right: ProjectFileReferenceCandidate): number {
  return right.confidence - left.confidence || Number(right.readable) - Number(left.readable) || left.path.localeCompare(right.path, "zh-Hans-CN");
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value || min)));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
