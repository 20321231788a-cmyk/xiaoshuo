import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWebsiteAiRoutes } from "./website-ai-routes.js";
import type { RuntimeContext } from "./types.js";

vi.mock("@xiaoshuo/config-service", () => ({
  loadPublicConfig: vi.fn(),
  savePublicConfig: vi.fn()
}));

import { loadPublicConfig, savePublicConfig } from "@xiaoshuo/config-service";

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
        models: [
          { name: "deepseek-chat", category: "text", enabled: true },
          { name: "gpt-image-2", category: "image", enabled: true, supports_image_edit: true, supported_sizes: ["768x1024"] }
        ]
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

  it("clears stale website embedding configuration when no vector model is selected", async () => {
    const writeJson = vi.fn();
    const readJsonBody = vi.fn().mockResolvedValue({ model: "deepseek-chat", embedding_model: "", temp: 0.7, top_p: 1 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(dashboardPayload()))
      .mockResolvedValueOnce(okJson({ purchaseUrl: "" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(loadPublicConfig).mockResolvedValue({
      ai_config_mode: "website",
      website_profile: {
        api_key: "license-token",
        license_account_key: "license-token",
        model: "deepseek-chat",
        embedding_enabled: true,
        embedding_api_key: "stale-key",
        embedding_base_url: "https://stale.example.test/v1",
        embedding_model: "stale-embedding"
      }
    } as unknown as Awaited<ReturnType<typeof loadPublicConfig>>);
    vi.mocked(savePublicConfig).mockResolvedValue({
      ai_config_mode: "website",
      website_profile: { api_key: "license-token", model: "deepseek-chat", embedding_enabled: false, embedding_model: "" }
    } as unknown as Awaited<ReturnType<typeof savePublicConfig>>);

    const handled = await handleWebsiteAiRoutes(
      createRequest("POST"),
      createResponse(),
      "/api/website-ai/apply",
      createContext(),
      { readJsonBody, writeJson }
    );

    expect(handled).toBe(true);
    expect(savePublicConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        website_profile: expect.objectContaining({
          embedding_enabled: false,
          embedding_api_key: "",
          embedding_base_url: "",
          embedding_model: ""
        })
      }),
      { rootDir: "D:\\xiaoshuo\\ts-migration" }
    );
  });

  it("saves the website image model without switching manual text mode", async () => {
    const writeJson = vi.fn();
    const readJsonBody = vi.fn().mockResolvedValue({ image_model: "gpt-image-2" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson(dashboardPayload()))
      .mockResolvedValueOnce(okJson({ purchaseUrl: "" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(loadPublicConfig).mockResolvedValue({
      ai_config_mode: "manual",
      manual_profile: { api_key: "manual-key", model: "manual-model" },
      website_profile: { api_key: "site-token", license_account_key: "site-token", image_model: "" }
    } as unknown as Awaited<ReturnType<typeof loadPublicConfig>>);
    vi.mocked(savePublicConfig).mockResolvedValue({
      ai_config_mode: "manual",
      manual_profile: { api_key: "manual-key", model: "manual-model" },
      website_profile: { api_key: "site-token", license_account_key: "site-token", image_model: "gpt-image-2" }
    } as unknown as Awaited<ReturnType<typeof savePublicConfig>>);

    await handleWebsiteAiRoutes(createRequest("PUT"), createResponse(), "/api/website-ai/image-config", createContext(), { readJsonBody, writeJson });

    expect(savePublicConfig).toHaveBeenCalledWith(expect.objectContaining({
      ai_config_mode: "manual",
      website_profile: expect.objectContaining({ image_model: "gpt-image-2" })
    }), { rootDir: "D:\\xiaoshuo\\ts-migration" });
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      image_models: [expect.objectContaining({ id: "gpt-image-2", capabilities: expect.objectContaining({ image_generation: true, image_edit: true }) })],
      selected_image_model: "gpt-image-2"
    }));
  });
});
