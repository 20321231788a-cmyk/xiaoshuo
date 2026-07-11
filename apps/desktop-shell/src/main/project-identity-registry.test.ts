import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectIdentityRegistry,
  ProjectIdentityRegistryError,
  projectIdentityConflictCode,
  projectIdentityUnconfirmedCode
} from "./project-identity-registry.js";

const projectId = "f745c8a6-21c2-4f33-bf72-66cab8d0eb30";
const otherProjectId = "6f9a3be0-438e-4d24-9408-5a04a6e11764";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ProjectIdentityRegistry", () => {
  it("persists an identity claim and allows a restarted desktop process to confirm it", async () => {
    const root = await createRoot();
    const projectPath = path.join(root, "project");
    await fs.mkdir(projectPath);
    const registryPath = path.join(root, "state", "project-identities.json");

    const first = new ProjectIdentityRegistry(registryPath);
    await expect(first.confirm(projectPath, projectId)).resolves.toMatchObject({ projectId, reassociated: false });
    first.assertWritable(projectPath);

    const restarted = new ProjectIdentityRegistry(registryPath);
    await expect(restarted.confirm(projectPath, projectId)).resolves.toMatchObject({ projectId, reassociated: false });
    expect((await restarted.snapshot()).projects).toHaveLength(1);
  });

  it("serializes competing same-UUID paths and rejects the unconfirmed copy", async () => {
    const root = await createRoot();
    const original = path.join(root, "original");
    const copy = path.join(root, "copy");
    await Promise.all([fs.mkdir(original), fs.mkdir(copy)]);
    const registry = new ProjectIdentityRegistry(path.join(root, "state", "project-identities.json"));

    const results = await Promise.allSettled([registry.confirm(original, projectId), registry.confirm(copy, projectId)]);
    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: projectIdentityConflictCode }) })
    ]);
    let error: unknown;
    try {
      registry.assertWritable(copy);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: projectIdentityUnconfirmedCode });
  });

  it("reassociates a moved project when its former canonical path is gone", async () => {
    const root = await createRoot();
    const original = path.join(root, "original");
    const moved = path.join(root, "moved");
    await fs.mkdir(original);
    const registry = new ProjectIdentityRegistry(path.join(root, "state", "project-identities.json"));
    await registry.confirm(original, projectId);
    await fs.rename(original, moved);

    await expect(registry.confirm(moved, projectId)).resolves.toMatchObject({ projectId, reassociated: true });
    registry.assertWritable(moved);
    const canonicalPath = await fs.realpath(moved);
    expect((await registry.snapshot()).projects[0]).toMatchObject({
      canonical_path: process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath
    });
  });

  it("rejects a path that was already claimed by a different project UUID", async () => {
    const root = await createRoot();
    const projectPath = path.join(root, "project");
    await fs.mkdir(projectPath);
    const registry = new ProjectIdentityRegistry(path.join(root, "state", "project-identities.json"));
    await registry.confirm(projectPath, projectId);

    await expect(registry.confirm(projectPath, otherProjectId)).rejects.toBeInstanceOf(ProjectIdentityRegistryError);
    await expect(registry.confirm(projectPath, otherProjectId)).rejects.toMatchObject({ code: projectIdentityConflictCode });
  });

  it("binds writable authorization to the expected project UUID", async () => {
    const root = await createRoot();
    const projectPath = path.join(root, "project");
    await fs.mkdir(projectPath);
    const registry = new ProjectIdentityRegistry(path.join(root, "state", "project-identities.json"));
    await registry.confirm(projectPath, projectId);

    expect(() => registry.assertWritable(projectPath, projectId)).not.toThrow();
    expect(() => registry.assertWritable(projectPath, otherProjectId)).toThrow(ProjectIdentityRegistryError);
    try {
      registry.assertWritable(projectPath, otherProjectId);
    } catch (error) {
      expect(error).toMatchObject({ code: projectIdentityUnconfirmedCode });
    }
  });

  it("fails closed when the persisted identity registry is corrupt", async () => {
    const root = await createRoot();
    const projectPath = path.join(root, "project");
    const registryPath = path.join(root, "state", "project-identities.json");
    await fs.mkdir(projectPath);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, "{not-json", "utf8");
    const registry = new ProjectIdentityRegistry(registryPath);

    await expect(registry.confirm(projectPath, projectId)).rejects.toMatchObject({ code: projectIdentityConflictCode });
  });

  it("fails closed when the project root has no canonical realpath", async () => {
    const root = await createRoot();
    const missingProject = path.join(root, "missing-project");
    const registry = new ProjectIdentityRegistry(path.join(root, "state", "project-identities.json"));

    await expect(registry.confirm(missingProject, projectId)).rejects.toMatchObject({ code: projectIdentityConflictCode });
  });
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-project-identity-"));
  tempRoots.push(root);
  return root;
}
