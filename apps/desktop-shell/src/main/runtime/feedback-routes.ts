import { artifactFeedbackSchema, type CurrentProject } from "@xiaoshuo/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type RuntimeFeedbackRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleFeedbackRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeFeedbackRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/agent/feedback") || !request.method) {
    return false;
  }
  const project = await deps.ensureProjectSessionCurrent(context);
  if (!project.path) {
    deps.writeJson(response, 400, { detail: "尚未打开项目" });
    return true;
  }
  const runtime = await getProjectAgentRuntime(context, project.path);
  if (request.method === "GET" && pathname === "/api/agent/feedback/candidates") {
    deps.writeJson(response, 200, await runtime.listPreferenceCandidates());
    return true;
  }
  if (request.method === "POST" && pathname === "/api/agent/feedback") {
    const payload = artifactFeedbackSchema.parse({
      ...(await deps.readJsonBody(request)),
      created_at: new Date().toISOString()
    });
    await runtime.recordArtifactFeedback({
      ...payload,
      action: payload.action === "discarded" || payload.action === "regenerated" || payload.action === "quality_override" ? "discard" : "accept"
    });
    deps.writeJson(response, 202, { ok: true });
    return true;
  }
  const match = pathname.match(/^\/api\/agent\/feedback\/candidates\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && match) {
    const payload = await deps.readJsonBody(request);
    const candidateId = decodeURIComponent(match[1]!);
    const confirmedBy = String(payload.confirmed_by || "").trim();
    if (match[2] === "approve") {
      const version = await runtime.approvePreferenceCandidate(candidateId, confirmedBy, String(payload.eval_manifest_ref || "").trim());
      deps.writeJson(response, 200, version);
    } else {
      await runtime.rejectPreferenceCandidate(candidateId, confirmedBy);
      deps.writeJson(response, 200, { ok: true });
    }
    return true;
  }
  return false;
}
