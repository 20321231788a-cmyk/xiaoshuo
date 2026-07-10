import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillService } from "@xiaoshuo/skill-service";
import { handleSkillRoutes } from "./skill-routes.js";
import { matchSkillRoute } from "./route-matchers.js";
import type { RuntimeContext } from "./types.js";

const runDurableSkill = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({
  runSkill: vi.fn(),
  runDurableSkill
}));

vi.mock("./agent-runtime-registry.js", () => ({
  getProjectAgentRuntime: vi.fn(() => runtime)
}));

vi.mock("./license-guard.js", () => ({
  writeAiLicenseRequiredIfNeeded: vi.fn(async () => false)
}));

let tempDir = "";

beforeEach(async () => {
  vi.clearAllMocks();
  runtime.runDurableSkill = runDurableSkill;
  runtime.runSkill.mockResolvedValue({ status: "done", result: "done", saved_path: "", data: {} });
  runDurableSkill.mockResolvedValue({
    status: "done",
    result: "saved",
    saved_path: "00_设定集/风格库/写作风格.txt",
    data: {
      run_id: "run_prompt_skill",
      saved_paths: ["00_设定集/风格库/写作风格.txt"]
    }
  });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-skill-route-"));
  const service = new SkillService({ projectRoot: tempDir, now: () => "2026-07-07 10:00:00" });
  await service.importSkillDraft({
    skill: {
      id: "custom_review",
      name: "Custom Review",
      description: "desc",
      input_mode: "text",
      context_requirements: [],
      handler_type: "prompt",
      linked_targets: [],
      prompt: "old prompt",
      imported_from: "",
      writable: false
    },
    source_url: "",
    source_name: "",
    source_text: ""
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: { list: () => [] } as unknown as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createDeps(body: Record<string, unknown> = {}) {
  return {
    ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: tempDir, name: "Novel" }),
    readJsonBody: vi.fn().mockResolvedValue(body),
    readRawBody: vi.fn(),
    parseJsonRecord: vi.fn(),
    parseMultipartFile: vi.fn(),
    rebuildProjectManifest: vi.fn(),
    writeJson: vi.fn(),
    matchSkillRoute,
    openPath: vi.fn()
  };
}

describe("handleSkillRoutes skill management", () => {
  it("uses the durable runtime contract for writable prompt skills", async () => {
    const deps = createDeps();
    deps.readRawBody.mockResolvedValue(Buffer.from("{}"));
    deps.parseJsonRecord.mockReturnValue({ instruction: "提取风格并保存", write_result: true });

    const handled = await handleSkillRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/skills/style_extract/run",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtime.runDurableSkill).toHaveBeenCalledWith(
      "style_extract",
      expect.objectContaining({ instruction: "提取风格并保存", write_result: true })
    );
    expect(runtime.runSkill).not.toHaveBeenCalled();
    expect(deps.rebuildProjectManifest).toHaveBeenCalledWith(tempDir);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      data: expect.objectContaining({ run_id: "run_prompt_skill" })
    }));
  });

  it("keeps non-writable prompt skills on the legacy run contract", async () => {
    const deps = createDeps();
    deps.readRawBody.mockResolvedValue(Buffer.from("{}"));
    deps.parseJsonRecord.mockReturnValue({ instruction: "review", write_result: false });

    const handled = await handleSkillRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/skills/custom_review/run",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtime.runSkill).toHaveBeenCalledWith("custom_review", expect.objectContaining({ instruction: "review" }));
    expect(runtime.runDurableSkill).not.toHaveBeenCalled();
  });

  it("uses the durable contract when a non-writable prompt skill explicitly requests a write", async () => {
    const deps = createDeps();
    deps.readRawBody.mockResolvedValue(Buffer.from("{}"));
    deps.parseJsonRecord.mockReturnValue({ instruction: "review and save", write_result: true });

    const handled = await handleSkillRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/skills/custom_review/run",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtime.runDurableSkill).toHaveBeenCalledWith(
      "custom_review",
      expect.objectContaining({ instruction: "review and save", write_result: true })
    );
    expect(runtime.runSkill).not.toHaveBeenCalled();
  });

  it("fails closed when the durable prompt-skill runtime contract is unavailable", async () => {
    const deps = createDeps();
    runtime.runDurableSkill = undefined as unknown as typeof runDurableSkill;
    deps.readRawBody.mockResolvedValue(Buffer.from("{}"));
    deps.parseJsonRecord.mockReturnValue({ instruction: "提取风格并保存", write_result: true });

    const handled = await handleSkillRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/skills/style_extract/run",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtime.runSkill).not.toHaveBeenCalled();
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 503, {
      detail: "当前运行时尚未提供可恢复的 Prompt Skill 执行能力",
      code: "DURABLE_SKILL_RUNTIME_UNAVAILABLE"
    });
  });

  it("keeps legacy description patch response shape", async () => {
    const deps = createDeps({ description: "new desc" });

    const handled = await handleSkillRoutes({ method: "PATCH" } as IncomingMessage, {} as ServerResponse, "/api/skills/custom_review", createContext(), deps);

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      id: "custom_review",
      description: "new desc"
    }));
  });

  it("patches imported skill and returns diff response", async () => {
    const deps = createDeps({ prompt: "new prompt", dry_run: true });

    const handled = await handleSkillRoutes({ method: "PATCH" } as IncomingMessage, {} as ServerResponse, "/api/skills/custom_review", createContext(), deps);

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      dry_run: true,
      diff: expect.stringContaining("new prompt")
    }));
  });

  it("clones builtin skills", async () => {
    const deps = createDeps({ target_id: "custom_outline", target_name: "Custom Outline" });

    const handled = await handleSkillRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/skills/outline_generate/clone", createContext(), deps);

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      id: "custom_outline",
      imported_from: "clone:outline_generate"
    }));
  });

  it("lists versions and rolls back imported skills", async () => {
    const patchDeps = createDeps({ prompt: "new prompt", change_reason: "v2" });
    await handleSkillRoutes({ method: "PATCH" } as IncomingMessage, {} as ServerResponse, "/api/skills/custom_review", createContext(), patchDeps);
    const patchResponse = patchDeps.writeJson.mock.calls.at(-1)?.[2] as { version_id: string };

    const versionsDeps = createDeps();
    await handleSkillRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/skills/custom_review/versions", createContext(), versionsDeps);
    expect(versionsDeps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      skill_id: "custom_review",
      versions: expect.arrayContaining([expect.objectContaining({ version_id: patchResponse.version_id })])
    }));

    const rollbackDeps = createDeps({ version_id: patchResponse.version_id });
    const handled = await handleSkillRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/skills/custom_review/rollback", createContext(), rollbackDeps);

    expect(handled).toBe(true);
    expect(rollbackDeps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      skill: expect.objectContaining({ prompt: "old prompt" })
    }));
  });
});
