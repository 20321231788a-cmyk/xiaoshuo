import {
  type AgentStreamEvent,
  agentStreamEventSchema,
  agentPlanResponseSchema,
  apiContracts,
  appConfigSchema,
  conversationMessageRequestSchema,
  conversationAttachmentSchema,
  conversationDetailSchema,
  documentContentSchema,
  executePlanResponseSchema,
  generatedCacheDetailSchema,
  generatedSaveResponseSchema,
  jobInfoSchema,
  licenseAccountKeyResponseSchema,
  ledgerItemSchema,
  currentProjectSchema,
  cardDrawRequestSchema,
  cardDrawResultSchema,
  cardDrawSelectRequestSchema,
  projectPickerResponseSchema,
  revisionLogEntrySchema,
  skillRunRequestSchema,
  skillRunResponseSchema,
  skillDefinitionSchema,
  skillUpdateRequestSchema,
  skillDraftResponseSchema,
  skillOpenFolderResponseSchema,
  timelineDeleteResultSchema,
  timelineEntrySchema,
  timelineRollbackResultSchema,
  vectorSearchResponseSchema,
  vectorOperationResultSchema,
  websiteAiApplyRequestSchema,
  websiteAiDashboardSchema,
  websiteAiLoginRequestSchema,
  websiteAiRechargeCreateRequestSchema,
  websiteAiRechargeOrderResponseSchema,
  websiteAiRedeemRequestSchema,
  websiteAiRedeemResponseSchema,
  type ApiContractName,
  type AgentRunRequest,
  type AgentPlanRequest,
  type ConversationMessageRequest,
  type ExecutePlanResponse,
  type FileOperation,
  type GeneratedSaveResponse,
  type ApiResponseFor
} from "@xiaoshuo/shared";
import { z } from "zod";

export type FetchLike = typeof fetch;
export type PathParams = Record<string, string | number>;
export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export type ApiClientOptions = {
  baseUrl: string;
  fetchFn?: FetchLike;
};

export type RequestOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | FormData | null;
  query?: QueryParams;
};

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly code: string;

  constructor(message: string, status: number, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    this.code = extractErrorCode(payload);
  }
}

type AgentStreamStartEvent = Extract<AgentStreamEvent, { type: "start" }>;
type AgentStreamDeltaEvent = Extract<AgentStreamEvent, { type: "delta" }>;
type AgentStreamFinalEvent = Extract<AgentStreamEvent, { type: "final" }>;
type AgentStreamErrorEvent = Extract<AgentStreamEvent, { type: "error" }>;

export type AgentStreamHandlers = {
  onStart?: (event: AgentStreamStartEvent) => void;
  onDelta?: (event: AgentStreamDeltaEvent) => void;
  onFinal?: (event: AgentStreamFinalEvent) => void | Promise<void>;
  onError?: (event: AgentStreamErrorEvent) => void | Promise<void>;
};

export function encodePathValue(value: string | number): string {
  return String(value)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function buildApiUrl(baseUrl: string, pathTemplate: string, pathParams?: PathParams, query?: QueryParams): string {
  let path = pathTemplate;

  for (const [key, value] of Object.entries(pathParams ?? {})) {
    path = path.replace(`{${key}}`, encodePathValue(value));
  }

  const url = new URL(path, normalizeBaseUrl(baseUrl));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function extractErrorMessage(text: string): string {
  if (!text) {
    return "";
  }

  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (parsed?.detail) {
      return String(parsed.detail);
    }
  } catch {
    return text;
  }

  return text;
}

function parseErrorPayload(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractErrorCode(payload: unknown): string {
  if (payload && typeof payload === "object" && "code" in payload) {
    return String((payload as { code?: unknown }).code ?? "");
  }
  return "";
}

export async function parseJsonResponse<TSchema extends z.ZodTypeAny>(response: Response, schema: TSchema): Promise<z.infer<TSchema>> {
  const payload = (await response.json()) as unknown;
  return schema.parse(payload);
}

export function createApiClient(options: ApiClientOptions) {
  const fetchFn = options.fetchFn ?? fetch;

  async function requestWithSchema<TSchema extends z.ZodTypeAny>(
    pathTemplate: string,
    schema: TSchema,
    requestOptions?: RequestOptions & { pathParams?: PathParams }
  ): Promise<z.infer<TSchema>> {
    const headers = new Headers(requestOptions?.headers ?? {});
    if (!headers.has("Content-Type") && requestOptions?.body && !(requestOptions.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    const url = buildApiUrl(options.baseUrl, pathTemplate, requestOptions?.pathParams, requestOptions?.query);
    const response = await fetchFn(url, { ...requestOptions, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(extractErrorMessage(text) || response.statusText, response.status, parseErrorPayload(text));
    }

    return parseJsonResponse(response, schema);
  }

  async function requestContract<TName extends ApiContractName>(
    name: TName,
    requestOptions?: RequestOptions & { pathParams?: PathParams }
  ): Promise<ApiResponseFor<TName>> {
    const contract = apiContracts[name];
    return requestWithSchema(contract.path, contract.response, {
      ...requestOptions,
      method: requestOptions?.method ?? contract.method
    }) as Promise<ApiResponseFor<TName>>;
  }

  return {
    requestWithSchema,
    requestContract,
    getHealth: () => requestContract("health"),
    getLicenseStatus: () => requestContract("licenseStatus"),
    getConfig: () => requestContract("config"),
    putConfig: (config: unknown) =>
      requestWithSchema(apiContracts.setConfig.path, appConfigSchema, {
        method: apiContracts.setConfig.method,
        body: JSON.stringify(config)
      }),
    setLicenseAccountKey: (accountKey: string) =>
      requestWithSchema(apiContracts.setLicenseAccountKey.path, licenseAccountKeyResponseSchema, {
        method: apiContracts.setLicenseAccountKey.method,
        body: JSON.stringify({ license_account_key: accountKey })
      }),
    loginWebsiteAi: (payload: z.input<typeof websiteAiLoginRequestSchema>) =>
      requestWithSchema(apiContracts.websiteAiLogin.path, websiteAiDashboardSchema, {
        method: apiContracts.websiteAiLogin.method,
        body: JSON.stringify(websiteAiLoginRequestSchema.parse(payload))
      }),
    getWebsiteAiDashboard: () => requestContract("websiteAiDashboard"),
    applyWebsiteAiConfig: (payload: z.input<typeof websiteAiApplyRequestSchema>) =>
      requestWithSchema(apiContracts.websiteAiApply.path, websiteAiDashboardSchema, {
        method: apiContracts.websiteAiApply.method,
        body: JSON.stringify(websiteAiApplyRequestSchema.parse(payload))
      }),
    redeemWebsiteAiCode: (payload: z.input<typeof websiteAiRedeemRequestSchema>) =>
      requestWithSchema(apiContracts.websiteAiRedeem.path, websiteAiRedeemResponseSchema, {
        method: apiContracts.websiteAiRedeem.method,
        body: JSON.stringify(websiteAiRedeemRequestSchema.parse(payload))
      }),
    createWebsiteAiRechargeOrder: (payload: z.input<typeof websiteAiRechargeCreateRequestSchema>) =>
      requestWithSchema(apiContracts.websiteAiRechargeCreate.path, websiteAiRechargeOrderResponseSchema, {
        method: apiContracts.websiteAiRechargeCreate.method,
        body: JSON.stringify(websiteAiRechargeCreateRequestSchema.parse(payload))
      }),
    getWebsiteAiRechargeOrder: (orderId: string) =>
      requestContract("websiteAiRechargeOrder", {
        pathParams: { order_id: orderId }
      }),
    getCurrentProject: () => requestContract("currentProject"),
    openProject: (path: string) =>
      requestWithSchema("/api/projects/open", currentProjectSchema, {
        method: "POST",
        body: JSON.stringify({ path })
      }),
    createProject: (path: string, projectName: string) =>
      requestWithSchema("/api/projects/create", currentProjectSchema, {
        method: "POST",
        body: JSON.stringify({
          path,
          project_name: projectName,
          create_in_parent: true
        })
      }),
    pickProject: () =>
      requestWithSchema("/api/projects/pick", projectPickerResponseSchema, {
        method: "POST"
      }),
    renameCurrentProject: (name: string) =>
      requestWithSchema("/api/projects/current", currentProjectSchema, {
        method: "PUT",
        body: JSON.stringify({ name })
      }),
    getDocuments: () => requestContract("documents"),
    getProjectTree: () => requestContract("projectTree"),
    getProjectTreeSubtree: (pathValue = "") =>
      requestContract("projectTreeSubtree", {
        query: pathValue ? { path: pathValue } : undefined
      }),
    getProjectChrome: (query?: QueryParams) => requestContract("projectChrome", { query }),
    getProjectManifestStatus: () => requestContract("projectManifestStatus"),
    getVectorStatus: () => requestContract("vectorStatus"),
    rebuildVectorIndex: () =>
      requestWithSchema("/api/vector/rebuild", vectorOperationResultSchema, {
        method: "POST"
      }),
    processPendingVectorFiles: (limit?: number) =>
      requestWithSchema("/api/vector/process-pending", vectorOperationResultSchema, {
        method: "POST",
        query: limit ? { limit } : undefined
      }),
    searchVector: (query: string, topK = 5, maxChars = 6000) =>
      requestWithSchema(apiContracts.vectorSearch.path, vectorSearchResponseSchema, {
        method: apiContracts.vectorSearch.method,
        body: JSON.stringify({
          query,
          top_k: topK,
          max_chars: maxChars
        })
      }),
    getLibraries: () => requestContract("libraries"),
    getDocument: (relativePath: string) =>
      requestContract("document", {
        pathParams: { rel_path: relativePath }
      }),
    saveDocument: (relativePath: string, content: string, options: { baseUpdatedAt?: string; baseUpdatedAtMs?: number; force?: boolean } = {}) =>
      requestWithSchema("/api/documents/{rel_path}", documentContentSchema, {
        method: "PUT",
        pathParams: { rel_path: relativePath },
        body: JSON.stringify({
          content,
          base_updated_at: options.baseUpdatedAt,
          base_updated_at_ms: options.baseUpdatedAtMs,
          force: options.force
        })
      }),
    getConversations: () => requestContract("conversations"),
    getConversation: (conversationId: string) =>
      requestContract("conversation", {
        pathParams: { conversation_id: conversationId }
      }),
    createConversation: (payload: { title?: string; skill_id?: string; agent_name?: string } = {}) =>
      requestWithSchema("/api/conversations", conversationDetailSchema, {
        method: "POST",
        body: JSON.stringify({
          title: payload.title ?? "",
          skill_id: payload.skill_id ?? "",
          agent_name: payload.agent_name ?? ""
        })
      }),
    updateConversationTitle: (conversationId: string, title: string) =>
      requestWithSchema("/api/conversations/{conversation_id}", conversationDetailSchema, {
        method: "PUT",
        pathParams: { conversation_id: conversationId },
        body: JSON.stringify({ title })
      }),
    summarizeConversation: (conversationId: string, useModel = false) =>
      requestWithSchema("/api/conversations/{conversation_id}/summarize", conversationDetailSchema, {
        method: "POST",
        pathParams: { conversation_id: conversationId },
        body: JSON.stringify({ use_model: useModel })
      }),
    pinConversationContext: (
      conversationId: string,
      payload: { kind?: "document" | "selection" | "text"; label?: string; path?: string; content?: string }
    ) =>
      requestWithSchema("/api/conversations/{conversation_id}/pin-context", conversationDetailSchema, {
        method: "POST",
        pathParams: { conversation_id: conversationId },
        body: JSON.stringify(payload)
      }),
    clearConversationPinnedContext: (conversationId: string) =>
      requestWithSchema("/api/conversations/{conversation_id}/pin-context", conversationDetailSchema, {
        method: "DELETE",
        pathParams: { conversation_id: conversationId }
      }),
    removeConversationPinnedContext: (conversationId: string, itemId: string) =>
      requestWithSchema("/api/conversations/{conversation_id}/pin-context/{item_id}", conversationDetailSchema, {
        method: "DELETE",
        pathParams: { conversation_id: conversationId, item_id: itemId }
      }),
    uploadConversationAttachment: (conversationId: string, file: File | Blob, filename = "attachment.txt") => {
      const form = new FormData();
      form.append("file", file, filename);
      return requestWithSchema("/api/conversations/{conversation_id}/attachments", conversationAttachmentSchema, {
        method: "POST",
        pathParams: { conversation_id: conversationId },
        body: form,
        headers: {}
      });
    },
    deleteConversationAttachment: (conversationId: string, attachmentId: string) =>
      requestWithSchema("/api/conversations/{conversation_id}/attachments/{attachment_id}", conversationDetailSchema, {
        method: "DELETE",
        pathParams: { conversation_id: conversationId, attachment_id: attachmentId }
      }),
    sendConversationMessage: (conversationId: string, payload: ConversationMessageRequest) =>
      requestWithSchema(
        "/api/conversations/{conversation_id}/messages",
        z
          .object({
            conversation: conversationDetailSchema,
            reply: z.string(),
            saved_path: z.string().default(""),
            web_search_sources: z.array(z.object({ title: z.string(), url: z.string() })).default([])
          })
          .passthrough(),
        {
          method: "POST",
          pathParams: { conversation_id: conversationId },
          body: JSON.stringify(conversationMessageRequestSchema.parse(payload))
        }
      ),
    streamConversationMessage: async (
      conversationId: string,
      payload: ConversationMessageRequest,
      handlers: AgentStreamHandlers,
      signal?: AbortSignal
    ) => {
      const response = await fetchFn(buildApiUrl(options.baseUrl, "/api/conversations/{conversation_id}/messages", { conversation_id: conversationId }), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson"
        },
        body: JSON.stringify(conversationMessageRequestSchema.parse(payload)),
        signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new ApiError(extractErrorMessage(text) || response.statusText, response.status, parseErrorPayload(text));
      }
      if (!response.body) {
        throw new Error("浏览器不支持流式响应");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          await dispatchAgentStreamLine(line, handlers);
        }

        if (done) {
          break;
        }
      }

      if (buffer.trim()) {
        await dispatchAgentStreamLine(buffer, handlers);
      }
    },
    runSkill: (skillId: string, payload: z.input<typeof skillRunRequestSchema>) =>
      requestWithSchema("/api/skills/{skill_id}/run", skillRunResponseSchema, {
        method: "POST",
        pathParams: { skill_id: skillId },
        body: JSON.stringify(payload)
      }),
    planAgent: (payload: AgentPlanRequest) =>
      requestWithSchema("/api/agent/plan", agentPlanResponseSchema, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    getSkills: () => requestContract("skills"),
    getSkill: (skillId: string) =>
      requestWithSchema("/api/skills/{skill_id}", skillDefinitionSchema, {
        method: "GET",
        pathParams: { skill_id: skillId }
      }),
    deleteSkill: (skillId: string) =>
      requestWithSchema("/api/skills/{skill_id}", z.object({ ok: z.boolean().default(true), deleted: z.boolean().default(false), disabled: z.boolean().default(false), skill_id: z.string() }).passthrough(), {
        method: "DELETE",
        pathParams: { skill_id: skillId }
      }),
    toggleSkill: (skillId: string, disabled?: boolean) =>
      requestWithSchema("/api/skills/{skill_id}/toggle", skillDefinitionSchema, {
        method: "POST",
        pathParams: { skill_id: skillId },
        body: JSON.stringify(disabled === undefined ? {} : { disabled })
      }),
    updateSkillDescription: (skillId: string, payload: z.input<typeof skillUpdateRequestSchema>) =>
      requestWithSchema("/api/skills/{skill_id}", skillDefinitionSchema, {
        method: "PATCH",
        pathParams: { skill_id: skillId },
        body: JSON.stringify(skillUpdateRequestSchema.parse(payload))
      }),
    importSkill: (skillPath: string) =>
      requestWithSchema("/api/skills/import", skillDefinitionSchema, {
        method: "POST",
        body: JSON.stringify({ path: skillPath })
      }),
    uploadSkill: (file: File | Blob, filename = "SKILL.md") => {
      const form = new FormData();
      form.append("file", file, filename);
      return requestWithSchema("/api/skills/upload", skillDefinitionSchema, {
        method: "POST",
        body: form
      });
    },
    draftSkillFromUrl: (url: string, instruction = "") =>
      requestWithSchema("/api/skills/draft-from-url", skillDraftResponseSchema, {
        method: "POST",
        body: JSON.stringify({ url, instruction })
      }),
    importSkillDraft: (payload: {
      skill: z.infer<typeof skillDefinitionSchema>;
      source_url?: string;
      source_name?: string;
      source_text?: string;
    }) =>
      requestWithSchema("/api/skills/import-draft", skillDefinitionSchema, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    openSkillFolder: () =>
      requestWithSchema("/api/skills/open-folder", skillOpenFolderResponseSchema, {
        method: "POST"
      }),
    generateCardDraw: (payload: z.input<typeof cardDrawRequestSchema>) =>
      requestWithSchema("/api/card-draw", cardDrawResultSchema, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    selectCardDraw: (drawId: string, payload: z.input<typeof cardDrawSelectRequestSchema>) =>
      requestWithSchema("/api/card-draw/{draw_id}/select", z.object({}).passthrough(), {
        method: "POST",
        pathParams: { draw_id: drawId },
        body: JSON.stringify(payload)
      }),
    getJobs: () => requestContract("jobs"),
    createJob: (kind: string, payload: Record<string, unknown>) =>
      requestWithSchema("/api/jobs", jobInfoSchema, {
        method: "POST",
        body: JSON.stringify({ kind, payload })
      }),
    getJob: (jobId: string) =>
      requestContract("job", {
        pathParams: { job_id: jobId }
      }),
    cancelJob: (jobId: string) =>
      requestWithSchema("/api/jobs/{job_id}/cancel", jobInfoSchema, {
        method: "POST",
        pathParams: { job_id: jobId }
      }),
    executeOperations: (operations: FileOperation[], confirmDelete = false) =>
      requestWithSchema("/api/agent/execute", executePlanResponseSchema, {
        method: "POST",
        body: JSON.stringify({ operations, confirm_delete: confirmDelete })
      }),
    saveGeneratedResult: (payload: {
      skill_id: string;
      content: string;
      cache_id?: string;
      mode: "replace" | "append";
      target_path: string;
      target_paths?: string[];
      chapter?: number;
      save_plan?: unknown;
    }) =>
      requestWithSchema("/api/agent/generated/save", generatedSaveResponseSchema, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    getGeneratedCache: (cacheId: string) =>
      requestWithSchema(apiContracts.generatedCache.path, generatedCacheDetailSchema, {
        method: apiContracts.generatedCache.method,
        pathParams: { cache_id: cacheId }
      }),
    discardGeneratedCache: (cacheId: string) =>
      requestWithSchema("/api/agent/generated/cache/{cache_id}", z.object({}).passthrough(), {
        method: "DELETE",
        pathParams: { cache_id: cacheId }
      }),
    streamAgentRun: async (payload: AgentRunRequest, handlers: AgentStreamHandlers, signal?: AbortSignal) => {
      const response = await fetchFn(buildApiUrl(options.baseUrl, "/api/agent/run-stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new ApiError(extractErrorMessage(text) || response.statusText, response.status, parseErrorPayload(text));
      }
      if (!response.body) {
        throw new Error("浏览器不支持流式响应");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          await dispatchAgentStreamLine(line, handlers);
        }

        if (done) {
          break;
        }
      }

      if (buffer.trim()) {
        await dispatchAgentStreamLine(buffer, handlers);
      }
    },
    getLedger: () => requestContract("ledger"),
    getTimeline: () => requestContract("timeline"),
    getTimelineEntry: (entryId: string) =>
      requestContract("timelineEntry", {
        pathParams: { entry_id: entryId }
      }),
    deleteTimelineEntry: (entryId: string) =>
      requestWithSchema(apiContracts.deleteTimelineEntry.path, timelineDeleteResultSchema, {
        method: apiContracts.deleteTimelineEntry.method,
        pathParams: { entry_id: entryId }
      }),
    rollbackTimelineEntry: (entryId: string, confirmDelete = false) =>
      requestWithSchema(apiContracts.rollbackTimelineEntry.path, timelineRollbackResultSchema, {
        method: apiContracts.rollbackTimelineEntry.method,
        pathParams: { entry_id: entryId },
        body: JSON.stringify({ confirm_delete: confirmDelete })
      }),
    getRevisionLog: () => requestContract("revisionLog"),
    clearRevisionLog: (confirmDelete = false) =>
      requestWithSchema("/api/revision-log", z.object({ ok: z.boolean() }).passthrough(), {
        method: "DELETE",
        body: JSON.stringify({ confirm_delete: confirmDelete })
      }),
    addLedgerItem: (desc: string) =>
      requestWithSchema("/api/ledger", ledgerItemSchema, {
        method: "POST",
        body: JSON.stringify({ desc })
      }),
    toggleLedgerItem: (itemId: string) =>
      requestWithSchema("/api/ledger/toggle", ledgerItemSchema, {
        method: "POST",
        body: JSON.stringify({ item_id: itemId })
      })
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

async function dispatchAgentStreamLine(line: string, handlers: AgentStreamHandlers): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  const event = agentStreamEventSchema.parse(JSON.parse(trimmed));
  if (event.type === "start") {
    handlers.onStart?.(event);
    return;
  }
  if (event.type === "delta") {
    handlers.onDelta?.(event);
    return;
  }
  if (event.type === "final") {
    await handlers.onFinal?.(event);
    return;
  }
  await handlers.onError?.(event);
}
