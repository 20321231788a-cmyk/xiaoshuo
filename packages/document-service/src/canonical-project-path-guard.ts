import fs from "node:fs/promises";
import path from "node:path";

export const canonicalProjectPathGuardCodes = {
  rootUnavailable: "PROJECT_SCOPE_ROOT_UNAVAILABLE",
  rootChanged: "PROJECT_SCOPE_ROOT_CHANGED",
  pathEscape: "PROJECT_SCOPE_PATH_ESCAPE"
} as const;

export type CanonicalProjectPathGuardCode =
  (typeof canonicalProjectPathGuardCodes)[keyof typeof canonicalProjectPathGuardCodes];

export class CanonicalProjectPathGuardError extends Error {
  constructor(
    readonly code: CanonicalProjectPathGuardCode,
    message: string
  ) {
    super(message);
    this.name = "CanonicalProjectPathGuardError";
  }
}

/**
 * Pins a lexical project root to its physical directory and revalidates every
 * target against that physical root. Missing targets are checked through their
 * nearest existing ancestor so directory symlinks and Windows junctions cannot
 * redirect a later write outside the project.
 */
export class CanonicalProjectPathGuard {
  readonly projectRoot: string;
  private initialCanonicalRoot: Promise<string> | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  async canonicalRoot(): Promise<string> {
    const initial = await this.getInitialCanonicalRoot();
    const current = await realpathRequired(this.projectRoot, canonicalProjectPathGuardCodes.rootUnavailable);
    if (!samePath(initial, current)) {
      throw new CanonicalProjectPathGuardError(
        canonicalProjectPathGuardCodes.rootChanged,
        "项目物理目录在授权后发生变化，已拒绝文件访问"
      );
    }
    return initial;
  }

  async assertPath(targetPath: string, options: { allowMissing?: boolean } = {}): Promise<string> {
    const absoluteTarget = path.resolve(targetPath);
    if (!isPathWithin(this.projectRoot, absoluteTarget)) {
      throw new CanonicalProjectPathGuardError(
        canonicalProjectPathGuardCodes.pathEscape,
        "路径越过项目目录"
      );
    }

    const canonicalRoot = await this.canonicalRoot();
    const physicalTarget = await physicalPathThroughNearestAncestor(absoluteTarget, Boolean(options.allowMissing));
    if (!isPathWithin(canonicalRoot, physicalTarget)) {
      throw new CanonicalProjectPathGuardError(
        canonicalProjectPathGuardCodes.pathEscape,
        "路径经由符号链接或目录联接越过项目物理目录"
      );
    }
    return absoluteTarget;
  }

  private getInitialCanonicalRoot(): Promise<string> {
    this.initialCanonicalRoot ??= realpathRequired(
      this.projectRoot,
      canonicalProjectPathGuardCodes.rootUnavailable
    );
    return this.initialCanonicalRoot;
  }
}

async function physicalPathThroughNearestAncestor(targetPath: string, allowMissing: boolean): Promise<string> {
  let cursor = targetPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      await fs.lstat(cursor);
      const physicalAncestor = await realpathRequired(cursor, canonicalProjectPathGuardCodes.pathEscape);
      return path.resolve(physicalAncestor, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      if (!allowMissing) {
        throw new CanonicalProjectPathGuardError(
          canonicalProjectPathGuardCodes.pathEscape,
          "受控项目路径不存在或无法解析"
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new CanonicalProjectPathGuardError(
          canonicalProjectPathGuardCodes.pathEscape,
          "无法找到受控项目路径的有效物理父目录"
        );
      }
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function realpathRequired(targetPath: string, code: CanonicalProjectPathGuardCode): Promise<string> {
  try {
    return normalizeComparablePath(await fs.realpath(targetPath));
  } catch {
    throw new CanonicalProjectPathGuardError(code, "无法确认项目物理路径，已拒绝文件访问");
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === "object" && error ? String((error as NodeJS.ErrnoException).code || "") : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(normalizeComparablePath(rootPath), normalizeComparablePath(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
