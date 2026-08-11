import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const EXCLUDED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const EXCLUDED_SUFFIXES = [".tmp", ".log"];
const PROJECT_TOP_LEVEL_NAMES = new Set(["00_设定集", "01_大纲", "02_正文", "99_回收站"]);
export const CLOUD_CORE_DATA_LIMIT_BYTES = 30 * 1024 * 1024;
const CLOUD_MANIFEST_ENTRY = ".arcwriter-cloud-manifest.json";
const CLOUD_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown"]);
const CLOUD_CORE_TEXT_ROOTS = ["01_大纲/", "02_正文/", "00_设定集/设定集/", "00_设定集/风格库/", "00_设定集/题材库/"];
const CLOUD_CORE_AGENT_FILES = new Set([
  "00_设定集/.agent/project_meta.json",
  "00_设定集/.agent/story-planning.jsonl",
  "00_设定集/.agent/libraries/lore.v1.jsonl",
  "00_设定集/.agent/libraries/style.v1.jsonl",
  "00_设定集/.agent/libraries/genre.v1.jsonl",
  "00_设定集/.agent/style_distillation/current.json"
]);

export type ExportProjectArchiveOptions = {
  projectPath: string;
  targetPath: string;
};

export type ExportProjectArchiveTempOptions = {
  projectPath: string;
  tempDir: string;
  fileName?: string;
};

export type ImportProjectArchiveOptions = {
  archivePath: string;
  targetParentPath: string;
  now?: () => Date;
};

export type ImportProjectArchiveToExistingOptions = {
  archivePath: string;
  targetProjectPath: string;
};

export type CloudCoreFileEntry = {
  path: string;
  size: number;
  sha256: string;
};

export type CloudCoreProjectInspection = {
  total_bytes: number;
  file_count: number;
  files: CloudCoreFileEntry[];
  largest_files: Array<Pick<CloudCoreFileEntry, "path" | "size">>;
};

export type ExportCloudCoreArchiveOptions = ExportProjectArchiveTempOptions & {
  projectId?: string;
  projectName?: string;
  maxBytes?: number;
};

export type ImportCloudCoreArchiveOptions = ImportProjectArchiveToExistingOptions & {
  maxBytes?: number;
};

type SafeZipEntry = {
  entry: AdmZip.IZipEntry;
  targetPath: string;
};

export function defaultProjectArchiveName(projectName: string, projectPath: string): string {
  const fallbackName = path.basename(path.resolve(projectPath || "."));
  return `${safeProjectStem(projectName || fallbackName)}.arcwriter.zip`;
}

export function ensureZipExtension(targetPath: string): string {
  return /\.zip$/i.test(targetPath) ? targetPath : `${targetPath}.zip`;
}

export async function exportProjectArchive(options: ExportProjectArchiveOptions): Promise<string> {
  const projectRoot = path.resolve(options.projectPath);
  const archivePath = path.resolve(ensureZipExtension(options.targetPath));
  const stats = await fs.stat(projectRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`项目目录不存在: ${projectRoot}`);
  }

  const zip = new AdmZip();
  await addDirectoryToArchive(zip, projectRoot, "", archivePath);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  zip.writeZip(archivePath);
  return archivePath;
}

export async function exportProjectArchiveToTemp(options: ExportProjectArchiveTempOptions): Promise<string> {
  const tempDir = path.resolve(options.tempDir);
  await fs.mkdir(tempDir, { recursive: true });
  const projectName = safeProjectStem(path.basename(path.resolve(options.projectPath)));
  const fileName = options.fileName || `${projectName}.arcwriter.zip`;
  const targetPath = path.join(tempDir, fileName);
  return exportProjectArchive({
    projectPath: options.projectPath,
    targetPath
  });
}

export async function inspectCloudCoreProject(projectPath: string, maxBytes = CLOUD_CORE_DATA_LIMIT_BYTES): Promise<CloudCoreProjectInspection> {
  const projectRoot = path.resolve(projectPath);
  const stats = await fs.stat(projectRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`项目目录不存在: ${projectRoot}`);
  }

  const files: CloudCoreFileEntry[] = [];
  await walkCloudCoreFiles(projectRoot, projectRoot, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  const totalBytes = files.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes > maxBytes) {
    const largest = [...files].sort((left, right) => right.size - left.size).slice(0, 3);
    throw new Error(`核心数据超过 30MB：当前 ${formatMegabytes(totalBytes)}。占用较大的文件：${largest.map((entry) => `${entry.path}（${formatMegabytes(entry.size)}）`).join("、")}`);
  }
  return {
    total_bytes: totalBytes,
    file_count: files.length,
    files,
    largest_files: [...files].sort((left, right) => right.size - left.size).slice(0, 5).map(({ path: entryPath, size }) => ({ path: entryPath, size }))
  };
}

export async function exportCloudCoreArchiveToTemp(options: ExportCloudCoreArchiveOptions): Promise<{ archivePath: string; inspection: CloudCoreProjectInspection }> {
  const projectRoot = path.resolve(options.projectPath);
  const inspection = await inspectCloudCoreProject(projectRoot, options.maxBytes);
  if (!inspection.file_count) {
    throw new Error("项目中没有可同步的大纲、正文、设定、风格或题材文件。");
  }
  const tempDir = path.resolve(options.tempDir);
  await fs.mkdir(tempDir, { recursive: true });
  const projectName = options.projectName || path.basename(projectRoot);
  const archivePath = path.join(tempDir, options.fileName || defaultProjectArchiveName(projectName, projectRoot));
  const zip = new AdmZip();
  for (const entry of inspection.files) {
    zip.addFile(entry.path, await fs.readFile(path.join(projectRoot, ...entry.path.split("/"))));
  }
  zip.addFile(CLOUD_MANIFEST_ENTRY, Buffer.from(JSON.stringify({
    schema_version: 1,
    project_id: options.projectId || "",
    project_name: projectName,
    created_at: new Date().toISOString(),
    total_bytes: inspection.total_bytes,
    files: inspection.files
  }), "utf8"));
  zip.writeZip(archivePath);
  return { archivePath, inspection };
}

export async function importCloudCoreArchiveToExisting(options: ImportCloudCoreArchiveOptions): Promise<{ restored_files: number; restored_bytes: number }> {
  const archivePath = path.resolve(options.archivePath);
  const targetProjectPath = path.resolve(options.targetProjectPath);
  const archiveStats = await fs.stat(archivePath).catch(() => null);
  if (!archiveStats?.isFile()) throw new Error(`项目归档不存在: ${archivePath}`);
  const targetStats = await fs.stat(targetProjectPath).catch(() => null);
  if (!targetStats?.isDirectory()) throw new Error(`导入目标项目不存在: ${targetProjectPath}`);

  let zip: AdmZip;
  try {
    zip = new AdmZip(archivePath);
  } catch {
    throw new Error("云端归档不是有效的 zip 文件");
  }
  const rootToStrip = commonArchiveRoot(zip.getEntries().map((entry) => entry.entryName));
  const cloudEntries: Array<{ relativePath: string; data: Buffer }> = [];
  let restoredBytes = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const relativePath = normalizeArchiveEntry(entry.entryName, rootToStrip);
    if (!relativePath || relativePath === CLOUD_MANIFEST_ENTRY) continue;
    const segments = relativePath.split("/");
    if (segments.some((segment) => unsafePathSegment(segment))) throw new Error("zip 内包含不安全路径");
    if (!isCloudCorePath(relativePath)) continue;
    const data = entry.getData();
    restoredBytes += data.length;
    if (restoredBytes > (options.maxBytes || CLOUD_CORE_DATA_LIMIT_BYTES)) throw new Error("云端核心数据超过 30MB，已停止恢复。");
    cloudEntries.push({ relativePath, data });
  }
  if (!cloudEntries.length) throw new Error("云端项目中没有可恢复的核心文件。");

  await removeExistingCloudCoreFiles(targetProjectPath);
  for (const entry of cloudEntries) {
    const targetPath = path.resolve(targetProjectPath, ...entry.relativePath.split("/"));
    if (!isInsidePath(targetProjectPath, targetPath)) throw new Error("zip 内包含不安全路径");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.data);
  }
  return { restored_files: cloudEntries.length, restored_bytes: restoredBytes };
}

export async function importProjectArchive(options: ImportProjectArchiveOptions): Promise<string> {
  const archivePath = path.resolve(options.archivePath);
  const targetParentPath = path.resolve(options.targetParentPath);
  const archiveStats = await fs.stat(archivePath).catch(() => null);
  if (!archiveStats?.isFile()) {
    throw new Error(`项目归档不存在: ${archivePath}`);
  }
  const parentStats = await fs.stat(targetParentPath).catch(() => null);
  if (!parentStats?.isDirectory()) {
    throw new Error(`导入目标目录不存在: ${targetParentPath}`);
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(archivePath);
  } catch {
    throw new Error("项目归档不是有效的 zip 文件");
  }

  const entries = zip.getEntries();
  const rootToStrip = commonArchiveRoot(entries.map((entry) => entry.entryName));
  const targetPath = await availableImportPath(targetParentPath, archivePath, options.now || (() => new Date()));
  const safeEntries = collectSafeEntries(entries, targetPath, rootToStrip);
  if (!safeEntries.length) {
    throw new Error("项目归档为空");
  }

  await fs.mkdir(targetPath, { recursive: true });
  for (const safeEntry of safeEntries) {
    if (safeEntry.entry.isDirectory) {
      await fs.mkdir(safeEntry.targetPath, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(safeEntry.targetPath), { recursive: true });
    await fs.writeFile(safeEntry.targetPath, safeEntry.entry.getData());
  }

  return targetPath;
}

export async function importProjectArchiveToExisting(options: ImportProjectArchiveToExistingOptions): Promise<void> {
  const archivePath = path.resolve(options.archivePath);
  const targetProjectPath = path.resolve(options.targetProjectPath);
  const archiveStats = await fs.stat(archivePath).catch(() => null);
  if (!archiveStats?.isFile()) {
    throw new Error(`项目归档不存在: ${archivePath}`);
  }
  const targetStats = await fs.stat(targetProjectPath).catch(() => null);
  if (!targetStats?.isDirectory()) {
    throw new Error(`导入目标项目不存在: ${targetProjectPath}`);
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(archivePath);
  } catch {
    throw new Error("项目归档不是有效的 zip 文件");
  }

  const entries = zip.getEntries();
  const rootToStrip = commonArchiveRoot(entries.map((entry) => entry.entryName));
  const safeEntries = collectSafeEntries(entries, targetProjectPath, rootToStrip);
  if (!safeEntries.length) {
    throw new Error("项目归档为空");
  }

  await clearProjectContents(targetProjectPath);
  for (const safeEntry of safeEntries) {
    if (safeEntry.entry.isDirectory) {
      await fs.mkdir(safeEntry.targetPath, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(safeEntry.targetPath), { recursive: true });
    await fs.writeFile(safeEntry.targetPath, safeEntry.entry.getData());
  }
}

async function addDirectoryToArchive(zip: AdmZip, directoryPath: string, relativeDirectory: string, archivePath: string): Promise<void> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  for (const entry of entries) {
    if (shouldExcludeEntry(entry.name, entry.isDirectory())) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.join(directoryPath, entry.name);
    if (path.resolve(entryPath) === archivePath) {
      continue;
    }

    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const zipPath = toZipPath(relativePath);
    if (entry.isDirectory()) {
      zip.addFile(`${zipPath}/`, Buffer.alloc(0));
      await addDirectoryToArchive(zip, entryPath, relativePath, archivePath);
      continue;
    }
    if (entry.isFile()) {
      zip.addFile(zipPath, await fs.readFile(entryPath));
    }
  }
}

async function walkCloudCoreFiles(projectRoot: string, directoryPath: string, output: CloudCoreFileEntry[]): Promise<void> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directoryPath, entry.name);
    const relativePath = toZipPath(path.relative(projectRoot, entryPath));
    if (entry.isDirectory()) {
      if (couldContainCloudCorePath(`${relativePath}/`)) await walkCloudCoreFiles(projectRoot, entryPath, output);
      continue;
    }
    if (!entry.isFile() || !isCloudCorePath(relativePath)) continue;
    const data = await fs.readFile(entryPath);
    output.push({ path: relativePath, size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
}

function couldContainCloudCorePath(relativeDirectory: string): boolean {
  const normalized = normalizeZipName(relativeDirectory).replace(/^\/+/, "");
  return CLOUD_CORE_TEXT_ROOTS.some((root) => root.startsWith(normalized) || normalized.startsWith(root)) ||
    [...CLOUD_CORE_AGENT_FILES].some((filePath) => filePath.startsWith(normalized));
}

export function isCloudCorePath(relativePath: string): boolean {
  const normalized = normalizeZipName(relativePath).replace(/^\/+/, "");
  if (CLOUD_CORE_AGENT_FILES.has(normalized)) return true;
  if (!CLOUD_TEXT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) return false;
  return CLOUD_CORE_TEXT_ROOTS.some((root) => normalized.startsWith(root) && normalized.length > root.length);
}

async function removeExistingCloudCoreFiles(projectRoot: string): Promise<void> {
  const files: CloudCoreFileEntry[] = [];
  await walkCloudCoreFiles(projectRoot, projectRoot, files);
  await Promise.all(files.map((entry) => fs.rm(path.join(projectRoot, ...entry.path.split("/")), { force: true })));
}

function collectSafeEntries(entries: AdmZip.IZipEntry[], targetRoot: string, rootToStrip: string): SafeZipEntry[] {
  const safeEntries: SafeZipEntry[] = [];
  for (const entry of entries) {
    const relativePath = normalizeArchiveEntry(entry.entryName, rootToStrip);
    if (!relativePath) {
      continue;
    }
    const segments = relativePath.split("/");
    if (segments.some((segment) => unsafePathSegment(segment))) {
      throw new Error("zip 内包含不安全路径");
    }
    const targetPath = path.resolve(targetRoot, ...segments);
    if (!isInsidePath(targetRoot, targetPath)) {
      throw new Error("zip 内包含不安全路径");
    }
    safeEntries.push({ entry, targetPath });
  }
  return safeEntries;
}

async function availableImportPath(targetParentPath: string, archivePath: string, now: () => Date): Promise<string> {
  const baseName = safeProjectStem(
    path
      .basename(archivePath)
      .replace(/\.zip$/i, "")
      .replace(/\.arcwriter$/i, "")
  );
  const initial = path.join(targetParentPath, baseName);
  if (!(await exists(initial))) {
    return initial;
  }

  const stamp = formatTimestamp(now());
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? stamp : `${stamp}-${index + 1}`;
    const candidate = path.join(targetParentPath, `${baseName}-${suffix}`);
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error("无法为导入项目生成不冲突的目录名");
}

function commonArchiveRoot(entryNames: string[]): string {
  const normalizedNames = entryNames.map((entryName) => normalizeZipName(entryName)).filter(Boolean);
  const roots = normalizedNames.map((entryName) => entryName.split("/")[0]).filter((item): item is string => Boolean(item));
  const uniqueRoots = new Set(roots);
  if (uniqueRoots.size !== 1) {
    return "";
  }
  const [root] = [...uniqueRoots];
  if (!root || PROJECT_TOP_LEVEL_NAMES.has(root) || unsafePathSegment(root)) {
    return "";
  }
  return normalizedNames.some((entryName) => entryName.startsWith(`${root}/`)) ? root : "";
}

async function clearProjectContents(targetRoot: string): Promise<void> {
  const entries = await fs.readdir(targetRoot, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    await fs.rm(path.join(targetRoot, entry.name), { recursive: true, force: true });
  }));
}

function normalizeArchiveEntry(entryName: string, rootToStrip: string): string {
  let normalized = normalizeZipName(entryName);
  if (rootToStrip && (normalized === rootToStrip || normalized.startsWith(`${rootToStrip}/`))) {
    normalized = normalized.slice(rootToStrip.length).replace(/^\/+/, "");
  }
  return normalized.replace(/\/+$/, "");
}

function normalizeZipName(entryName: string): string {
  return entryName.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function unsafePathSegment(segment: string): boolean {
  return !segment || segment === "." || segment === ".." || /[<>:"|?*\x00-\x1f]/.test(segment);
}

function shouldExcludeEntry(name: string, isDirectory: boolean): boolean {
  const normalized = name.toLowerCase();
  if (isDirectory && EXCLUDED_DIRECTORY_NAMES.has(normalized)) {
    return true;
  }
  if (EXCLUDED_FILE_NAMES.has(normalized)) {
    return true;
  }
  return EXCLUDED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function safeProjectStem(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 80);
  return cleaned || "ArcWriter项目";
}

function toZipPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isInsidePath(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2)}MB`;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
