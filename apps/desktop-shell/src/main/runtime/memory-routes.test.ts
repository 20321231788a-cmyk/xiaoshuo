import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMemoryRoutes } from "./memory-routes.js";
import type { RuntimeContext } from "./types.js";

const mockRuntime = vi.hoisted(() => ({
  listGovernedMemoryClaims: vi.fn(),
  listGovernedMemoryOverrides: vi.fn(),
  createGovernedMemoryClaim: vi.fn(),
  requestGovernedMemoryConfirmation: vi.fn(),
  resolveGovernedMemoryConfirmation: vi.fn(),
  confirmGovernedMemoryClaim: vi.fn(),
  forgetGovernedMemoryClaim: vi.fn(),
  createGovernedMemoryOverride: vi.fn(),
  revokeGovernedMemoryOverride: vi.fn(),
  invalidateGovernedMemorySource: vi.fn(),
  registerGovernedTimelineAnchors: vi.fn(),
  rebaseGovernedTimelineClaims: vi.fn(),
  getGovernedConversationMemory: vi.fn(),
  upsertGovernedConversationMemory: vi.fn(),
  exportGovernedMemory: vi.fn(),
  listGovernedMemoryProjectionStatuses: vi.fn(),
  rebuildGovernedMemoryProjections: vi.fn()
}));
const mockGetRuntime = vi.hoisted(() => vi.fn());

vi.mock("./agent-runtime-registry.js", () => ({ getProjectAgentRuntime: mockGetRuntime }));

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {} as any,
    projectSession: {} as any,
    documentSessions: new Map()
  };
}

function createDeps(body: Record<string, unknown> = {}) {
  return {
    ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
    readJsonBody: vi.fn().mockResolvedValue(body),
    writeJson: vi.fn()
  };
}

describe("memory-routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockGetRuntime.mockResolvedValue(mockRuntime);
  });

  it("rejects memory access when no project is open", async () => {
    const deps = createDeps();
    deps.ensureProjectSessionCurrent.mockResolvedValue({ path: "" });
    const handled = await handleMemoryRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/memory/claims", createContext(), deps);
    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ code: "PROJECT_NOT_OPEN" }));
  });

  it("never forwards a renderer supplied confirmed status into the runtime", async () => {
    const deps = createDeps({
      id: "claim-1",
      subject: "陆尘",
      predicate: "境界",
      object: "练气期",
      status: "confirmed"
    });
    const handled = await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/claims", createContext(), deps);
    expect(handled).toBe(true);
    expect(mockRuntime.createGovernedMemoryClaim).not.toHaveBeenCalled();
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ code: "MEMORY_DIRECT_CONFIRMED_WRITE" }));
  });

  it("uses a separate request, user approval, and receipt-consumption flow", async () => {
    const deps = createDeps({ source_revision: 0 });
    mockRuntime.requestGovernedMemoryConfirmation.mockResolvedValue({ confirmation_id: "memconf-1", version: 1, status: "requested" });
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/claims/claim-1/confirmations", createContext(), deps);
    expect(mockRuntime.requestGovernedMemoryConfirmation).toHaveBeenCalledWith("claim-1", 0);

    deps.readJsonBody.mockResolvedValue({ expected_version: 1, decision: "approved" });
    mockRuntime.resolveGovernedMemoryConfirmation.mockResolvedValue({ confirmation_id: "memconf-1", version: 2, status: "approved" });
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/confirmations/memconf-1/resolve", createContext(), deps);
    expect(mockRuntime.resolveGovernedMemoryConfirmation).toHaveBeenCalledWith({ confirmationId: "memconf-1", expectedVersion: 1, decision: "approved" });

    deps.readJsonBody.mockResolvedValue({ confirmation_id: "memconf-1", expected_version: 2 });
    mockRuntime.confirmGovernedMemoryClaim.mockResolvedValue({ id: "claim-1", status: "confirmed" });
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/claims/claim-1/confirm", createContext(), deps);
    expect(mockRuntime.confirmGovernedMemoryClaim).toHaveBeenCalledWith({
      claimId: "claim-1",
      confirmationId: "memconf-1",
      expectedConfirmationVersion: 2
    });
  });

  it("routes correction and revocation through the project-scoped runtime", async () => {
    const deps = createDeps({ claim_id: "claim-1", override_object: "筑基期" });
    mockRuntime.createGovernedMemoryOverride.mockResolvedValue({ override_id: "memovr-1", status: "active" });
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/overrides", createContext(), deps);
    expect(mockRuntime.createGovernedMemoryOverride).toHaveBeenCalledWith({
      override: { claimId: "claim-1", overrideObject: "筑基期", overrideStatus: undefined, overrideInterval: undefined }
    });

    mockRuntime.revokeGovernedMemoryOverride.mockResolvedValue({ override_id: "memovr-1", status: "revoked" });
    await handleMemoryRoutes({ method: "DELETE" } as IncomingMessage, {} as ServerResponse, "/api/memory/overrides/memovr-1", createContext(), deps);
    expect(mockRuntime.revokeGovernedMemoryOverride).toHaveBeenCalledWith("memovr-1");
  });

  it("invalidates a source through the manifest-scoped runtime without accepting a project id", async () => {
    const deps = createDeps({ source_ref: "01_大纲/大纲.txt", current_source_revision: "sha256:new" });
    mockRuntime.invalidateGovernedMemorySource.mockResolvedValue([{ id: "claim-1", status: "superseded" }]);
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/sources/invalidate", createContext(), deps);
    expect(mockRuntime.invalidateGovernedMemorySource).toHaveBeenCalledWith({
      sourceRef: "01_大纲/大纲.txt",
      currentSourceRevision: "sha256:new"
    });
  });

  it("routes timeline anchor registration and rebase through the scoped runtime", async () => {
    const deps = createDeps({
      timeline_id: "main",
      timeline_revision: 2,
      anchors: [{ anchor_id: "chapter-1", ordinal: 10 }]
    });
    mockRuntime.registerGovernedTimelineAnchors.mockResolvedValue(4);
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/timelines/anchors", createContext(), deps);
    expect(mockRuntime.registerGovernedTimelineAnchors).toHaveBeenCalledWith({
      timelineId: "main",
      timelineRevision: 2,
      anchors: [{ anchorId: "chapter-1", ordinal: 10 }]
    });

    deps.readJsonBody.mockResolvedValue({ timeline_id: "main", from_timeline_revision: 1, to_timeline_revision: 2 });
    mockRuntime.rebaseGovernedTimelineClaims.mockResolvedValue([{ id: "claim-1" }]);
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/timelines/rebase", createContext(), deps);
    expect(mockRuntime.rebaseGovernedTimelineClaims).toHaveBeenCalledWith({ timelineId: "main", fromRevision: 1, toRevision: 2 });
  });

  it("exposes projection status and only rebuilds through the manifest-scoped runtime", async () => {
    mockRuntime.listGovernedMemoryProjectionStatuses.mockResolvedValue([{ projection_name: "vector_graph", status: "pending" }]);
    const deps = createDeps();
    await handleMemoryRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/memory/projections", createContext(), deps);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, {
      projections: [{ projection_name: "vector_graph", status: "pending" }]
    });

    mockRuntime.rebuildGovernedMemoryProjections.mockResolvedValue({ memory_revision: 3, statuses: [] });
    await handleMemoryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/memory/projections/rebuild", createContext(), deps);
    expect(mockRuntime.rebuildGovernedMemoryProjections).toHaveBeenCalledWith();
  });

  it("uses a structured, project-scoped conversation memory contract", async () => {
    const deps = createDeps({
      confirmed_facts: ["陆尘是主角"],
      decisions: ["先写大纲"],
      rejected_options: [],
      user_preferences: ["克制叙事"],
      open_tasks: ["补第 2 章"],
      current_goal: "完成第一卷",
      source_message_ids: ["message-1"]
    });
    mockRuntime.upsertGovernedConversationMemory.mockResolvedValue({ conversationId: "conversation-1", memoryRevision: 2 });
    await handleMemoryRoutes({ method: "PUT" } as IncomingMessage, {} as ServerResponse, "/api/memory/conversations/conversation-1", createContext(), deps);
    expect(mockRuntime.upsertGovernedConversationMemory).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      confirmedFacts: ["陆尘是主角"],
      sourceMessageIds: ["message-1"]
    }));
  });
});
