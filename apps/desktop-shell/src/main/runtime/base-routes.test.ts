import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleBaseRuntimeRoutes } from "./base-routes.js";
import type { RuntimeContext } from "./types.js";

vi.mock("@xiaoshuo/config-service", () => ({
  loadPublicConfig: vi.fn(),
  savePublicConfig: vi.fn()
}));

import { loadPublicConfig, savePublicConfig } from "@xiaoshuo/config-service";

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {
      list: () => [{ id: "job-1" }, { id: "job-2" }]
    } as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createResponse(): ServerResponse {
  return {} as ServerResponse;
}

describe("handleBaseRuntimeRoutes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves health payload with version and ts job count", async () => {
    const writeJson = vi.fn();
    const handled = await handleBaseRuntimeRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/health",
      createContext(),
      {
        readJsonBody: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        version: "0.1.0",
        runtime: "typescript-electron",
        ts_services: expect.objectContaining({
          ts_job_count: 2
        })
      })
    );
  });

  it("serves login-required license status when no website account is configured", async () => {
    const writeJson = vi.fn();
    vi.mocked(loadPublicConfig).mockResolvedValue({
      ai_config_mode: "manual",
      website_profile: {},
      license_account_key: ""
    } as unknown as Awaited<ReturnType<typeof loadPublicConfig>>);

    const handled = await handleBaseRuntimeRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/license/status",
      createContext(),
      {
        readJsonBody: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(loadPublicConfig).toHaveBeenCalledWith({
      rootDir: "D:\\xiaoshuo\\ts-migration",
      env: process.env
    });
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: false,
        licensed: false,
        status: "login_required",
        deviceCode: expect.any(String)
      })
    );
  });

  it("verifies license status through the website account token", async () => {
    const writeJson = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            ok: true,
            licensed: true,
            status: "licensed",
            message: "账号已授权",
            license: { planType: "lifetime", expiresAt: "" }
          })
        )
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(loadPublicConfig).mockResolvedValue({
      ai_config_mode: "website",
      website_profile: {
        api_key: "website-token",
        license_account_key: "website-token"
      }
    } as unknown as Awaited<ReturnType<typeof loadPublicConfig>>);

    const handled = await handleBaseRuntimeRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/license/status",
      createContext(),
      {
        readJsonBody: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://matian.online/api/software-license/verify",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer website-token"
        }),
        body: expect.stringContaining("\"toolKind\":\"novel\"")
      })
    );
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        licensed: true,
        status: "licensed",
        message: "账号已授权",
        planType: "lifetime"
      })
    );
  });

  it("loads config on GET /api/config", async () => {
    const writeJson = vi.fn();
    vi.mocked(loadPublicConfig).mockResolvedValue({ language: "zh-CN" } as unknown as Awaited<ReturnType<typeof loadPublicConfig>>);

    const handled = await handleBaseRuntimeRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/config",
      createContext(),
      {
        readJsonBody: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(loadPublicConfig).toHaveBeenCalledWith({ rootDir: "D:\\xiaoshuo\\ts-migration" });
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, { language: "zh-CN" });
  });

  it("saves config on POST /api/config", async () => {
    const writeJson = vi.fn();
    const readJsonBody = vi.fn().mockResolvedValue({ theme: "dark" });
    vi.mocked(savePublicConfig).mockResolvedValue({ theme: "dark" } as unknown as Awaited<ReturnType<typeof savePublicConfig>>);

    const handled = await handleBaseRuntimeRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/config",
      createContext(),
      {
        readJsonBody,
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(readJsonBody).toHaveBeenCalled();
    expect(savePublicConfig).toHaveBeenCalledWith({ theme: "dark" }, { rootDir: "D:\\xiaoshuo\\ts-migration" });
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, { theme: "dark" });
  });

  it("returns false for unmatched routes", async () => {
    const handled = await handleBaseRuntimeRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/unknown",
      createContext(),
      {
        readJsonBody: vi.fn(),
        writeJson: vi.fn()
      }
    );

    expect(handled).toBe(false);
  });
});
