import { describe, expect, it } from "vitest";
import {
  novelProjectTransferCommitRequestSchema,
  novelRoomRequestSchema,
  novelTypedActionRequestSchema,
  novelUserGestureActionSchema
} from "./novel-agent.js";

describe("novel Agent shared schemas", () => {
  it("rejects executable, shell, argv, environment, and working-directory injection", () => {
    const base = {
      action: "rebuild_index",
      project_id: "project-a",
      project_root: "C:/novel/project-a",
      confirmation_id: "confirmation-a",
      operation_id: "operation-a"
    };
    for (const injected of [
      { executable: "cmd.exe" },
      { shell: "powershell -Command whoami" },
      { argv: ["/c", "whoami"] },
      { environment: { PATH: "C:/unsafe" } },
      { cwd: "C:/outside" }
    ]) {
      expect(() => novelTypedActionRequestSchema.parse({ ...base, ...injected })).toThrow();
    }
  });

  it("removes the old one-click transfer gesture and renderer target receipt", () => {
    expect(novelUserGestureActionSchema.safeParse("transfer_commit").success).toBe(false);
    expect(novelUserGestureActionSchema.parse("transfer_source_confirm")).toBe("transfer_source_confirm");
    expect(novelUserGestureActionSchema.parse("transfer_target_confirm")).toBe("transfer_target_confirm");
    expect(() => novelProjectTransferCommitRequestSchema.parse({
      transfer_id: "transfer-a",
      source_confirmation_id: "source-receipt",
      target_confirmation_id: "renderer-fabricated-target-receipt",
      plan_sha256: "a".repeat(64),
      operation_id: "operation-a"
    })).toThrow();
  });

  it("keeps reviews in the novel domain and caps fixed reviewer fan-out at three", () => {
    const base = {
      project_id: "project-a",
      run_id: "request-a",
      budget_id: "untrusted-placeholder",
      instruction: "检查当前章节",
      source_revision: "revision-a"
    };
    expect(() => novelRoomRequestSchema.parse({ ...base, domain: "general_agent" })).toThrow();
    expect(() => novelRoomRequestSchema.parse({
      ...base,
      requested_roles: ["plot_reviewer", "character_reviewer", "continuity_reviewer", "style_reviewer"]
    })).toThrow();
  });
});
