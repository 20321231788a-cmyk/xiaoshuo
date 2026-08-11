import { app } from "electron";
import { createRequire } from "node:module";
import type { AppUpdater } from "electron-updater";
import type { DesktopUpdateStatus } from "../shared/channels.js";

type UpdateStatusListener = (status: DesktopUpdateStatus) => void;
type UpdateSource = "github" | "mirror";
type UpdateApp = Pick<typeof app, "getVersion" | "isPackaged">;

type UpdateServiceOptions = {
  beforeInstall?: () => Promise<void> | void;
  app?: UpdateApp;
  autoUpdater?: AppUpdater;
};

const DEFAULT_UPDATE_OWNER = "20321231788a-cmyk";
const DEFAULT_UPDATE_REPO = "xiaoshuo";
const DEFAULT_UPDATE_MIRROR_URL = "https://ai-downloads-1318078295.cos.ap-guangzhou.myqcloud.com/software/novel/";
const require = createRequire(import.meta.url);

function normalizeReleaseNotes(notes: unknown): string | undefined {
  if (!notes) {
    return undefined;
  }
  if (typeof notes === "string") {
    return notes;
  }
  if (Array.isArray(notes)) {
    return notes
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "note" in item && typeof item.note === "string") {
          return item.note;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

function resolveUpdateRepository(): { owner: string; repo: string } {
  const explicitOwner = process.env.XIAOSHUO_UPDATE_OWNER?.trim();
  const explicitRepo = process.env.XIAOSHUO_UPDATE_REPO?.trim();
  if (explicitOwner && explicitRepo) {
    return { owner: explicitOwner, repo: explicitRepo };
  }

  const githubRepository = process.env.GITHUB_REPOSITORY?.trim();
  if (githubRepository) {
    const [owner, repo] = githubRepository.split("/");
    if (owner && repo) {
      return { owner, repo };
    }
  }

  return { owner: DEFAULT_UPDATE_OWNER, repo: DEFAULT_UPDATE_REPO };
}

function resolveUpdateMirrorUrl(): string {
  const explicitMirrorUrl = process.env.XIAOSHUO_UPDATE_MIRROR_URL?.trim();
  return ensureTrailingSlash(explicitMirrorUrl || DEFAULT_UPDATE_MIRROR_URL);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function getDefaultAutoUpdater(): AppUpdater {
  const { autoUpdater } = require("electron-updater") as { autoUpdater: AppUpdater };
  return autoUpdater;
}

export class UpdateService {
  private readonly listeners = new Set<UpdateStatusListener>();
  private readonly beforeInstall?: () => Promise<void> | void;
  private readonly app: UpdateApp;
  private readonly autoUpdater: AppUpdater;
  private readonly repository: { owner: string; repo: string };
  private readonly mirrorUrl: string;
  private activeSource: UpdateSource = "mirror";
  private status: DesktopUpdateStatus;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(options: UpdateServiceOptions = {}) {
    this.beforeInstall = options.beforeInstall;
    this.app = options.app || app;
    this.autoUpdater = options.autoUpdater || getDefaultAutoUpdater();
    this.repository = resolveUpdateRepository();
    this.mirrorUrl = resolveUpdateMirrorUrl();
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.allowPrerelease = false;
    this.useUpdateSource("mirror");

    this.status = {
      state: "idle",
      currentVersion: this.app.getVersion(),
      updateSource: this.activeSource,
      isPackaged: this.app.isPackaged,
      canCheck: this.app.isPackaged
    };

    this.autoUpdater.on("checking-for-update", () => {
      this.setStatus({ state: "checking", updateSource: this.activeSource, error: undefined, checkedAt: new Date().toISOString() });
    });

    this.autoUpdater.on("update-available", (info) => {
      this.setStatus({
        state: "available",
        updateSource: this.activeSource,
        latestVersion: info.version,
        releaseName: info.releaseName || undefined,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        error: undefined,
        percent: undefined,
        checkedAt: new Date().toISOString()
      });
    });

    this.autoUpdater.on("update-not-available", (info) => {
      this.setStatus({
        state: "not_available",
        updateSource: this.activeSource,
        latestVersion: info.version,
        releaseName: info.releaseName || undefined,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        error: undefined,
        percent: undefined,
        checkedAt: new Date().toISOString()
      });
    });

    this.autoUpdater.on("download-progress", (progress) => {
      this.setStatus({
        state: "downloading",
        updateSource: this.activeSource,
        percent: Math.max(0, Math.min(100, progress.percent || 0)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
        error: undefined
      });
    });

    this.autoUpdater.on("update-downloaded", (event) => {
      this.setStatus({
        state: "downloaded",
        updateSource: this.activeSource,
        latestVersion: event.version,
        releaseName: event.releaseName || undefined,
        releaseNotes: normalizeReleaseNotes(event.releaseNotes),
        downloadedFile: event.downloadedFile,
        percent: 100,
        error: undefined
      });
    });

    this.autoUpdater.on("error", (error) => {
      this.setStatus({
        state: "error",
        updateSource: this.activeSource,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  getStatus(): DesktopUpdateStatus {
    return this.status;
  }

  onStatus(listener: UpdateStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async checkForUpdates(): Promise<DesktopUpdateStatus> {
    if (!this.status.canCheck) {
      return this.setStatus({
        state: "error",
        error: "开发模式不可用：请使用正式安装包后再检查软件更新。",
        checkedAt: new Date().toISOString()
      });
    }

    const checkedAt = new Date().toISOString();
    try {
      this.useUpdateSource("mirror");
      this.setStatus({ state: "checking", updateSource: "mirror", error: undefined, checkedAt });
      await this.autoUpdater.checkForUpdates();
      return this.status;
    } catch (mirrorError) {
      try {
        this.useUpdateSource("github");
        this.setStatus({ state: "checking", updateSource: "github", error: undefined, checkedAt: new Date().toISOString() });
        await this.autoUpdater.checkForUpdates();
        return this.status;
      } catch (githubError) {
        const mirrorMessage = mirrorError instanceof Error ? mirrorError.message : String(mirrorError);
        const githubMessage = githubError instanceof Error ? githubError.message : String(githubError);
        return this.setStatus({
          state: "error",
          updateSource: "github",
          error: `国内镜像和 GitHub 更新检查都失败。国内镜像：${mirrorMessage}；GitHub：${githubMessage}`,
          checkedAt: new Date().toISOString()
        });
      }
    }
  }

  private useUpdateSource(source: UpdateSource): void {
    this.activeSource = source;
    if (source === "mirror") {
      this.autoUpdater.setFeedURL({
        provider: "generic",
        url: this.mirrorUrl
      });
      return;
    }
    this.autoUpdater.setFeedURL({
      provider: "github",
      owner: this.repository.owner,
      repo: this.repository.repo,
      private: false
    });
  }

  async downloadUpdate(): Promise<DesktopUpdateStatus> {
    if (!this.status.canCheck) {
      return this.setStatus({
        state: "error",
        error: "开发模式不可用：请使用正式安装包后再下载更新。"
      });
    }
    if (this.status.state !== "available") {
      return this.setStatus({
        state: "error",
        error: "还没有可下载的新版本，请先检查更新。"
      });
    }

    try {
      this.setStatus({ state: "downloading", updateSource: this.activeSource, percent: 0, error: undefined });
      const files = await this.autoUpdater.downloadUpdate();
      return this.setStatus({
        state: "downloaded",
        updateSource: this.activeSource,
        downloadedFile: files[0] || this.status.downloadedFile,
        percent: 100,
        error: undefined
      });
    } catch (error) {
      return this.setStatus({
        state: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async installAndRestart(): Promise<void> {
    if (this.status.state !== "downloaded") {
      this.setStatus({ state: "error", error: "更新尚未下载完成，不能安装。" });
      return;
    }

    if (this.beforeInstall) {
      await this.beforeInstall();
    }
    this.autoUpdater.quitAndInstall(false, true);
  }

  scheduleStartupCheck(delayMs = 12_000): void {
    if (!this.status.canCheck || this.startupTimer) {
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates();
    }, delayMs);
  }

  private setStatus(patch: Partial<DesktopUpdateStatus>): DesktopUpdateStatus {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: this.app.getVersion(),
      updateSource: patch.updateSource || this.status.updateSource || this.activeSource,
      isPackaged: this.app.isPackaged,
      canCheck: this.app.isPackaged
    };
    for (const listener of this.listeners) {
      listener(this.status);
    }
    return this.status;
  }
}
