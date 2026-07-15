import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAgentFeatureFlagRegistry } from "./kernel/feature-flag-registry.js";
import { AgentRuntimeService } from "./runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("novel governed-memory batch review", () => {
  it("confirms objective claims with per-claim receipts and rejects subjective claims", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-memory-batch-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "00_设定集"), { recursive: true });
    const runtime = new AgentRuntimeService({
      projectRoot: root,
      featureFlags: new InMemoryAgentFeatureFlagRegistry({
        agent_execution_v2_mode: "on",
        model_gateway_v2: true,
        agent_replanning_v2: true,
        context_budget_v2: true,
        memory_v2: true,
        novel_memory_batch_review_v1: true
      })
    });
    await runtime.createGovernedMemoryClaim({
      id: "objective",
      subject: "陆尘",
      predicate: "身份",
      object: "主角",
      interval: {},
      status: "proposed",
      sourceRef: "00_设定集/人物.txt",
      perspective: "objective"
    });
    await runtime.createGovernedMemoryClaim({
      id: "subjective",
      subject: "陆尘",
      predicate: "内心想法",
      object: "准备背叛师门",
      interval: {},
      status: "proposed",
      sourceRef: "02_正文/第一章.txt",
      perspective: "character"
    });
    const prepared = await runtime.prepareGovernedMemoryBatch();
    const result = await runtime.confirmGovernedMemoryBatch({
      project_id: prepared.project_id,
      batch_id: "batch-1",
      items: prepared.items,
      confirmation_ids: { objective: "confirm-objective", subjective: "confirm-subjective" },
      operation_id: "operation-1"
    });
    expect(result.confirmed_claim_ids).toEqual(["objective"]);
    expect(result.rejected_claim_ids).toEqual(["subjective"]);
    expect((await runtime.listGovernedMemoryClaims()).find((claim) => claim.id === "objective")?.status).toBe("confirmed");
    expect((await runtime.listGovernedMemoryClaims()).find((claim) => claim.id === "subjective")?.status).toBe("proposed");
    runtime.close();
  });

  it("invalidates a prepared item when its content hash is changed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-memory-stale-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "00_设定集"), { recursive: true });
    const runtime = new AgentRuntimeService({
      projectRoot: root,
      featureFlags: new InMemoryAgentFeatureFlagRegistry({
        agent_execution_v2_mode: "on",
        model_gateway_v2: true,
        agent_replanning_v2: true,
        context_budget_v2: true,
        memory_v2: true,
        novel_memory_batch_review_v1: true
      })
    });
    await runtime.createGovernedMemoryClaim({ id: "stale", subject: "A", predicate: "是", object: "B", interval: {}, status: "draft" });
    const prepared = await runtime.prepareGovernedMemoryBatch();
    const result = await runtime.confirmGovernedMemoryBatch({
      project_id: prepared.project_id,
      batch_id: "batch-stale",
      items: prepared.items.map((item) => ({ ...item, content_hash: "0".repeat(64) })),
      confirmation_ids: { stale: "confirm-stale" },
      operation_id: "operation-stale"
    });
    expect(result.stale_claim_ids).toEqual(["stale"]);
    expect((await runtime.listGovernedMemoryClaims())[0]?.status).toBe("draft");
    runtime.close();
  });

  it("shows same-subject conflicts and keeps them out of batch confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-memory-conflict-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "00_设定集"), { recursive: true });
    const runtime = new AgentRuntimeService({
      projectRoot: root,
      featureFlags: new InMemoryAgentFeatureFlagRegistry({
        agent_execution_v2_mode: "on",
        model_gateway_v2: true,
        context_budget_v2: true,
        memory_v2: true,
        novel_memory_batch_review_v1: true
      })
    });
    await runtime.createGovernedMemoryClaim({ id: "identity-a", subject: "陆尘", predicate: "身份", object: "散修", interval: {}, status: "proposed" });
    await runtime.createGovernedMemoryClaim({ id: "identity-b", subject: "陆尘", predicate: "身份", object: "宗门弟子", interval: {}, status: "proposed" });
    const prepared = await runtime.prepareGovernedMemoryBatch();

    expect(prepared.items.every((item) => item.conflict_summary.includes("需逐条处理"))).toBe(true);
    const result = await runtime.confirmGovernedMemoryBatch({
      project_id: prepared.project_id,
      batch_id: "batch-conflict",
      items: prepared.items,
      confirmation_ids: { "identity-a": "confirm-a", "identity-b": "confirm-b" },
      operation_id: "operation-conflict"
    });
    expect(result.confirmed_claim_ids).toEqual([]);
    expect(result.rejected_claim_ids.sort()).toEqual(["identity-a", "identity-b"]);
    expect((await runtime.listGovernedMemoryClaims()).every((claim) => claim.status === "proposed")).toBe(true);
    runtime.close();
  });
});
