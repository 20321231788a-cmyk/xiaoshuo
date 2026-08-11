import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleProjectReferenceRoutes } from "./project-reference-routes.js";
import type { RuntimeContext } from "./types.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-project-reference-route-"));
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_设定"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "章纲内容", "utf8");
  await fs.writeFile(path.join(tempDir, "02_设定", "人物设定.txt"), "人物内容", "utf8");
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

function createDeps(body: Record<string, unknown>, projectPath = tempDir) {
  return {
    ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: projectPath, name: "Novel" }),
    readJsonBody: vi.fn().mockResolvedValue(body),
    writeJson: vi.fn()
  };
}

describe("handleProjectReferenceRoutes", () => {
  it("returns false for unrelated routes", async () => {
    const deps = createDeps({});

    const handled = await handleProjectReferenceRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/project/other", createContext(), deps);

    expect(handled).toBe(false);
  });

  it("requires an open project", async () => {
    const deps = createDeps({}, "");

    const handled = await handleProjectReferenceRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/project/resolve-files", createContext(), deps);

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 400, { detail: "尚未打开项目" });
  });

  it("resolves alias references", async () => {
    const deps = createDeps({ text: "参考章纲继续写" });

    const handled = await handleProjectReferenceRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/project/resolve-files", createContext(), deps);

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      references: [expect.objectContaining({ path: "01_大纲/章纲.txt", kind: "alias" })]
    }));
  });

  it("reads references through DocumentService safety rules", async () => {
    const deps = createDeps({ paths: ["01_大纲/章纲.txt", "../secret.txt"] });

    const handled = await handleProjectReferenceRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/project/read-references", createContext(), deps);

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      blocks: [expect.objectContaining({ path: "01_大纲/章纲.txt", content: "章纲内容" })],
      warnings: expect.arrayContaining([expect.any(String)])
    }));
  });

  it("rebuilds file manifest", async () => {
    const deps = createDeps({});

    const handled = await handleProjectReferenceRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/project/rebuild-file-manifest", createContext(), deps);

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      ok: true,
      entries: 2,
      path: "00_设定集/.agent/file-manifest.json"
    }));
  });
});
