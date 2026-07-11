import { ConversationService } from "@xiaoshuo/conversation-service";
import { loadModelConfig, readRawConfig } from "@xiaoshuo/config-service";
import { OpenAICompatibleClient } from "@xiaoshuo/model-client";
import { conversationMessageRequestSchema, type CurrentProject } from "@xiaoshuo/shared";
import { AgentRuntimeService, encodeNdjsonEvent } from "@xiaoshuo/agent-runtime";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequestAbortSignal } from "./http-utils.js";
import { writeAiLicenseRequiredIfNeeded } from "./license-guard.js";
import type { RuntimeContext } from "./types.js";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";

type JsonRecord = Record<string, unknown>;
type RuntimeAbortOptions = { signal?: AbortSignal };
type AbortableConversationRuntimeService = Omit<AgentRuntimeService, "sendMessage" | "streamMessage"> & {
  sendMessage: (
    conversationId: Parameters<AgentRuntimeService["sendMessage"]>[0],
    payload: Parameters<AgentRuntimeService["sendMessage"]>[1],
    options: RuntimeAbortOptions
  ) => ReturnType<AgentRuntimeService["sendMessage"]>;
  streamMessage: (
    conversationId: Parameters<AgentRuntimeService["streamMessage"]>[0],
    payload: Parameters<AgentRuntimeService["streamMessage"]>[1],
    options: RuntimeAbortOptions
  ) => ReturnType<AgentRuntimeService["streamMessage"]>;
};

type ConversationRouteMatch =
  | {
      id?: string;
      action?: string;
      itemId?: string;
    }
  | null;

type RuntimeConversationRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  readRawBody: (request: IncomingMessage) => Promise<Buffer>;
  parseJsonRecord: (rawBody: Buffer) => JsonRecord;
  stringValue: (value: unknown) => string;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
  writeNdjsonEvent: (response: ServerResponse, payload: Parameters<typeof encodeNdjsonEvent>[0]) => void;
  addCorsHeaders: (response: ServerResponse) => void;
  parseMultipartFile: (body: Buffer, contentType: string) => { filename: string; mediaType: string; content: Buffer };
  matchConversationRoute: (pathname: string) => ConversationRouteMatch;
};

function canWriteNdjsonResponse(response: ServerResponse): boolean {
  return !response.writableEnded && !response.destroyed;
}

export async function handleConversationRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeConversationRouteDeps
): Promise<boolean> {
  const conversationRoute = deps.matchConversationRoute(pathname);
  if (!conversationRoute || !request.method || !["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
    return false;
  }

  const currentProject = await deps.ensureProjectSessionCurrent(context);
  const projectPath = currentProject.path;
  if (!projectPath) {
    deps.writeJson(response, 400, { detail: "尚未打开项目" });
    return true;
  }

  const service = new ConversationService({ projectRoot: projectPath });
  if (!conversationRoute.id && request.method === "GET") {
    deps.writeJson(response, 200, await service.listConversations());
    return true;
  }
  if (!conversationRoute.id && request.method === "POST") {
    deps.writeJson(response, 200, await service.createConversation(await deps.readJsonBody(request)));
    return true;
  }
  if (conversationRoute.id && !conversationRoute.action && request.method === "GET") {
    deps.writeJson(response, 200, await service.getConversation(conversationRoute.id));
    return true;
  }
  if (conversationRoute.id && !conversationRoute.action && request.method === "PUT") {
    const payload = await deps.readJsonBody(request);
    deps.writeJson(response, 200, await service.renameConversation(conversationRoute.id, deps.stringValue(payload.title)));
    return true;
  }
  if (conversationRoute.id && conversationRoute.action === "messages" && request.method === "POST") {
    if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
      return true;
    }
    const runtime = await getProjectAgentRuntime(context, projectPath) as AbortableConversationRuntimeService;
    const transportSignal = createRequestAbortSignal(request, response);
    const rawBody = await deps.readRawBody(request);
    const payload = conversationMessageRequestSchema.parse(deps.parseJsonRecord(rawBody));
    const acceptHeader = String(request.headers["accept"] || "").toLowerCase();
    const wantsStream = acceptHeader.includes("text/event-stream") || acceptHeader.includes("application/x-ndjson");

    if (wantsStream) {
      deps.addCorsHeaders(response);
      response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
      try {
        // The HTTP stream is a renderer transport, not durable-run ownership.
        // A reload must not abort a run that the user can pause/cancel/resume
        // through its durable controls after the renderer reconnects.
        for await (const event of runtime.streamMessage(conversationRoute.id, payload, {})) {
          if (!transportSignal.aborted && canWriteNdjsonResponse(response)) {
            deps.writeNdjsonEvent(response, event);
          }
        }
      } catch (error) {
        if (!transportSignal.aborted && canWriteNdjsonResponse(response)) {
          deps.writeNdjsonEvent(response, {
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } finally {
        if (canWriteNdjsonResponse(response)) {
          response.end();
        }
      }
    } else {
      try {
        const result = await runtime.sendMessage(conversationRoute.id, payload, { signal: transportSignal });
        if (!transportSignal.aborted) {
          deps.writeJson(response, 200, result);
        }
      } catch (error) {
        if (!transportSignal.aborted) {
          deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return true;
  }
  if (conversationRoute.id && conversationRoute.action === "attachments" && !conversationRoute.itemId && request.method === "POST") {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      deps.writeJson(response, 400, { detail: "附件上传需要选择文件，请重新选择附件后上传。" });
      return true;
    }
    const rawBody = await deps.readRawBody(request);
    try {
      const { filename, mediaType, content } = deps.parseMultipartFile(rawBody, contentType);
      deps.writeJson(response, 200, await service.addAttachment(conversationRoute.id, filename, mediaType, content));
    } catch (err) {
      deps.writeJson(response, 400, { detail: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (conversationRoute.id && conversationRoute.action === "attachments" && conversationRoute.itemId && request.method === "DELETE") {
    try {
      deps.writeJson(response, 200, await service.deleteAttachment(conversationRoute.id, conversationRoute.itemId));
    } catch (err) {
      deps.writeJson(response, 404, { detail: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (conversationRoute.id && conversationRoute.action === "pin-context" && !conversationRoute.itemId && request.method === "POST") {
    deps.writeJson(response, 200, await service.pinContext(conversationRoute.id, await deps.readJsonBody(request)));
    return true;
  }
  if (conversationRoute.id && conversationRoute.action === "pin-context" && !conversationRoute.itemId && request.method === "DELETE") {
    deps.writeJson(response, 200, await service.clearPinnedContext(conversationRoute.id));
    return true;
  }
  if (conversationRoute.id && conversationRoute.action === "pin-context" && conversationRoute.itemId && request.method === "DELETE") {
    deps.writeJson(response, 200, await service.removePinnedContext(conversationRoute.id, conversationRoute.itemId));
    return true;
  }
  if (conversationRoute.id && conversationRoute.action === "summarize" && request.method === "POST") {
    const rawBody = await deps.readRawBody(request);
    const payload = deps.parseJsonRecord(rawBody);
    if (payload.use_model === true) {
      if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
        return true;
      }
      const configOptions = { rootDir: projectPath, env: process.env };
      const rawConfig = await readRawConfig(configOptions);
      const hasExplicitSecondary = Boolean(String(rawConfig.secondary_api_key || "").trim() && String(rawConfig.secondary_model || "").trim());
      let config = hasExplicitSecondary ? await loadModelConfig(configOptions, "secondary") : await loadModelConfig(configOptions, "primary");
      if (!config.configured) {
        deps.writeJson(response, 200, await service.summarizeConversation(conversationRoute.id));
        return true;
      }
      if (!hasExplicitSecondary) {
        config = {
          ...config,
          temperature: Math.min(config.temperature, 0.2)
        };
      }
      try {
        const detail = await service.getConversation(conversationRoute.id);
        const joined = detail.messages.slice(-18).map((msg) => `${msg.role}: ${msg.content}`).join("\n\n");
        const aiClient = new OpenAICompatibleClient();
        const systemPrompt = "请把对话压缩成简洁项目摘要，保留任务目标、约束、结论和未完成事项。";
        const aiSummary = await aiClient.requestCompletion(
          config,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: joined.slice(0, 18000) }
          ],
          0.2
        );
        const updated = await service.updateConversationSummary(conversationRoute.id, aiSummary.trim());
        deps.writeJson(response, 200, updated);
      } catch {
        deps.writeJson(response, 200, await service.summarizeConversation(conversationRoute.id));
      }
      return true;
    }
    deps.writeJson(response, 200, await service.summarizeConversation(conversationRoute.id));
    return true;
  }

  return false;
}
