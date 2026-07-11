import { parseProjectId } from "@xiaoshuo/project-manifest";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const projectIdentityConflictCode = "PROJECT_IDENTITY_CONFLICT";
export const projectIdentityUnconfirmedCode = "PROJECT_IDENTITY_UNCONFIRMED";

type ProjectIdentityRecord = {
  project_id: string;
  canonical_path: string;
  previous_paths: string[];
  updated_at: string;
};

type ProjectIdentityRegistryDisk = {
  version: 1;
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
  private readonly confirmedInputPaths = new Map<string, { projectId: string; canonicalPath: string }>();
  private readonly canonicalize: (projectPath: string) => Promise<string>;
  private readonly pathExists: (projectPath: string) => Promise<boolean>;
  private readonly now: () => string;
  private loaded: ProjectIdentityRegistryDisk | null = null;
  private writeBarrier: Promise<void> = Promise.resolve();

  constructor(
    private readonly registryPath: string,
    options: ProjectIdentityRegistryOptions = {}
  ) {
    this.canonicalize = options.canonicalize || canonicalProjectPath;
    this.pathExists = options.pathExists || existingPath;
    this.now = options.now || (() => new Date().toISOString());
  }

  async confirm(projectPath: string, projectId: string): Promise<ProjectIdentityClaim> {
    const release = await this.acquireWriteLock();
    try {
      return await this.confirmLocked(projectPath, projectId);
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

  async snapshot(): Promise<ProjectIdentityRegistryDisk> {
    const disk = await this.readDisk();
    return {
      version: disk.version,
      projects: disk.projects.map((project) => ({ ...project, previous_paths: [...project.previous_paths] }))
    };
  }

  private async confirmLocked(projectPath: string, projectId: string): Promise<ProjectIdentityClaim> {
    const normalizedProjectId = parseProjectId(projectId);
    if (!normalizedProjectId) {
      throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目 manifest 未提供有效 UUID，已拒绝写入");
    }

    const inputPath = normalizeProjectPath(projectPath);
    const canonicalPath = await this.canonicalize(projectPath);
    const disk = await this.readDisk();
    const currentAtPath = disk.projects.find((project) => project.canonical_path === canonicalPath);
    if (currentAtPath && currentAtPath.project_id !== normalizedProjectId) {
      throw new ProjectIdentityRegistryError(
        projectIdentityConflictCode,
        "项目路径已关联到另一项目 UUID，已拒绝写入"
      );
    }

    const currentForId = disk.projects.find((project) => project.project_id === normalizedProjectId);
    if (!currentForId) {
      disk.projects.push({
        project_id: normalizedProjectId,
        canonical_path: canonicalPath,
        previous_paths: [],
        updated_at: this.now()
      });
      await this.writeDisk(disk);
      this.confirmedInputPaths.set(inputPath, { projectId: normalizedProjectId, canonicalPath });
      return { projectId: normalizedProjectId, canonicalPath, reassociated: false };
    }

    if (currentForId.canonical_path === canonicalPath) {
      this.confirmedInputPaths.set(inputPath, { projectId: normalizedProjectId, canonicalPath });
      return { projectId: normalizedProjectId, canonicalPath, reassociated: false };
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
    this.confirmedInputPaths.set(inputPath, { projectId: normalizedProjectId, canonicalPath });
    return { projectId: normalizedProjectId, canonicalPath, reassociated: true };
  }

  private async readDisk(): Promise<ProjectIdentityRegistryDisk> {
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

  private async writeDisk(disk: ProjectIdentityRegistryDisk): Promise<void> {
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

function parseDisk(raw: string): ProjectIdentityRegistryDisk {
  if (!raw.trim()) {
    return { version: 1, projects: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectIdentityRegistryDisk>;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目身份注册表格式无效，已拒绝写入");
    }
    return {
      version: 1,
      projects: parsed.projects.flatMap((project) => {
        const projectId = parseProjectId(project?.project_id);
        const canonicalPath = typeof project?.canonical_path === "string" ? project.canonical_path.trim() : "";
        if (!projectId || !canonicalPath) {
          return [];
        }
        return [{
          project_id: projectId,
          canonical_path: canonicalPath,
          previous_paths: Array.isArray(project.previous_paths)
            ? uniquePaths(project.previous_paths.filter((candidate): candidate is string => typeof candidate === "string"))
            : [],
          updated_at: typeof project.updated_at === "string" ? project.updated_at : ""
        }];
      })
    };
  } catch (error) {
    if (error instanceof ProjectIdentityRegistryError) {
      throw error;
    }
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目身份注册表损坏，已拒绝写入");
  }
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
