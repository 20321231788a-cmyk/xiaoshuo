import { parseProjectId } from "@xiaoshuo/project-manifest";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const projectIdentityConflictCode = "PROJECT_IDENTITY_CONFLICT";
export const projectIdentityUnconfirmedCode = "PROJECT_IDENTITY_UNCONFIRMED";

const filesystemIdentityScheme = "stat-dev-ino-v1";

export type ProjectFilesystemIdentity = {
  scheme: typeof filesystemIdentityScheme;
  dev: string;
  ino: string;
};

export type ProjectIdentityRecord = {
  project_id: string;
  canonical_path: string;
  previous_paths: string[];
  updated_at: string;
  /**
   * `true` marks a v1 entry that has not yet been explicitly re-confirmed.
   * Such an entry is deliberately not sufficient to authorize a writable
   * runtime after a desktop restart.
   */
  requires_reconfirmation: boolean;
  /**
   * Identity of the canonical project root, captured with bigint stat fields
   * so it survives process restarts without trusting a lexical path alone.
   */
  filesystem_identity?: ProjectFilesystemIdentity;
};

export type ProjectIdentityRegistrySnapshot = {
  version: 2;
  projects: ProjectIdentityRecord[];
};

export type ProjectIdentityClaim = {
  projectId: string;
  canonicalPath: string;
  reassociated: boolean;
};

export type ProjectIdentityRegistryOptions = {
  canonicalize?: (projectPath: string) => Promise<string>;
  pathExists?: (projectPath: string) => Promise<boolean>;
  filesystemIdentity?: (canonicalProjectPath: string) => Promise<ProjectFilesystemIdentity>;
  now?: () => string;
};

export class ProjectIdentityRegistryError extends Error {
  readonly code: typeof projectIdentityConflictCode | typeof projectIdentityUnconfirmedCode;

  constructor(code: typeof projectIdentityConflictCode | typeof projectIdentityUnconfirmedCode, message: string) {
    super(message);
    this.name = "ProjectIdentityRegistryError";
    this.code = code;
  }
}

/**
 * Owns the desktop-local UUID-to-path observation record. A copied project
 * cannot become writable while its original, distinct path is still present.
 */
export class ProjectIdentityRegistry {
  private readonly confirmedInputPaths = new Map<string, {
    projectId: string;
    canonicalPath: string;
    filesystemIdentity: ProjectFilesystemIdentity;
  }>();
  private readonly canonicalize: (projectPath: string) => Promise<string>;
  private readonly pathExists: (projectPath: string) => Promise<boolean>;
  private readonly getFilesystemIdentity: (canonicalProjectPath: string) => Promise<ProjectFilesystemIdentity>;
  private readonly now: () => string;
  private loaded: ProjectIdentityRegistrySnapshot | null = null;
  private writeBarrier: Promise<void> = Promise.resolve();

  constructor(
    private readonly registryPath: string,
    options: ProjectIdentityRegistryOptions = {}
  ) {
    this.canonicalize = options.canonicalize || canonicalProjectPath;
    this.pathExists = options.pathExists || existingPath;
    this.getFilesystemIdentity = options.filesystemIdentity || filesystemProjectIdentity;
    this.now = options.now || (() => new Date().toISOString());
  }

  async confirm(projectPath: string, projectId: string): Promise<ProjectIdentityClaim> {
    return this.confirmWithMode(projectPath, projectId, false);
  }

  /**
   * Records the current OS file identity after an intentional project-open
   * action. This is the only way a pre-v2 registry entry may become writable.
   */
  async reconfirm(projectPath: string, projectId: string): Promise<ProjectIdentityClaim> {
    return this.confirmWithMode(projectPath, projectId, true);
  }

  private async confirmWithMode(
    projectPath: string,
    projectId: string,
    allowLegacyReconfirmation: boolean
  ): Promise<ProjectIdentityClaim> {
    const release = await this.acquireWriteLock();
    try {
      return await this.confirmLocked(projectPath, projectId, allowLegacyReconfirmation);
    } finally {
      release();
    }
  }

  assertWritable(projectPath: string, expectedProjectId?: string): void {
    const confirmed = this.confirmedInputPaths.get(normalizeProjectPath(projectPath));
    const expected = expectedProjectId === undefined ? null : parseProjectId(expectedProjectId);
    if (!confirmed || (expectedProjectId !== undefined && (!expected || confirmed.projectId !== expected))) {
      throw new ProjectIdentityRegistryError(
        projectIdentityUnconfirmedCode,
        "项目身份或预期 UUID 尚未确认，已拒绝创建可写运行时"
      );
    }
  }

  async snapshot(): Promise<ProjectIdentityRegistrySnapshot> {
    const disk = await this.readDisk();
    return {
      version: disk.version,
      projects: disk.projects.map((project) => ({
        ...project,
        previous_paths: [...project.previous_paths],
        filesystem_identity: project.filesystem_identity ? { ...project.filesystem_identity } : undefined
      }))
    };
  }

  private async confirmLocked(
    projectPath: string,
    projectId: string,
    allowLegacyReconfirmation: boolean
  ): Promise<ProjectIdentityClaim> {
    const normalizedProjectId = parseProjectId(projectId);
    if (!normalizedProjectId) {
      throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目 manifest 未提供有效 UUID，已拒绝写入");
    }

    const inputPath = normalizeProjectPath(projectPath);
    const canonicalPath = await this.canonicalize(projectPath);
    const filesystemIdentity = await this.getFilesystemIdentity(canonicalPath);
    const disk = await this.readDisk();
    const currentAtPath = disk.projects.find((project) => project.canonical_path === canonicalPath);
    if (currentAtPath && currentAtPath.project_id !== normalizedProjectId) {
      throw new ProjectIdentityRegistryError(
        projectIdentityConflictCode,
        "项目路径已关联到另一项目 UUID，已拒绝写入"
      );
    }
    const currentAtFilesystemIdentity = disk.projects.find((project) =>
      project.filesystem_identity && sameFilesystemIdentity(project.filesystem_identity, filesystemIdentity)
    );
    if (currentAtFilesystemIdentity && currentAtFilesystemIdentity.project_id !== normalizedProjectId) {
      throw new ProjectIdentityRegistryError(
        projectIdentityConflictCode,
        "项目物理目录已关联到另一项目 UUID，已拒绝写入"
      );
    }

    const currentForId = disk.projects.find((project) => project.project_id === normalizedProjectId);
    if (!currentForId) {
      disk.projects.push({
        project_id: normalizedProjectId,
        canonical_path: canonicalPath,
        previous_paths: [],
        updated_at: this.now(),
        requires_reconfirmation: false,
        filesystem_identity: filesystemIdentity
      });
      await this.writeDisk(disk);
      this.confirmedInputPaths.set(inputPath, { projectId: normalizedProjectId, canonicalPath, filesystemIdentity });
      return { projectId: normalizedProjectId, canonicalPath, reassociated: false };
    }

    if (currentForId.requires_reconfirmation) {
      if (!allowLegacyReconfirmation) {
        throw new ProjectIdentityRegistryError(
          projectIdentityUnconfirmedCode,
          "旧版项目身份记录缺少物理目录身份；请通过“打开项目”重新确认后再写入"
        );
      }
      if (currentForId.canonical_path !== canonicalPath && await this.pathExists(currentForId.canonical_path)) {
        throw new ProjectIdentityRegistryError(
          projectIdentityConflictCode,
          "旧版项目 UUID 位于两个有效目录；重新确认前已拒绝写入"
        );
      }
      const reassociated = currentForId.canonical_path !== canonicalPath;
      if (reassociated) {
        currentForId.previous_paths = uniquePaths([...currentForId.previous_paths, currentForId.canonical_path]);
        currentForId.canonical_path = canonicalPath;
      }
      currentForId.requires_reconfirmation = false;
      currentForId.filesystem_identity = filesystemIdentity;
      currentForId.updated_at = this.now();
      await this.writeDisk(disk);
      this.confirmedInputPaths.set(inputPath, { projectId: normalizedProjectId, canonicalPath, filesystemIdentity });
      return { projectId: normalizedProjectId, canonicalPath, reassociated };
    }

    if (currentForId.canonical_path === canonicalPath) {
      if (!currentForId.filesystem_identity || !sameFilesystemIdentity(currentForId.filesystem_identity, filesystemIdentity)) {
        throw new ProjectIdentityRegistryError(
          projectIdentityConflictCode,
          "项目路径的物理目录身份已改变；已拒绝将替换目录视为原项目"
        );
      }
      this.confirmedInputPaths.set(inputPath, { projectId: normalizedProjectId, canonicalPath, filesystemIdentity });
      return { projectId: normalizedProjectId, canonicalPath, reassociated: false };
    }

    if (!currentForId.filesystem_identity || !sameFilesystemIdentity(currentForId.filesystem_identity, filesystemIdentity)) {
      throw new ProjectIdentityRegistryError(
        projectIdentityConflictCode,
        "项目 UUID 的物理目录身份已改变；已拒绝自动关联复制或替换目录"
      );
    }
    if (await this.pathExists(currentForId.canonical_path)) {
      throw new ProjectIdentityRegistryError(
        projectIdentityConflictCode,
        "检测到同一项目 UUID 位于两个有效目录，身份未确认前已拒绝写入"
      );
    }

    currentForId.previous_paths = uniquePaths([...currentForId.previous_paths, currentForId.canonical_path]);
    currentForId.canonical_path = canonicalPath;
    currentForId.updated_at = this.now();
    await this.writeDisk(disk);
    this.confirmedInputPaths.set(inputPath, { projectId: normalizedProjectId, canonicalPath, filesystemIdentity });
    return { projectId: normalizedProjectId, canonicalPath, reassociated: true };
  }

  private async readDisk(): Promise<ProjectIdentityRegistrySnapshot> {
    if (this.loaded) {
      return this.loaded;
    }
    let raw = "";
    try {
      raw = await fs.readFile(this.registryPath, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "无法读取项目身份注册表，已拒绝写入");
      }
    }
    this.loaded = parseDisk(raw);
    return this.loaded;
  }

  private async writeDisk(disk: ProjectIdentityRegistrySnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    const tempPath = path.join(path.dirname(this.registryPath), `.${path.basename(this.registryPath)}.${randomUUID()}.tmp`);
    await fs.writeFile(tempPath, `${JSON.stringify(disk, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.registryPath);
    this.loaded = disk;
  }

  private async acquireWriteLock(): Promise<() => void> {
    const previous = this.writeBarrier;
    let release: (() => void) | undefined;
    this.writeBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return () => release?.();
  }
}

function parseDisk(raw: string): ProjectIdentityRegistrySnapshot {
  if (!raw.trim()) {
    return { version: 2, projects: [] };
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; projects?: unknown };
    const sourceVersion = parsed.version;
    if ((sourceVersion !== 1 && sourceVersion !== 2) || !Array.isArray(parsed.projects)) {
      throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目身份注册表格式无效，已拒绝写入");
    }
    const projects = parsed.projects.map((project, index) => parseProjectIdentityRecord(project, index, sourceVersion));
    const projectIds = new Set<string>();
    const canonicalPaths = new Set<string>();
    const filesystemIdentities = new Set<string>();
    for (const project of projects) {
      if (projectIds.has(project.project_id)) {
        throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目身份注册表包含重复 project UUID，已拒绝写入");
      }
      if (canonicalPaths.has(project.canonical_path)) {
        throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目身份注册表包含重复 canonical path，已拒绝写入");
      }
      projectIds.add(project.project_id);
      canonicalPaths.add(project.canonical_path);
      if (project.filesystem_identity) {
        const identityKey = filesystemIdentityKey(project.filesystem_identity);
        if (filesystemIdentities.has(identityKey)) {
          throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目身份注册表包含重复物理目录身份，已拒绝写入");
        }
        filesystemIdentities.add(identityKey);
      }
    }
    // v1 had only UUID + lexical canonical path. It is converted in-memory
    // to v2 entries that cannot authorize writes until a user opens and
    // re-confirms each project. The v2 form is persisted on the next valid
    // write, preserving pending entries rather than silently dropping them.
    return { version: 2, projects };
  } catch (error) {
    if (error instanceof ProjectIdentityRegistryError) {
      throw error;
    }
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目身份注册表损坏，已拒绝写入");
  }
}

function parseProjectIdentityRecord(value: unknown, index: number, sourceVersion: 1 | 2): ProjectIdentityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条记录无效`);
  }
  const record = value as Partial<ProjectIdentityRecord>;
  const projectId = parseProjectId(record.project_id);
  const canonicalPath = typeof record.canonical_path === "string" && record.canonical_path.trim()
    ? normalizeProjectPath(record.canonical_path)
    : "";
  if (!projectId || !canonicalPath || !path.isAbsolute(record.canonical_path || "")) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条身份或路径无效`);
  }
  if (!Array.isArray(record.previous_paths) || record.previous_paths.some((candidate) =>
    typeof candidate !== "string" || !candidate.trim() || !path.isAbsolute(candidate)
  )) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条历史路径无效`);
  }
  if (typeof record.updated_at !== "string") {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条更新时间无效`);
  }
  if (sourceVersion === 1) {
    return {
      project_id: projectId,
      canonical_path: canonicalPath,
      previous_paths: uniquePaths(record.previous_paths.map(normalizeProjectPath)),
      updated_at: record.updated_at,
      requires_reconfirmation: true
    };
  }
  if (typeof record.requires_reconfirmation !== "boolean") {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条重新确认状态无效`);
  }
  const filesystemIdentity = record.filesystem_identity === undefined
    ? undefined
    : parseFilesystemIdentity(record.filesystem_identity, index);
  if (record.requires_reconfirmation === Boolean(filesystemIdentity)) {
    throw new ProjectIdentityRegistryError(
      projectIdentityConflictCode,
      `项目身份注册表第 ${index + 1} 条物理目录身份与重新确认状态不一致`
    );
  }
  return {
    project_id: projectId,
    canonical_path: canonicalPath,
    previous_paths: uniquePaths(record.previous_paths.map(normalizeProjectPath)),
    updated_at: record.updated_at,
    requires_reconfirmation: record.requires_reconfirmation,
    filesystem_identity: filesystemIdentity
  };
}

async function canonicalProjectPath(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath);
  let physicalPath: string;
  try {
    physicalPath = await fs.realpath(resolved);
  } catch {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "无法确认项目 canonical realpath，已拒绝写入");
  }
  return normalizeProjectPath(physicalPath);
}

async function existingPath(projectPath: string): Promise<boolean> {
  return Boolean(await fs.stat(projectPath).catch(() => null));
}

async function filesystemProjectIdentity(projectPath: string): Promise<ProjectFilesystemIdentity> {
  const stats = await fs.stat(projectPath, { bigint: true }).catch(() => null);
  if (!stats) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "无法读取项目物理目录身份，已拒绝写入");
  }
  if (!stats.isDirectory()) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目路径不是目录，已拒绝写入");
  }
  if (stats.dev < 0n || stats.ino < 0n) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目物理目录身份不可用，已拒绝写入");
  }
  return {
    scheme: filesystemIdentityScheme,
    dev: stats.dev.toString(),
    ino: stats.ino.toString()
  };
}

function parseFilesystemIdentity(value: unknown, index: number): ProjectFilesystemIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条物理目录身份无效`);
  }
  const identity = value as Partial<ProjectFilesystemIdentity>;
  if (identity.scheme !== filesystemIdentityScheme) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条物理目录身份方案无效`);
  }
  const dev = normalizeStatPart(identity.dev);
  const ino = normalizeStatPart(identity.ino);
  if (!dev || !ino) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, `项目身份注册表第 ${index + 1} 条物理目录身份数值无效`);
  }
  return { scheme: filesystemIdentityScheme, dev, ino };
}

function normalizeStatPart(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value).toString();
  } catch {
    return null;
  }
}

function sameFilesystemIdentity(left: ProjectFilesystemIdentity, right: ProjectFilesystemIdentity): boolean {
  return left.scheme === right.scheme && left.dev === right.dev && left.ino === right.ino;
}

function filesystemIdentityKey(identity: ProjectFilesystemIdentity): string {
  return `${identity.scheme}:${identity.dev}:${identity.ino}`;
}

function normalizeProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath.trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((candidate) => candidate.trim()).filter(Boolean))];
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
