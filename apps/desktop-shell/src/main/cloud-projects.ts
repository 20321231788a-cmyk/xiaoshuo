import { loadPublicConfig } from "@xiaoshuo/config-service";
import type {
  CloudProjectDeleteResponse,
  CloudProjectDownloadRequest,
  CloudProjectDownloadResponse,
  CloudProjectInspectRequest,
  CloudProjectInspectResponse,
  CloudProjectListResponse,
  CloudProjectSlot,
  CloudProjectUploadRequest,
  CloudProjectUploadResponse
} from "../shared/channels.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CLOUD_CORE_DATA_LIMIT_BYTES,
  defaultProjectArchiveName,
  exportCloudCoreArchiveToTemp,
  exportProjectArchive,
  importCloudCoreArchiveToExisting,
  inspectCloudCoreProject
} from "./project-archive.js";
import { loadLicenseStatusForRoot } from "./runtime/license-guard.js";

const DEFAULT_WEBSITE_BASE_URL = "https://matian.online";
export const CLOUD_PROJECT_UPLOAD_LIMIT_BYTES = CLOUD_CORE_DATA_LIMIT_BYTES;

export type CloudProjectServiceOptions = {
  appRoot: string;
  tempRoot: string;
  stateRoot?: string;
};

type CloudSyncStateRecord = {
  key: string;
  slot_id: number;
  remote_id: string;
  remote_updated_at: string;
  content_digest: string;
};

type WebsiteJsonRecord = Record<string, unknown>;

export class CloudProjectService {
  constructor(private readonly options: CloudProjectServiceOptions) {}

  async list(): Promise<CloudProjectListResponse> {
    const { tokenKey, websiteBaseUrl } = await this.readWebsiteToken();
    const payload = await this.fetchWebsiteJson<CloudProjectListResponse>(`${websiteBaseUrl}/api/arcwriter/cloud-projects`, {
      headers: this.authHeaders(tokenKey)
    });
    return normalizeListResponse(payload);
  }

  async inspect(request: CloudProjectInspectRequest): Promise<CloudProjectInspectResponse> {
    const inspection = await inspectCloudCoreProject(path.resolve(request.project_path));
    return {
      ok: true,
      project_path: path.resolve(request.project_path),
      core_bytes: inspection.total_bytes,
      file_count: inspection.file_count,
      max_upload_bytes: CLOUD_PROJECT_UPLOAD_LIMIT_BYTES,
      largest_files: inspection.largest_files
    };
  }

  async upload(request: CloudProjectUploadRequest): Promise<CloudProjectUploadResponse> {
    const projectPath = path.resolve(request.project_path);
    const projectName = request.project_name || path.basename(projectPath);
    await this.requireLicensedForCloudUpload();
    const { tokenKey, websiteBaseUrl } = await this.readWebsiteToken();
    const tempDir = await fs.mkdtemp(path.join(this.options.tempRoot, "arcwriter-cloud-upload-"));
    let archivePath = "";
    try {
      const projectId = request.project_id || await readProjectId(projectPath);
      const exported = await exportCloudCoreArchiveToTemp({
        projectPath,
        tempDir,
        fileName: defaultProjectArchiveName(projectName, projectPath),
        projectId,
        projectName
      });
      archivePath = exported.archivePath;
      const stats = await fs.stat(archivePath);
      if (!stats.isFile() || stats.size <= 0) {
        throw new Error("项目归档为空，无法上传。");
      }
      if (stats.size > CLOUD_PROJECT_UPLOAD_LIMIT_BYTES) {
        throw new Error("单本小说的云同步数据上限为 30MB。");
      }

      const contentDigest = createHash("sha256")
        .update(exported.inspection.files.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}`).join("\n"))
        .digest("hex");
      const syncKey = projectId || projectPath.toLocaleLowerCase("en-US");
      const remoteList = normalizeListResponse(await this.fetchWebsiteJson<CloudProjectListResponse>(`${websiteBaseUrl}/api/arcwriter/cloud-projects`, {
        headers: this.authHeaders(tokenKey)
      }));
      const remoteSlot = remoteList.slots.find((slot) => slot.slot_id === request.slot_id);
      const syncState = await this.readSyncState();
      const previous = syncState.find((entry) => entry.key === syncKey && entry.slot_id === request.slot_id);
      if (remoteSlot && previous && previous.remote_id === remoteSlot.id && previous.remote_updated_at === remoteSlot.updated_at && previous.content_digest === contentDigest) {
        return {
          ok: true,
          slot: remoteSlot,
          uploaded_bytes: 0,
          daily_upload_limit: remoteList.daily_upload_limit,
          today_upload_count: remoteList.today_upload_count,
          today_upload_remaining: remoteList.today_upload_remaining,
          core_bytes: exported.inspection.total_bytes,
          unchanged: true
        };
      }

      const form = new FormData();
      form.set("slot_id", String(request.slot_id));
      form.set("project_name", projectName);
      form.set("project_id", projectId);
      form.set("sync_mode", request.sync_mode || "manual");
      form.set("core_bytes", String(exported.inspection.total_bytes));
      form.set("content_digest", contentDigest);
      form.set("project", new Blob([await fs.readFile(archivePath)], { type: "application/zip" }), path.basename(archivePath));

      const payload = await this.fetchWebsiteJson<CloudProjectUploadResponse>(`${websiteBaseUrl}/api/arcwriter/cloud-projects`, {
        method: "POST",
        headers: this.authHeaders(tokenKey),
        body: form
      });
      const normalizedSlot = normalizeSlot(payload.slot);
      await this.writeSyncState([
        ...syncState.filter((entry) => entry.key !== syncKey && entry.slot_id !== request.slot_id),
        { key: syncKey, slot_id: request.slot_id, remote_id: normalizedSlot.id, remote_updated_at: normalizedSlot.updated_at, content_digest: contentDigest }
      ]);
      return {
        ok: Boolean(payload.ok ?? true),
        slot: normalizedSlot,
        uploaded_bytes: Number(payload.uploaded_bytes || stats.size),
        daily_upload_limit: numberValue(payload.daily_upload_limit) || 10,
        today_upload_count: numberValue(payload.today_upload_count),
        today_upload_remaining: numberValue(payload.today_upload_remaining),
        core_bytes: numberValue(payload.core_bytes) || exported.inspection.total_bytes,
        unchanged: Boolean(payload.unchanged)
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async downloadToProject(request: CloudProjectDownloadRequest): Promise<CloudProjectDownloadResponse> {
    const targetProjectPath = path.resolve(request.project_path);
    const projectName = request.project_name || path.basename(targetProjectPath);
    const { tokenKey, websiteBaseUrl } = await this.readWebsiteToken();
    const targetStats = await fs.stat(targetProjectPath).catch(() => null);
    if (!targetStats?.isDirectory()) {
      throw new Error(`当前项目目录不存在: ${targetProjectPath}`);
    }

    const backupPath = await this.makeBackupPath(targetProjectPath, projectName);
    await exportProjectArchive({ projectPath: targetProjectPath, targetPath: backupPath });

    const tempDir = await fs.mkdtemp(path.join(this.options.tempRoot, "arcwriter-cloud-download-"));
    const archivePath = path.join(tempDir, `${randomUUID()}.arcwriter.zip`);
    try {
      const response = await this.fetchWebsite(`${websiteBaseUrl}/api/arcwriter/cloud-projects/${encodeURIComponent(request.id)}/download`, {
        headers: this.authHeaders(tokenKey)
      });
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length) {
        throw new Error("云项目下载为空。");
      }
      if (data.length > CLOUD_PROJECT_UPLOAD_LIMIT_BYTES) {
        throw new Error("云项目文件超过 30MB，已停止同步。");
      }
      await fs.writeFile(archivePath, data);
      const restored = await importCloudCoreArchiveToExisting({
        archivePath,
        targetProjectPath
      });
      return {
        ok: true,
        project_path: targetProjectPath,
        backup_path: backupPath,
        restored_files: restored.restored_files,
        restored_bytes: restored.restored_bytes
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} 当前项目备份已保留：${backupPath}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async delete(request: { id: string }): Promise<CloudProjectDeleteResponse> {
    const { tokenKey, websiteBaseUrl } = await this.readWebsiteToken();
    const payload = await this.fetchWebsiteJson<CloudProjectDeleteResponse>(
      `${websiteBaseUrl}/api/arcwriter/cloud-projects/${encodeURIComponent(request.id)}`,
      {
        method: "DELETE",
        headers: this.authHeaders(tokenKey)
      }
    );
    const syncState = await this.readSyncState();
    await this.writeSyncState(syncState.filter((entry) => entry.remote_id !== request.id));
    return {
      ok: Boolean(payload.ok ?? true),
      deleted_id: String(payload.deleted_id || request.id)
    };
  }

  private async readWebsiteToken(): Promise<{ tokenKey: string; websiteBaseUrl: string }> {
    const config = await loadPublicConfig({ rootDir: this.options.appRoot });
    const websiteProfile = (config.website_profile || {}) as Record<string, unknown>;
    const tokenKey = String(
      websiteProfile.license_account_key || websiteProfile.api_key || config.license_account_key || ""
    ).trim();
    if (!tokenKey) {
      throw new Error("请先在网站配置里登录账号。");
    }
    return { tokenKey, websiteBaseUrl: resolveWebsiteBaseUrl(process.env) };
  }

  private async requireLicensedForCloudUpload(): Promise<void> {
    const licenseStatus = await loadLicenseStatusForRoot(this.options.appRoot);
    if (licenseStatus.licensed) {
      return;
    }
    const reason = String(licenseStatus.message || "").trim();
    throw new Error(reason ? `当前账号未授权，无法上传云项目。${reason}` : "当前账号未授权，无法上传云项目。请登录已授权的网站账号后刷新授权状态。");
  }

  private async makeBackupPath(projectPath: string, projectName: string): Promise<string> {
    const backupDir = path.join(path.dirname(projectPath), ".arcwriter-cloud-backups");
    await fs.mkdir(backupDir, { recursive: true });
    const stem = defaultProjectArchiveName(projectName, projectPath).replace(/\.zip$/i, "");
    return path.join(backupDir, `${stem}.cloud-backup-${formatTimestamp(new Date())}.zip`);
  }

  private async readSyncState(): Promise<CloudSyncStateRecord[]> {
    const raw = await fs.readFile(this.syncStatePath(), "utf8").catch(() => "");
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const value = entry as Partial<CloudSyncStateRecord>;
        return typeof value.key === "string" && typeof value.remote_id === "string" && typeof value.content_digest === "string"
          ? [{ key: value.key, slot_id: Number(value.slot_id || 0), remote_id: value.remote_id, remote_updated_at: String(value.remote_updated_at || ""), content_digest: value.content_digest }]
          : [];
      });
    } catch {
      return [];
    }
  }

  private async writeSyncState(records: CloudSyncStateRecord[]): Promise<void> {
    const targetPath = this.syncStatePath();
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(records), "utf8");
    await fs.rename(temporaryPath, targetPath);
  }

  private syncStatePath(): string {
    return path.join(this.options.stateRoot || this.options.tempRoot, "arcwriter-cloud-sync-state.json");
  }

  private authHeaders(tokenKey: string): Headers {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${tokenKey}`);
    return headers;
  }

  private async fetchWebsiteJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchWebsite(url, init);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async fetchWebsite(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(extractWebsiteError(text) || response.statusText || `网站接口请求失败：${response.status}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("连接网站超时，请稍后重试。");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function resolveWebsiteBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = String(env.XIAOSHUO_WEBSITE_BASE_URL || DEFAULT_WEBSITE_BASE_URL).trim() || DEFAULT_WEBSITE_BASE_URL;
  return raw.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function normalizeListResponse(payload: CloudProjectListResponse): CloudProjectListResponse {
  return {
    slots: Array.isArray(payload.slots) ? payload.slots.map(normalizeSlot).filter((slot) => slot.id) : [],
    limit: Number(payload.limit || 3),
    max_upload_bytes: Number(payload.max_upload_bytes || CLOUD_PROJECT_UPLOAD_LIMIT_BYTES),
    daily_upload_limit: numberValue(payload.daily_upload_limit) || 10,
    today_upload_count: numberValue(payload.today_upload_count),
    today_upload_remaining: numberValue(payload.today_upload_remaining),
    daily_upload_bytes_limit: numberValue(payload.daily_upload_bytes_limit),
    daily_upload_bytes_used: numberValue(payload.daily_upload_bytes_used),
    daily_upload_bytes_remaining: numberValue(payload.daily_upload_bytes_remaining),
    monthly_upload_bytes_limit: numberValue(payload.monthly_upload_bytes_limit),
    monthly_upload_bytes_used: numberValue(payload.monthly_upload_bytes_used),
    monthly_upload_bytes_remaining: numberValue(payload.monthly_upload_bytes_remaining),
    monthly_download_bytes_limit: numberValue(payload.monthly_download_bytes_limit),
    monthly_download_bytes_used: numberValue(payload.monthly_download_bytes_used),
    monthly_download_bytes_remaining: numberValue(payload.monthly_download_bytes_remaining),
    quota_resets_at: String(payload.quota_resets_at || "")
  };
}

function normalizeSlot(value: unknown): CloudProjectSlot {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as WebsiteJsonRecord) : {};
  return {
    id: String(record.id || ""),
    slot_id: clampSlotId(record.slot_id ?? record.slotId),
    project_name: String(record.project_name || record.projectName || ""),
    project_id: String(record.project_id || record.projectId || ""),
    file_name: String(record.file_name || record.fileName || ""),
    size: numberValue(record.size),
    core_size: numberValue(record.core_size || record.core_bytes),
    revision: numberValue(record.revision),
    sha256: String(record.sha256 || ""),
    created_at: String(record.created_at || record.createdAt || ""),
    updated_at: String(record.updated_at || record.updatedAt || "")
  };
}

async function readProjectId(projectRoot: string): Promise<string> {
  const raw = await fs.readFile(path.join(projectRoot, "00_设定集", ".agent", "project_manifest.json"), "utf8").catch(() => "");
  if (!raw.trim()) return "";
  try {
    const value = JSON.parse(raw) as { project_id?: unknown };
    return typeof value.project_id === "string" ? value.project_id.trim() : "";
  } catch {
    return "";
  }
}

function clampSlotId(value: unknown): 1 | 2 | 3 {
  const parsed = Number.parseInt(String(value), 10);
  return parsed === 1 || parsed === 2 || parsed === 3 ? parsed : 1;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function extractWebsiteError(text: string): string {
  if (!text) {
    return "";
  }
  try {
    const payload = JSON.parse(text) as WebsiteJsonRecord;
    return String(payload.message || payload.detail || payload.error || "").trim();
  } catch {
    return text.trim();
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
