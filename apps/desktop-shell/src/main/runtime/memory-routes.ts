import { AgentRuntimeService, type CreateGovernedMemoryClaimInput } from "@xiaoshuo/agent-runtime";
import type { CurrentProject } from "@xiaoshuo/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type RuntimeMemoryRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

/**
 * User-governed project memory. The renderer never provides a project ID: the
 * runtime derives it from the current manifest before every operation.
 */
export async function handleMemoryRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeMemoryRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/memory") || !request.method) {
    return false;
  }
  const currentProject = await deps.ensureProjectSessionCurrent(context);
  if (!currentProject.path) {
    deps.writeJson(response, 400, { detail: "尚未打开项目", code: "PROJECT_NOT_OPEN" });
    return true;
  }
  try {
    const runtime = await getProjectAgentRuntime(context, currentProject.path);
    const claimRoute = matchClaimRoute(pathname);
    const confirmationRoute = matchConfirmationRoute(pathname);
    const conversationRoute = matchConversationRoute(pathname);

    if (conversationRoute && request.method === "GET") {
      const summary = await runtime.getGovernedConversationMemory(conversationRoute.conversationId);
      if (!summary) {
        deps.writeJson(response, 404, { detail: "会话记忆不存在", code: "MEMORY_CONVERSATION_NOT_FOUND" });
        return true;
      }
      deps.writeJson(response, 200, summary);
      return true;
    }
    if (conversationRoute && request.method === "PUT") {
      const body = await deps.readJsonBody(request);
      deps.writeJson(response, 200, {
        summary: await runtime.upsertGovernedConversationMemory({
          conversationId: conversationRoute.conversationId,
          confirmedFacts: stringList(body.confirmed_facts, "confirmed_facts"),
          decisions: stringList(body.decisions, "decisions"),
          rejectedOptions: stringList(body.rejected_options, "rejected_options"),
          userPreferences: stringList(body.user_preferences, "user_preferences"),
          openTasks: stringList(body.open_tasks, "open_tasks"),
          currentGoal: stringValue(body.current_goal),
          sourceMessageIds: stringList(body.source_message_ids, "source_message_ids")
        })
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/api/memory/claims") {
      deps.writeJson(response, 200, { claims: await runtime.listGovernedMemoryClaims() });
      return true;
    }
    if (request.method === "GET" && pathname === "/api/memory/overrides") {
      deps.writeJson(response, 200, { overrides: await runtime.listGovernedMemoryOverrides(true) });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/memory/claims") {
      const payload = await deps.readJsonBody(request);
      deps.writeJson(response, 201, { claim: await runtime.createGovernedMemoryClaim(parseCreateClaim(payload)) });
      return true;
    }
    if (request.method === "GET" && pathname === "/api/memory/export") {
      deps.writeJson(response, 200, await runtime.exportGovernedMemory());
      return true;
    }
    if (request.method === "GET" && pathname === "/api/memory/projections") {
      deps.writeJson(response, 200, { projections: await runtime.listGovernedMemoryProjectionStatuses() });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/memory/projections/rebuild") {
      deps.writeJson(response, 200, await runtime.rebuildGovernedMemoryProjections());
      return true;
    }
    if (request.method === "POST" && pathname === "/api/memory/sources/invalidate") {
      const body = await deps.readJsonBody(request);
      deps.writeJson(response, 200, {
        claims: await runtime.invalidateGovernedMemorySource({
          sourceRef: requiredText(body.source_ref, "source_ref"),
          currentSourceRevision: requiredText(body.current_source_revision, "current_source_revision")
        })
      });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/memory/timelines/anchors") {
      const body = await deps.readJsonBody(request);
      deps.writeJson(response, 200, {
        memory_revision: await runtime.registerGovernedTimelineAnchors({
          timelineId: requiredText(body.timeline_id, "timeline_id"),
          timelineRevision: nonNegativeInteger(body.timeline_revision, "timeline_revision"),
          anchors: parseTimelineAnchors(body.anchors)
        })
      });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/memory/timelines/rebase") {
      const body = await deps.readJsonBody(request);
      deps.writeJson(response, 200, {
        claims: await runtime.rebaseGovernedTimelineClaims({
          timelineId: requiredText(body.timeline_id, "timeline_id"),
          fromRevision: nonNegativeInteger(body.from_timeline_revision, "from_timeline_revision"),
          toRevision: nonNegativeInteger(body.to_timeline_revision, "to_timeline_revision")
        })
      });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/memory/overrides") {
      const body = await deps.readJsonBody(request);
      deps.writeJson(response, 201, {
        override: await runtime.createGovernedMemoryOverride({
          override: parseOverride(body)
        })
      });
      return true;
    }
    const overrideRoute = matchOverrideRoute(pathname);
    if (overrideRoute && request.method === "DELETE") {
      deps.writeJson(response, 200, { override: await runtime.revokeGovernedMemoryOverride(overrideRoute.overrideId) });
      return true;
    }
    if (claimRoute?.action === "confirmations" && request.method === "POST") {
      const body = await deps.readJsonBody(request);
      deps.writeJson(response, 201, {
        confirmation: await runtime.requestGovernedMemoryConfirmation(claimRoute.claimId, nonNegativeInteger(body.source_revision, "source_revision"))
      });
      return true;
    }
    if (confirmationRoute?.action === "resolve" && request.method === "POST") {
      const body = await deps.readJsonBody(request);
      const decision = stringValue(body.decision);
      if (decision !== "approved" && decision !== "rejected") {
        throw new Error("decision 必须是 approved 或 rejected");
      }
      deps.writeJson(response, 200, {
        confirmation: await runtime.resolveGovernedMemoryConfirmation({
          confirmationId: confirmationRoute.confirmationId,
          expectedVersion: positiveInteger(body.expected_version, "expected_version"),
          decision
        })
      });
      return true;
    }
    if (claimRoute?.action === "confirm" && request.method === "POST") {
      const body = await deps.readJsonBody(request);
      deps.writeJson(response, 200, {
        claim: await runtime.confirmGovernedMemoryClaim({
          claimId: claimRoute.claimId,
          confirmationId: requiredText(body.confirmation_id, "confirmation_id"),
          expectedConfirmationVersion: positiveInteger(body.expected_version, "expected_version")
        })
      });
      return true;
    }
    if (claimRoute && !claimRoute.action && request.method === "DELETE") {
      deps.writeJson(response, 200, { claim: await runtime.forgetGovernedMemoryClaim(claimRoute.claimId) });
      return true;
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "MEMORY_REQUEST_INVALID";
    const status = code.includes("VERSION") || code.includes("SCOPE") || code.includes("ALREADY") || code.includes("REVISION") ? 409 : 400;
    deps.writeJson(response, status, { detail: error instanceof Error ? error.message : String(error), code });
    return true;
  }
  return false;
}

function matchClaimRoute(pathname: string): { claimId: string; action: "confirmations" | "confirm" | "" } | null {
  const match = /^\/api\/memory\/claims\/([^/]+)(?:\/(confirmations|confirm))?$/.exec(pathname);
  return match ? { claimId: decodeURIComponent(match[1]!), action: (match[2] ?? "") as "confirmations" | "confirm" | "" } : null;
}

function matchConfirmationRoute(pathname: string): { confirmationId: string; action: "resolve" } | null {
  const match = /^\/api\/memory\/confirmations\/([^/]+)\/(resolve)$/.exec(pathname);
  return match ? { confirmationId: decodeURIComponent(match[1]!), action: "resolve" } : null;
}

function matchOverrideRoute(pathname: string): { overrideId: string } | null {
  const match = /^\/api\/memory\/overrides\/([^/]+)$/.exec(pathname);
  return match ? { overrideId: decodeURIComponent(match[1]!) } : null;
}

function matchConversationRoute(pathname: string): { conversationId: string } | null {
  const match = /^\/api\/memory\/conversations\/([^/]+)$/.exec(pathname);
  return match ? { conversationId: decodeURIComponent(match[1]!) } : null;
}

function parseCreateClaim(payload: JsonRecord): CreateGovernedMemoryClaimInput {
  const status = payload.status === undefined ? undefined : stringValue(payload.status);
  if (status !== undefined && status !== "draft" && status !== "proposed" && status !== "planned") {
    throw Object.assign(new Error("模型草稿不能直接写入 confirmed memory"), { code: "MEMORY_DIRECT_CONFIRMED_WRITE" });
  }
  return {
    id: requiredText(payload.id, "id"),
    subject: requiredText(payload.subject, "subject"),
    predicate: requiredText(payload.predicate, "predicate"),
    object: requiredText(payload.object, "object"),
    interval: parseInterval(payload.interval),
    status
  };
}

function parseInterval(value: unknown): CreateGovernedMemoryClaimInput["interval"] {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("interval 必须是对象");
  }
  return JSON.parse(JSON.stringify(value)) as CreateGovernedMemoryClaimInput["interval"];
}

function parseOverride(payload: JsonRecord): { claimId: string; overrideObject?: string; overrideStatus?: "draft" | "proposed" | "confirmed" | "planned" | "rejected" | "superseded"; overrideInterval?: CreateGovernedMemoryClaimInput["interval"] } {
  const overrideStatus = payload.override_status === undefined ? undefined : stringValue(payload.override_status);
  if (overrideStatus !== undefined && !["draft", "proposed", "confirmed", "planned", "rejected", "superseded"].includes(overrideStatus)) {
    throw new Error("override_status 无效");
  }
  return {
    claimId: requiredText(payload.claim_id, "claim_id"),
    overrideObject: payload.override_object === undefined ? undefined : stringValue(payload.override_object),
    overrideStatus: overrideStatus as "draft" | "proposed" | "confirmed" | "planned" | "rejected" | "superseded" | undefined,
    overrideInterval: payload.override_interval === undefined ? undefined : parseInterval(payload.override_interval)
  };
}

function parseTimelineAnchors(value: unknown): Array<{ anchorId: string; ordinal: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("anchors 必须是非空数组");
  }
  return value.map((anchor) => {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
      throw new Error("anchor 必须是对象");
    }
    const raw = anchor as JsonRecord;
    return {
      anchorId: requiredText(raw.anchor_id, "anchor_id"),
      ordinal: nonNegativeInteger(raw.ordinal, "ordinal")
    };
  });
}

function requiredText(value: unknown, label: string): string {
  const text = stringValue(value).trim();
  if (!text) {
    throw new Error(`${label} 不能为空`);
  }
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
  return number;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return value.map((item) => requiredText(item, label));
}
