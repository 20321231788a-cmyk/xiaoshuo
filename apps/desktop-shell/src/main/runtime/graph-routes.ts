import { type CurrentProject } from "@xiaoshuo/shared";
import { GraphContext } from "@xiaoshuo/vector-service";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";
import { writeAiLicenseRequiredIfNeeded } from "./license-guard.js";

type JsonRecord = Record<string, unknown>;

type RuntimeGraphRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  stringValue: (value: unknown) => string;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleGraphRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  context: RuntimeContext,
  deps: RuntimeGraphRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/graph") || !request.method) {
    return false;
  }

  const currentProject = await deps.ensureProjectSessionCurrent(context);
  if (!currentProject.path) {
    deps.writeJson(response, 400, { detail: "尚未打开项目" });
    return true;
  }

  const usesAiGraphOperation =
    request.method === "POST" &&
    (pathname === "/api/graph/rebuild" ||
      pathname === "/api/graph/writing-context" ||
      pathname === "/api/graph/check");

  if (usesAiGraphOperation && (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson))) {
    return true;
  }

  const graph = new GraphContext(currentProject.path);
  try {
    if (request.method === "GET" && pathname === "/api/graph/status") {
      deps.writeJson(response, 200, graph.getStatus());
      return true;
    }

    if (request.method === "POST" && pathname === "/api/graph/rebuild") {
      graph.rebuildGraph();
      deps.writeJson(response, 200, { status: "ok", ...graph.getStatus() });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/graph/writing-context") {
      const body = await deps.readJsonBody(request);
      const query = deps.stringValue(body.query || "");
      const topK = body.top_k ? Number(body.top_k) : undefined;
      const result = await graph.buildWritingContext(query, { topK });
      deps.writeJson(response, 200, { context: result });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/graph/check") {
      const body = await deps.readJsonBody(request);
      const text = deps.stringValue(body.text || "");
      const result = await graph.checkConsistency(text);
      deps.writeJson(response, 200, result);
      return true;
    }
  } catch (err) {
    deps.writeJson(response, 500, { detail: err instanceof Error ? err.message : String(err) });
    return true;
  } finally {
    graph.close();
  }

  return false;
}
