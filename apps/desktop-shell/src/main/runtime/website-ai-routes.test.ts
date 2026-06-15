import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWebsiteAiRoutes } from "./website-ai-routes.js";
import type { RuntimeContext } from "./types.js";

vi.mock("@xiaoshuo/config-service", () => ({
  loadPublicConfig: vi.fn(),
  savePublicConfig: vi.fn()
}));

import { loadPublicConfig } from "@xiaoshuo/config-service";

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {} as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createRequest(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function createResponse(): ServerResponse {
  return {} as ServerResponse;
}

function okJson(payload: unknown) {
  return {
    ok: true,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(payload))
  };
}

function dashboardPayload() {
  return {
    token: {
      email: "user@example.test",
      key: "license-token",
      enabled: true,
      balance: 8,
      used: 2
    },
    providers: [
      {
        name: "provider",
        models: [{ name: "deepseek-chat", category: "text", enabled: true }]
      }
    ],
    maxConcurrency: 300,
    maxRpm: 100,
    maxTpm: 50000000,
    rechargeOptions: []
  };
}

describe("handleWebsiteAiRoutes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("refreshes dashboard with license_account_key before api_key", async () => {
    const writeJson = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(dashboardPayload()))
      .mockResolvedValueOnce(okJson({ purchaseUrl: "" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(loadPublicConfig).mockResolvedValue({
      ai_config_mode: "website",
      website_profile: {
        api_key: "stale-model-key",
        license_account_key: "license-token",
        model: "deepseek-chat"
      }
    } as unknown as Awaited<ReturnType<typeof loadPublicConfig>>);

    const handled = await handleWebsiteAiRoutes(
      createRequest("GET"),
      createResponse(),
      "/api/website-ai/dashboard",
      createContext(),
      {
        readJsonBody: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://matian.online/api/relay/dashboard",
      expect.objectContaining({
        headers: { Authorization: "Bearer license-token" },
        signal: expect.any(AbortSignal)
      })
    );
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        logged_in: true,
        account: expect.objectContaining({ email: "user@example.test" })
      })
    );
  });

  it("redeems website codes with Authorization Bearer token", async () => {
    const writeJson = vi.fn();
    const readJsonBody = vi.fn().mockResolvedValue({ code: "XY2B-664B-7813-B5E2-9F" });
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ ok: true, status: "redeemed", message: "兑换成功" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(loadPublicConfig).mockResolvedValue({
      ai_config_mode: "website",
      website_profile: {
        api_key: "stale-model-key",
        license_account_key: "license-token"
      }
    } as unknown as Awaited<ReturnType<typeof loadPublicConfig>>);

    const handled = await handleWebsiteAiRoutes(
      createRequest("POST"),
      createResponse(),
      "/api/website-ai/redeem",
      createContext(),
      {
        readJsonBody,
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://matian.online/api/redeem",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer license-token"
        },
        body: JSON.stringify({ code: "XY2B-664B-7813-B5E2-9F" }),
        signal: expect.any(AbortSignal)
      })
    );
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        status: "redeemed",
        message: "兑换成功"
      })
    );
  });
});
