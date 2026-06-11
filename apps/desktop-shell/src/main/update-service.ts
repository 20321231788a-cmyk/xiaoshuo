import { app } from "electron";
import { createRequire } from "node:module";
import type { AppUpdater } from "electron-updater";
import type { DesktopUpdateStatus } from "../shared/channels.js";

type UpdateStatusListener = (status: DesktopUpdateStatus) => void;

type UpdateServiceOptions = {
  beforeInstall?: () => Promise<void> | void;
};

const DEFAULT_UPDATE_OWNER = "20321231788a-cmyk";
const DEFAULT_UPDATE_REPO = "xiaoshuo";
const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as { autoUpdater: AppUpdater };

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

export class UpdateService {
  private readonly listeners = new Set<UpdateStatusListener>();
  private readonly beforeInstall?: () => Promise<void> | void;
  private status: DesktopUpdateStatus;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(options: UpdateServiceOptions = {}) {
    this.beforeInstall = options.beforeInstall;
    const repository = resolveUpdateRepository();
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL({
      provider: "github",
      owner: repository.owner,
      repo: repository.repo,
      private: false
    });

    this.status = {
      state: "idle",
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      canCheck: app.isPackaged
    };

    autoUpdater.on("checking-for-update", () => {
      this.setStatus({ state: "checking", error: undefined, checkedAt: new Date().toISOString() });
    });

    autoUpdater.on("update-available", (info) => {
      this.setStatus({
        state: "available",
        latestVersion: info.version,
        releaseName: info.releaseName || undefined,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        error: undefined,
        percent: undefined,
        checkedAt: new Date().toISOString()
      });
    });

    autoUpdater.on("update-not-available", (info) => {
      this.setStatus({
        state: "not_available",
        latestVersion: info.version,
        releaseName: info.releaseName || undefined,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        error: undefined,
        percent: undefined,
        checkedAt: new Date().toISOString()
      });
    });

    autoUpdater.on("download-progress", (progress) => {
      this.setStatus({
        state: "downloading",
        percent: Math.max(0, Math.min(100, progress.percent || 0)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
        error: undefined
      });
    });

    autoUpdater.on("update-downloaded", (event) => {
      this.setStatus({
        state: "downloaded",
        latestVersion: event.version,
        releaseName: event.releaseName || undefined,
        releaseNotes: normalizeReleaseNotes(event.releaseNotes),
        downloadedFile: event.downloadedFile,
        percent: 100,
        error: undefined
      });
    });

    autoUpdater.on("error", (error) => {
      this.setStatus({
        state: "error",
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
        error: "开发模式不可用：请使用正式安装包后再检查 GitHub Releases 更新。",
        checkedAt: new Date().toISOString()
      });
    }

    try {
      this.setStatus({ state: "checking", error: undefined, checkedAt: new Date().toISOString() });
      await autoUpdater.checkForUpdates();
      return this.status;
    } catch (error) {
      return this.setStatus({
        state: "error",
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString()
      });
    }
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
      this.setStatus({ state: "downloading", percent: 0, error: undefined });
      const files = await autoUpdater.downloadUpdate();
      return this.setStatus({
        state: "downloaded",
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
    autoUpdater.quitAndInstall(false, true);
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
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      canCheck: app.isPackaged
    };
    for (const listener of this.listeners) {
      listener(this.status);
    }
    return this.status;
  }
}
