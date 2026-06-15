import type { CurrentProject, ContinuityContext, DocumentContent, StyleDistillationProfile } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import path from "node:path";

export const SETTINGS_DIR = "00_设定集";
export const OUTLINE_DIR = "01_大纲";
export const BODY_DIR = "02_正文";
export const STYLE_DIR = "风格库";
export const GENRE_DIR = "题材库";
export const AGENT_DIR = `${SETTINGS_DIR}/.agent`;
export const PROJECT_META_FILE = "project_meta.json";
export const STYLE_DISTILLATION_REL_PATH = `${AGENT_DIR}/style_distillation/current.json`;

const DEFAULT_PROJECT_NAME = "新建小说项目";
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);

const STARTER_DIRECTORIES = [
  SETTINGS_DIR,
  `${SETTINGS_DIR}/${STYLE_DIR}`,
  `${SETTINGS_DIR}/${GENRE_DIR}`,
  `${SETTINGS_DIR}/修正日志`,
  OUTLINE_DIR,
  BODY_DIR,
  AGENT_DIR
] as const;

const STARTER_FILES: Record<string, string> = {
  [`${OUTLINE_DIR}/大纲.txt`]: "",
  [`${SETTINGS_DIR}/${GENRE_DIR}/题材规则.txt`]: "",
  [`${SETTINGS_DIR}/${GENRE_DIR}/题材素材.txt`]: "",
  [`${SETTINGS_DIR}/${GENRE_DIR}/违禁词.txt`]: "",
  [`${SETTINGS_DIR}/${GENRE_DIR}/战斗模板.txt`]: "",
  [`${SETTINGS_DIR}/${STYLE_DIR}/参考素材.txt`]: "",
  [`${SETTINGS_DIR}/${STYLE_DIR}/风格示例.txt`]: "",
  [`${SETTINGS_DIR}/${STYLE_DIR}/写作风格.txt`]: "",
  [`${OUTLINE_DIR}/细纲.txt`]: "",
  [`${OUTLINE_DIR}/章纲.txt`]: "",
  [`${BODY_DIR}/正文.txt`]: ""
};

type ProjectSessionState = {
  current_project: CurrentProject;
  updated_at: string;
};

export type ProjectSessionServiceOptions = {
  stateFilePath?: string;
  now?: () => string;
};

export class ProjectSessionService {
  private readonly stateFilePath: string;
  private readonly now: () => string;
  private currentProject: CurrentProject = { path: "", name: "" };
  private loaded = false;

  constructor(options: ProjectSessionServiceOptions = {}) {
    this.stateFilePath = path.resolve(options.stateFilePath || path.join(process.cwd(), ".xiaoshuo-project-session.json"));
    this.now = options.now || (() => formatNow(new Date()));
  }

  async getCurrentProject(): Promise<CurrentProject> {
    await this.ensureLoaded();
    return { ...this.currentProject };
  }

  async requireProject(): Promise<CurrentProject> {
    const current = await this.getCurrentProject();
    if (!current.path) {
      throw new Error("未打开项目");
    }
    return current;
  }

  async syncCurrentProject(project: CurrentProject): Promise<CurrentProject> {
    await this.ensureLoaded();
    if (!project.path.trim()) {
      this.currentProject = { path: "", name: "" };
      await this.persistState();
      return { ...this.currentProject };
    }
    this.currentProject = await this.readProjectInfo(path.resolve(project.path), project.name);
    await this.persistState();
    return { ...this.currentProject };
  }

  async openProject(projectPath: string): Promise<CurrentProject> {
    await this.ensureLoaded();
    const resolved = path.resolve(projectPath);
    const stats = await fs.stat(resolved).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`项目目录不存在: ${resolved}`);
    }
    this.currentProject = await this.readProjectInfo(resolved);
    await this.persistState();
    return { ...this.currentProject };
  }

  async createProject(projectPath: string, projectName = "", createInParent = false): Promise<CurrentProject> {
    await this.ensureLoaded();
    const resolved = await this.resolveNewProjectPath(projectPath, projectName, createInParent);
    await fs.mkdir(resolved, { recursive: true });
    const stats = await fs.stat(resolved).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`无法创建项目目录: ${resolved}`);
    }

    await Promise.all(STARTER_DIRECTORIES.map((entry) => fs.mkdir(path.join(resolved, entry), { recursive: true })));
    await Promise.all(
      Object.entries(STARTER_FILES).map(async ([relativePath, content]) => {
        const target = path.join(resolved, relativePath);
        try {
          await fs.access(target);
        } catch {
          await fs.writeFile(target, content, "utf8");
        }
      })
    );

    const metaPath = projectMetaPath(resolved);
    try {
      await fs.access(metaPath);
    } catch {
      await fs.mkdir(path.dirname(metaPath), { recursive: true });
      await fs.writeFile(
        metaPath,
        `${JSON.stringify({ display_name: path.basename(resolved), created_at: this.now() }, null, 2)}\n`,
        "utf8"
      );
    }

    this.currentProject = await this.readProjectInfo(resolved);
    await this.persistState();
    return { ...this.currentProject };
  }

  async renameCurrentProject(name: string): Promise<CurrentProject> {
    await this.ensureLoaded();
    const current = await this.requireProject();
    const displayName = (name || "").trim();
    if (!displayName) {
      throw new Error("项目名称不能为空");
    }

    const previousPath = path.resolve(current.path);
    const targetName = safeProjectFolderName(displayName);
    const targetPath = path.resolve(path.dirname(previousPath), targetName);
    const sameLocation = pathsReferToSameLocation(previousPath, targetPath);
    const needsDirectoryRename = path.resolve(previousPath) !== path.resolve(targetPath);

    if (!sameLocation && (await exists(targetPath))) {
      throw new Error(`同级目录已存在项目文件夹: ${targetName}`);
    }

    const meta = await readProjectMeta(previousPath);
    meta.display_name = displayName.slice(0, 80);
    await writeProjectMeta(previousPath, meta);

    if (needsDirectoryRename && sameLocation) {
      await renameCaseOnlyDirectory(previousPath, targetPath);
    } else if (needsDirectoryRename) {
      await fs.rename(previousPath, targetPath);
    }

    this.currentProject = {
      path: needsDirectoryRename ? targetPath : previousPath,
      name: meta.display_name
    };
    await this.persistState();
    return {
      ...this.currentProject,
      previous_path: needsDirectoryRename ? previousPath : ""
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    const raw = await fs.readFile(this.stateFilePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ProjectSessionState>;
      const storedPath = typeof parsed.current_project?.path === "string" ? parsed.current_project.path.trim() : "";
      if (!storedPath) {
        return;
      }
      const resolved = path.resolve(storedPath);
      const stats = await fs.stat(resolved).catch(() => null);
      if (!stats?.isDirectory()) {
        await this.persistState();
        return;
      }
      this.currentProject = await this.readProjectInfo(resolved, parsed.current_project?.name);
    } catch {
      this.currentProject = { path: "", name: "" };
    }
  }

  private async persistState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    await fs.writeFile(
      this.stateFilePath,
      `${JSON.stringify({ current_project: this.currentProject, updated_at: this.now() }, null, 2)}\n`,
      "utf8"
    );
  }

  private async readProjectInfo(projectPath: string, fallbackName = ""): Promise<CurrentProject> {
    const meta = await readProjectMeta(projectPath);
    return {
      path: projectPath,
      name: (meta.display_name || "").trim() || fallbackName.trim() || path.basename(projectPath)
    };
  }

  private async resolveNewProjectPath(projectPath: string, projectName: string, createInParent: boolean): Promise<string> {
    const base = path.resolve(projectPath);
    if (!createInParent) {
      return base;
    }

    await fs.mkdir(base, { recursive: true });
    const stats = await fs.stat(base).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`父目录不存在: ${base}`);
    }

    const safeName = safeProjectFolderName(projectName || DEFAULT_PROJECT_NAME);
    const initial = path.join(base, safeName);
    const initialExists = await exists(initial);
    if (!initialExists) {
      return initial;
    }

    for (let index = 2; index < 1000; index += 1) {
      const candidate = path.join(base, `${safeName} (${index})`);
      if (!(await exists(candidate))) {
        return candidate;
      }
    }

    throw new Error("无法创建唯一项目文件夹，请更换项目名称");
  }

  async buildContinuityContext(): Promise<ContinuityContext> {
    const current = await this.requireProject();
    return buildProjectContinuityContext(current.path);
  }
}

export async function buildProjectContinuityContext(projectDir: string): Promise<ContinuityContext> {
  const resolvedProjectDir = path.resolve(projectDir);
  const bodyDir = path.join(resolvedProjectDir, BODY_DIR);
  const bodyExists = await exists(bodyDir);
  let previousChapters: DocumentContent[] = [];

  if (bodyExists) {
    const files = await fs.readdir(bodyDir, { withFileTypes: true }).catch(() => []);
    const txtFiles = files.filter((f) => f.isFile() && f.name.endsWith(".txt"));

    const sortedTxtFiles = txtFiles
      .map((f) => f.name)
      .sort((a, b) => {
        const numA = getChapterNumber(a);
        const numB = getChapterNumber(b);
        if (numA !== numB) {
          return numA - numB;
        }
        if (a < b) {
          return -1;
        }
        if (a > b) {
          return 1;
        }
        return 0;
      });

    const lastTwo = sortedTxtFiles.slice(-2);
    previousChapters = await Promise.all(
      lastTwo.map(async (name) => {
        const relPath = path.join(BODY_DIR, name).replace(/\\/g, "/");
        const fullPath = path.join(bodyDir, name);
        const content = await readTextWithLimit(fullPath, 6000);
        return {
          path: relPath,
          content,
          updated_at: ""
        };
      })
    );
  }

  const statePath = path.join(resolvedProjectDir, SETTINGS_DIR, "project_state.json");
  let stateSummary = "";
  if (await exists(statePath)) {
    try {
      const rawState = await fs.readFile(statePath, "utf8");
      const state = JSON.parse(rawState) as Record<string, unknown>;
      stateSummary = JSON.stringify({
        updated_at: state.updated_at || "",
        body: state.body || {},
        ledger: state.ledger || {}
      }).slice(0, 8000);
    } catch {
      stateSummary = "project_state.json 解析失败";
    }
  }

  const outline = await readTextWithLimit(path.join(resolvedProjectDir, OUTLINE_DIR, "大纲.txt"), 12000);
  const detailedOutline = await readTextWithLimit(path.join(resolvedProjectDir, OUTLINE_DIR, "细纲.txt"), 12000);
  const chapterOutline = await readTextWithLimit(path.join(resolvedProjectDir, OUTLINE_DIR, "章纲.txt"), 12000);

  const lore: Record<string, string> = {
    "人物设定": await readFirstExistingText([
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定库", "人物设定.txt"),
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定集", "人物设定.txt")
    ], 8000),
    "体系设定": await readFirstExistingText([
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定库", "体系设定.txt"),
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定集", "体系设定.txt")
    ], 8000),
    "地图设定": await readFirstExistingText([
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定库", "地图设定.txt"),
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定集", "地图设定.txt")
    ], 8000),
    "道具设定": await readFirstExistingText([
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定库", "道具设定.txt"),
      path.join(resolvedProjectDir, SETTINGS_DIR, "设定集", "道具设定.txt")
    ], 8000)
  };

  const styleDistillation = await readProjectStyleDistillation(resolvedProjectDir);
  const style: Record<string, string> = styleDistillation?.enabled && styleDistillation.profile_text.trim()
    ? {
        "Nuwa蒸馏文风": styleDistillation.profile_text,
        "当前蒸馏书籍": styleDistillation.book_title,
        "蒸馏来源摘要": styleDistillation.source_summary
      }
    : {
    "写作风格": await readTextWithLimit(path.join(resolvedProjectDir, SETTINGS_DIR, STYLE_DIR, "写作风格.txt"), 8000),
    "风格示例": await readTextWithLimit(path.join(resolvedProjectDir, SETTINGS_DIR, STYLE_DIR, "风格示例.txt"), 8000),
    "参考素材": await readTextWithLimit(path.join(resolvedProjectDir, SETTINGS_DIR, STYLE_DIR, "参考素材.txt"), 8000)
  };

  const genre: Record<string, string> = {
    "题材规则": await readTextWithLimit(path.join(resolvedProjectDir, SETTINGS_DIR, GENRE_DIR, "题材规则.txt"), 8000),
    "题材素材": await readTextWithLimit(path.join(resolvedProjectDir, SETTINGS_DIR, GENRE_DIR, "题材素材.txt"), 8000),
    "战斗模板": await readTextWithLimit(path.join(resolvedProjectDir, SETTINGS_DIR, GENRE_DIR, "战斗模板.txt"), 8000),
    "违禁词": await readTextWithLimit(path.join(resolvedProjectDir, SETTINGS_DIR, GENRE_DIR, "违禁词.txt"), 8000)
  };

  return {
    outline,
    detailed_outline: detailedOutline,
    chapter_outline: chapterOutline,
    previous_chapters: previousChapters,
    lore,
    style,
    genre,
    state_summary: stateSummary,
    style_distillation: styleDistillation
  };
}

export async function readProjectStyleDistillation(projectDir: string): Promise<StyleDistillationProfile | null> {
  const filePath = path.join(path.resolve(projectDir), STYLE_DISTILLATION_REL_PATH);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StyleDistillationProfile>;
    const profileText = String(parsed.profile_text || "").trim();
    const bookTitle = String(parsed.book_title || "").trim();
    if (!profileText || !bookTitle) {
      return null;
    }
    return {
      book_title: bookTitle,
      source_summary: String(parsed.source_summary || ""),
      source_path: String(parsed.source_path || ""),
      source_hash: String(parsed.source_hash || ""),
      distilled_at: String(parsed.distilled_at || ""),
      enabled: Boolean(parsed.enabled),
      profile_text: profileText
    };
  } catch {
    return null;
  }
}

export async function writeProjectStyleDistillation(projectDir: string, profile: StyleDistillationProfile): Promise<StyleDistillationProfile> {
  const normalized: StyleDistillationProfile = {
    book_title: String(profile.book_title || "").trim() || "未命名书籍",
    source_summary: String(profile.source_summary || "").trim(),
    source_path: String(profile.source_path || "").trim(),
    source_hash: String(profile.source_hash || "").trim(),
    distilled_at: String(profile.distilled_at || "").trim(),
    enabled: Boolean(profile.enabled),
    profile_text: String(profile.profile_text || "").trim()
  };
  if (!normalized.profile_text) {
    throw new Error("蒸馏档案内容为空");
  }

  const filePath = path.join(path.resolve(projectDir), STYLE_DISTILLATION_REL_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function deleteProjectStyleDistillation(projectDir: string): Promise<void> {
  const filePath = path.join(path.resolve(projectDir), STYLE_DISTILLATION_REL_PATH);
  await fs.rm(filePath, { force: true }).catch(() => {});
}

export function safeProjectFolderName(name: string): string {
  let cleaned = (name || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "");
  cleaned = cleaned.replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  if (!cleaned) {
    cleaned = DEFAULT_PROJECT_NAME;
  }
  if (RESERVED_NAMES.has(cleaned.toUpperCase())) {
    cleaned = `${cleaned}_project`;
  }
  return cleaned.slice(0, 80);
}

export function projectMetaPath(projectPath: string): string {
  return path.join(projectPath, AGENT_DIR, PROJECT_META_FILE);
}

async function readProjectMeta(projectPath: string): Promise<Record<string, string>> {
  const filePath = projectMetaPath(projectPath);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [String(key), value === undefined || value === null ? "" : String(value)]));
  } catch {
    return {};
  }
}

async function writeProjectMeta(projectPath: string, payload: Record<string, string>): Promise<void> {
  const filePath = projectMetaPath(projectPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function pathsReferToSameLocation(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32" ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}

async function renameCaseOnlyDirectory(sourcePath: string, targetPath: string): Promise<void> {
  const parent = path.dirname(sourcePath);
  const stem = path.basename(sourcePath).replace(/^[.]+/g, "") || "project";
  let tempPath = "";
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(parent, `.${stem}.rename-${Date.now()}-${index}`);
    if (!(await exists(candidate))) {
      tempPath = candidate;
      break;
    }
  }
  if (!tempPath) {
    throw new Error("无法创建临时目录完成项目文件夹改名");
  }

  await fs.rename(sourcePath, tempPath);
  try {
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.rename(tempPath, sourcePath).catch(() => {});
    throw error;
  }
}

function formatNow(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getChapterNumber(filename: string): number {
  const stem = path.parse(filename).name;
  const match = stem.match(/第\s*(\d+)\s*章/);
  return match ? Number.parseInt(match[1]!, 10) : -1;
}

async function readTextWithLimit(filePath: string, limit?: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath);
    const encodings = ["utf-8", "gb18030", "utf-16le", "utf-16be"];
    for (const encoding of encodings) {
      try {
        const decoder = new TextDecoder(encoding, { fatal: true });
        const decoded = decoder.decode(content);
        return limit !== undefined ? decoded.slice(0, limit) : decoded;
      } catch {
        // ignore
      }
    }
    const fallback = content.toString("utf8");
    return limit !== undefined ? fallback.slice(0, limit) : fallback;
  } catch {
    return "";
  }
}

async function readFirstExistingText(filePaths: string[], limit?: number): Promise<string> {
  for (const filePath of filePaths) {
    const content = await readTextWithLimit(filePath, limit);
    if (content) {
      return content;
    }
  }
  return "";
}
