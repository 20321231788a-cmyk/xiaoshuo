import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentTraceRecorder, getAgentTraceFilePath } from "./agent-trace.js";

let tempDir = "";
const fixedNow = new Date("2026-07-07T06:00:00.000Z");

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-agent-trace-"));
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function readTraceLines() {
  const raw = await fs.readFile(getAgentTraceFilePath(tempDir, fixedNow), "utf8");
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("AgentTraceRecorder", () => {
  it("writes a final trace record as project-local jsonl", async () => {
    const recorder = createAgentTraceRecorder({
      projectRoot: tempDir,
      conversationId: "conv-1",
      skillId: "body_generate",
      content: "生成第1章正文并写入文件",
      now: () => fixedNow,
      idFactory: () => "trace001"
    });

    recorder.mark("classified", { intent: "skill", selected_skill_id: "body_generate", selected_reason: "规则命中正文生成" });
    recorder.addRouteCandidates([
      {
        skill_id: "body_generate",
        score: 88,
        reasons: ["用户明确要求正文。"],
        signals: ["intent:body_writing"]
      }
    ]);
    recorder.addSaveDecision({
      action: "save_generated",
      mode: "replace",
      target_paths: ["02_正文/第001章.txt"],
      cache_id: "cache001",
      auto_committed: true,
      reason: "用户明确要求写入"
    });
    await recorder.finish({ saved_paths: ["02_正文/第001章.txt"] });

    const [trace] = await readTraceLines();
    expect(trace.run_id).toBe("trace001");
    expect(trace.conversation_id).toBe("conv-1");
    expect(trace.intent).toBe("skill");
    expect(trace.selected_skill_id).toBe("body_generate");
    expect(trace.route_candidates[0].skill_id).toBe("body_generate");
    expect(trace.save_decision.target_paths).toEqual(["02_正文/第001章.txt"]);
    expect(trace.saved_paths).toEqual(["02_正文/第001章.txt"]);
  });

  it("records failures and redacts common secrets", async () => {
    const recorder = createAgentTraceRecorder({
      projectRoot: tempDir,
      content: "api_key=sk-1234567890abcdefghijklmnop Bearer abcdefghijklmnopqrstuvwxyz123456",
      now: () => fixedNow,
      idFactory: () => "trace002"
    });

    recorder.fail(new Error("token=secret-value failed with sk-abcdef1234567890"));
    await recorder.finish();

    const [trace] = await readTraceLines();
    const serialized = JSON.stringify(trace);
    expect(trace.stage).toBe("failed");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(serialized).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(serialized).toContain("[redacted]");
  });

  it("sanitizes web source URLs and writes only once", async () => {
    const recorder = createAgentTraceRecorder({
      projectRoot: tempDir,
      now: () => fixedNow,
      idFactory: () => "trace003"
    });

    recorder.addWebSearchSources([
      { title: "safe source", url: "https://user:pass@example.com/read?token=abc&id=1" },
      { title: "unsafe", url: "javascript:alert(1)" }
    ]);
    await recorder.finish();
    await recorder.finish({ saved_paths: ["ignored.txt"] });

    const traces = await readTraceLines();
    expect(traces).toHaveLength(1);
    expect(traces[0].web_search_sources).toEqual([
      {
        title: "safe source",
        url: "https://example.com/read?id=1"
      }
    ]);
    expect(traces[0].saved_paths).toEqual([]);
  });

  it("does not throw when the trace path cannot be written", async () => {
    const fileRoot = path.join(tempDir, "not-a-directory");
    await fs.writeFile(fileRoot, "occupied", "utf8");
    const recorder = createAgentTraceRecorder({
      projectRoot: fileRoot,
      content: "一次普通请求",
      now: () => fixedNow,
      idFactory: () => "trace004"
    });

    await expect(recorder.finish()).resolves.toBeUndefined();
  });
});
