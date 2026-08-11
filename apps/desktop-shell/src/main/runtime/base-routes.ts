import { loadPublicConfig, savePublicConfig } from "@xiaoshuo/config-service";
import type { AiConfigProfile } from "@xiaoshuo/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadRuntimeLicenseStatus } from "./license-guard.js";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

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
    deps.writeJson(response, 200, await loadRuntimeLicenseStatus(context));
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
    const licenseStatus = await loadRuntimeLicenseStatus(context, saved);
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

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
