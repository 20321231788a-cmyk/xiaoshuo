import { describe, it, expect, vi } from "vitest";
import type { ModelConfig } from "@xiaoshuo/config-service";
import { ModelGateway } from "./model-gateway.js";

describe("ModelGateway", () => {
  const localConfig: ModelConfig = {
    configured: true,
    model: "local-model",
    base_url: "http://localhost:11434/v1",
    api_key: "key",
    temperature: 0.5,
    top_p: 0.9,
    thinking_enabled: false
  };

  const cloudConfig: ModelConfig = {
    configured: true,
    model: "cloud-model",
    base_url: "https://api.openai.com/v1",
    api_key: "key",
    temperature: 0.5,
    top_p: 0.9,
    thinking_enabled: false
  };

  it("should enforce privacy guard boundary", async () => {
    const gateway = new ModelGateway();
    
    await expect(
      gateway.completeText(cloudConfig, [{ role: "user", content: "secret text" }], {
        purpose: "chat",
        dataClassification: "private_local",
        disableRateLimiter: true
      })
    ).rejects.toThrow("隐私安全策略拦截");

    const mockClient = {
      requestCompletion: vi.fn().mockResolvedValue("local reply")
    };
    const localGateway = new ModelGateway(mockClient as any);
    const reply = await localGateway.completeText(localConfig, [{ role: "user", content: "secret text" }], {
      purpose: "chat",
      dataClassification: "private_local",
      disableRateLimiter: true
    });
    expect(reply).toBe("local reply");
  });

  it("should trigger fallback on failure", async () => {
    const mockClient = {
      requestCompletion: vi
        .fn()
        .mockRejectedValueOnce(new Error("status: 503 Service Unavailable"))
        .mockResolvedValueOnce("fallback reply")
    };
    const gateway = new ModelGateway(mockClient as any);

    const reply = await gateway.completeText(cloudConfig, [{ role: "user", content: "hello" }], {
      purpose: "chat",
      fallbackConfigs: [localConfig],
      disableRateLimiter: true
    });

    expect(reply).toBe("fallback reply");
    expect(mockClient.requestCompletion).toHaveBeenCalledTimes(2);
  });

  it("should trip circuit breaker after multiple failures", async () => {
    const mockClient = {
      requestCompletion: vi.fn().mockRejectedValue(new Error("status: 503"))
    };
    const gateway = new ModelGateway(mockClient as any);

    for (let i = 0; i < 3; i++) {
      await expect(
        gateway.completeText(cloudConfig, [{ role: "user", content: "fail" }], { purpose: "chat", disableRateLimiter: true })
      ).rejects.toThrow("status: 503");
    }

    mockClient.requestCompletion.mockClear();
    await expect(
      gateway.completeText(cloudConfig, [{ role: "user", content: "fail" }], { purpose: "chat", disableRateLimiter: true })
    ).rejects.toThrow("模型熔断器已开启，快速失败");
    expect(mockClient.requestCompletion).not.toHaveBeenCalled();
  });
});
