import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernedMemoryProjectionService, GOVERNED_MEMORY_PROJECTION_PATH } from "./governed-memory-projection-service.js";
import { GovernedMemoryStore } from "./governed-memory-store.js";

const roots: string[] = [];
const stores: GovernedMemoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaoshuo-memory-projection-"));
  roots.push(root);
  const store = new GovernedMemoryStore(root);
  stores.push(store);
  return { root, store };
}

async function confirmClaim(store: GovernedMemoryStore, projectId: string) {
  store.createClaim(projectId, {
    id: "claim-1",
    subject: "陆尘",
    predicate: "境界",
    object: "练气期",
    interval: {},
    status: "draft"
  });
  const receipt = store.requestConfirmation({ projectId, claimId: "claim-1", sourceRevision: 0 });
  const approved = store.resolveConfirmation({ confirmationId: receipt.confirmation_id, expectedVersion: receipt.version, decision: "approved" });
  store.confirmClaim({ projectId, claimId: "claim-1", confirmationId: approved.confirmation_id, expectedConfirmationVersion: approved.version });
}

describe("GovernedMemoryProjectionService", () => {
  it("materializes only confirmed memory and advances both projections at the same revision", async () => {
    const { root, store } = createStore();
    const projectId = "project-alpha";
    await confirmClaim(store, projectId);
    store.createClaim(projectId, {
      id: "draft-hidden",
      subject: "林风",
      predicate: "身份",
      object: "草稿内容",
      interval: {},
      status: "draft"
    });
    const service = new GovernedMemoryProjectionService(root, store);
    const result = await service.rebuild(projectId);

    expect(result.memory_revision).toBe(3);
    expect(readFileSync(path.join(root, GOVERNED_MEMORY_PROJECTION_PATH), "utf8")).toContain("陆尘 | 境界 | 练气期");
    expect(readFileSync(path.join(root, GOVERNED_MEMORY_PROJECTION_PATH), "utf8")).not.toContain("草稿内容");
    expect(existsSync(path.join(root, "00_设定集", ".agent", "vector_index.sqlite3"))).toBe(true);
    expect(result.statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ projection_name: "canon_markdown", memory_revision: 3, status: "ready" }),
      expect.objectContaining({ projection_name: "vector_graph", memory_revision: 3, status: "ready" })
    ]));
  });
});
