import type { AgentRuntimeService } from "@xiaoshuo/agent-runtime";
import { MANIFEST_REL_PATH } from "@xiaoshuo/project-manifest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import type { RuntimeContext } from "./types.js";

const projectId = "f745c8a6-21c2-4f33-bf72-66cab8d0eb30";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("getProjectAgentRuntime", () => {
  it("passes the strict manifest UUID into the writable identity assertion", async () => {
    const projectRoot = await temporaryRoot("runtime-project-");
    await writeManifest(projectRoot, projectId);
    const runtime = {} as AgentRuntimeService;
    const key = process.platform === "win32" ? path.resolve(projectRoot).toLowerCase() : path.resolve(projectRoot);
    const assertWritable = vi.fn();
    const context = {
      agentRuntimes: new Map([[key, runtime]]),
      projectIdentityRegistry: { assertWritable }
    } as unknown as RuntimeContext;

    await expect(getProjectAgentRuntime(context, projectRoot)).resolves.toBe(runtime);
    expect(assertWritable).toHaveBeenCalledWith(path.resolve(projectRoot), projectId);
  });

  it("rejects a manifest reached through an external directory junction", async (testContext) => {
    const projectRoot = await temporaryRoot("runtime-project-");
    const outside = await temporaryRoot("runtime-external-");
    const settingsRoot = path.join(projectRoot, "00_设定集");
    const agentPath = path.join(settingsRoot, ".agent");
    await fs.mkdir(settingsRoot, { recursive: true });
    await writeManifest(outside, projectId, "project_manifest.json");
    try {
      await fs.symlink(outside, agentPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isLinkPrivilegeError(error)) {
        testContext.skip();
        return;
      }
      throw error;
    }
    const assertWritable = vi.fn();
    const context = {
      agentRuntimes: new Map(),
      projectIdentityRegistry: { assertWritable }
    } as unknown as RuntimeContext;

    await expect(getProjectAgentRuntime(context, projectRoot)).rejects.toMatchObject({
      code: "PROJECT_SCOPE_PATH_ESCAPE"
    });
    expect(assertWritable).not.toHaveBeenCalled();
  });

  it("fails closed when the runtime context has no identity registry", async () => {
    const projectRoot = await temporaryRoot("runtime-project-");
    await writeManifest(projectRoot, projectId);
    const context = { agentRuntimes: new Map() } as unknown as RuntimeContext;

    await expect(getProjectAgentRuntime(context, projectRoot)).rejects.toMatchObject({
      code: "PROJECT_IDENTITY_UNCONFIRMED"
    });
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeManifest(projectRoot: string, identity: string, relativePath = MANIFEST_REL_PATH): Promise<void> {
  const manifestPath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({ project_id: identity, entries: [] }), "utf8");
}

function isLinkPrivilegeError(error: unknown): boolean {
  const code = typeof error === "object" && error ? String((error as NodeJS.ErrnoException).code || "") : "";
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}
