import { loadPublicConfig, savePublicConfig } from "@xiaoshuo/config-service";
import type { AiConfigProfile, AppConfig, LicenseStatus } from "@xiaoshuo/shared";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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

type RuntimeBaseRouteDeps = {
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleBaseRuntimeRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeBaseRouteDeps
): Promise<boolean> {
  if (request.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
    deps.writeJson(response, 200, {
      ok: true,
      version: "0.1.0",
      runtime: "typescript-electron",
      ts_services: {
        config: "active",
        project_session: "active",
        project_manifest: "active:readonly",
        documents: "active:read+write+timeline+ledger+revision",
        conversations: "active:file-crud",
        skills: "active:catalog+import",
        agent_runtime: "active:plan+prompt-skill+chat-stream",
        jobs: "active:local-ts",
        ts_job_count: context.jobManager.list().length
      }
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/license/status") {
    deps.writeJson(response, 200, await loadLicenseStatus(context));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/license/account-key") {
    const payload = await deps.readJsonBody(request);
    const accountKey = stringValue(payload.license_account_key || payload.accountKey || payload.key).trim();
    if (!accountKey) {
      deps.writeJson(response, 400, { detail: "缺少授权账号 Key" });
      return true;
    }
    const currentConfig = await loadPublicConfig({ rootDir: context.projectRoot });
    const websiteProfile: Partial<AiConfigProfile> = currentConfig.website_profile || {};
    const saved = await savePublicConfig(
      {
        ai_config_mode: "website",
        website_profile: {
          ...websiteProfile,
          api_key: stringValue(websiteProfile.api_key || accountKey),
          license_account_key: accountKey
        }
      },
      { rootDir: context.projectRoot }
    );
    const licenseStatus = await loadLicenseStatus(context, saved);
    deps.writeJson(response, 200, {
      ok: Boolean(licenseStatus.ok ?? licenseStatus.licensed),
      message: licenseStatus.message || (licenseStatus.licensed ? "账号授权已验证。" : "授权账号 Key 已保存，但账号未授权。"),
      config: saved,
      license_status: licenseStatus
    });
    return true;
  }

  if ((pathname === "/config" || pathname === "/api/config") && (request.method === "GET" || request.method === "POST" || request.method === "PUT")) {
    if (request.method === "GET") {
      deps.writeJson(response, 200, await loadPublicConfig({ rootDir: context.projectRoot }));
      return true;
    }

    const payload = await deps.readJsonBody(request);
    deps.writeJson(response, 200, await savePublicConfig(payload, { rootDir: context.projectRoot }));
    return true;
  }

  return false;
}

async function loadLicenseStatus(context: RuntimeContext, configOverride?: AppConfig): Promise<LicenseStatus> {
  const config = configOverride || (await loadPublicConfig({ rootDir: context.projectRoot }));
  const websiteProfile: Partial<AiConfigProfile> = config.website_profile || {};
  const tokenKey = stringValue(websiteProfile.license_account_key || websiteProfile.api_key || config.license_account_key).trim();
  const deviceCode = getDeviceCode(context.projectRoot);

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

async function fetchWebsiteLicenseStatus(tokenKey: string, deviceCode: string): Promise<WebsiteLicensePayload> {
  const websiteBaseUrl = resolveWebsiteBaseUrl(process.env);
  const response = await fetch(`${websiteBaseUrl}/api/software-license/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
