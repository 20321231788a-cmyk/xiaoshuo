import { vectorSearchRequestSchema, type CurrentProject } from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type RuntimeVectorRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  stringValue: (value: unknown) => string;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleVectorRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  context: RuntimeContext,
  deps: RuntimeVectorRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/vector") || !request.method) {
    return false;
  }

  const currentProject = await deps.ensureProjectSessionCurrent(context);
  if (!currentProject.path) {
    deps.writeJson(response, 400, { detail: "尚未打开项目" });
    return true;
  }

  const index = new VectorIndex(currentProject.path);
  try {
    if (request.method === "GET" && pathname === "/api/vector/status") {
      deps.writeJson(response, 200, await index.status());
      return true;
    }

    if (request.method === "POST" && pathname === "/api/vector/rebuild") {
      deps.writeJson(response, 200, await index.rebuild());
      return true;
    }

    if (request.method === "POST" && pathname === "/api/vector/process-pending") {
      const limitStr = searchParams.get("limit");
      const limit = limitStr ? Number(limitStr) : undefined;
      deps.writeJson(response, 200, await index.processPending(undefined, { limit }));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/vector/search") {
      const payload = vectorSearchRequestSchema.parse(await deps.readJsonBody(request));
      const hits = await index.search(payload.query, { topK: payload.top_k, maxChars: payload.max_chars });
      deps.writeJson(response, 200, { hits });
      return true;
    }
  } finally {
    index.close();
  }

  return false;
}
