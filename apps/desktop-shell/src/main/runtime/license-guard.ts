import { loadPublicConfig } from "@xiaoshuo/config-service";
import type { AiConfigProfile, AppConfig, LicenseStatus } from "@xiaoshuo/shared";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import os from "node:os";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;
type WebsiteLicensePayload = JsonRecord & {
  ok?: unknown;
  licensed?: unknown;
  status?: unknown;
  message?: unknown;
  expiresAt?: unknown;
  licenseExpiresAt?: unknown;
  license?: JsonRecord;
};

export type WriteJson = (response: ServerResponse, status: number, payload: unknown) => void;

export async function loadRuntimeLicenseStatus(context: RuntimeContext, configOverride?: AppConfig): Promise<LicenseStatus> {
  return loadLicenseStatusForRoot(context.projectRoot, configOverride);
}

export async function loadLicenseStatusForRoot(projectRoot: string, configOverride?: AppConfig): Promise<LicenseStatus> {
  const deviceCode = getDeviceCode(projectRoot);
  if (shouldBypassLicenseForE2e(process.env)) {
    return {
      ok: true,
      licensed: true,
      status: "e2e_bypass",
      message: "E2E runtime license bypass enabled.",
      deviceCode
    };
  }

  const config = configOverride || (await loadPublicConfig({ rootDir: projectRoot }));
  const websiteProfile: Partial<AiConfigProfile> = config.website_profile || {};
  const tokenKey = stringValue(websiteProfile.license_account_key || websiteProfile.api_key || config.license_account_key).trim();

  if (!tokenKey) {
    return {
      ok: false,
      licensed: false,
      status: "login_required",
      message: "请先在 AI 设置的网站配置里登录账号，软件会用该账号验证授权。",
      deviceCode
    };
  }

  try {
    const payload = await fetchWebsiteLicenseStatus(tokenKey, deviceCode);
    return normalizeLicenseStatus(payload, deviceCode);
  } catch (error) {
    return {
      ok: false,
      licensed: false,
      status: "verify_failed",
      message: error instanceof Error ? `授权验证失败：${error.message}` : "授权验证失败，请稍后重试。",
      deviceCode
    };
  }
}

export async function writeAiLicenseRequiredIfNeeded(context: RuntimeContext, response: ServerResponse, writeJson: WriteJson): Promise<boolean> {
  const licenseStatus = await loadRuntimeLicenseStatus(context);
  if (licenseStatus.licensed) {
    return false;
  }

  writeJson(response, 403, aiLicenseRequiredPayload(licenseStatus));
  return true;
}

function shouldBypassLicenseForE2e(env: NodeJS.ProcessEnv): boolean {
  return env.XIAOSHUO_E2E_RUNTIME === "1" && env.XIAOSHUO_E2E_BYPASS_LICENSE === "1";
}

export function aiLicenseRequiredPayload(licenseStatus: LicenseStatus): JsonRecord {
  return {
    detail: "当前账号未授权，无法使用 AI 功能。请登录已授权的网站账号后刷新授权状态。",
    code: "AI_LICENSE_REQUIRED",
    license_status: licenseStatus
  };
}

async function fetchWebsiteLicenseStatus(tokenKey: string, deviceCode: string): Promise<WebsiteLicensePayload> {
  const websiteBaseUrl = resolveWebsiteBaseUrl(process.env);
  const response = await fetch(`${websiteBaseUrl}/api/software-license/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenKey}`
    },
    body: JSON.stringify({
      key: tokenKey,
      accountKey: tokenKey,
      toolId: resolveLicenseToolId(process.env),
      toolKind: resolveLicenseToolKind(process.env),
      deviceCode,
      machineCode: deviceCode
    }),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    return {
      ok: false,
      licensed: false,
      status: stringValue(payload.status || (response.status === 401 ? "invalid_account_key" : "verify_failed")),
      message: stringValue(payload.message || payload.detail || response.statusText || `网站授权接口请求失败：${response.status}`)
    };
  }
  return payload as WebsiteLicensePayload;
}

function normalizeLicenseStatus(payload: WebsiteLicensePayload, deviceCode: string): LicenseStatus {
  const license = recordValue(payload.license);
  const expiresAt = stringValue(payload.expiresAt || payload.licenseExpiresAt || license?.expiresAt);
  const status = stringValue(payload.status || (payload.licensed ? "licensed" : "not_found")) || "unknown";
  const message = stringValue(payload.message || (payload.licensed ? "账号已授权" : "当前账号未授权"));
  return {
    ok: Boolean(payload.ok ?? true),
    licensed: Boolean(payload.licensed),
    status,
    message,
    deviceCode,
    expiresAt,
    licenseExpiresAt: expiresAt,
    planType: stringValue(license?.planType || payload.planType)
  };
}

function getDeviceCode(projectRoot: string): string {
  const username = safeUserName();
  const basis = [os.hostname(), username, projectRoot].filter(Boolean).join("|");
  return createHash("sha256").update(`arcwriter-license:${basis}`).digest("hex").slice(0, 32);
}

function safeUserName(): string {
  try {
    return os.userInfo().username || "";
  } catch {
    return "";
  }
}

function resolveWebsiteBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = stringValue(env.XIAOSHUO_WEBSITE_BASE_URL || "https://matian.online").trim() || "https://matian.online";
  return raw.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function resolveLicenseToolId(env: NodeJS.ProcessEnv): string {
  return stringValue(env.XIAOSHUO_LICENSE_TOOL_ID || "1").trim() || "1";
}

function resolveLicenseToolKind(env: NodeJS.ProcessEnv): string {
  return stringValue(env.XIAOSHUO_LICENSE_TOOL_KIND || "novel").trim().toLowerCase() || "novel";
}

function parseJson(text: string): JsonRecord {
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    return recordValue(parsed) || { message: text };
  } catch {
    return { message: text };
  }
}

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
