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
    expect(await restarted.snapshot()).toMatchObject({
      version: 2,
      projects: [{
        project_id: projectId,
        requires_reconfirmation: false,
        filesystem_identity: { scheme: "stat-dev-ino-v1" }
      }]
    });
  });

  it("fails closed after restart when a project directory is replaced at the same canonical path", async () => {
    const root = await createRoot();
    const projectPath = path.join(root, "project");
    const displacedPath = path.join(root, "displaced");
    const registryPath = path.join(root, "state", "project-identities.json");
    await fs.mkdir(projectPath);

    await new ProjectIdentityRegistry(registryPath).confirm(projectPath, projectId);
    await fs.rename(projectPath, displacedPath);
    await fs.mkdir(projectPath);

    const restarted = new ProjectIdentityRegistry(registryPath);
    await expect(restarted.confirm(projectPath, projectId)).rejects.toMatchObject({ code: projectIdentityConflictCode });
    expectIdentityUnconfirmed(() => restarted.assertWritable(projectPath, projectId));
  });

  it("requires an explicit user re-confirmation before migrating a v1 record", async () => {
    const root = await createRoot();
    const projectPath = path.join(root, "project");
    const registryPath = path.join(root, "state", "project-identities.json");
    await fs.mkdir(projectPath);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify({
      version: 1,
      projects: [identityRecord(projectId, projectPath)]
    }), "utf8");

    const restarted = new ProjectIdentityRegistry(registryPath);
    await expect(restarted.confirm(projectPath, projectId)).rejects.toMatchObject({ code: projectIdentityUnconfirmedCode });
    expectIdentityUnconfirmed(() => restarted.assertWritable(projectPath, projectId));

    await expect(restarted.reconfirm(projectPath, projectId)).resolves.toMatchObject({ projectId, reassociated: false });
    await expect(fs.readFile(registryPath, "utf8")).resolves.toContain('"version": 2');
    expect((await restarted.snapshot()).projects[0]).toMatchObject({
      requires_reconfirmation: false,
      filesystem_identity: { scheme: "stat-dev-ino-v1" }
    });

    const afterMigration = new ProjectIdentityRegistry(registryPath);
    await expect(afterMigration.confirm(projectPath, projectId)).resolves.toMatchObject({ projectId, reassociated: false });
  });

  it("does not auto-associate a copied directory after the original disappeared", async () => {
    const root = await createRoot();
    const original = path.join(root, "original");
    const copy = path.join(root, "copy");
    const registryPath = path.join(root, "state", "project-identities.json");
    await fs.mkdir(original);
    await new ProjectIdentityRegistry(registryPath).confirm(original, projectId);
    await fs.cp(original, copy, { recursive: true });
    await fs.rm(original, { recursive: true });

    const restarted = new ProjectIdentityRegistry(registryPath);
    await expect(restarted.confirm(copy, projectId)).rejects.toMatchObject({ code: projectIdentityConflictCode });
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

  it.each([
    ["invalid record", [{ project_id: "not-a-uuid", canonical_path: "relative", previous_paths: [], updated_at: "" }]],
    ["duplicate UUID", [identityRecord(projectId, "first"), identityRecord(projectId, "second")]],
    ["duplicate canonical path", [identityRecord(projectId, "same"), identityRecord(otherProjectId, "same")]]
  ])("fails closed for %s instead of silently dropping registry entries", async (_label, projects) => {
    const root = await createRoot();
    const projectPath = path.join(root, "project");
    const registryPath = path.join(root, "state", "project-identities.json");
    await fs.mkdir(projectPath);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify({ version: 1, projects }), "utf8");
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

function identityRecord(identity: string, pathName: string) {
  return {
    project_id: identity,
    canonical_path: path.resolve(pathName),
    previous_paths: [],
    updated_at: "2026-07-11T00:00:00.000Z"
  };
}

function expectIdentityUnconfirmed(action: () => void): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: projectIdentityUnconfirmedCode });
}
