import { AgentRuntimeService, encodeNdjsonEvent } from "@xiaoshuo/agent-runtime";
import { loadPublicConfig, savePublicConfig } from "@xiaoshuo/config-service";
import { DocumentService, type DocumentTimelineSession } from "@xiaoshuo/document-service";
import { JobManager } from "@xiaoshuo/job-service";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { ProjectSessionService } from "@xiaoshuo/project-session";
import { VectorIndex } from "@xiaoshuo/vector-service";
import {
  projectOpenRequestSchema,
  projectRenameRequestSchema,
  saveDocumentRequestSchema,
  cardDrawRequestSchema,
  cardDrawSelectRequestSchema,
  type CurrentProject
} from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  addCorsHeaders,
  booleanValue,
  ensureDocumentSession,
  ensureProjectSessionCurrent,
  handleAgentRoutes,
  handleBaseRuntimeRoutes,
  handleConversationRoutes,
  handleGeneratedCacheRoutes,
  handleJobRoutes,
  handleProjectDocumentRoutes,
  handleSkillRoutes,
  handleVectorRoutes,
  handleWebsiteAiRoutes,
  listRuntimeJobs,
  matchCardDrawRoute,
  matchConversationRoute,
  matchDocumentRoute,
  matchSkillRoute,
  matchTimelineRoute,
  moveDocumentSession,
  parseJsonRecord,
  parseMultipartFile,
  readBooleanQuery,
  readIntQuery,
  readJsonBody,
  readRawBody,
  readRequestFields,
  rebuildProjectManifest,
  runtimeHost,
  runtimePort,
  runtimeUrl,
  startDocumentSession,
  stringValue,
  stripTrailingSlash,
  type JsonRecord,
  type RuntimeContext,
  type RuntimeServerOptions,
  type RuntimeServerState,
  writeAiLicenseRequiredIfNeeded,
  writeJson,
  writeNdjsonEvent
} from "./runtime/index.js";

export { runtimeHost, runtimePort, runtimeUrl, type RuntimeServerOptions, type RuntimeServerState } from "./runtime/types.js";
type ShellLike = { openPath: (target: string) => unknown };
let shellBridge: ShellLike | null = null;

export function registerRuntimeShell(shellLike: ShellLike): void {
  shellBridge = shellLike;
}

export async function startRuntimeServer(options: RuntimeServerOptions): Promise<void> {
  if (options.state.server?.listening) {
    return;
  }

  const jobManager = new JobManager({ idFactory: () => "ts-" + randomUUID().replace(/-/g, "") });
  const projectSession = new ProjectSessionService({ stateFilePath: options.stateFilePath });
  const documentSessions = options.state.documentSessions || new Map<string, DocumentTimelineSession>();
  options.state.jobManager = jobManager;
  options.state.documentSessions = documentSessions;
  const restoredProject = await projectSession.getCurrentProject();
  if (restoredProject.path) {
    startDocumentSession(documentSessions, restoredProject.path);
  }

  const server = http.createServer((request, response) => {
    void handleRuntimeRequest(request, response, {
      projectRoot: options.projectRoot,
      jobManager,
      projectSession,
      documentSessions
    }).catch((error) => {
      options.state.lastError = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { detail: options.state.lastError });
    });
  });

  options.state.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtimePort, runtimeHost, () => {
      server.off("error", reject);
      options.state.ready = true;
      resolve();
    });
  });
}

export async function stopRuntimeServer(state: RuntimeServerState): Promise<void> {
  const server = state.server;
  state.server = undefined;
  state.ready = false;
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function handleRuntimeRequest(request: IncomingMessage, response: ServerResponse, context: RuntimeContext): Promise<void> {
  addCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url || "/", runtimeUrl);
  const pathname = stripTrailingSlash(url.pathname);

  if (await handleBaseRuntimeRoutes(request, response, pathname, context, { readJsonBody, writeJson })) {
    return;
  }

  if (await handleWebsiteAiRoutes(request, response, pathname, context, { readJsonBody, writeJson })) {
    return;
  }

  if (await handleProjectDocumentRoutes(request, response, pathname, url.searchParams, context, {
    ensureProjectSessionCurrent,
    ensureDocumentSession,
    startDocumentSession,
    moveDocumentSession,
    readJsonBody,
    readRequestFields,
    rebuildProjectManifest,
    booleanValue,
    stringValue,
    readBooleanQuery,
    readIntQuery,
    writeJson,
    matchDocumentRoute,
    matchTimelineRoute
  })) {
    return;
  }

  if (await handleAgentRoutes(request, response, pathname, context, {
    ensureProjectSessionCurrent,
    ensureDocumentSession,
    readJsonBody,
    readRawBody,
    parseJsonRecord,
    booleanValue,
    rebuildProjectManifest,
    writeJson,
    writeNdjsonEvent,
    addCorsHeaders
  })) {
    return;
  }

  if (await handleSkillRoutes(request, response, pathname, context, {
    ensureProjectSessionCurrent,
    readJsonBody,
    readRawBody,
    parseJsonRecord,
    parseMultipartFile,
    rebuildProjectManifest,
    writeJson,
    matchSkillRoute,
    openPath: (target) => shellBridge?.openPath(target)
  })) {
    return;
  }

  const cardDrawRoute = matchCardDrawRoute(pathname);
  if (cardDrawRoute && request.method === "POST" && !cardDrawRoute.action && !cardDrawRoute.drawId) {
    if (await writeAiLicenseRequiredIfNeeded(context, response, writeJson)) {
      return;
    }
    const currentProject = await ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      writeJson(response, 400, { detail: "尚未打开项目" });
      return;
    }
    const rawBody = await readRawBody(request);
    const payload = cardDrawRequestSchema.parse(parseJsonRecord(rawBody));
    const runtime = new AgentRuntimeService({
      projectRoot: currentProject.path,
      config: { rootDir: context.projectRoot, env: process.env }
    });
    try {
      const result = await runtime.generateCardDraw(payload, () => undefined);
      await rebuildProjectManifest(currentProject.path);
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (cardDrawRoute && request.method === "POST" && cardDrawRoute.action === "select") {
    if (!cardDrawRoute.drawId) {
      writeJson(response, 400, { detail: "缺少抽卡记录 ID" });
      return;
    }
    const currentProject = await ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      writeJson(response, 400, { detail: "尚未打开项目" });
      return;
    }
    const rawBody = await readRawBody(request);
    const payload = cardDrawSelectRequestSchema.parse(parseJsonRecord(rawBody));
    const runtime = new AgentRuntimeService({
      projectRoot: currentProject.path,
      config: { rootDir: context.projectRoot, env: process.env }
    });
    try {
      const result = await runtime.selectCardDraw(cardDrawRoute.drawId, payload);
      await rebuildProjectManifest(currentProject.path);
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (await handleConversationRoutes(request, response, pathname, context, {
    ensureProjectSessionCurrent,
    readJsonBody,
    readRawBody,
    parseJsonRecord,
    stringValue,
    writeJson,
    writeNdjsonEvent,
    addCorsHeaders,
    parseMultipartFile,
    matchConversationRoute
  })) {
    return;
  }

  if (await handleGeneratedCacheRoutes(request, response, pathname, context, {
    ensureProjectSessionCurrent,
    readJsonBody,
    readRawBody,
    parseJsonRecord,
    rebuildProjectManifest,
    stringValue,
    writeJson
  })) {
    return;
  }

  if (await handleVectorRoutes(request, response, pathname, url.searchParams, context, {
    ensureProjectSessionCurrent,
    readJsonBody,
    stringValue,
    writeJson
  })) {
    return;
  }

  if (await handleJobRoutes(request, response, pathname, context, {
    ensureProjectSessionCurrent,
    readJsonBody,
    rebuildProjectManifest,
    stringValue,
    booleanValue,
    writeJson
  })) {
    return;
  }

  writeJson(response, 404, { detail: `未找到该接口: ${request.method} ${pathname}` });
}
