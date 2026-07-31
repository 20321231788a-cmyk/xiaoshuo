import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => process.env.XIAOSHUO_LOCAL_STATE_TEST_DIR || os.tmpdir()
  }
}));

import {
  closeLocalState,
  recordRecentProject,
  removeRecentProject,
  trackGeneratedCacheMetadata
} from "./local-state.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-local-state-"));
  process.env.XIAOSHUO_LOCAL_STATE_TEST_DIR = tempDir;
});

afterEach(async () => {
  closeLocalState();
  delete process.env.XIAOSHUO_LOCAL_STATE_TEST_DIR;
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("removeRecentProject", () => {
  it("removes only the selected recent row and preserves generated cache metadata", async () => {
    await recordRecentProject({ path: "D:\\novels\\one", name: "第一本" });
    await recordRecentProject({ path: "D:\\novels\\two", name: "第二本" });
    await trackGeneratedCacheMetadata({
      cache_id: "cache-1",
      project_path: "D:\\novels\\one",
      skill_id: "consistency_check",
      source: "skill",
      target_path: "02_正文/正文.txt",
      target_paths: ["02_正文/正文.txt"],
      status: "pending",
      cache_chars: 120
    });

    const snapshot = await removeRecentProject({ path: "D:\\novels\\one" });

    expect(snapshot.recent_projects.map((project) => project.path)).toEqual(["D:\\novels\\two"]);
    expect(snapshot.generated_caches).toHaveLength(1);
    expect(snapshot.generated_caches[0]?.project_path).toBe("D:\\novels\\one");
  });
});
