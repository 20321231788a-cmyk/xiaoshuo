import { encodeNdjsonEvent } from "@xiaoshuo/agent-runtime";
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
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  addCorsHeaders,
  booleanValue,
  closeProjectAgentRuntimes,
  createRequestAbortSignal,
  ensureDocumentSession,
  ensureProjectSessionCurrent,
  getProjectAgentRuntime,
  handleAgentRoutes,
  handleAgentTraceRoutes,
  handleBaseRuntimeRoutes,
  handleConversationRoutes,
  handleGeneratedCacheRoutes,
  handleJobRoutes,
  handleProjectDocumentRoutes,
  handleProjectReferenceRoutes,
  handleSkillRoutes,
  handleVectorRoutes,
  handleGraphRoutes,
  handleWebsiteAiRoutes,
  runtimeRequestAccessStatus,
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
import { ProjectIdentityRegistry, ProjectIdentityRegistryError } from "./project-identity-registry.js";

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
  const agentRuntimes = options.state.agentRuntimes || new Map();
  const projectIdentityRegistry = options.state.projectIdentityRegistry || new ProjectIdentityRegistry(
    options.projectIdentityRegistryPath || path.join(path.dirname(options.stateFilePath), "project-identities.json")
  );
  // Browser E2E cannot use Electron's preload bridge. The explicit token is
  // accepted only by the separately-gated test runtime process.
  const sessionToken = process.env.XIAOSHUO_E2E_RUNTIME === "1" && process.env.XIAOSHUO_E2E_SESSION_TOKEN
    ? process.env.XIAOSHUO_E2E_SESSION_TOKEN
    : randomBytes(32).toString("base64url");
  const allowedOrigins = runtimeAllowedOrigins();
  options.state.jobManager = jobManager;
  options.state.documentSessions = documentSessions;
  options.state.agentRuntimes = agentRuntimes;
  options.state.projectIdentityRegistry = projectIdentityRegistry;
  options.state.sessionToken = sessionToken;
  const restoredProject = await projectSession.getCurrentProject();
  if (restoredProject.path) {
    startDocumentSession(documentSessions, restoredProject.path);
  }

  const server = http.createServer((request, response) => {
    void handleRuntimeRequest(request, response, {
      projectRoot: options.projectRoot,
      jobManager,
      projectSession,
      documentSessions,
      agentRuntimes,
      projectIdentityRegistry,
      sessionToken,
      allowedOrigins
    }).catch((error) => {
      options.state.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof ProjectIdentityRegistryError) {
        writeJson(response, 409, { detail: options.state.lastError, code: error.code });
        return;
      }
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
  closeProjectAgentRuntimes(state.agentRuntimes);
  state.agentRuntimes = undefined;
  state.sessionToken = undefined;
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
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] || "" : request.headers.origin || "";
  const url = new URL(request.url || "/", runtimeUrl);
  const pathname = stripTrailingSlash(url.pathname);
  const accessStatus = runtimeRequestAccessStatus(request, pathname, {
    expectedHost: `${runtimeHost}:${runtimePort}`,
    allowedOrigins: context.allowedOrigins || [],
    sessionToken: context.sessionToken || ""
  });
  if (accessStatus === 403) {
    writeJson(response, 403, { detail: "拒绝非本机来源或主机访问 ArcWriter 本地服务" });
    return;
  }
  if (accessStatus === 401) {
    writeJson(response, 401, { detail: "本地运行时会话未认证", code: "RUNTIME_SESSION_REQUIRED" });
    return;
  }
  addCorsHeaders(response, origin, context.allowedOrigins || []);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

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

  if (await handleProjectReferenceRoutes(request, response, pathname, context, {
    ensureProjectSessionCurrent,
    readJsonBody,
    writeJson
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
  }, url.searchParams)) {
    return;
  }

  if (await handleAgentTraceRoutes(request, response, pathname, url.searchParams, context, {
    ensureProjectSessionCurrent,
    writeJson
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
    const signal = createRequestAbortSignal(request, response);
    const rawBody = await readRawBody(request);
    const payload = cardDrawRequestSchema.parse(parseJsonRecord(rawBody));
    const runtime = getProjectAgentRuntime(context, currentProject.path);
    try {
      const result = await runtime.generateCardDraw(payload, () => undefined, { signal });
      if (!signal.aborted) {
        await rebuildProjectManifest(currentProject.path);
        writeJson(response, 200, result);
      }
    } catch (error) {
      if (!signal.aborted) {
        writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
      }
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
    const runtime = getProjectAgentRuntime(context, currentProject.path);
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

  if (await handleGraphRoutes(request, response, pathname, url.searchParams, context, {
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

function runtimeAllowedOrigins(): string[] {
  const origins = [runtimeUrl];
  const rendererUrl = process.env.XIAOSHUO_RENDERER_URL;
  if (rendererUrl) {
    try {
      origins.push(new URL(rendererUrl).origin);
    } catch {
      // Invalid renderer URLs are rejected by BrowserWindow loading before any request can be trusted.
    }
  }
  return [...new Set(origins)];
}
