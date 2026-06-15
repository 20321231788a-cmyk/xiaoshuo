import { loadPublicConfig } from "@xiaoshuo/config-service";
import type {
  CloudProjectDeleteResponse,
  CloudProjectDownloadRequest,
  CloudProjectDownloadResponse,
  CloudProjectListResponse,
  CloudProjectSlot,
  CloudProjectUploadRequest,
  CloudProjectUploadResponse
} from "../shared/channels.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultProjectArchiveName,
  exportProjectArchive,
  exportProjectArchiveToTemp,
  importProjectArchiveToExisting
} from "./project-archive.js";
import { loadLicenseStatusForRoot } from "./runtime/license-guard.js";

const DEFAULT_WEBSITE_BASE_URL = "https://matian.online";
export const CLOUD_PROJECT_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export type CloudProjectServiceOptions = {
  appRoot: string;
  tempRoot: string;
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

  async upload(request: CloudProjectUploadRequest): Promise<CloudProjectUploadResponse> {
    const projectPath = path.resolve(request.project_path);
    const projectName = request.project_name || path.basename(projectPath);
    await this.requireLicensedForCloudUpload();
    const { tokenKey, websiteBaseUrl } = await this.readWebsiteToken();
    const tempDir = await fs.mkdtemp(path.join(this.options.tempRoot, "arcwriter-cloud-upload-"));
    let archivePath = "";
    try {
      archivePath = await exportProjectArchiveToTemp({
        projectPath,
        tempDir,
        fileName: defaultProjectArchiveName(projectName, projectPath)
      });
      const stats = await fs.stat(archivePath);
      if (!stats.isFile() || stats.size <= 0) {
        throw new Error("项目归档为空，无法上传。");
      }
      if (stats.size > CLOUD_PROJECT_UPLOAD_LIMIT_BYTES) {
        throw new Error("云项目上传上限为 20MB。");
      }

      const form = new FormData();
      form.set("slot_id", String(request.slot_id));
      form.set("project_name", projectName);
      form.set("project", new Blob([await fs.readFile(archivePath)], { type: "application/zip" }), path.basename(archivePath));

      const payload = await this.fetchWebsiteJson<CloudProjectUploadResponse>(`${websiteBaseUrl}/api/arcwriter/cloud-projects`, {
        method: "POST",
        headers: this.authHeaders(tokenKey),
        body: form
      });
      return {
        ok: Boolean(payload.ok ?? true),
        slot: normalizeSlot(payload.slot),
        uploaded_bytes: Number(payload.uploaded_bytes || stats.size),
        daily_upload_limit: numberValue(payload.daily_upload_limit) || 10,
        today_upload_count: numberValue(payload.today_upload_count),
        today_upload_remaining: numberValue(payload.today_upload_remaining)
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
        throw new Error("云项目文件超过 20MB，已停止同步。");
      }
      await fs.writeFile(archivePath, data);
      await importProjectArchiveToExisting({
        archivePath,
        targetProjectPath
      });
      return {
        ok: true,
        project_path: targetProjectPath,
        backup_path: backupPath
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
    today_upload_remaining: numberValue(payload.today_upload_remaining)
  };
}

function normalizeSlot(value: unknown): CloudProjectSlot {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as WebsiteJsonRecord) : {};
  return {
    id: String(record.id || ""),
    slot_id: clampSlotId(record.slot_id ?? record.slotId),
    project_name: String(record.project_name || record.projectName || ""),
    file_name: String(record.file_name || record.fileName || ""),
    size: numberValue(record.size),
    sha256: String(record.sha256 || ""),
    created_at: String(record.created_at || record.createdAt || ""),
    updated_at: String(record.updated_at || record.updatedAt || "")
  };
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
