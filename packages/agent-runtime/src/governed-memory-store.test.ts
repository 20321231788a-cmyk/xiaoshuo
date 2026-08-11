import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOVERNED_MEMORY_ERROR_CODES,
  GovernedMemoryStore
} from "./governed-memory-store.js";

const roots: string[] = [];
const stores: GovernedMemoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaoshuo-governed-memory-"));
  roots.push(root);
  return {
    root,
    store: openStore(root)
  };
}

function openStore(root: string): GovernedMemoryStore {
  const store = new GovernedMemoryStore(root, { now: () => new Date("2026-07-13T00:00:00.000Z") });
  stores.push(store);
  return store;
}

function draft(id = "claim-1") {
  return {
    id,
    subject: "陆尘",
    predicate: "境界",
    object: "练气期",
    interval: { from: { chapter: 1 } },
    status: "draft" as const
  };
}

describe("GovernedMemoryStore", () => {
  it("persists a receipt-bound draft -> confirmed transition across restart", () => {
    const { root, store } = createStore();
    const projectId = "project-alpha";
    store.createClaim(projectId, draft());
    expect(store.getMemoryRevision(projectId)).toBe(1);

    const receipt = store.requestConfirmation({ projectId, claimId: "claim-1", sourceRevision: 0 });
    expect(receipt.status).toBe("requested");
    const approved = store.resolveConfirmation({
      confirmationId: receipt.confirmation_id,
      expectedVersion: receipt.version,
      decision: "approved"
    });
    const confirmed = store.confirmClaim({
      projectId,
      claimId: "claim-1",
      confirmationId: approved.confirmation_id,
      expectedConfirmationVersion: approved.version
    });
    expect(confirmed).toMatchObject({ status: "confirmed", revision: 1 });
    expect(store.getMemoryRevision(projectId)).toBe(2);
    expect(store.listOutbox(projectId).map((event) => event.topic)).toEqual(["claim.created", "claim.confirmed"]);
    const reopened = openStore(root);
    expect(reopened.listClaims(projectId)).toMatchObject([{ id: "claim-1", status: "confirmed", revision: 1 }]);
    expect(reopened.exportProject(projectId).confirmations).toMatchObject([{ status: "consumed", source_revision: 0 }]);
    expect(() => reopened.confirmClaim({
      projectId,
      claimId: "claim-1",
      confirmationId: approved.confirmation_id,
      expectedConfirmationVersion: approved.version + 1
    })).toThrowError(expect.objectContaining({ code: GOVERNED_MEMORY_ERROR_CODES.confirmationAlreadyConsumed }));
  });

  it("fails closed for direct confirmation, stale receipts, and cross-project receipt reuse", () => {
    const { store } = createStore();
    const projectId = "project-alpha";
    expect(() => store.createClaim(projectId, { ...draft(), status: "confirmed" } as never))
      .toThrowError(expect.objectContaining({ code: GOVERNED_MEMORY_ERROR_CODES.directConfirmedWrite }));

    store.createClaim(projectId, draft());
    const receipt = store.requestConfirmation({ projectId, claimId: "claim-1", sourceRevision: 0 });
    const approved = store.resolveConfirmation({
      confirmationId: receipt.confirmation_id,
      expectedVersion: 1,
      decision: "approved"
    });
    expect(() => store.confirmClaim({
      projectId: "project-beta",
      claimId: "claim-1",
      confirmationId: approved.confirmation_id,
      expectedConfirmationVersion: approved.version
    })).toThrowError(expect.objectContaining({ code: GOVERNED_MEMORY_ERROR_CODES.confirmationScopeMismatch }));

    store.forgetClaim(projectId, "claim-1");
    expect(() => store.confirmClaim({
      projectId,
      claimId: "claim-1",
      confirmationId: approved.confirmation_id,
      expectedConfirmationVersion: approved.version
    })).toThrowError(expect.objectContaining({ code: GOVERNED_MEMORY_ERROR_CODES.claimNotFound }));
  });

  it("keeps overrides independent, reversible, and visible through export", () => {
    const { store } = createStore();
    const projectId = "project-alpha";
    store.createClaim(projectId, draft());
    const override = store.createOverride({
      projectId,
      override: { claimId: "claim-1", overrideObject: "筑基期" }
    });
    expect(store.listOverrides(projectId)).toMatchObject([{ override_id: override.override_id, status: "active" }]);
    const revoked = store.revokeOverride(projectId, override.override_id);
    expect(revoked.status).toBe("revoked");
    expect(store.listOverrides(projectId)).toEqual([]);
    expect(store.exportProject(projectId).overrides).toMatchObject([{ override_id: override.override_id, status: "revoked" }]);
  });

  it("supersedes only stale claims from an updated source and emits an ordered invalidation event", () => {
    const { store } = createStore();
    const projectId = "project-alpha";
    store.createClaim(projectId, {
      ...draft("claim-old"),
      sourceRef: "01_大纲/大纲.txt",
      sourceRevision: "sha256:old",
      evidenceRefs: ["01_大纲/大纲.txt#L1-L2"],
      perspective: "objective",
      confidence: 0.9
    });
    store.createClaim(projectId, {
      ...draft("claim-current"),
      sourceRef: "01_大纲/大纲.txt",
      sourceRevision: "sha256:new"
    });
    store.createClaim(projectId, {
      ...draft("claim-other-source"),
      sourceRef: "00_设定集/设定.txt",
      sourceRevision: "sha256:old"
    });

    const invalidated = store.invalidateSource({
      projectId,
      sourceRef: "01_大纲/大纲.txt",
      currentSourceRevision: "sha256:new"
    });

    expect(invalidated).toMatchObject([{ id: "claim-old", status: "superseded", revision: 1 }]);
    expect(store.listClaims(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claim-current", status: "draft", sourceRevision: "sha256:new" }),
      expect.objectContaining({ id: "claim-other-source", status: "draft" })
    ]));
    expect(store.listOutbox(projectId).at(-1)).toMatchObject({
      topic: "source.invalidated",
      payload: { source_ref: "01_大纲/大纲.txt", current_source_revision: "sha256:new", claim_ids: ["claim-old"] }
    });
  });

  it("rebases timeline coordinates through registered anchors and rejects missing mappings", () => {
    const { store } = createStore();
    const projectId = "project-alpha";
    store.createClaim(projectId, {
      ...draft("claim-timeline"),
      interval: {
        from: { schemaVersion: 1, timelineId: "main", anchorId: "chapter-1", ordinal: 1, timelineRevision: 1, phase: "at" },
        to: { schemaVersion: 1, timelineId: "main", anchorId: "chapter-2", ordinal: 2, timelineRevision: 1, phase: "at" }
      },
      storyTime: { schemaVersion: 1, timelineId: "main", anchorId: "chapter-1", ordinal: 1, timelineRevision: 1, phase: "after" }
    });
    store.registerTimelineAnchors({
      projectId,
      timelineId: "main",
      timelineRevision: 2,
      anchors: [{ anchorId: "chapter-1", ordinal: 10 }, { anchorId: "chapter-2", ordinal: 20 }]
    });
    const rebased = store.rebaseTimelineClaims({ projectId, timelineId: "main", fromRevision: 1, toRevision: 2 });
    expect(rebased).toMatchObject([{
      id: "claim-timeline",
      revision: 1,
      interval: {
        from: { timelineRevision: 2, ordinal: 10 },
        to: { timelineRevision: 2, ordinal: 20 }
      },
      storyTime: { timelineRevision: 2, ordinal: 10, phase: "after" }
    }]);
    expect(store.listOutbox(projectId).at(-1)).toMatchObject({ topic: "timeline.rebased" });

    store.createClaim(projectId, {
      ...draft("claim-missing-anchor"),
      interval: { from: { schemaVersion: 1, timelineId: "main", anchorId: "missing", ordinal: 3, timelineRevision: 1, phase: "at" } }
    });
    expect(() => store.rebaseTimelineClaims({ projectId, timelineId: "main", fromRevision: 1, toRevision: 2 }))
      .toThrowError(expect.objectContaining({ code: GOVERNED_MEMORY_ERROR_CODES.invalidTransition }));
  });

  it("persists a structured conversation summary at the current memory revision", () => {
    const { root, store } = createStore();
    const projectId = "project-alpha";
    store.createClaim(projectId, draft("summary-claim"));
    const summary = store.upsertConversationMemory(projectId, {
      conversationId: "conversation-1",
      confirmedFacts: ["陆尘是主角", "陆尘是主角"],
      decisions: ["先写大纲"],
      rejectedOptions: [],
      userPreferences: ["克制叙事"],
      openTasks: ["补第 2 章"],
      currentGoal: "完成第一卷",
      sourceMessageIds: ["message-1"]
    });
    expect(summary).toMatchObject({ memoryRevision: 1, confirmedFacts: ["陆尘是主角"] });
    const reopened = openStore(root);
    expect(reopened.getConversationMemory(projectId, "conversation-1")).toMatchObject({
      memoryRevision: 1,
      currentGoal: "完成第一卷",
      sourceMessageIds: ["message-1"]
    });
  });

  it("marks graph and vector projections stale for every memory revision and rejects stale completion", () => {
    const { root, store } = createStore();
    const projectId = "project-alpha";
    store.createClaim(projectId, draft("projection-claim"));
    const pending = store.listProjectionStatuses(projectId);
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ projection_name: "canon_markdown", memory_revision: 1, status: "pending" }),
      expect.objectContaining({ projection_name: "vector_graph", memory_revision: 1, status: "pending" })
    ]));
    store.markProjectionReady(projectId, "canon_markdown", 1, "sha256:projection-v1");
    store.createOverride({ projectId, override: { claimId: "projection-claim", overrideObject: "筑基期" } });
    expect(store.listProjectionStatuses(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ projection_name: "canon_markdown", memory_revision: 2, status: "pending" })
    ]));
    expect(() => store.markProjectionReady(projectId, "vector_graph", 1, "sha256:stale"))
      .toThrowError(expect.objectContaining({ code: GOVERNED_MEMORY_ERROR_CODES.sourceRevisionMismatch }));
    const reopened = openStore(root);
    expect(reopened.listProjectionStatuses(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ projection_name: "vector_graph", memory_revision: 2, status: "pending" })
    ]));
  });
});
