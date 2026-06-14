import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";

const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const EXCLUDED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const EXCLUDED_SUFFIXES = [".tmp", ".log"];
const PROJECT_TOP_LEVEL_NAMES = new Set(["00_设定集", "01_大纲", "02_正文", "99_回收站"]);

export type ExportProjectArchiveOptions = {
  projectPath: string;
  targetPath: string;
};

export type ImportProjectArchiveOptions = {
  archivePath: string;
  targetParentPath: string;
  now?: () => Date;
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
