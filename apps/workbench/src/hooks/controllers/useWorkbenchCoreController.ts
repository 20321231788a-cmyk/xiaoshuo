import { ApiError, createApiClient } from "@xiaoshuo/api-client";
import type {
  AppConfig,
  AiConfigProfile,
  AiModelOption,
  AgentConfirmation,
  AgentRunResponse,
  AgentRunState,
  CardDrawRequest,
  CardDrawResult,
  CardDrawSelectRequest,
  CloudProjectListResponse,
  CloudProjectSlot,
  ConversationDetail,
  ConversationAttachment,
  ConversationMessage,
  ConversationSummary,
  ConversationModelPreferences,
  ConversationType,
  CurrentProject,
  JobInfo,
  LedgerItem,
  LocalStateGeneratedCache,
  ProjectChromeSnapshot,
  ProjectFileReferenceCandidate,
  ProjectManifestStatus,
  SkillDefinition,
  SkillDraftResponse,
  SkillDraftSourceKind,
  SkillPatchRequest,
  SkillPatchResponse,
  SkillRunRequest,
  SkillRunResponse,
  SkillVersionEntry,
  StyleDistillationProfile,
  TimelineEntry,
  VectorSearchHit,
  VectorIndexStatus,
  VectorTestRequest,
  WebsiteAiApplyRequest,
  WebsiteImageConfigRequest,
  WebsiteAiDashboard,
  WebsiteAiRechargeOrder
} from "@xiaoshuo/shared";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { normalizeConfigDraft } from "../../lib/config.js";
import type { DashboardSnapshot } from "../../lib/dashboard.js";
import { loadDashboardSnapshot } from "../../lib/dashboard.js";
import { applyDocumentContent, markDocumentStale } from "../../lib/editorState.js";
import { childProjectPath, normalizeNewProjectFileName, treePathExists } from "../../lib/projectTreeActions.js";
import { findStarterDocumentPath } from "../../lib/projectWorkspace.js";
import type { WorkbenchRuntime } from "../../lib/runtime.js";
import {
  describeActionableError,
  describeJobKind,
  describeSavedGeneratedResult,
  describeJobStarted,
  describeStoppedConversationResponse,
  describeUnsavedWorkbenchState,
  extractPathsFromUnknownResult,
  messageRequiresActiveDocument,
  pendingSaveFromSkill,
  pendingSavesFromSkill,
  resolveAssistantReply,
  shouldPollJob,
  skillRequiresActiveDocument,
  summarizeJobResult,
  summarizeOperationResults,
  type PendingGeneratedSave,
  type PendingLibraryDraftGroup,
  type PendingReviewItem
} from "../../lib/workflow.js";

type LoadStatus = "loading" | "ready" | "error";

export type AgentConfirmationExecutionState = {
  status: "pending" | "executing" | "completed" | "failed" | "rejected";
  message: string;
};

export type WorkbenchTab = "overview" | "project" | "editor" | "config" | "conversations" | "operations" | "terminal";

const workbenchTabs = new Set<WorkbenchTab>(["overview", "project", "editor", "config", "conversations", "operations", "terminal"]);
const projectReferenceHintPattern = /@|参考|参照|根据|读取|读一下|对照|结合|当前(?:文档|文件)|这篇|这章|章纲|细纲|大纲|人物|角色|世界观|设定|正文|\.txt|\.md|\.jsonl/i;

function workflowProgressLabel(skillId: string): string {
  if (skillId === "disassemble_book" || skillId === "continue_disassemble") return "拆书任务";
  if (skillId === "batch_generate") return "批量生成";
  if (skillId === "body_generate") return "正文续写";
  if (skillId === "book_fusion") return "融梗任务";
  if (skillId === "nuwa_style_distill") return "蒸馏任务";
  if (skillId === "style_genre_generate") return "风格题材库";
  return "任务";
}

function assistantConversations(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations.filter((conversation) => conversation.conversation_type === "assistant");
}

function taskConversationSpecForWorkflow(skillId: string, payload: Partial<SkillRunRequest>, sourcePath: string) {
  if (skillId === "disassemble_book" || skillId === "continue_disassemble") {
    const bookTitle = String((payload as any).book_title || "未命名作品").trim();
    return {
      type: "disassembly" as const,
      title: `拆书 · 《${bookTitle}》`,
      entry: skillId,
      sourceBookId: String((payload as any).source_book_id || "").trim()
    };
  }
  if (skillId === "body_generate" || skillId === "batch_generate") {
    const filename = sourcePath.split("/").filter(Boolean).pop() || "当前章节";
    return { type: "continuation" as const, title: `正文续写 · ${filename}`, entry: skillId, sourceBookId: "" };
  }
  if (skillId === "book_fusion") {
    return { type: "fusion" as const, title: "融梗 · 参考作品", entry: skillId, sourceBookId: "" };
  }
  if (skillId === "style_extract" && /(?:^|[\\/])拆书库(?:[\\/]|$)/.test(sourcePath)) {
    return { type: "disassembly" as const, title: "拆书 · 方法提取", entry: skillId, sourceBookId: "" };
  }
  return null;
}

export type OpenDocumentTab = {
  path: string;
  title: string;
  content: string;
  updatedAt: string;
  updatedAtMs?: number;
  chars: number;
  dirty: boolean;
  saving: boolean;
  stale: boolean;
};

export type DisassemblyBookSummary = {
  schema_version: number;
  template_version: string;
  id: string;
  title: string;
  dir: string;
  created_at: string;
  updated_at: string;
  origin: string;
  source_path: string;
  source_summary: string;
  source_hash: string;
  conversation_id: string;
  chars: number;
  status: "imported" | "analyzing" | "ready" | "failed" | "cancelled" | "stale";
  analysis_version: number;
  error: string;
  analyzed_at: string;
  source: { path: string; hash: string; chars: number; chapter_count: number; import_complete: boolean };
  progress: { stage: string; completed_chapters: number; total_chapters: number; last_error: string; completed_batches?: number; total_batches?: number; message?: string };
  coverage: { first_chapter: number; last_chapter: number; analyzed_chapters: number[]; missing_chapters: number[] };
  analysis_scope?: {
    mode: "prefix_chars" | "prefix_chapters";
    requested_chars?: number;
    requested_chapters?: number;
    actual_chars: number;
    actual_chapters?: number;
    source_chars: number;
    source_chapters?: number;
    first_chapter: number;
    last_chapter: number;
    truncated: boolean;
  };
  legacy?: boolean;
  paths: {
    source?: string;
    lore?: string;
    reverse_outline?: string;
    detail_outline?: string;
    report?: string;
    chapter_index?: string;
    evidence_index?: string;
  };
};

export type LongTaskProgress = {
  task_id: string;
  conversation_id: string;
  skill_id: "disassemble_book" | "continue_disassemble" | "batch_generate";
  status: AgentRunState["status"];
  stage: string;
  message: string;
  completed: number;
  total: number;
  current_step_id: string;
  version: number;
  error: string;
  updated_at: string;
};

const longTaskSkillIds = new Set<LongTaskProgress["skill_id"]>([
  "disassemble_book",
  "continue_disassemble",
  "batch_generate"
]);
const terminalLongTaskStatuses = new Set<AgentRunState["status"]>(["completed", "failed", "cancelled"]);

type OpenDocumentOptions = {
  forceReload?: boolean;
  discardDirty?: boolean;
  activate?: boolean;
};

type SkillDraftPreviewInput = {
  kind?: SkillDraftSourceKind;
  instruction?: string;
  targetName?: string;
  targetId?: string;
  url?: string;
  text?: string;
  sourceSkillId?: string;
};

export type PendingReferenceResolution = {
  content: string;
  references: ProjectFileReferenceCandidate[];
  candidates: ProjectFileReferenceCandidate[];
  selectedPaths: string[];
  warnings: string[];
};

export type PendingSkillPatchPreview = {
  skillId: string;
  request: SkillPatchRequest;
  response: SkillPatchResponse;
};

type SendConversationOptions = {
  checkActiveDocument?: boolean;
  skipReferenceResolution?: boolean;
  referencePaths?: string[];
  confirmedReferencePaths?: string[];
  disableAutoReferences?: boolean;
};

export type PendingCloseRequest = {
  path: string;
  title: string;
};

export type PendingReloadRequest = {
  path: string;
  title: string;
};

export type PendingSaveConflictRequest = {
  path: string;
  title: string;
  currentUpdatedAt: string;
};

export type PendingProjectSwitchRequest =
  | {
      mode: "open";
      targetPath: string;
      title: string;
      detail: string;
    }
  | {
      mode: "create";
      parentPath: string;
      projectName: string;
      title: string;
      detail: string;
    };

export type WorkbenchController = ReturnType<typeof useWorkbenchController>;

function makeLocalMessage(role: ConversationMessage["role"], content: string): ConversationMessage {
  return {
    id: `local-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
    role,
    content,
    created_at: new Date().toISOString(),
    metadata: {}
  };
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
}

function referenceCandidatePaths(candidates: ProjectFileReferenceCandidate[]): string[] {
  return uniquePaths(candidates.map((candidate) => candidate.path));
}

function shouldResolveProjectReferences(text: string): boolean {
  return projectReferenceHintPattern.test(text);
}

function skillSavedPaths(result: SkillRunResponse | null): string[] {
  if (!result) {
    return [];
  }

  const rawSavedPaths = result.data?.saved_paths;
  const fromData = Array.isArray(rawSavedPaths)
    ? rawSavedPaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  return uniquePaths([...fromData, result.saved_path || ""]);
}

function readStyleDistillationProfileFromResult(result: SkillRunResponse | null): StyleDistillationProfile | null {
  const profile = result?.data?.profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return null;
  }
  const raw = profile as Partial<StyleDistillationProfile>;
  const bookTitle = String(raw.book_title || "").trim();
  const profileText = String(raw.profile_text || "").trim();
  if (!bookTitle || !profileText) {
    return null;
  }
  return {
    book_title: bookTitle,
    source_summary: String(raw.source_summary || ""),
    source_path: String(raw.source_path || ""),
    source_hash: String(raw.source_hash || ""),
    source_book_id: String(raw.source_book_id || ""),
    source_report_path: String(raw.source_report_path || ""),
    evidence_spans: Array.isArray(raw.evidence_spans) ? raw.evidence_spans as StyleDistillationProfile["evidence_spans"] : [],
    evidence_version: Number(raw.evidence_version || 1),
    status: raw.status === "stale" || raw.status === "orphaned" ? raw.status : "active",
    distilled_at: String(raw.distilled_at || ""),
    enabled: Boolean(raw.enabled),
    profile_text: profileText
  };
}

function readDisassemblyBookFromUnknown(value: unknown): DisassemblyBookSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<DisassemblyBookSummary>;
  const id = String(raw.id || "").trim();
  const title = String(raw.title || "").trim();
  if (!id || !title) {
    return null;
  }
  const paths = raw.paths && typeof raw.paths === "object" && !Array.isArray(raw.paths) ? raw.paths : {};
  const source = raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source as DisassemblyBookSummary["source"] : { path: String(raw.source_path || ""), hash: String(raw.source_hash || ""), chars: Number(raw.chars || 0), chapter_count: 0, import_complete: Boolean(paths.source) };
  return {
    schema_version: Number(raw.schema_version || 1),
    template_version: String(raw.template_version || "1"),
    id,
    title,
    dir: String(raw.dir || ""),
    created_at: String(raw.created_at || ""),
    updated_at: String(raw.updated_at || raw.created_at || ""),
    origin: String(raw.origin || ""),
    source_path: String(raw.source_path || ""),
    source_summary: String(raw.source_summary || ""),
    source_hash: String(raw.source_hash || ""),
    conversation_id: String(raw.conversation_id || ""),
    chars: Number(raw.chars || 0),
    status: ["imported", "analyzing", "ready", "failed", "cancelled", "stale"].includes(String(raw.status || ""))
      ? raw.status as DisassemblyBookSummary["status"]
      : "imported",
    analysis_version: Number(raw.analysis_version || 1),
    error: String(raw.error || ""),
    analyzed_at: String(raw.analyzed_at || ""),
    source,
    progress: raw.progress && typeof raw.progress === "object" && !Array.isArray(raw.progress) ? raw.progress as DisassemblyBookSummary["progress"] : { stage: String(raw.status || "imported"), completed_chapters: 0, total_chapters: 0, last_error: String(raw.error || "") },
    coverage: raw.coverage && typeof raw.coverage === "object" && !Array.isArray(raw.coverage) ? raw.coverage as DisassemblyBookSummary["coverage"] : { first_chapter: 0, last_chapter: 0, analyzed_chapters: [], missing_chapters: [] },
    analysis_scope: raw.analysis_scope && typeof raw.analysis_scope === "object" && !Array.isArray(raw.analysis_scope)
      ? raw.analysis_scope as DisassemblyBookSummary["analysis_scope"]
      : undefined,
    legacy: Boolean(raw.legacy),
    paths: {
      source: String(paths.source || ""),
      lore: String(paths.lore || ""),
      reverse_outline: String(paths.reverse_outline || ""),
      detail_outline: String(paths.detail_outline || ""),
      report: String(paths.report || ""),
      chapter_index: String(paths.chapter_index || ""),
      evidence_index: String(paths.evidence_index || "")
    }
  };
}

function readDisassemblyBooksFromUnknown(value: unknown): DisassemblyBookSummary[] {
  return Array.isArray(value)
    ? value.map(readDisassemblyBookFromUnknown).filter((item): item is DisassemblyBookSummary => Boolean(item))
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function executionTraceFromRunEvents(events: Array<{ event_type?: string; payload?: unknown }>): Array<{ stage: string; message: string }> {
  const trace: Array<{ stage: string; message: string }> = [];
  const seen = new Set<string>();
  for (const event of events) {
    const payload = recordValue(event.payload);
    if (event.event_type !== "workflow.progress") continue;
    const message = String(payload.message || "").trim();
    if (!message) continue;
    const step = { stage: String(payload.stage || "working"), message };
    const key = `${step.stage}:${step.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      trace.push(step);
    }
  }
  return trace.slice(-80);
}

function workflowSkillIdFromRun(run: AgentRunState): LongTaskProgress["skill_id"] | "" {
  const requestSnapshot = recordValue(recordValue(run.goal).request_snapshot);
  const settings = recordValue(requestSnapshot.settings_snapshot);
  const request = recordValue(settings.agent_request);
  const skillId = String(request.skill_id || "").trim();
  return longTaskSkillIds.has(skillId as LongTaskProgress["skill_id"])
    ? skillId as LongTaskProgress["skill_id"]
    : "";
}

function longTaskProgressFromRun(run: AgentRunState, events: Array<{ event_type?: string; payload?: unknown }>): LongTaskProgress | null {
  const skillId = workflowSkillIdFromRun(run);
  if (!skillId) {
    return null;
  }
  const progressEvent = [...events].reverse().find((event) => event.event_type === "workflow.progress");
  const payload = recordValue(progressEvent?.payload);
  const error = String(run.error || "").trim();
  const statusMessage = run.status === "completed"
    ? "任务已完成"
    : run.status === "paused"
      ? "任务已暂停，可继续执行"
      : run.status === "cancelled"
        ? "任务已取消"
        : error || "正在准备任务…";
  return {
    task_id: run.run_id,
    conversation_id: run.conversation_id || "",
    skill_id: skillId,
    status: run.status,
    stage: String(payload.stage || run.status || "queued"),
    message: String(payload.message || statusMessage),
    completed: Math.max(0, Number(payload.completed || 0)),
    total: Math.max(0, Number(payload.total || 0)),
    current_step_id: run.current_step_id || "",
    version: run.version,
    error,
    updated_at: run.updated_at
  };
}

function stringListFromUnknown(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function configSignature(config: AppConfig): string {
  return JSON.stringify(normalizeConfigDraft(config));
}

function makeEmptyProjectChrome(currentProject: CurrentProject): ProjectChromeSnapshot {
  return {
    tree: [],
    libraries: [],
    timeline: [],
    current: currentProject,
    version: 0,
    generated_at: new Date().toISOString()
  };
}

function makeEmptyProjectManifestStatus(): ProjectManifestStatus {
  return {
    ready: false,
    files: 0,
    version: 0,
    generated_at: "",
    source: "empty",
    path: ""
  };
}

function makeEmptyVectorIndexStatus(): VectorIndexStatus {
  return {
    enabled: false,
    configured: false,
    db: "",
    chunks: 0,
    embedded_chunks: 0,
    current_embedded_chunks: 0,
    pending_files: 0,
    embedding_model: "",
    ready: false,
    updated_at: ""
  };
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

function isSaveConflictError(error: unknown): error is Error & { status: number; payload?: unknown } {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status?: unknown }).status === 409
  );
}

function conflictCurrentUpdatedAt(error: { payload?: unknown }): string {
  const payload = error.payload;
  if (payload && typeof payload === "object" && "current_updated_at" in payload) {
    return String((payload as { current_updated_at?: unknown }).current_updated_at ?? "");
  }
  return "";
}

function timelineChangedPaths(entry: TimelineEntry | null | undefined): string[] {
  return uniquePaths((entry?.files ?? []).map((file) => file.path));
}

function generatedDraftPath(pendingSave: Pick<PendingGeneratedSave, "skillId" | "source">): string {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/[T:]/g, "-");
  const safeSkillId = (pendingSave.skillId || pendingSave.source || "generated")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "generated";
  return `00_设定集/AI生成草稿/${stamp}-${safeSkillId}.md`;
}

export function useWorkbenchController(runtime: WorkbenchRuntime) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("editor");
  const [refreshTick, setRefreshTick] = useState(0);
  const [projectDataRevision, setProjectDataRevision] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState("");
  const [recentProjectRemovingPath, setRecentProjectRemovingPath] = useState("");
  const [vectorSearchBusy, setVectorSearchBusy] = useState(false);
  const [vectorSearchMessage, setVectorSearchMessage] = useState("");
  const [vectorSearchResults, setVectorSearchResults] = useState<VectorSearchHit[]>([]);
  const [projectPathInput, setProjectPathInput] = useState("");
  const [projectNameInput, setProjectNameInput] = useState("");
  const [configDraft, setConfigDraft] = useState<AppConfig | null>(null);
  const [configMessage, setConfigMessage] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [embeddingTestBusy, setEmbeddingTestBusy] = useState(false);
  const [embeddingTestMessage, setEmbeddingTestMessage] = useState("");
  const [websiteAiDashboard, setWebsiteAiDashboard] = useState<WebsiteAiDashboard | null>(null);
  const [websiteAiBusy, setWebsiteAiBusy] = useState(false);
  const [websiteAiMessage, setWebsiteAiMessage] = useState("");
  const [websiteAiRedeemBusy, setWebsiteAiRedeemBusy] = useState(false);
  const [websiteAiRedeemMessage, setWebsiteAiRedeemMessage] = useState("");
  const [websiteAiRechargeBusy, setWebsiteAiRechargeBusy] = useState(false);
  const [websiteAiRechargeMessage, setWebsiteAiRechargeMessage] = useState("");
  const [websiteAiRechargeOrder, setWebsiteAiRechargeOrder] = useState<WebsiteAiRechargeOrder | null>(null);
  const [manualModelCatalog, setManualModelCatalog] = useState<AiModelOption[]>([]);
  const [manualModelDiscoveryBusy, setManualModelDiscoveryBusy] = useState(false);
  const [manualModelDiscoveryMessage, setManualModelDiscoveryMessage] = useState("");
  const [cloudProjectSlots, setCloudProjectSlots] = useState<CloudProjectSlot[]>([]);
  const [cloudProjectSummary, setCloudProjectSummary] = useState<CloudProjectListResponse | null>(null);
  const [cloudProjectBusy, setCloudProjectBusy] = useState(false);
  const [cloudProjectActivePath, setCloudProjectActivePath] = useState("");
  const [cloudProjectMessage, setCloudProjectMessage] = useState("");
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationMessage, setConversationMessage] = useState("");
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  // A renderer can display one conversation while other conversations keep
  // running in the durable runtime.  Never let their busy state leak into the
  // visible composer or its stop button.
  const [sendingConversationIds, setSendingConversationIds] = useState<string[]>([]);
  const sendingMessage = Boolean(conversationDetail?.id && sendingConversationIds.includes(conversationDetail.id));
  const [conversationModelPreferences, setConversationModelPreferences] = useState<ConversationModelPreferences>({
    model_override: "",
    reasoning_enabled: false,
    reasoning_effort: "medium"
  });
  const [conversationModelPreferenceBusy, setConversationModelPreferenceBusy] = useState(false);
  const [pendingReferenceResolution, setPendingReferenceResolution] = useState<PendingReferenceResolution | null>(null);
  const [openDocuments, setOpenDocuments] = useState<OpenDocumentTab[]>([]);
  const [activeDocumentPath, setActiveDocumentPath] = useState("");
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentMessage, setDocumentMessage] = useState("");
  const [pendingCloseRequest, setPendingCloseRequest] = useState<PendingCloseRequest | null>(null);
  const [pendingReloadRequest, setPendingReloadRequest] = useState<PendingReloadRequest | null>(null);
  const [pendingSaveConflictRequest, setPendingSaveConflictRequest] = useState<PendingSaveConflictRequest | null>(null);
  const [pendingProjectSwitchRequest, setPendingProjectSwitchRequest] = useState<PendingProjectSwitchRequest | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<SkillDefinition | null>(null);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedJobDetail, setSelectedJobDetail] = useState<JobInfo | null>(null);
  const [operationsBusy, setOperationsBusy] = useState(false);
  const [operationsMessage, setOperationsMessage] = useState("");
  const [latestSkillResult, setLatestSkillResult] = useState<SkillRunResponse | null>(null);
  const [pendingSkillDraft, setPendingSkillDraft] = useState<SkillDraftResponse | null>(null);
  const [pendingSkillPatchPreview, setPendingSkillPatchPreview] = useState<PendingSkillPatchPreview | null>(null);
  const [selectedSkillVersions, setSelectedSkillVersions] = useState<SkillVersionEntry[]>([]);
  const [latestCardDrawResult, setLatestCardDrawResult] = useState<CardDrawResult | null>(null);
  const [pendingGeneratedSaves, setPendingGeneratedSaves] = useState<PendingGeneratedSave[]>([]);
  const [pendingLibraryDraftGroups, setPendingLibraryDraftGroups] = useState<PendingLibraryDraftGroup[]>([]);
  const pendingGeneratedSave = pendingGeneratedSaves.at(-1) || null;
  const pendingReviews: PendingReviewItem[] = [
    ...pendingGeneratedSaves.map((pending) => ({ kind: "generated_file" as const, id: pending.cacheId, pending })),
    ...pendingLibraryDraftGroups.map((pending) => ({ kind: "library_group" as const, id: pending.groupId, pending }))
  ].sort((left, right) => String(right.pending.createdAt || "").localeCompare(String(left.pending.createdAt || "")));
  const [pendingAgentConfirmations, setPendingAgentConfirmations] = useState<AgentConfirmation[]>([]);
  const [pendingAgentConfirmationBusy, setPendingAgentConfirmationBusy] = useState("");
  const [agentConfirmationExecution, setAgentConfirmationExecution] = useState<Record<string, AgentConfirmationExecutionState>>({});
  const [styleDistillationProfile, setStyleDistillationProfile] = useState<StyleDistillationProfile | null>(null);
  const [disassemblyBooks, setDisassemblyBooks] = useState<DisassemblyBookSummary[]>([]);
  const [disassemblyLibraryBusy, setDisassemblyLibraryBusy] = useState(false);
  const [longTasks, setLongTasks] = useState<LongTaskProgress[]>([]);
  const assistantAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const taskAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const longTaskSubscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const activeConversationRunIdsRef = useRef<Map<string, string>>(new Map());
  const activeConversationIdRef = useRef("");
  const liveJobIdsRef = useRef<Set<string>>(new Set());
  const selectedJobIdRef = useRef("");
  const lastSyncedProjectRef = useRef<CurrentProject>({ path: "", name: "" });
  const openDocumentsRef = useRef<OpenDocumentTab[]>([]);
  const activeDocumentPathRef = useRef("");
  const activeDocumentOpenRequestRef = useRef(0);
  const restoredSettingsRef = useRef(false);
  const skipNextSettingsPersistRef = useRef(false);
  const lastConfigSignatureRef = useRef("");
  const configDraftDirtyRef = useRef(false);
  const websiteAiRefreshKeyRef = useRef("");
  const manualModelRefreshKeyRef = useRef("");
  const conversationModelPreferencesRef = useRef<ConversationModelPreferences>({
    model_override: "",
    reasoning_enabled: false,
    reasoning_effort: "medium"
  });
  const client = useMemo(() => createApiClient({ baseUrl: runtime.apiBase, fetchFn: runtime.fetchFn }), [runtime.apiBase, runtime.fetchFn]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setIsRefreshing(true);
      if (!refreshTick) {
        setStatus("loading");
        setError("");
      }
      try {
        const nextSnapshot = await loadDashboardSnapshot(runtime);
        if (cancelled) {
          return;
        }
        startTransition(() => {
          setSnapshot(nextSnapshot);
          const normalizedConfig = normalizeConfigDraft(nextSnapshot.config);
          setConfigDraft(normalizedConfig);
          lastConfigSignatureRef.current = configSignature(normalizedConfig);
          configDraftDirtyRef.current = false;
          setStatus("ready");
          setError("");
        });
      } catch (nextError) {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(nextError instanceof Error ? nextError.message : "加载 ArcWriter 失败");
      } finally {
        if (!cancelled) {
          setIsRefreshing(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [refreshTick, runtime]);

  useEffect(() => {
    selectedJobIdRef.current = selectedJobId;
  }, [selectedJobId]);

  useEffect(() => {
    conversationModelPreferencesRef.current = conversationModelPreferences;
  }, [conversationModelPreferences]);

  useEffect(() => {
    activeConversationIdRef.current = conversationDetail?.id || "";
  }, [conversationDetail?.id]);

  useEffect(() => {
    if (pendingReferenceResolution && messageInput.trim() !== pendingReferenceResolution.content) {
      setPendingReferenceResolution(null);
    }
  }, [messageInput, pendingReferenceResolution]);

  useEffect(() => () => {
    for (const controller of assistantAbortControllersRef.current.values()) controller.abort();
    assistantAbortControllersRef.current.clear();
    for (const controller of taskAbortControllersRef.current.values()) controller.abort();
    taskAbortControllersRef.current.clear();
    for (const unsubscribe of longTaskSubscriptionsRef.current.values()) unsubscribe();
    longTaskSubscriptionsRef.current.clear();
  }, []);

  useEffect(() => {
    for (const unsubscribe of longTaskSubscriptionsRef.current.values()) unsubscribe();
    longTaskSubscriptionsRef.current.clear();
    if (!snapshot?.currentProject.path) {
      setLongTasks([]);
      return;
    }
    void refreshLongTasks().catch(() => setLongTasks([]));
  }, [client, snapshot?.currentProject.path]);

  useEffect(() => {
    const projectPath = snapshot?.currentProject.path || "";
    if (!projectPath) {
      setPendingGeneratedSaves([]);
      setPendingLibraryDraftGroups([]);
      return;
    }
    let cancelled = false;
    const cacheRows = (snapshot?.localState?.generated_caches || []).filter((cache) => cache.project_path === projectPath && cache.status === "pending");
    void Promise.all(cacheRows.map(async (cache) => {
      try {
        const detail = await client.getGeneratedCache(cache.cache_id);
        if (detail.meta.status !== "pending") return null;
        const targetPaths = detail.meta.target_paths.length ? detail.meta.target_paths : cache.target_paths;
        const targetPath = targetPaths[0] || cache.target_path;
        if (!targetPath) return null;
        return {
          skillId: detail.meta.skill_id || cache.skill_id,
          content: detail.content,
          cacheId: detail.meta.cache_id,
          cachePath: detail.meta.cache_path || cache.cache_path || "",
          cacheChars: detail.meta.chars || cache.cache_chars || detail.content.length,
          targetPath,
          targetPaths: targetPaths.length ? targetPaths : [targetPath],
          chapter: 0,
          defaultMode: detail.meta.mode || cache.mode || "replace",
          source: cache.source,
          savePlan: detail.meta.save_plan,
          conversationId: cache.conversation_id || detail.meta.conversation_id || undefined,
          messageId: cache.message_id,
          runId: cache.run_id || detail.meta.commit_run_id || undefined,
          createdAt: cache.created_at
        } satisfies PendingGeneratedSave;
      } catch {
        return null;
      }
    })).then((items) => {
      if (cancelled) return;
      setPendingGeneratedSaves((current) => {
        const next = new Map(current.map((item) => [item.cacheId, item]));
        for (const item of items) if (item) next.set(item.cacheId, item);
        return [...next.values()].sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
      });
    });
    void refreshPendingLibraryDraftGroups();
    return () => {
      cancelled = true;
    };
  }, [client, snapshot?.currentProject.path, snapshot?.localState?.synced_at]);

  useEffect(() => {
    if (status !== "ready") {
      return;
    }

    let cancelled = false;
    async function syncExternalConfig() {
      if (configBusy || configDraftDirtyRef.current) {
        return;
      }
      try {
        const remoteConfig = normalizeConfigDraft(await client.getConfig());
        if (cancelled) {
          return;
        }
        const nextSignature = configSignature(remoteConfig);
        if (!lastConfigSignatureRef.current) {
          lastConfigSignatureRef.current = nextSignature;
          return;
        }
        if (nextSignature === lastConfigSignatureRef.current) {
          return;
        }
        lastConfigSignatureRef.current = nextSignature;
        setConfigDraft(remoteConfig);
        setSnapshot((current) => (current ? { ...current, config: remoteConfig } : current));
        setConfigMessage("已同步网站桥接写入的 API 配置");
      } catch {
        // 外部桥接同步失败不打断主工作台，下一轮继续尝试。
      }
    }

    const timer = window.setInterval(() => {
      void syncExternalConfig();
    }, 1800);
    void syncExternalConfig();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, configBusy, status]);

  useEffect(() => {
    const websiteProfile = configDraft?.website_profile;
    const websiteToken = `${websiteProfile?.license_account_key || websiteProfile?.api_key || ""}`.trim();
    if (status !== "ready" || configDraft?.ai_config_mode !== "website" || !websiteToken) {
      return;
    }
    const refreshKey = `${websiteToken}:${websiteProfile?.model || ""}:${websiteProfile?.embedding_model || ""}`;
    if (websiteAiRefreshKeyRef.current === refreshKey) {
      return;
    }
    websiteAiRefreshKeyRef.current = refreshKey;
    void refreshWebsiteAiDashboard({ silent: true });
  }, [
    configDraft?.ai_config_mode,
    configDraft?.website_profile?.api_key,
    configDraft?.website_profile?.embedding_model,
    configDraft?.website_profile?.license_account_key,
    configDraft?.website_profile?.model,
    status
  ]);

  useEffect(() => {
    const manualProfile = configDraft?.manual_profile;
    const baseUrl = String(manualProfile?.base_url || "").trim();
    if (status !== "ready" || configDraft?.ai_config_mode !== "manual" || !baseUrl) {
      return;
    }
    const refreshKey = `${baseUrl}:${manualProfile?.api_key || ""}`;
    if (manualModelRefreshKeyRef.current === refreshKey) {
      return;
    }
    manualModelRefreshKeyRef.current = refreshKey;
    void refreshManualModelCatalog(manualProfile, { silent: true });
  }, [
    configDraft?.ai_config_mode,
    configDraft?.manual_profile?.api_key,
    configDraft?.manual_profile?.base_url,
    status
  ]);

  useEffect(() => {
    if (!websiteAiRechargeOrder?.order_id || websiteAiRechargeOrder.status !== "pending") {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      if (!cancelled) {
        void refreshWebsiteAiRechargeOrder(websiteAiRechargeOrder.order_id, { silent: true });
      }
    }, 3000);

    void refreshWebsiteAiRechargeOrder(websiteAiRechargeOrder.order_id, { silent: true });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [websiteAiRechargeOrder?.order_id, websiteAiRechargeOrder?.status]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (!restoredSettingsRef.current && runtime.isDesktopShell && snapshot.localState?.settings) {
      restoredSettingsRef.current = true;
      skipNextSettingsPersistRef.current = true;
      const settings = snapshot.localState.settings;
      if (workbenchTabs.has(settings.active_tab)) {
        setActiveTab(settings.active_tab);
      }
      if (!snapshot.currentProject.path && settings.project_path_input) {
        setProjectPathInput(settings.project_path_input);
      }
      if (!snapshot.currentProject.name && settings.project_name_input) {
        setProjectNameInput(settings.project_name_input);
      }
    }

    const lastSynced = lastSyncedProjectRef.current;
    if (snapshot.currentProject.path !== lastSynced.path || snapshot.currentProject.name !== lastSynced.name) {
      setProjectPathInput(snapshot.currentProject.path);
      setProjectNameInput(snapshot.currentProject.name);
      lastSyncedProjectRef.current = snapshot.currentProject;
    }
  }, [snapshot]);

  useEffect(() => {
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.localState || !restoredSettingsRef.current) {
      return;
    }
    if (skipNextSettingsPersistRef.current) {
      skipNextSettingsPersistRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      void window.xiaoshuoDesktop?.localState
        .patchSettings({
          active_tab: activeTab,
          project_path_input: projectPathInput,
          project_name_input: projectNameInput
        })
        .then((localState) => {
          setSnapshot((current) => (current ? { ...current, localState } : current));
        })
        .catch(() => {
          // Preferences are a convenience cache; runtime flows keep working if persistence is unavailable.
        });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [activeTab, projectNameInput, projectPathInput, runtime.isDesktopShell]);

  useEffect(() => {
    openDocumentsRef.current = openDocuments;
  }, [openDocuments]);

  useEffect(() => {
    activeDocumentPathRef.current = activeDocumentPath;
  }, [activeDocumentPath]);

  useEffect(() => {
    if (!snapshot?.conversations.length || conversationDetail) {
      return;
    }

    const firstConversation = snapshot.conversations[0];
    if (!firstConversation) {
      return;
    }

    void loadConversation(firstConversation.id, { activateTab: false });
  }, [conversationDetail, snapshot]);

  useEffect(() => {
    if (!snapshot?.conversations.length || !conversationDetail) {
      return;
    }
    if (snapshot.conversations.some((item) => item.id === conversationDetail.id)) {
      return;
    }

    setConversationDetail(null);
  }, [conversationDetail, snapshot]);

  useEffect(() => {
    if (!conversationDetail) {
      return;
    }
    setConversationModelPreferences({
      model_override: conversationDetail.model_override || "",
      reasoning_enabled: Boolean(conversationDetail.reasoning_enabled),
      reasoning_effort: conversationDetail.reasoning_effort || "medium"
    });
  }, [conversationDetail?.id, conversationDetail?.model_override, conversationDetail?.reasoning_enabled, conversationDetail?.reasoning_effort]);

  useEffect(() => {
    if (!snapshot?.skills.length || selectedSkillId) {
      return;
    }
    const firstSkill = snapshot.skills[0];
    if (!firstSkill) {
      return;
    }
    void selectSkill(firstSkill.id, { activateTab: false });
  }, [selectedSkillId, snapshot]);

  useEffect(() => {
    if (!snapshot?.jobs.length || selectedJobId) {
      return;
    }
    const firstJob = snapshot.jobs[0];
    if (!firstJob) {
      return;
    }
    void selectJob(firstJob.id, { activateTab: false });
  }, [selectedJobId, snapshot]);

  useEffect(() => {
    if (!snapshot?.jobs.length || !selectedJobId) {
      if (!snapshot?.jobs.length) {
        setSelectedJobDetail(null);
        setSelectedJobId("");
      }
      return;
    }

    const matchingJob = snapshot.jobs.find((item) => item.id === selectedJobId);
    if (!matchingJob) {
      setSelectedJobDetail(null);
      setSelectedJobId("");
      return;
    }

    setSelectedJobDetail(matchingJob);
  }, [selectedJobId, snapshot]);

  useEffect(() => {
    let cancelled = false;
    const projectPath = snapshot?.currentProject.path || "";
    if (!projectPath) {
      setStyleDistillationProfile(null);
      return;
    }

    void client
      .runSkill("nuwa_style_distill", {
        text: "",
        instruction: "",
        target_path: "",
        conversation_id: "",
        source_path: "",
        write_result: false,
        attachment_ids: [],
        action: "status"
      })
      .then((result) => {
        if (!cancelled) {
          setStyleDistillationProfile(readStyleDistillationProfileFromResult(result));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStyleDistillationProfile(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, snapshot?.currentProject.path, refreshTick]);

  async function recordDesktopProject(project: CurrentProject): Promise<void> {
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.localState || !project.path) {
      return;
    }

    try {
      const localState = await window.xiaoshuoDesktop.localState.recordProject({
        path: project.path,
        name: project.name || project.path,
        opened_at: new Date().toISOString(),
        previous_path: project.previous_path || undefined
      });
      setSnapshot((current) => (current ? { ...current, localState } : current));
    } catch (nextError) {
      setProjectMessage((current) => {
        const detail = nextError instanceof Error ? nextError.message : "本地状态写入失败";
        return current ? `${current}；最近项目记录失败：${detail}` : `最近项目记录失败：${detail}`;
      });
    }
  }

  async function syncDesktopProjectSnapshot(project: CurrentProject, conversations: ConversationSummary[], jobs: JobInfo[]): Promise<void> {
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.localState || !project.path) {
      return;
    }

    try {
      const localState = await window.xiaoshuoDesktop.localState.syncProject({
        project: {
          path: project.path,
          name: project.name || project.path,
          opened_at: new Date().toISOString()
        },
        conversations,
        jobs
      });
      setSnapshot((current) => (current ? { ...current, localState } : current));
    } catch (nextError) {
      setProjectMessage((current) => {
        const detail = nextError instanceof Error ? nextError.message : "本地快照同步失败";
        return current ? `${current}；本地快照同步失败：${detail}` : `本地快照同步失败：${detail}`;
      });
    }
  }

  async function trackDesktopGeneratedCache(pendingSave: PendingGeneratedSave, status: "pending" | "saved" | "discarded", mode?: "replace" | "append"): Promise<void> {
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.localState || !pendingSave.cacheId) {
      return;
    }

    try {
      const localState = await window.xiaoshuoDesktop.localState.trackGeneratedCache({
        cache_id: pendingSave.cacheId,
        project_path: snapshot?.currentProject.path || "",
        skill_id: pendingSave.skillId,
        source: pendingSave.source,
        target_path: pendingSave.targetPath,
        target_paths: pendingSave.targetPaths,
        status,
        mode,
        cache_path: pendingSave.cachePath,
        cache_chars: pendingSave.cacheChars || pendingSave.content.length,
        conversation_id: pendingSave.conversationId,
        message_id: pendingSave.messageId,
        run_id: pendingSave.runId
      });
      setSnapshot((current) => (current ? { ...current, localState } : current));
    } catch {
      // This is metadata only; generated save/discard must not depend on the local cache index.
    }
  }

  function upsertPendingGeneratedSave(pendingSave: PendingGeneratedSave): void {
    const identity = pendingSave.cacheId || `${pendingSave.targetPath}:${pendingSave.createdAt || ""}`;
    setPendingGeneratedSaves((current) => {
      const next = [...current.filter((item) => (item.cacheId || `${item.targetPath}:${item.createdAt || ""}`) !== identity), pendingSave];
      return next.sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
    });
  }

  function removePendingGeneratedSave(cacheId: string): void {
    setPendingGeneratedSaves((current) => current.filter((item) => item.cacheId !== cacheId));
  }

  function setPendingGeneratedSaveError(cacheId: string, error: string): void {
    setPendingGeneratedSaves((current) => current.map((item) => item.cacheId === cacheId ? { ...item, error } : item));
  }

  function pendingSaveByCacheId(cacheId = ""): PendingGeneratedSave | null {
    if (!cacheId) return pendingGeneratedSave;
    return pendingGeneratedSaves.find((item) => item.cacheId === cacheId) || null;
  }

  function pendingLibraryDraftGroupFromUnknown(value: unknown): PendingLibraryDraftGroup | null {
    const raw = recordValue(value);
    const groupId = String(raw.group_id || raw.groupId || "").trim();
    if (!groupId) return null;
    const domains = stringListFromUnknown(raw.domains).filter((domain): domain is PendingLibraryDraftGroup["domains"][number] => domain === "lore" || domain === "style" || domain === "genre");
    return {
      groupId,
      mode: raw.commit_mode === "merge" || raw.mode === "merge" ? "merge" : "replace",
      domains,
      draftIds: stringListFromUnknown(raw.draft_ids || raw.draftIds),
      source: String(raw.source || ""),
      conversationId: String(raw.conversation_id || raw.conversationId || "") || undefined,
      messageId: String(raw.message_id || raw.messageId || "") || undefined,
      runId: String(raw.run_id || raw.runId || "") || undefined,
      createdAt: String(raw.created_at || raw.createdAt || "") || undefined,
      error: String(raw.error || "") || undefined
    };
  }

  async function libraryDraftGroupRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
    const fetchFn = runtime.fetchFn || fetch;
    const response = await fetchFn(new URL(pathname, runtime.apiBase).toString(), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(String(payload.detail || response.statusText || "待确认资料草稿请求失败"));
    return payload as T;
  }

  async function refreshPendingLibraryDraftGroups(): Promise<void> {
    if (!snapshot?.currentProject.path) {
      setPendingLibraryDraftGroups([]);
      return;
    }
    try {
      const payload = await libraryDraftGroupRequest<{ groups?: unknown[] }>("/api/project-library-draft-groups");
      setPendingLibraryDraftGroups((payload.groups || []).flatMap((item) => {
        const group = pendingLibraryDraftGroupFromUnknown(item);
        return group ? [group] : [];
      }));
    } catch {
      // The old runtime does not expose draft groups. Existing single-library reviews remain available in their pages.
    }
  }

  async function setLibraryDraftGroupOrigin(groupId: string, origin: Pick<PendingLibraryDraftGroup, "conversationId" | "messageId" | "runId">): Promise<void> {
    if (!groupId) return;
    await libraryDraftGroupRequest(`/api/project-library-draft-groups/${encodeURIComponent(groupId)}/origin`, {
      method: "PUT",
      body: JSON.stringify({ conversation_id: origin.conversationId || "", message_id: origin.messageId || "", run_id: origin.runId || "" })
    });
  }

  function setPendingLibraryDraftGroupError(groupId: string, error: string): void {
    setPendingLibraryDraftGroups((current) => current.map((group) => group.groupId === groupId ? { ...group, error } : group));
  }

  async function commitPendingLibraryDraftGroup(groupId: string): Promise<void> {
    const group = pendingLibraryDraftGroups.find((item) => item.groupId === groupId);
    if (!group) return;
    setOperationsBusy(true);
    try {
      const result = await libraryDraftGroupRequest<{ bundles?: Array<{ projection_paths?: string[] }> }>(`/api/project-library-draft-groups/${encodeURIComponent(groupId)}/commit`, { method: "POST" });
      setPendingLibraryDraftGroups((current) => current.filter((item) => item.groupId !== groupId));
      const paths = (result.bundles || []).flatMap((bundle) => bundle.projection_paths || []);
      await syncChangedPaths(paths, { openFirst: false });
      await refreshProjectWorkspace();
      const message = `已${group.mode === "replace" ? "替换" : "合并"}${group.domains.length > 1 ? "风格与题材库" : "资料库"}，项目上下文已刷新。`;
      setOperationsMessage(message);
      setConversationMessage(message);
    } catch (error) {
      const message = describeActionableError(error, "确认资料草稿失败", "草稿仍保留，可以刷新预览后重试。");
      setPendingLibraryDraftGroupError(groupId, message);
      setConversationMessage(message);
    } finally {
      setOperationsBusy(false);
    }
  }

  async function discardPendingLibraryDraftGroup(groupId: string): Promise<void> {
    const group = pendingLibraryDraftGroups.find((item) => item.groupId === groupId);
    if (!group) return;
    setOperationsBusy(true);
    try {
      await libraryDraftGroupRequest(`/api/project-library-draft-groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
      setPendingLibraryDraftGroups((current) => current.filter((item) => item.groupId !== groupId));
      const message = "已丢弃资料草稿，项目文件未发生变化。";
      setOperationsMessage(message);
      setConversationMessage(message);
    } catch (error) {
      const message = describeActionableError(error, "丢弃资料草稿失败", "草稿仍保留，可稍后重试。");
      setPendingLibraryDraftGroupError(groupId, message);
      setConversationMessage(message);
    } finally {
      setOperationsBusy(false);
    }
  }

  function replaceProjectSnapshot(currentProject: CurrentProject, projectChrome: ProjectChromeSnapshot, options?: { clearJobs?: boolean; clearConversations?: boolean }) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        currentProject,
        projectChrome,
        timeline: projectChrome.timeline,
        conversations: options?.clearConversations ? [] : current.conversations,
        jobs: options?.clearJobs ? [] : current.jobs
      };
    });
  }

  function replaceProjectStatus(projectManifest: ProjectManifestStatus, vectorIndex: VectorIndexStatus) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        projectManifest,
        vectorIndex
      };
    });
  }

  function patchConversationSummary(conversationId: string, updater: (summary: ConversationSummary) => ConversationSummary) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        conversations: current.conversations.map((item) => (item.id === conversationId ? updater(item) : item))
      };
    });
  }

  function applyConversationDetail(detail: ConversationDetail) {
    setConversationDetail(detail);
    patchConversationSummary(detail.id, (item) => ({
      ...item,
      title: detail.title,
      updated_at: detail.updated_at,
      current_skill: detail.current_skill,
      current_agent: detail.current_agent,
      message_count: detail.message_count,
      attachment_count: detail.attachment_count,
      model_override: detail.model_override,
      reasoning_effort: detail.reasoning_effort
    }));
  }

  function updateActiveConversationSkill(conversationId: string, skillId: string, agentName = "") {
    setConversationDetail((current) =>
      current?.id === conversationId
        ? {
            ...current,
            current_skill: skillId || current.current_skill,
            current_agent: agentName || current.current_agent
          }
        : current
    );
    patchConversationSummary(conversationId, (item) => ({
      ...item,
      current_skill: skillId || item.current_skill,
      current_agent: agentName || item.current_agent
    }));
  }

  function upsertJobInSnapshot(job: JobInfo) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      const existingIndex = current.jobs.findIndex((item) => item.id === job.id);
      const jobs =
        existingIndex >= 0
          ? current.jobs.map((item) => (item.id === job.id ? job : item))
          : [job, ...current.jobs];

      return { ...current, jobs };
    });
  }

  async function refreshConversationsList() {
    const conversations = await client.getConversations();
    const assistantOnly = assistantConversations(conversations);
    setSnapshot((current) => (current ? { ...current, conversations: assistantOnly } : current));
    return assistantOnly;
  }

  async function refreshJobsList() {
    const jobs = await client.getJobs();
    setSnapshot((current) => (current ? { ...current, jobs } : current));
    return jobs;
  }

  async function refreshSkillCatalog() {
    const skills = await client.getSkills();
    setSnapshot((current) => (current ? { ...current, skills } : current));
    return skills;
  }

  async function loadProjectStatus() {
    const [projectManifestResult, vectorStatusResult] = await Promise.allSettled([
      client.getProjectManifestStatus(),
      client.getVectorStatus()
    ]);

    return {
      projectManifest: settledValue(projectManifestResult, makeEmptyProjectManifestStatus()),
      vectorIndex: settledValue(vectorStatusResult, makeEmptyVectorIndexStatus()),
      manifestError: projectManifestResult.status === "rejected" ? projectManifestResult.reason : null,
      vectorError: vectorStatusResult.status === "rejected" ? vectorStatusResult.reason : null
    };
  }

  async function refreshProjectChrome() {
    const [projectChrome, nextStatus] = await Promise.all([client.getProjectChrome({ force: 1 }), loadProjectStatus()]);
    replaceProjectSnapshot(projectChrome.current, projectChrome);
    replaceProjectStatus(nextStatus.projectManifest, nextStatus.vectorIndex);
    return projectChrome;
  }

  function clearProjectScopedState(nextProject: CurrentProject) {
    for (const controller of assistantAbortControllersRef.current.values()) controller.abort();
    assistantAbortControllersRef.current.clear();
    for (const controller of taskAbortControllersRef.current.values()) controller.abort();
    taskAbortControllersRef.current.clear();
    liveJobIdsRef.current.clear();
    setSendingConversationIds([]);
    setOpenDocuments([]);
    setActiveDocumentPath("");
    setDocumentBusy(false);
    setDocumentMessage("");
    setVectorSearchBusy(false);
    setVectorSearchMessage("");
    setVectorSearchResults([]);
    setEmbeddingTestBusy(false);
    setEmbeddingTestMessage("");
    setPendingCloseRequest(null);
    setPendingReloadRequest(null);
    setPendingSaveConflictRequest(null);
    setPendingProjectSwitchRequest(null);
    setConversationDetail(null);
    setConversationBusy(false);
    setConversationMessage("");
    setMessageInput("");
    setPendingReferenceResolution(null);
    setPendingGeneratedSaves([]);
    setPendingLibraryDraftGroups([]);
    setPendingAgentConfirmations([]);
    setPendingAgentConfirmationBusy("");
    setAgentConfirmationExecution({});
    setLatestSkillResult(null);
    setPendingSkillPatchPreview(null);
    setSelectedSkillVersions([]);
    setStyleDistillationProfile(null);
    setSelectedJobId("");
    setSelectedJobDetail(null);
    setOperationsMessage("");
    replaceProjectStatus(makeEmptyProjectManifestStatus(), makeEmptyVectorIndexStatus());
    replaceProjectSnapshot(nextProject, makeEmptyProjectChrome(nextProject), {
      clearConversations: true,
      clearJobs: true
    });
  }

  async function finalizeProjectSwitch(
    nextProject: CurrentProject,
    successMessage: string,
    options: { landing?: "project" | "assistant" } = {}
  ) {
    clearProjectScopedState(nextProject);
    await recordDesktopProject(nextProject);
    setProjectPathInput(nextProject.path);
    setProjectNameInput(nextProject.name);
    setActiveTab("project");

    const [projectChromeResult, projectStatusResult, conversationsResult, jobsResult] = await Promise.allSettled([
      loadProjectChromeWithRetry(),
      loadProjectStatus(),
      client.getConversations(),
      client.getJobs()
    ]);

    const nextChrome = projectChromeResult.status === "fulfilled" ? projectChromeResult.value : makeEmptyProjectChrome(nextProject);
    const nextProjectStatus =
      projectStatusResult.status === "fulfilled"
        ? projectStatusResult.value
        : {
            projectManifest: makeEmptyProjectManifestStatus(),
            vectorIndex: makeEmptyVectorIndexStatus(),
            manifestError: null,
            vectorError: null
          };
    const nextConversations = conversationsResult.status === "fulfilled" ? assistantConversations(conversationsResult.value) : [];
    const nextJobs = jobsResult.status === "fulfilled" ? jobsResult.value : [];
    const resolvedProject = nextChrome.current.path ? nextChrome.current : nextProject;

    setSnapshot((current) =>
      current
        ? {
            ...current,
            currentProject: resolvedProject,
            projectChrome: nextChrome.current.path ? nextChrome : makeEmptyProjectChrome(nextProject),
            projectManifest: nextProjectStatus.projectManifest,
            vectorIndex: nextProjectStatus.vectorIndex,
            timeline: nextChrome.timeline,
            conversations: nextConversations,
            jobs: nextJobs
          }
        : current
    );
    await syncDesktopProjectSnapshot(resolvedProject, nextConversations, nextJobs);

    if (options.landing === "assistant") {
      setActiveTab("conversations");
      setProjectMessage(`${successMessage}，已进入 AI 助手。`);
      return;
    }

    const warnings: string[] = [];
    if (projectChromeResult.status === "rejected") {
      warnings.push(`项目结构刷新失败：${projectChromeResult.reason instanceof Error ? projectChromeResult.reason.message : "未知错误"}`);
    }
    if (nextProjectStatus.manifestError) {
      warnings.push(
        `manifest 状态读取失败：${nextProjectStatus.manifestError instanceof Error ? nextProjectStatus.manifestError.message : "未知错误"}`
      );
    }
    if (nextProjectStatus.vectorError) {
      warnings.push(
        `向量状态读取失败：${nextProjectStatus.vectorError instanceof Error ? nextProjectStatus.vectorError.message : "未知错误"}`
      );
    }

    if (projectChromeResult.status === "fulfilled") {
      const starterPath = findStarterDocumentPath(nextChrome.tree);
      if (starterPath) {
        const opened = await openDocument(starterPath, { forceReload: true, discardDirty: true });
        const starterMessage = opened ? `${successMessage}，已自动打开 ${starterPath}` : `${successMessage}，默认文档稍后手动打开即可。`;
        setProjectMessage(warnings.length ? `${starterMessage}；${warnings.join("；")}` : starterMessage);
        return;
      }
    }

    const fallbackStarterPath = "02_正文/正文.txt";
    const opened = await openDocument(fallbackStarterPath, { forceReload: true, discardDirty: true });
    if (opened) {
      const starterMessage = `${successMessage}，已自动打开 ${fallbackStarterPath}`;
      setProjectMessage(warnings.length ? `${starterMessage}；${warnings.join("；")}` : starterMessage);
      return;
    }

    setProjectMessage(warnings.length ? `${successMessage}；${warnings.join("；")}` : successMessage);
  }

  async function loadProjectChromeWithRetry() {
    try {
      return await client.getProjectChrome({ force: 1 });
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      try {
        return await client.getProjectChrome({ force: 1 });
      } catch {
        throw error;
      }
    }
  }

  function getActiveDocument() {
    return openDocuments.find((item) => item.path === activeDocumentPath) || null;
  }

  function buildProjectContextHint() {
    const activeDocument = getActiveDocument();
    if (!activeDocument) {
      return "";
    }

    const excerpt = activeDocument.content.trim().slice(-6000);
    if (!excerpt) {
      return "";
    }

    return `当前文档：${activeDocument.path}\n\n${excerpt}`.slice(0, 18000);
  }

  function appendLocalMessage(conversationId: string, role: ConversationMessage["role"], content: string) {
    const message = makeLocalMessage(role, content);
    setConversationDetail((current) => {
      if (!current || current.id !== conversationId) {
        return current;
      }

      return {
        ...current,
        updated_at: message.created_at,
        message_count: current.message_count + 1,
        messages: [...current.messages, message]
      };
    });
    patchConversationSummary(conversationId, (item) => ({
      ...item,
      updated_at: message.created_at,
      message_count: item.message_count + 1
    }));
    return message;
  }

  function setConversationMessageFor(conversationId: string, message: string) {
    if (activeConversationIdRef.current === conversationId) {
      setConversationMessage(message);
    }
  }

  function upsertLocalMessage(conversationId: string, message: ConversationMessage) {
    setConversationDetail((current) => {
      if (!current || current.id !== conversationId) {
        return current;
      }

      const existing = current.messages.some((item) => item.id === message.id);
      return {
        ...current,
        updated_at: message.created_at,
        message_count: existing ? current.message_count : current.message_count + 1,
        messages: existing
          ? current.messages.map((item) => (item.id === message.id ? message : item))
          : [...current.messages, message]
      };
    });
    patchConversationSummary(conversationId, (item) => ({
      ...item,
      updated_at: message.created_at
    }));
  }

  async function refreshActiveConversation() {
    if (!conversationDetail?.id) {
      return null;
    }

    const detail = await client.getConversation(conversationDetail.id);
    setConversationDetail(detail);
    return detail;
  }

  function publishPendingSaveMessage(pendingSave: PendingGeneratedSave, message: string) {
    if (pendingSave.source === "skill") {
      setOperationsMessage(message);
      setActiveTab("operations");
      return;
    }

    if (pendingSave.conversationId && activeConversationIdRef.current === pendingSave.conversationId) {
      setConversationMessage(message);
    }
  }

  async function syncChangedPaths(paths: string[], options: { openFirst?: boolean } = {}) {
    const nextPaths = uniquePaths(paths);
    if (!nextPaths.length) {
      return;
    }

    await refreshProjectChrome();

    const openPathSet = new Set(openDocumentsRef.current.map((item) => item.path));
    for (const path of nextPaths) {
      if (openPathSet.has(path)) {
        await openDocument(path, { forceReload: true, activate: path === activeDocumentPathRef.current });
      }
    }

    if (options.openFirst && nextPaths[0]) {
      await openDocument(nextPaths[0], {
        forceReload: openPathSet.has(nextPaths[0]),
        activate: true
      });
    }
  }

  async function handleCompletedJob(job: JobInfo) {
    await refreshJobsList();

    const changedPaths = extractPathsFromUnknownResult(job.result);
    if (changedPaths.length) {
      await syncChangedPaths(changedPaths, { openFirst: true });
    }
    if (job.kind === "novel_crawl") {
      await refreshDisassemblyLibrary();
    }

    await refreshConversationsList();
    if (conversationDetail?.id && job.kind === "summarize_conversation") {
      await refreshActiveConversation();
    }

    const resultSummary = "result" in job && job.result !== undefined
      ? summarizeJobResult(job.result).detail
      : "";
    const baseMessage = job.error || job.message || (job.status === "done" ? "任务已完成" : "任务已结束");
    setOperationsMessage(resultSummary && job.status === "done" ? `${baseMessage}：${resultSummary}` : baseMessage);
  }

  async function openJobResultFile(path: string) {
    const ok = await openDocument(path, { activate: true });
    if (ok) {
      setActiveTab("editor");
      setOperationsMessage(`已打开任务结果文件：${path}`);
    }
  }

  async function continueJobResultInConversation(path: string) {
    const ok = await openDocument(path, { activate: true });
    if (!ok) {
      return;
    }
    setMessageInput(`继续处理 ${path}：`);
    setConversationMessage(`已把 ${path} 作为当前文档带入会话输入。`);
    setActiveTab("conversations");
  }

  async function ensureConversationId() {
    if (conversationDetail?.id) {
      return conversationDetail.id;
    }

    let detail = await client.createConversation();
    const preferences = conversationModelPreferencesRef.current;
    if (preferences.model_override || preferences.reasoning_enabled || preferences.reasoning_effort !== "medium") {
      detail = await client.updateConversationModelPreferences(detail.id, preferences);
    }
    const conversations = await client.getConversations();
    setConversationDetail(detail);
    setSnapshot((current) => (current ? { ...current, conversations: assistantConversations(conversations) } : current));
    return detail.id;
  }

  async function createTaskConversation(input: {
    type: Exclude<ConversationType, "assistant">;
    title: string;
    skillId?: string;
    entry: string;
    sourcePath?: string;
    sourceBookId?: string;
    targetPaths?: string[];
  }): Promise<ConversationDetail> {
    let detail = await client.createConversation({
      title: input.title,
      skill_id: input.skillId || "",
      conversation_type: input.type,
      task_metadata: {
        entry: input.entry,
        source_path: input.sourcePath || "",
        source_book_id: input.sourceBookId || "",
        target_paths: uniquePaths(input.targetPaths || []),
        created_for: input.title
      }
    });
    const preferences: ConversationModelPreferences = {
      model_override: "",
      reasoning_enabled: Boolean(configDraft?.model_thinking_enabled),
      reasoning_effort: "medium"
    };
    if (preferences.reasoning_enabled) {
      detail = await client.updateConversationModelPreferences(detail.id, preferences);
    }
    return detail;
  }

  function includedConversationAttachmentIds(detail = conversationDetail): string[] {
    return detail?.attachments.map((attachment) => attachment.id) || [];
  }

  async function handleAgentRunPayload(conversationId: string, reply: string, payload: AgentRunResponse) {
    const rawPendingSaves = pendingSavesFromSkill(payload.skill_result, "chat");
    const rawPendingSave = rawPendingSaves[0] || null;
    const skillResultData = payload.skill_result?.data || {};
    const libraryDraftGroup = pendingLibraryDraftGroupFromUnknown(skillResultData.library_draft_group);
    const libraryDraft = skillResultData.library_draft && typeof skillResultData.library_draft === "object" && !Array.isArray(skillResultData.library_draft)
      ? skillResultData.library_draft as Record<string, unknown>
      : null;
    const libraryDraftDomain = String(libraryDraft?.domain || "");
    const libraryDraftLabel = libraryDraftDomain === "lore"
      ? "设定资料"
      : libraryDraftDomain === "style"
        ? "写作风格"
        : libraryDraftDomain === "genre"
          ? "题材规则"
          : "项目资料";
    const completionMessage = rawPendingSave
      ? "生成完成，等待选择写入方式"
      : libraryDraftGroup
        ? "风格与题材草稿已生成，等待整体确认写入；确认前不会修改项目文件"
      : libraryDraft
        ? `${libraryDraftLabel}草稿已生成，请在下方预览后确认写入或丢弃；确认前不会修改项目文件`
      : payload.requires_confirmation
        ? "已生成待确认的操作预览，请检查内容后再执行写入"
        : payload.results.length
          ? "智能体已完成文件改动"
          : payload.skill_result?.status === "job_created"
            ? "已创建后台任务，工作台会继续追踪它"
            : reply || payload.reply || "智能体已完成";

    const payloadConversation = payload.conversation;
    if (payloadConversation) {
      setConversationDetail((current) => current?.id === payloadConversation.id ? payloadConversation : current);
      await refreshConversationsList();
    }

    const persistedConversation = payloadConversation;
    const ownerConversationId = persistedConversation?.id || conversationId;
    const ownerMessageId = [...(persistedConversation?.messages || [])].reverse().find((message) =>
      message.role === "assistant" && (!payload.run_id || message.run_id === payload.run_id || String(message.metadata?.run_id || "") === payload.run_id)
    )?.id || [...(persistedConversation?.messages || [])].reverse().find((message) => message.role === "assistant")?.id || "";
    const pendingSaves = rawPendingSaves.map((item) => ({
          ...item,
          conversationId: ownerConversationId || undefined,
          messageId: ownerMessageId || undefined,
          runId: payload.run_id || undefined,
          createdAt: new Date().toISOString()
        }));

    if (payload.requires_confirmation && payload.run_id) {
      try {
        const confirmations = await client.getAgentRunConfirmations(payload.run_id);
        setPendingAgentConfirmations(confirmations.filter((item) => item.status === "pending"));
      } catch (nextError) {
        setPendingAgentConfirmations([]);
        setConversationMessageFor(conversationId, `已生成待确认操作，但读取确认详情失败：${nextError instanceof Error ? nextError.message : "未知错误"}`);
      }
    } else if (!payload.requires_confirmation) {
      setPendingAgentConfirmations([]);
    }

    if (payload.skill_result) {
      setLatestSkillResult(payload.skill_result);
    }

    if (payload.results.length) {
      setOperationsMessage(summarizeOperationResults(payload.results));
      await syncChangedPaths(
        payload.results.filter((result) => result.ok).map((result) => result.path),
        { openFirst: true }
      );
    }

    if (payload.skill_result?.status === "job_created" && payload.skill_result.job) {
      liveJobIdsRef.current.add(payload.skill_result.job.id);
      setSelectedJobId(payload.skill_result.job.id);
      setSelectedJobDetail(payload.skill_result.job);
      upsertJobInSnapshot(payload.skill_result.job);
      await refreshJobsList();
    }

    if (payload.skill_result?.data?.skill_imported) {
      await refreshSkillCatalog();
    }

    if (pendingSaves.length) {
      for (const pendingSave of pendingSaves) {
        upsertPendingGeneratedSave(pendingSave);
        void trackDesktopGeneratedCache(pendingSave, "pending");
      }
      publishPendingSaveMessage(pendingSaves[0]!, completionMessage);
      return;
    }

    if (libraryDraftGroup) {
      const ownedGroup = {
        ...libraryDraftGroup,
        conversationId: ownerConversationId || libraryDraftGroup.conversationId,
        messageId: ownerMessageId || libraryDraftGroup.messageId,
        runId: payload.run_id || libraryDraftGroup.runId,
        createdAt: libraryDraftGroup.createdAt || new Date().toISOString()
      };
      setPendingLibraryDraftGroups((current) => [...current.filter((item) => item.groupId !== ownedGroup.groupId), ownedGroup]);
      void setLibraryDraftGroupOrigin(ownedGroup.groupId, ownedGroup).then(() => refreshPendingLibraryDraftGroups()).catch(() => undefined);
    }

    if (payload.saved_paths.length) {
      await syncChangedPaths(payload.saved_paths, { openFirst: true });
    }

    const postprocessWarning = String(skillResultData.postprocess_warning || "").trim();
    setConversationMessageFor(conversationId, postprocessWarning ? `${completionMessage}；大纲结构整理待重试：${postprocessWarning}` : completionMessage);
  }

  async function refreshAll() {
    setRefreshTick((value) => value + 1);
  }

  async function refreshProjectWorkspace() {
    setProjectBusy(true);
    setProjectMessage("");
    try {
      const currentProject = await client.getCurrentProject();
      if (!currentProject.path) {
        replaceProjectStatus(makeEmptyProjectManifestStatus(), makeEmptyVectorIndexStatus());
        replaceProjectSnapshot(currentProject, makeEmptyProjectChrome(currentProject), {
          clearConversations: false,
          clearJobs: false
        });
        setProjectMessage("当前还没有打开项目，可以直接在这里创建一个。");
        return;
      }

      const [projectChromeResult, conversationsResult, jobsResult, projectStatusResult] = await Promise.allSettled([
        client.getProjectChrome({ force: 1 }),
        client.getConversations(),
        client.getJobs(),
        loadProjectStatus()
      ]);

      const projectChrome =
        projectChromeResult.status === "fulfilled" ? projectChromeResult.value : snapshot?.projectChrome || makeEmptyProjectChrome(currentProject);
      const conversations = conversationsResult.status === "fulfilled" ? conversationsResult.value : snapshot?.conversations || [];
      const jobs = jobsResult.status === "fulfilled" ? jobsResult.value : snapshot?.jobs || [];
      const projectStatus =
        projectStatusResult.status === "fulfilled"
          ? projectStatusResult.value
          : {
              projectManifest: snapshot?.projectManifest || makeEmptyProjectManifestStatus(),
              vectorIndex: snapshot?.vectorIndex || makeEmptyVectorIndexStatus(),
              manifestError: null,
              vectorError: null
            };
      const warnings: string[] = [];
      if (projectChromeResult.status === "rejected") {
        warnings.push(`项目结构刷新失败：${projectChromeResult.reason instanceof Error ? projectChromeResult.reason.message : "未知错误"}`);
      }
      if (conversationsResult.status === "rejected") {
        warnings.push(`会话列表刷新失败：${conversationsResult.reason instanceof Error ? conversationsResult.reason.message : "未知错误"}`);
      }
      if (jobsResult.status === "rejected") {
        warnings.push(`任务列表刷新失败：${jobsResult.reason instanceof Error ? jobsResult.reason.message : "未知错误"}`);
      }
      if (projectStatusResult.status === "rejected") {
        warnings.push(`索引状态刷新失败：${projectStatusResult.reason instanceof Error ? projectStatusResult.reason.message : "未知错误"}`);
      }

      setProjectPathInput(currentProject.path);
      setProjectNameInput(currentProject.name);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              currentProject,
              projectChrome,
              projectManifest: projectStatus.projectManifest,
              vectorIndex: projectStatus.vectorIndex,
              timeline: projectChrome.timeline,
              conversations,
              jobs
            }
          : current
      );
      setProjectDataRevision((value) => value + 1);
      await syncDesktopProjectSnapshot(currentProject, conversations, jobs);
      setProjectMessage(warnings.length ? `项目视图已部分刷新；${warnings.join("；")}` : "项目视图已刷新");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "刷新项目失败", "请确认项目目录仍存在，然后重试刷新。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function performOpenProject(targetPath: string) {
    setProjectBusy(true);
    setProjectMessage("");
    try {
      const opened = await client.openProject(targetPath);
      await finalizeProjectSwitch(opened, "项目已打开");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "打开项目失败", "请确认项目目录存在并且可以访问。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function performCreateProject(parentPath: string, projectName: string): Promise<"created" | "failed"> {
    setProjectBusy(true);
    setProjectMessage("");
    try {
      const created = await client.createProject(parentPath, projectName);
      await finalizeProjectSwitch(created, "新项目已创建并打开", { landing: "assistant" });
      return "created";
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "创建项目失败", "请确认父目录存在并且允许写入。"));
      return "failed";
    } finally {
      setProjectBusy(false);
    }
  }

  function hasDirtyOpenDocuments() {
    return openDocumentsRef.current.some((item) => item.dirty);
  }

  function getUnsavedWorkbenchState() {
    return describeUnsavedWorkbenchState({
      dirtyDocumentCount: openDocumentsRef.current.filter((item) => item.dirty).length,
      hasConversationDraft: messageInput.trim().length > 0,
      hasPendingGeneratedSave: pendingGeneratedSaves.length + pendingLibraryDraftGroups.length > 0
    });
  }

  function queueProjectSwitch(request: PendingProjectSwitchRequest) {
    const unsavedState = getUnsavedWorkbenchState();
    setPendingProjectSwitchRequest(request);
    setProjectMessage(
      unsavedState.hasUnsavedState
        ? `${unsavedState.summary}，确认后才会${request.mode === "create" ? "创建并切换到新项目" : "切换项目"}。`
        : `确认后才会${request.mode === "create" ? "创建并切换到新项目" : "切换项目"}。`
    );
    setActiveTab("project");
  }

  async function openProjectFromInput(pathOverride?: string) {
    const targetPath = (pathOverride ?? projectPathInput).trim();
    if (!targetPath) {
      setProjectMessage("先填一个项目目录，再打开。");
      return;
    }

    const unsavedState = getUnsavedWorkbenchState();
    if (unsavedState.hasUnsavedState) {
      queueProjectSwitch({
        mode: "open",
        targetPath,
        title: "当前有未保存草稿，确认要切换项目吗？",
        detail: `${unsavedState.detail} 切换后会打开 ${targetPath}。`
      });
      return;
    }

    await performOpenProject(targetPath);
  }

  async function createProjectFromInput(pathOverride?: string): Promise<"created" | "queued" | "failed"> {
    const parentPath = (pathOverride ?? projectPathInput).trim();
    const projectName = projectNameInput.trim();
    if (!parentPath) {
      setProjectMessage("先填一个父目录，再创建项目。");
      return "failed";
    }
    if (!projectName) {
      setProjectMessage("给新项目起个名字吧。");
      return "failed";
    }

    const unsavedState = getUnsavedWorkbenchState();
    if (unsavedState.hasUnsavedState) {
      queueProjectSwitch({
        mode: "create",
        parentPath,
        projectName,
        title: "当前有未保存草稿，确认要新建并切换项目吗？",
        detail: `${unsavedState.detail} 继续后会在 ${parentPath} 下创建 ${projectName}。`
      });
      return "queued";
    }

    return performCreateProject(parentPath, projectName);
  }

  async function pickAndCreateProject(projectNameInput: string): Promise<"created" | "queued" | "cancelled" | "failed"> {
    const projectName = projectNameInput.trim().slice(0, 80);
    if (!projectName) {
      setProjectMessage("给新小说起个名字吧。");
      return "failed";
    }

    setProjectBusy(true);
    setProjectMessage("请选择保存新小说的父目录。");
    try {
      const picked =
        runtime.isDesktopShell && window.xiaoshuoDesktop?.pickProjectDirectory
          ? await window.xiaoshuoDesktop.pickProjectDirectory()
          : await client.pickProject();
      if (!picked.path) {
        setProjectMessage("已取消创建，新小说尚未写入磁盘。");
        return "cancelled";
      }

      setProjectPathInput(picked.path);
      const unsavedState = getUnsavedWorkbenchState();
      if (unsavedState.hasUnsavedState) {
        queueProjectSwitch({
          mode: "create",
          parentPath: picked.path,
          projectName,
          title: "当前有未保存内容，确认要新建并切换项目吗？",
          detail: `${unsavedState.detail} 继续后会在 ${picked.path} 下创建 ${projectName}。`
        });
        return "queued";
      }

      return await performCreateProject(picked.path, projectName);
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "选择目录失败", "请重新选择一个可访问的目录。"));
      return "failed";
    } finally {
      setProjectBusy(false);
    }
  }

  async function pickAndOpenProject(mode: "open" | "create") {
    if (mode === "create") {
      await pickAndCreateProject(projectNameInput);
      return;
    }
    setProjectBusy(true);
    setProjectMessage("请选择要打开的项目目录。");
    try {
      const picked =
        runtime.isDesktopShell && window.xiaoshuoDesktop?.pickProjectDirectory
          ? await window.xiaoshuoDesktop.pickProjectDirectory()
          : await client.pickProject();
      if (!picked.path) {
        setProjectMessage("没有选中目录。");
        return;
      }

      setProjectPathInput(picked.path);
      await openProjectFromInput(picked.path);
    } catch (nextError) {
      setProjectMessage(
        describeActionableError(nextError, "选择项目失败", "请重新选择一个可访问的目录。")
      );
    } finally {
      setProjectBusy(false);
    }
  }

  async function removeRecentProject(projectPath: string): Promise<boolean> {
    const path = projectPath.trim();
    if (!path || !runtime.isDesktopShell || !window.xiaoshuoDesktop?.localState?.removeRecentProject) {
      setProjectMessage("最近项目管理需要桌面版。");
      return false;
    }

    setRecentProjectRemovingPath(path);
    setProjectMessage("");
    try {
      const localState = await window.xiaoshuoDesktop.localState.removeRecentProject({ path });
      setSnapshot((current) => (current ? { ...current, localState } : current));
      setProjectMessage("已从最近项目中移除，本地小说文件和云端副本均未删除。");
      return true;
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "移除最近项目失败", "请稍后重试，本地小说文件没有变化。"));
      return false;
    } finally {
      setRecentProjectRemovingPath("");
    }
  }

  async function exportCurrentProject() {
    const currentProject = snapshot?.currentProject;
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.exportProject) {
      setProjectMessage("项目导出需要桌面版。");
      return;
    }
    if (!currentProject?.path) {
      setProjectMessage("先打开一个项目，再导出。");
      return;
    }
    if (hasDirtyOpenDocuments()) {
      setProjectMessage("当前有未保存文档，请先保存后再导出项目。");
      return;
    }

    setProjectBusy(true);
    setProjectMessage("请选择项目归档保存位置。");
    try {
      const result = await window.xiaoshuoDesktop.exportProject({
        project_path: currentProject.path,
        project_name: currentProject.name
      });
      if (result.canceled || !result.path) {
        setProjectMessage("已取消导出项目。");
        return;
      }
      setProjectMessage(`项目已导出：${result.path}`);
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "导出项目失败", "请确认项目目录和保存位置都可以访问。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function importProjectArchive() {
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.importProject) {
      setProjectMessage("项目导入需要桌面版。");
      return;
    }

    let importedPath = "";
    setProjectBusy(true);
    setProjectMessage("请选择项目归档和导入位置。");
    try {
      const result = await window.xiaoshuoDesktop.importProject();
      if (result.canceled || !result.path) {
        setProjectMessage("已取消导入项目。");
        return;
      }
      importedPath = result.path;
      setProjectPathInput(importedPath);
      setProjectMessage("项目归档已导入，正在打开...");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "导入项目失败", "请确认 zip 是 ArcWriter 项目归档，目标文件夹允许写入。"));
    } finally {
      setProjectBusy(false);
    }

    if (importedPath) {
      await openProjectFromInput(importedPath);
    }
  }

  async function refreshCloudProjects(options: { silent?: boolean } = {}) {
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.cloudProjects) {
      if (!options.silent) {
        setCloudProjectMessage("云项目需要桌面版。");
      }
      setCloudProjectSlots([]);
      return [];
    }

    if (!options.silent) {
      setCloudProjectBusy(true);
      setCloudProjectMessage("");
    }
    try {
      const result = await window.xiaoshuoDesktop.cloudProjects.list();
      setCloudProjectSlots(result.slots);
      setCloudProjectSummary(result);
      if (!options.silent) {
        setCloudProjectMessage(result.slots.length ? "云项目已刷新。" : "当前账号还没有云项目。");
      }
      return result.slots;
    } catch (nextError) {
      if (!options.silent) {
        setCloudProjectMessage(describeActionableError(nextError, "刷新云项目失败", "请确认已登录网站账号并且网络可用。"));
      }
      setCloudProjectSlots([]);
      setCloudProjectSummary(null);
      return [];
    } finally {
      if (!options.silent) {
        setCloudProjectBusy(false);
      }
    }
  }

  useEffect(() => {
    void refreshCloudProjects({ silent: true });
  }, [snapshot?.currentProject.path, runtime.isDesktopShell]);

  async function uploadProjectToCloud(targetProject: CurrentProject, slotId: number, syncMode: "manual" | "auto" = "manual") {
    const currentProject = snapshot?.currentProject;
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.cloudProjects) {
      setCloudProjectMessage("云项目需要桌面版。");
      return;
    }
    if (!targetProject.path) {
      setCloudProjectMessage("先打开一个项目，再上传。");
      return null;
    }
    if (targetProject.path === currentProject?.path && hasDirtyOpenDocuments()) {
      setCloudProjectMessage("当前有未保存文档，请先保存后再上传项目。");
      return null;
    }

    setCloudProjectBusy(true);
    setCloudProjectActivePath(targetProject.path);
    setCloudProjectMessage(`正在上传到云项目槽位 ${slotId}...`);
    try {
      const result = await window.xiaoshuoDesktop.cloudProjects.upload({
        slot_id: slotId,
        project_path: targetProject.path,
        project_name: targetProject.name,
        sync_mode: syncMode
      });
      await refreshCloudProjects({ silent: true });
      setCloudProjectMessage(result.unchanged ? "云端已是最新版本，没有产生上传流量。" : `已同步到云端：${result.slot.project_name || targetProject.name}`);
      return result;
    } catch (nextError) {
      setCloudProjectMessage(describeActionableError(nextError, "同步云项目失败", "请确认核心数据不超过 30MB、网站账号已登录且网络可用。"));
      return null;
    } finally {
      setCloudProjectBusy(false);
      setCloudProjectActivePath("");
    }
  }

  async function uploadCurrentProjectToCloud(slotId: number) {
    const currentProject = snapshot?.currentProject;
    if (!currentProject?.path) {
      setCloudProjectMessage("先打开一个项目，再上传。");
      return null;
    }
    return uploadProjectToCloud(currentProject, slotId, "manual");
  }

  async function restoreCloudProject(slot: CloudProjectSlot, targetProject?: CurrentProject) {
    const currentProject = snapshot?.currentProject;
    const restoreTarget = targetProject?.path ? targetProject : currentProject;
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.cloudProjects) {
      setCloudProjectMessage("云项目需要桌面版。");
      return;
    }
    if (!restoreTarget?.path) {
      setCloudProjectMessage("请先选择一个本地项目目录，再恢复云端内容。");
      return;
    }
    const unsavedState = restoreTarget.path === currentProject?.path ? getUnsavedWorkbenchState() : { hasUnsavedState: false, summary: "" };
    if (unsavedState.hasUnsavedState) {
      setCloudProjectMessage(`同步前请先处理未保存内容：${unsavedState.summary}。`);
      return;
    }
    if (!window.confirm(`确认将云端“${slot.project_name || `槽位 ${slot.slot_id}`}”的核心文件恢复到“${restoreTarget.name || "所选项目"}”吗？软件会先备份本地项目，其他文件不会删除。`)) {
      return;
    }

    setCloudProjectBusy(true);
    setCloudProjectActivePath(restoreTarget.path);
    setCloudProjectMessage("正在备份当前项目并同步云项目...");
    try {
      const result = await window.xiaoshuoDesktop.cloudProjects.downloadToProject({
        id: slot.id,
        project_path: restoreTarget.path,
        project_name: restoreTarget.name
      });
      if (restoreTarget.path === currentProject?.path) {
        setOpenDocuments([]);
        setActiveDocumentPath("");
        setPendingGeneratedSaves([]);
        await refreshProjectWorkspace();
      }
      await refreshCloudProjects({ silent: true });
      setCloudProjectMessage(`已恢复 ${result.restored_files} 个核心文件，并保留同步前备份。`);
    } catch (nextError) {
      setCloudProjectMessage(describeActionableError(nextError, "同步云项目失败", "已尽量保留同步前备份，请根据提示路径检查。"));
    } finally {
      setCloudProjectBusy(false);
      setCloudProjectActivePath("");
    }
  }

  async function syncCloudProjectToCurrent(slot: CloudProjectSlot) {
    return restoreCloudProject(slot);
  }

  async function deleteCloudProject(slot: CloudProjectSlot) {
    if (!runtime.isDesktopShell || !window.xiaoshuoDesktop?.cloudProjects) {
      setCloudProjectMessage("云项目需要桌面版。");
      return;
    }
    if (!window.confirm(`确认删除云项目“${slot.project_name || `槽位 ${slot.slot_id}`}”吗？`)) {
      return;
    }

    setCloudProjectBusy(true);
    setCloudProjectMessage("正在删除云项目...");
    try {
      await window.xiaoshuoDesktop.cloudProjects.delete({ id: slot.id });
      await refreshCloudProjects({ silent: true });
      setCloudProjectMessage("云项目已删除。");
    } catch (nextError) {
      setCloudProjectMessage(describeActionableError(nextError, "删除云项目失败", "请稍后重试。"));
    } finally {
      setCloudProjectBusy(false);
    }
  }

  function cancelProjectSwitch() {
    setPendingProjectSwitchRequest(null);
    setProjectMessage("已保留当前项目和本地草稿，可以继续编辑后再切换。");
  }

  async function confirmProjectSwitch() {
    const request = pendingProjectSwitchRequest;
    if (!request) {
      return;
    }

    setPendingProjectSwitchRequest(null);
    if (request.mode === "create") {
      await performCreateProject(request.parentPath, request.projectName);
      return;
    }

    await performOpenProject(request.targetPath);
  }

  async function renameCurrentProject() {
    const nextName = projectNameInput.trim();
    if (!snapshot?.currentProject.path) {
      setProjectMessage("先打开一个项目，再修改它的显示名。");
      return;
    }
    if (!nextName) {
      setProjectMessage("项目显示名不能为空。");
      return;
    }

    setProjectBusy(true);
    setProjectMessage("");
    try {
      const renamed = await client.renameCurrentProject(nextName);
      const projectChrome = await client.getProjectChrome({ force: 1 });
      await recordDesktopProject(renamed);
      setProjectPathInput(renamed.path);
      setProjectNameInput(renamed.name);
      replaceProjectSnapshot(renamed, projectChrome);
      setProjectMessage(renamed.previous_path ? "项目名称和文件夹已更新" : "项目显示名已更新");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "项目重命名失败", "请确认项目仍然打开，然后重试。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function rebuildVectorIndex() {
    if (!snapshot?.currentProject.path) {
      setProjectMessage("先打开一个项目，再重建向量索引。");
      return;
    }

    setProjectBusy(true);
    setProjectMessage("正在重建向量索引...");
    try {
      const result = await client.rebuildVectorIndex();
      const projectManifest = await client
        .getProjectManifestStatus()
        .catch(() => makeEmptyProjectManifestStatus());
      replaceProjectStatus(projectManifest, result);
      setProjectMessage(
        result.ready
          ? `向量索引已就绪，共 ${result.current_embedded_chunks}/${result.chunks} 个分块可直接使用。`
          : `向量索引已重建，当前 ${result.current_embedded_chunks}/${result.chunks} 个分块可用，待嵌入文件 ${result.pending_files} 个。`
      );
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "重建向量索引失败", "请先到配置页检查向量和 Embedding 设置，再重试。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function processPendingVectorFiles() {
    if (!snapshot?.currentProject.path) {
      setProjectMessage("先打开一个项目，再处理待嵌入文件。");
      return;
    }

    setProjectBusy(true);
    setProjectMessage("正在处理待嵌入文件...");
    try {
      const result = await client.processPendingVectorFiles();
      const projectManifest = await client
        .getProjectManifestStatus()
        .catch(() => makeEmptyProjectManifestStatus());
      replaceProjectStatus(projectManifest, result);
      const processedFiles = result.processed_files ?? 0;
      setProjectMessage(
        processedFiles
          ? `已处理 ${processedFiles} 个待嵌入文件，剩余 ${result.pending_files} 个。`
          : result.pending_before
            ? `这轮没有新增可处理文件，当前仍有 ${result.pending_files} 个待处理条目。`
            : "当前没有待嵌入文件。"
      );
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "处理待嵌入文件失败", "请先确认项目文件仍存在，再重试处理。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function searchVectorIndex(query: string) {
    const text = query.trim();
    if (!text) {
      setVectorSearchMessage("请输入要测试召回的关键词或问题。");
      setVectorSearchResults([]);
      return;
    }

    setVectorSearchBusy(true);
    setVectorSearchMessage("");
    try {
      const result = await client.searchVector(text, 5, 6000);
      setVectorSearchResults(result.hits);
      setVectorSearchMessage(result.hits.length ? `找到 ${result.hits.length} 条召回片段。` : "没有召回结果；可以先重建索引或换一个关键词。");
    } catch (nextError) {
      setVectorSearchResults([]);
      setVectorSearchMessage(describeActionableError(nextError, "向量搜索失败", "请确认项目已打开、索引已建立，并检查 Embedding 配置。"));
    } finally {
      setVectorSearchBusy(false);
    }
  }

  async function testEmbeddingConnection(payload: VectorTestRequest) {
    setEmbeddingTestBusy(true);
    setEmbeddingTestMessage("");
    try {
      const result = await client.testVectorEmbedding(payload);
      const dimensionLabel = result.dimensions > 0 ? `，维度 ${result.dimensions}` : "";
      setEmbeddingTestMessage(`连接可用：${result.provider} / ${result.model}${dimensionLabel}`);
    } catch (error) {
      setEmbeddingTestMessage(describeActionableError(error, "Embedding 检测失败", "请检查 API Key、Base URL、模型名或网络连接。"));
    } finally {
      setEmbeddingTestBusy(false);
    }
  }

  function resetEmbeddingTestResult() {
    if (!embeddingTestBusy) {
      setEmbeddingTestMessage("");
    }
  }

  function patchConfig(patch: Partial<AppConfig>) {
    configDraftDirtyRef.current = true;
    setConfigDraft((current) => (current ? normalizeConfigDraft({ ...current, ...patch }) : current));
  }

  async function patchAndSaveConfig(patch: Partial<AppConfig>, message = "设置已保存。"): Promise<boolean> {
    const baseConfig = configDraft;
    if (!baseConfig) {
      return false;
    }
    const nextConfig = normalizeConfigDraft({ ...baseConfig, ...patch });
    setConfigDraft(nextConfig);
    setConfigBusy(true);
    setConfigMessage("");
    try {
      const saved = await client.putConfig(nextConfig);
      const normalizedConfig = normalizeConfigDraft(saved);
      setConfigDraft(normalizedConfig);
      lastConfigSignatureRef.current = configSignature(normalizedConfig);
      configDraftDirtyRef.current = false;
      setSnapshot((current) => (current ? { ...current, config: normalizedConfig } : current));
      if (normalizedConfig.ai_config_mode === "manual") {
        void refreshManualModelCatalog(normalizedConfig.manual_profile, { silent: true, force: true });
      }
      setConfigMessage(message);
      return true;
    } catch (nextError) {
      setConfigDraft(baseConfig);
      configDraftDirtyRef.current = configSignature(baseConfig) !== lastConfigSignatureRef.current;
      setConfigMessage(describeActionableError(nextError, "配置保存失败", "请检查联网搜索配置后重试。"));
      return false;
    } finally {
      setConfigBusy(false);
    }
  }

  function applySyncedConfig(nextConfig: AppConfig) {
    const normalizedConfig = normalizeConfigDraft(nextConfig);
    setConfigDraft(normalizedConfig);
    lastConfigSignatureRef.current = configSignature(normalizedConfig);
    configDraftDirtyRef.current = false;
    setSnapshot((current) => (current ? { ...current, config: normalizedConfig } : current));
  }

  async function refreshWebsiteAiDashboard(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setWebsiteAiBusy(true);
      setWebsiteAiMessage("");
    }
    try {
      const dashboard = await client.getWebsiteAiDashboard();
      setWebsiteAiDashboard(dashboard);
      if (dashboard.config && !configDraftDirtyRef.current) {
        applySyncedConfig(dashboard.config);
        void syncLicenseStatus();
      }
      if (!options.silent) {
        setWebsiteAiMessage(dashboard.message || (dashboard.logged_in ? "网站账号状态已刷新。" : "尚未登录网站配置。"));
      }
    } catch (nextError) {
      setWebsiteAiMessage(describeActionableError(nextError, "刷新网站配置失败", "请确认网络可访问网站，或稍后重试。"));
    } finally {
      if (!options.silent) {
        setWebsiteAiBusy(false);
      }
    }
  }

  async function refreshManualModelCatalog(
    profile: Partial<AiConfigProfile> | undefined = configDraft?.manual_profile,
    options: { silent?: boolean; force?: boolean } = {}
  ): Promise<AiModelOption[]> {
    const baseUrl = String(profile?.base_url || "").trim();
    if (!baseUrl) {
      setManualModelCatalog([]);
      setManualModelDiscoveryMessage("请先在设置中填写手动 API 地址。");
      return [];
    }
    if (!options.silent) {
      setManualModelDiscoveryBusy(true);
      setManualModelDiscoveryMessage("");
    }
    if (options.force) {
      manualModelRefreshKeyRef.current = "";
    }
    try {
      const result = await client.discoverManualModels({
        base_url: baseUrl,
        api_key: String(profile?.api_key || ""),
        force: options.force === true
      });
      setManualModelCatalog(result.models);
      setManualModelDiscoveryMessage(result.cached ? "已读取最近发现的模型列表。" : `已发现 ${result.models.length} 个文本模型。`);
      return result.models;
    } catch (nextError) {
      setManualModelDiscoveryMessage(describeActionableError(
        nextError,
        "模型列表刷新失败",
        "已保存的默认模型仍可继续使用，请检查接口是否提供 /models。"
      ));
      return [];
    } finally {
      if (!options.silent) {
        setManualModelDiscoveryBusy(false);
      }
    }
  }

  async function loginWebsiteAi(email: string, password: string) {
    setWebsiteAiBusy(true);
    setWebsiteAiMessage("");
    try {
      const dashboard = await client.loginWebsiteAi({ email, password });
      setWebsiteAiDashboard(dashboard);
      if (dashboard.config) {
        applySyncedConfig(dashboard.config);
      }
      await syncLicenseStatus();
      setWebsiteAiMessage(dashboard.message || "网站账号已登录，模型配置已写入。");
    } catch (nextError) {
      setWebsiteAiMessage(describeActionableError(nextError, "网站账号登录失败", "请检查 QQ 邮箱、密码和网站服务状态。"));
    } finally {
      setWebsiteAiBusy(false);
    }
  }

  async function applyWebsiteAiConfig(payload: WebsiteAiApplyRequest): Promise<boolean> {
    setWebsiteAiBusy(true);
    setWebsiteAiMessage("");
    try {
      const dashboard = await client.applyWebsiteAiConfig(payload);
      setWebsiteAiDashboard(dashboard);
      if (dashboard.config) {
        applySyncedConfig(dashboard.config);
      }
      await syncLicenseStatus();
      setWebsiteAiMessage(dashboard.message || "网站模型配置已应用。");
      return true;
    } catch (nextError) {
      setWebsiteAiMessage(describeActionableError(nextError, "应用网站配置失败", "请先登录网站账号并选择可用模型。"));
      return false;
    } finally {
      setWebsiteAiBusy(false);
    }
  }

  async function applyWebsiteImageConfig(payload: WebsiteImageConfigRequest): Promise<boolean> {
    setWebsiteAiBusy(true);
    setWebsiteAiMessage("");
    try {
      const dashboard = await client.applyWebsiteImageConfig(payload);
      setWebsiteAiDashboard(dashboard);
      if (dashboard.config) applySyncedConfig(dashboard.config);
      setWebsiteAiMessage(dashboard.message || "网站生图模型已保存。");
      return true;
    } catch (nextError) {
      setWebsiteAiMessage(describeActionableError(nextError, "生图模型保存失败", "请先登录网站账号并选择可用的生图模型。"));
      return false;
    } finally {
      setWebsiteAiBusy(false);
    }
  }

  async function redeemWebsiteAiCode(code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (!trimmed) {
      setWebsiteAiRedeemMessage("请输入兑换码。");
      return false;
    }

    setWebsiteAiRedeemBusy(true);
    setWebsiteAiRedeemMessage("");
    try {
      const result = await client.redeemWebsiteAiCode({ code: trimmed });
      setWebsiteAiRedeemMessage(result.message || "兑换成功。");
      await refreshWebsiteAiDashboard({ silent: true });
      return true;
    } catch (nextError) {
      setWebsiteAiRedeemMessage(describeActionableError(nextError, "兑换失败", "请检查兑换码后重试。"));
      return false;
    } finally {
      setWebsiteAiRedeemBusy(false);
    }
  }

  async function refreshWebsiteAiRechargeOrder(orderId: string, options: { silent?: boolean } = {}): Promise<WebsiteAiRechargeOrder | null> {
    const trimmedOrderId = orderId.trim();
    if (!trimmedOrderId) {
      return null;
    }

    if (!options.silent) {
      setWebsiteAiRechargeBusy(true);
      setWebsiteAiRechargeMessage("");
    }
    try {
      const result = await client.getWebsiteAiRechargeOrder(trimmedOrderId);
      const order = result.order ?? null;
      setWebsiteAiRechargeOrder(order);
      if (!options.silent) {
        setWebsiteAiRechargeMessage(result.message || (order?.status === "paid" ? "充值已到账。" : order?.status === "expired" ? "订单已过期。" : "已刷新订单状态。"));
      }
      if (order?.status === "paid" || order?.status === "expired") {
        await refreshWebsiteAiDashboard({ silent: true });
      }
      return order;
    } catch (nextError) {
      if (!options.silent) {
        setWebsiteAiRechargeMessage(describeActionableError(nextError, "刷新充值订单失败", "请稍后重试或重新创建订单。"));
      }
      return null;
    } finally {
      if (!options.silent) {
        setWebsiteAiRechargeBusy(false);
      }
    }
  }

  async function createWebsiteAiRechargeOrder(optionIndex: number): Promise<WebsiteAiRechargeOrder | null> {
    if (!Number.isFinite(optionIndex)) {
      setWebsiteAiRechargeMessage("请选择有效的充值档位。");
      return null;
    }

    setWebsiteAiRechargeBusy(true);
    setWebsiteAiRechargeMessage("");
    try {
      const result = await client.createWebsiteAiRechargeOrder({ option_index: optionIndex });
      const order = result.order ?? null;
      setWebsiteAiRechargeOrder(order);
      setWebsiteAiRechargeMessage(result.message || (order ? "充值订单已创建。" : "充值订单已创建。"));
      if (order?.status === "paid" || order?.status === "expired") {
        await refreshWebsiteAiDashboard({ silent: true });
      }
      return order;
    } catch (nextError) {
      setWebsiteAiRechargeMessage(describeActionableError(nextError, "创建充值订单失败", "请确认网站已配置充值档位后重试。"));
      return null;
    } finally {
      setWebsiteAiRechargeBusy(false);
    }
  }

  async function saveConfig() {
    if (!configDraft) {
      return;
    }

    setConfigBusy(true);
    setConfigMessage("");
    try {
      const saved = await client.putConfig(normalizeConfigDraft(configDraft));
      const license = await client.getLicenseStatus();
      const normalizedConfig = normalizeConfigDraft(saved);
      setConfigDraft(normalizedConfig);
      lastConfigSignatureRef.current = configSignature(normalizedConfig);
      configDraftDirtyRef.current = false;
      setSnapshot((current) => (current ? { ...current, config: saved, license } : current));
      if (normalizedConfig.ai_config_mode === "manual") {
        void refreshManualModelCatalog(normalizedConfig.manual_profile, { silent: true, force: true });
      }
      setConfigMessage(license.licensed ? "配置已保存，授权状态已刷新" : `配置已保存；${license.message || "当前未授权"}`);
    } catch (nextError) {
      setConfigMessage(describeActionableError(nextError, "配置保存失败", "请检查必填配置后重新保存。"));
    } finally {
      setConfigBusy(false);
    }
  }

  async function syncLicenseStatus() {
    try {
      const license = await client.getLicenseStatus();
      setSnapshot((current) => (current ? { ...current, license } : current));
      return license;
    } catch {
      return null;
    }
  }

  async function refreshLicense() {
    setConfigBusy(true);
    setConfigMessage("");
    try {
      const saved = configDraft ? await client.putConfig(normalizeConfigDraft(configDraft)) : null;
      const license = await client.getLicenseStatus();
      if (saved) {
        const normalizedConfig = normalizeConfigDraft(saved);
        setConfigDraft(normalizedConfig);
        lastConfigSignatureRef.current = configSignature(normalizedConfig);
        configDraftDirtyRef.current = false;
      }
      setSnapshot((current) => (current ? { ...current, ...(saved ? { config: saved } : {}), license } : current));
      setConfigMessage(license.licensed ? "配置已保存，授权状态已刷新" : `配置已保存；${license.message || "当前未授权"}`);
    } catch (nextError) {
      setConfigMessage(describeActionableError(nextError, "授权刷新失败", "请检查授权状态或稍后重新刷新。"));
    } finally {
      setConfigBusy(false);
    }
  }

  async function loadConversation(conversationId: string, options: { activateTab?: boolean } = {}) {
    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.getConversation(conversationId);
      setConversationDetail(detail);
      void hydrateConversationExecutionTrace(detail);
      setConversationModelPreferences({
        model_override: detail.model_override || "",
        reasoning_enabled: Boolean(detail.reasoning_enabled),
        reasoning_effort: detail.reasoning_effort || "medium"
      });
      if (options.activateTab ?? true) {
        setActiveTab("conversations");
      }
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "读取会话失败"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function hydrateConversationExecutionTrace(detail: ConversationDetail) {
    const targets = detail.messages.flatMap((message, index) => {
      const runId = String(recordValue(recordValue(message.metadata).inline_plan).run_id || "").trim();
      return runId ? [{ index, runId }] : [];
    });
    if (!targets.length) return;
    const traces = await Promise.all(targets.map(async (target) => ({
      ...target,
      trace: executionTraceFromRunEvents((await client.getAgentRunEvents(target.runId, 0, 1_000).catch(() => ({ events: [] }))).events)
    })));
    if (!traces.some((item) => item.trace.length)) return;
    setConversationDetail((current) => {
      if (!current || current.id !== detail.id) return current;
      const messages = current.messages.map((message, index) => {
        const trace = traces.find((item) => item.index === index)?.trace;
        return trace?.length ? { ...message, metadata: { ...message.metadata, execution_trace: trace } } : message;
      });
      return { ...current, messages };
    });
  }

  async function getConversationPlanRun(runId: string): Promise<AgentRunState> {
    return client.getAgentRun(runId);
  }

  function subscribeConversationPlanRun(
    runId: string,
    onRun: (run: AgentRunState) => void,
    onError?: (error: unknown) => void
  ): () => void {
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (controller.signal.aborted || refreshing) {
        return;
      }
      refreshing = true;
      try {
        onRun(await client.getAgentRun(runId));
      } catch (error) {
        if (!controller.signal.aborted) {
          onError?.(error);
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    // The journal stream remains the fast path. A bounded polling fallback
    // covers renderer reloads and transport completion while a cooperative
    // pause is still waiting for its durable checkpoint.
    const refreshTimer = window.setInterval(() => void refresh(), 1_000);
    void client.streamAgentRunEvents(runId, { onEvent: refresh, onGap: refresh, onEnd: refresh }, 0, controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        onError?.(error);
      }
    });
    return () => {
      window.clearInterval(refreshTimer);
      controller.abort();
    };
  }

  async function controlConversationPlanRun(
    runId: string,
    action: "pause" | "resume" | "cancel" | "retry",
    stepId = "",
    expectedConversationId = ""
  ): Promise<{ run: AgentRunState; conflict: boolean }> {
    const latest = await client.getAgentRun(runId);
    const payload = {
      operation_id: `op_inline_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
      expected_version: latest.version,
      ...(expectedConversationId ? { expected_conversation_id: expectedConversationId } : {})
    };
    try {
      const run = action === "pause"
        ? await client.pauseAgentRun(runId, payload)
        : action === "resume"
          ? await client.resumeAgentRun(runId, payload)
          : action === "cancel"
            ? await client.cancelAgentRun(runId, payload)
            : await client.retryAgentRunStep(runId, stepId || latest.current_step_id, payload);
      return { run, conflict: false };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return { run: await client.getAgentRun(runId), conflict: true };
      }
      throw error;
    }
  }

  async function refreshLongTask(runId: string): Promise<LongTaskProgress | null> {
    const run = await client.getAgentRun(runId);
    const events = await client.getAgentRunEvents(runId, 0, 1_000).catch(() => ({ events: [] }));
    const progress = longTaskProgressFromRun(run, events.events);
    if (!progress) {
      return null;
    }
    setLongTasks((current) => {
      const next = current.filter((item) => item.task_id !== progress.task_id);
      return [progress, ...next].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    });
    if (!terminalLongTaskStatuses.has(run.status)) {
      ensureLongTaskSubscription(run.run_id);
    }
    return progress;
  }

  function ensureLongTaskSubscription(runId: string): void {
    if (!runId || longTaskSubscriptionsRef.current.has(runId)) {
      return;
    }
    let unsubscribe: (() => void) | null = null;
    unsubscribe = subscribeConversationPlanRun(
      runId,
      (run) => {
        void refreshLongTask(run.run_id).finally(() => {
          if (terminalLongTaskStatuses.has(run.status)) {
            unsubscribe?.();
            longTaskSubscriptionsRef.current.delete(run.run_id);
          }
        });
      },
      () => undefined
    );
    longTaskSubscriptionsRef.current.set(runId, unsubscribe);
  }

  async function refreshLongTasks(): Promise<LongTaskProgress[]> {
    const listing = await client.listAgentRuns({ limit: 100 });
    const progress = (await Promise.all(
      listing.runs
        .filter((run) => Boolean(workflowSkillIdFromRun(run)))
        .map(async (run) => {
          const events = await client.getAgentRunEvents(run.run_id, 0, 1_000).catch(() => ({ events: [] }));
          return longTaskProgressFromRun(run, events.events);
        })
    )).filter((item): item is LongTaskProgress => Boolean(item));
    setLongTasks(progress.sort((left, right) => right.updated_at.localeCompare(left.updated_at)));
    for (const task of progress) {
      if (!terminalLongTaskStatuses.has(task.status)) {
        ensureLongTaskSubscription(task.task_id);
      }
    }
    return progress;
  }

  async function controlLongTask(
    taskId: string,
    action: "pause" | "resume" | "cancel" | "retry"
  ): Promise<LongTaskProgress | null> {
    try {
      const result = await controlConversationPlanRun(taskId, action);
      const progress = await refreshLongTask(result.run.run_id);
      setOperationsMessage(result.conflict ? "任务状态已刷新，请根据最新状态再次操作。" : "任务控制指令已发送。");
      return progress;
    } catch (error) {
      setOperationsMessage(describeActionableError(error, "任务控制失败", "请刷新任务状态后重试。"));
      return null;
    }
  }

  async function createConversation() {
    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.createConversation();
      const defaults: ConversationModelPreferences = { model_override: "", reasoning_enabled: false, reasoning_effort: "medium" };
      conversationModelPreferencesRef.current = defaults;
      setConversationModelPreferences(defaults);
      const list = await client.getConversations();
      setConversationDetail(detail);
      setSnapshot((current) => (current ? { ...current, conversations: assistantConversations(list) } : current));
      setActiveTab("conversations");
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "新建对话失败"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function updateConversationModelPreferences(
    nextPreferences: ConversationModelPreferences
  ): Promise<boolean> {
    if (sendingMessage || conversationBusy || conversationModelPreferenceBusy) {
      return false;
    }
    const normalized: ConversationModelPreferences = {
      model_override: nextPreferences.model_override.trim(),
      reasoning_enabled: Boolean(nextPreferences.reasoning_enabled),
      reasoning_effort: nextPreferences.reasoning_effort
    };
    const previous = conversationModelPreferencesRef.current;
    conversationModelPreferencesRef.current = normalized;
    setConversationModelPreferences(normalized);

    const conversationId = conversationDetail?.id || "";
    if (!conversationId) {
      setConversationMessage("模型偏好将在首次发送时保存到新会话。");
      return true;
    }

    setConversationModelPreferenceBusy(true);
    setConversationDetail((current) => current?.id === conversationId ? { ...current, ...normalized } : current);
    patchConversationSummary(conversationId, (item) => ({ ...item, ...normalized }));
    setConversationMessage("");
    try {
      const detail = await client.updateConversationModelPreferences(conversationId, normalized);
      setConversationDetail((current) => current?.id === conversationId ? detail : current);
      patchConversationSummary(conversationId, (item) => ({
        ...item,
        model_override: detail.model_override,
        reasoning_enabled: detail.reasoning_enabled,
        reasoning_effort: detail.reasoning_effort,
        updated_at: detail.updated_at
      }));
      setConversationMessage(normalized.model_override ? "本会话模型偏好已保存。" : "本会话已恢复跟随默认模型。");
      return true;
    } catch (nextError) {
      conversationModelPreferencesRef.current = previous;
      setConversationModelPreferences(previous);
      setConversationDetail((current) => current?.id === conversationId ? { ...current, ...previous } : current);
      patchConversationSummary(conversationId, (item) => ({ ...item, ...previous }));
      setConversationMessage(describeActionableError(nextError, "模型偏好保存失败", "已恢复为保存前的选择，请重试。"));
      return false;
    } finally {
      setConversationModelPreferenceBusy(false);
    }
  }

  async function updateConversationModelAndDefault(
    modelId: string,
    nextPreferences: ConversationModelPreferences
  ): Promise<boolean> {
    const normalizedModel = modelId.trim();
    const baseConfig = configDraft;
    if (!normalizedModel || !baseConfig) {
      setConversationMessage("模型选择失败：没有可保存的模型或配置。");
      return false;
    }
    const previous = conversationModelPreferencesRef.current;
    const conversationSaved = await updateConversationModelPreferences({
      ...nextPreferences,
      model_override: normalizedModel
    });
    if (!conversationSaved) return false;

    const mode = baseConfig.ai_config_mode === "website" ? "website" : "manual";
    const globalSaved = mode === "website"
      ? await applyWebsiteAiConfig({
          model: normalizedModel,
          embedding_model: baseConfig.website_profile?.embedding_model || "",
          temp: baseConfig.website_profile?.temp ?? baseConfig.temp ?? 0.7,
          top_p: baseConfig.website_profile?.top_p ?? baseConfig.top_p ?? 1
        })
      : await patchAndSaveConfig({
          manual_profile: normalizeConfigDraft({
            ...baseConfig,
            manual_profile: { ...baseConfig.manual_profile, model: normalizedModel } as AiConfigProfile
          }).manual_profile!
        }, "");

    if (!globalSaved) {
      await updateConversationModelPreferences(previous);
      setConversationMessage("模型未设为全局默认，已恢复保存前的会话选择。请检查连接或登录状态后重试。");
      return false;
    }
    setConversationMessage("已设为当前会话模型和全局默认。其他 AI 功能将使用这个模型。");
    return true;
  }

  async function updateConversationTitle(title: string, conversationId = conversationDetail?.id || "") {
    if (!conversationId) {
      return;
    }

    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.updateConversationTitle(conversationId, title);
      if (conversationDetail?.id === detail.id) {
        applyConversationDetail(detail);
      } else {
        patchConversationSummary(detail.id, (item) => ({
          ...item,
          title: detail.title,
          updated_at: detail.updated_at,
          current_skill: detail.current_skill,
          current_agent: detail.current_agent,
          message_count: detail.message_count,
          attachment_count: detail.attachment_count
        }));
      }
      setConversationMessage("会话标题已更新。");
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "更新会话标题失败", "标题不能为空，最多保留 80 个字符。"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function deleteConversation(conversationId = conversationDetail?.id || "") {
    if (!conversationId) {
      return false;
    }
    setConversationBusy(true);
    setConversationMessage("");
    try {
      await client.deleteConversation(conversationId);
      const list = await client.getConversations();
      setSnapshot((current) => (current ? { ...current, conversations: assistantConversations(list) } : current));
      if (conversationDetail?.id === conversationId) {
        if (list[0]?.id) {
          const next = await client.getConversation(list[0].id);
          setConversationDetail(next);
        } else {
          setConversationDetail(null);
        }
      }
      setConversationMessage("会话已删除。");
      return true;
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "删除会话失败", "请刷新会话列表后重试。"));
      return false;
    } finally {
      setConversationBusy(false);
    }
  }

  async function summarizeConversation(useModel = false) {
    if (!conversationDetail?.id) {
      return;
    }

    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.summarizeConversation(conversationDetail.id, useModel);
      applyConversationDetail(detail);
      setConversationMessage(useModel ? "会话摘要已刷新；如果副模型不可用，会自动使用本地摘要。" : "会话摘要已刷新。");
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "刷新会话摘要失败", "请确认会话仍存在后重试。"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function pinCurrentDocumentToConversation() {
    if (!activeDocumentPathRef.current) {
      setConversationMessage("请先打开一个文档。");
      return;
    }

    setConversationBusy(true);
    setConversationMessage("");
    try {
      const conversationId = await ensureConversationId();
      const detail = await client.pinConversationContext(conversationId, {
        kind: "document",
        path: activeDocumentPathRef.current
      });
      applyConversationDetail(detail);
      setConversationMessage(`已固定当前文档：${activeDocumentPathRef.current}`);
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "固定当前文档失败", "请确认该文档仍存在后重试。"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function pinTextToConversation(content: string) {
    if (!conversationDetail?.id) {
      return;
    }
    const text = content.trim();
    if (!text) {
      setConversationMessage("请先输入要固定的上下文文本。");
      return;
    }

    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.pinConversationContext(conversationDetail.id, {
        kind: "text",
        content: text,
        label: text.slice(0, 30)
      });
      applyConversationDetail(detail);
      setConversationMessage("文本上下文已固定。");
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "固定文本上下文失败", "请缩短文本或刷新会话后重试。"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function removePinnedConversationContext(itemId: string) {
    if (!conversationDetail?.id || !itemId) {
      return;
    }

    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.removeConversationPinnedContext(conversationDetail.id, itemId);
      applyConversationDetail(detail);
      setConversationMessage("固定上下文已移除。");
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "移除固定上下文失败", "请刷新会话详情后重试。"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function uploadConversationAttachment(input: File | File[] | FileList | null) {
    const files = input instanceof File ? [input] : Array.from(input || []);
    if (!files.length) {
      return;
    }

    setUploadingAttachment(true);
    setConversationMessage("");
    try {
      const conversationId = await ensureConversationId();
      const attachments: ConversationAttachment[] = [];
      for (const file of files) {
        attachments.push(await client.uploadConversationAttachment(conversationId, file, file.name || "attachment.txt"));
      }
      const detail = await client.getConversation(conversationId);
      const conversations = await client.getConversations();
      setConversationDetail(detail);
      setSnapshot((current) => (current ? { ...current, conversations } : current));
      setActiveTab("conversations");
      setConversationMessage(
        attachments.length === 1
          ? `已上传附件：${attachments[0]!.name}，发送消息时会作为上下文一起使用。`
          : `已上传 ${attachments.length} 个附件，发送消息时会作为上下文一起使用。`
      );
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "上传附件失败", "请确认文件可读取后重新上传。"));
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function uploadWorkflowAttachment(
    file: File | null,
    options: { conversationId?: string; bookTitle?: string } = {}
  ): Promise<(ConversationAttachment & { conversation_id: string }) | null> {
    if (!file) {
      return null;
    }

    setUploadingAttachment(true);
    setOperationsMessage("");
    try {
      const title = options.bookTitle?.trim() || file.name.replace(/\.[^.]+$/, "").trim() || file.name;
      const conversationId = options.conversationId || (await createTaskConversation({
        type: "disassembly",
        title: `拆书 · 《${title}》`,
        skillId: "disassemble_book",
        entry: "import_source",
        sourcePath: file.name,
        targetPaths: ["00_设定集/拆书库"]
      })).id;
      const attachment = await client.uploadConversationAttachment(conversationId, file, file.name || "attachment.txt");
      setOperationsMessage(`已上传拆书文件：${attachment.name}`);
      return { ...attachment, conversation_id: conversationId };
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "上传拆书文件失败", "请确认文件可读取后重新上传。"));
      return null;
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function refreshDisassemblyLibrary(): Promise<DisassemblyBookSummary[]> {
    if (!snapshot?.currentProject.path) {
      setDisassemblyBooks([]);
      return [];
    }

    setDisassemblyLibraryBusy(true);
    try {
      const result = await client.runSkill("disassemble_book", {
        text: "",
        chapter: 0,
        end_chapter: 0,
        target_words: 2500,
        instruction: "",
        target_path: "",
        conversation_id: "",
        source_path: "",
        write_result: false,
        attachment_ids: [],
        action: "list_library"
      } as any);
      const books = readDisassemblyBooksFromUnknown(result.data?.books);
      setDisassemblyBooks(books);
      return books;
    } catch {
      setDisassemblyBooks([]);
      return [];
    } finally {
      setDisassemblyLibraryBusy(false);
    }
  }

  async function archiveDisassemblySource(
    attachmentId: string,
    bookTitle = "",
    taskConversationId = ""
  ): Promise<DisassemblyBookSummary | null> {
    if (!attachmentId) {
      return null;
    }

    setOperationsBusy(true);
    setOperationsMessage("拆书导入：正在归档原文...");
    try {
      const conversationId = taskConversationId || (await createTaskConversation({
        type: "disassembly",
        title: `拆书 · 《${bookTitle || "未命名作品"}》`,
        skillId: "disassemble_book",
        entry: "archive_source",
        sourceBookId: "",
        targetPaths: ["00_设定集/拆书库"]
      })).id;
      const result = await client.runSkill("disassemble_book", {
        text: "",
        chapter: 0,
        end_chapter: 0,
        target_words: 2500,
        instruction: "",
        target_path: "",
        conversation_id: conversationId,
        source_path: "",
        write_result: true,
        attachment_ids: [attachmentId],
        action: "archive_source",
        book_title: bookTitle
      } as any);
      const book = readDisassemblyBookFromUnknown(result.data?.book);
      const books = readDisassemblyBooksFromUnknown(result.data?.books);
      if (books.length) {
        setDisassemblyBooks(books);
      } else {
        await refreshDisassemblyLibrary();
      }
      setLatestSkillResult(result);
      setOperationsMessage(book ? `已创建拆书目录：${book.title}` : "已创建拆书目录");
      await refreshProjectChrome();
      return book;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "创建拆书目录失败", "请确认上传文件可读取后重试。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function deleteConversationAttachment(attachmentId: string) {
    if (!conversationDetail?.id || !attachmentId) {
      return;
    }

    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.deleteConversationAttachment(conversationDetail.id, attachmentId);
      const conversations = await client.getConversations();
      setConversationDetail(detail);
      setSnapshot((current) => (current ? { ...current, conversations } : current));
      setConversationMessage("附件已移除，本次后续消息不会再包含它。");
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "删除附件失败", "请刷新会话详情后重试。"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function createProjectTreeFile(directoryPath: string, fileNameInput: string): Promise<boolean> {
    if (!snapshot?.currentProject.path) {
      setProjectMessage("先打开一个项目，再在项目树中新建文件。");
      return false;
    }

    let targetPath = "";
    try {
      targetPath = childProjectPath(directoryPath, normalizeNewProjectFileName(fileNameInput));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setProjectMessage(message);
      return false;
    }

    if (treePathExists(snapshot.projectChrome.tree, targetPath)) {
      setProjectMessage(`文件已存在：${targetPath}`);
      return false;
    }
    const existingDocument = await client.getDocument(targetPath).catch(() => null);
    if (existingDocument) {
      setProjectMessage(`文件已存在：${targetPath}`);
      return false;
    }

    setProjectBusy(true);
    setProjectMessage("");
    setDocumentMessage("");
    try {
      const saved = await client.saveDocument(targetPath, "");
      await refreshProjectChrome();
      await openDocument(saved.path, { forceReload: true, discardDirty: true, activate: true });
      setProjectMessage(`已创建文件：${saved.path}`);
      setDocumentMessage(`已创建文件：${saved.path}`);
      return true;
    } catch (nextError) {
      const message = describeActionableError(nextError, "创建文件失败", "请确认文件名有效且项目目录允许写入。");
      setProjectMessage(message);
      setDocumentMessage(message);
      return false;
    } finally {
      setProjectBusy(false);
    }
  }

  async function deleteProjectTreeFile(path: string): Promise<boolean> {
    if (!snapshot?.currentProject.path) {
      setProjectMessage("先打开一个项目，再删除项目树文件。");
      return false;
    }
    const targetPath = String(path || "").trim();
    if (!targetPath) {
      setProjectMessage("请选择要删除的文件。");
      return false;
    }
    const openTarget = openDocumentsRef.current.find((item) => item.path === targetPath);
    if (openTarget?.dirty) {
      setActiveDocumentPath(targetPath);
      setActiveTab("editor");
      setDocumentMessage(`${targetPath} 还有未保存修改，请先保存或关闭草稿后再删除。`);
      return false;
    }

    setProjectBusy(true);
    setProjectMessage("");
    setDocumentMessage("");
    try {
      const result = await client.deleteDocument(targetPath, true);
      await refreshProjectChrome();
      setPendingCloseRequest((current) => (current?.path === targetPath ? null : current));
      setPendingReloadRequest((current) => (current?.path === targetPath ? null : current));
      setPendingSaveConflictRequest((current) => (current?.path === targetPath ? null : current));
      setOpenDocuments((current) => {
        const remaining = current.filter((item) => item.path !== targetPath);
        if (activeDocumentPathRef.current === targetPath) {
          setActiveDocumentPath(remaining.at(-1)?.path || "");
        }
        return remaining;
      });
      const message = `已删除文件：${result.path}，已归档到 ${result.archived_path}`;
      setProjectMessage(message);
      setDocumentMessage(message);
      return true;
    } catch (nextError) {
      const message = describeActionableError(nextError, "删除文件失败", "请刷新项目树后确认文件仍存在。");
      setProjectMessage(message);
      setDocumentMessage(message);
      return false;
    } finally {
      setProjectBusy(false);
    }
  }

  async function openDocument(path: string, options: OpenDocumentOptions = {}): Promise<boolean> {
    const existing = openDocumentsRef.current.find((item) => item.path === path);
    const shouldActivate = options.activate ?? true;

    if (existing && !options.forceReload) {
      if (shouldActivate) {
        activeDocumentOpenRequestRef.current += 1;
        activeDocumentPathRef.current = path;
        setActiveDocumentPath(path);
        setActiveTab("editor");
      }
      return true;
    }
    if (existing?.dirty && options.forceReload && !options.discardDirty) {
      setOpenDocuments((current) => markDocumentStale(current, path));
      setDocumentMessage(`${path} 已在后台更新，但当前标签还有未保存修改，暂时没有覆盖本地草稿。`);
      if (shouldActivate) {
        setActiveDocumentPath(path);
        setActiveTab("editor");
      }
      return false;
    }

    const previousActivePath = activeDocumentPathRef.current;
    const activeOpenRequest = shouldActivate ? activeDocumentOpenRequestRef.current + 1 : 0;
    if (shouldActivate) {
      activeDocumentOpenRequestRef.current = activeOpenRequest;
      activeDocumentPathRef.current = "";
      setActiveDocumentPath("");
      setActiveTab("editor");
    }

    setDocumentBusy(true);
    setDocumentMessage("");
    try {
      const document = await client.getDocument(path);
      if (shouldActivate && activeOpenRequest !== activeDocumentOpenRequestRef.current) {
        return false;
      }
      setOpenDocuments((current) => {
        const nextTab = {
          path: document.path,
          title: document.path.split("/").pop() || document.path,
          content: document.content,
          updatedAt: document.updated_at,
          updatedAtMs: document.updated_at_ms,
          chars: document.content.length,
          dirty: false,
          saving: false,
          stale: false
        };
        const existingIndex = current.findIndex((item) => item.path === document.path);
        if (existingIndex >= 0) {
          return current.map((item) => (item.path === document.path ? nextTab : item));
        }
        return [...current, nextTab];
      });
      if (shouldActivate) {
        activeDocumentPathRef.current = document.path;
        setActiveDocumentPath(document.path);
        setActiveTab("editor");
      }
      return true;
    } catch (nextError) {
      if (shouldActivate && activeOpenRequest === activeDocumentOpenRequestRef.current) {
        activeDocumentPathRef.current = previousActivePath;
        setActiveDocumentPath(previousActivePath);
      }
      setDocumentMessage(describeActionableError(nextError, "打开文档失败"));
      return false;
    } finally {
      if (!shouldActivate || activeOpenRequest === activeDocumentOpenRequestRef.current) {
        setDocumentBusy(false);
      }
    }
  }

  function activateDocument(path: string) {
    activeDocumentOpenRequestRef.current += 1;
    activeDocumentPathRef.current = path;
    setActiveDocumentPath(path);
    setActiveTab("editor");
  }

  function closeDocument(path: string) {
    const target = openDocumentsRef.current.find((item) => item.path === path);
    if (target?.dirty) {
      setPendingReloadRequest((current) => (current?.path === path ? null : current));
      setPendingCloseRequest({
        path: target.path,
        title: target.title
      });
      setDocumentMessage(`${target.path} 还有未保存修改，确认后才会关闭。`);
      setActiveDocumentPath(path);
      setActiveTab("editor");
      return;
    }

    setPendingCloseRequest((current) => (current?.path === path ? null : current));
    setPendingReloadRequest((current) => (current?.path === path ? null : current));
    setPendingSaveConflictRequest((current) => (current?.path === path ? null : current));
    setOpenDocuments((current) => {
      const remaining = current.filter((item) => item.path !== path);
      if (activeDocumentPathRef.current === path) {
        setActiveDocumentPath(remaining.at(-1)?.path || "");
      }
      return remaining;
    });
  }

  function updateActiveDocument(content: string) {
    const targetPath = activeDocumentPathRef.current;
    if (!targetPath) {
      return;
    }

    setPendingReloadRequest((current) => (current?.path === targetPath ? null : current));
    setOpenDocuments((current) =>
      current.map((item) =>
        item.path === targetPath
          ? {
              ...item,
              content,
              chars: content.length,
              dirty: true
            }
          : item
      )
    );
  }

  function cancelCloseDocument() {
    setPendingCloseRequest(null);
    setDocumentMessage((current) => (current.includes("确认后才会关闭") ? "已保留当前标签，继续编辑即可。" : current));
  }

  function cancelReloadDocument() {
    setPendingReloadRequest(null);
    setDocumentMessage((current) => (current.includes("确认后才会读取磁盘最新版") ? "已保留当前本地草稿，继续编辑即可。" : current));
  }

  function confirmCloseDocument() {
    const request = pendingCloseRequest;
    if (!request) {
      return;
    }

    setPendingCloseRequest(null);
    setPendingReloadRequest((current) => (current?.path === request.path ? null : current));
    setPendingSaveConflictRequest((current) => (current?.path === request.path ? null : current));
    setDocumentMessage(`已关闭 ${request.path}，未保存草稿没有写回磁盘。`);
    setOpenDocuments((current) => {
      const remaining = current.filter((item) => item.path !== request.path);
      if (activeDocumentPathRef.current === request.path) {
        setActiveDocumentPath(remaining.at(-1)?.path || "");
      }
      return remaining;
    });
  }

  async function reopenDocumentFromDisk(path = activeDocumentPathRef.current) {
    if (!path) {
      return;
    }

    const target = openDocumentsRef.current.find((item) => item.path === path);
    if (target?.dirty) {
      setPendingCloseRequest(null);
      setPendingReloadRequest({
        path: target.path,
        title: target.title
      });
      setDocumentMessage(`${target.path} 还有未保存修改，确认后才会读取磁盘最新版。`);
      setActiveDocumentPath(path);
      setActiveTab("editor");
      return;
    }

    await openDocument(path, {
      forceReload: true,
      discardDirty: true,
      activate: true
    });
    setPendingSaveConflictRequest((current) => (current?.path === path ? null : current));
    setDocumentMessage(`已从磁盘重新载入 ${path}`);
  }

  async function confirmReloadDocument() {
    const request = pendingReloadRequest;
    if (!request) {
      return;
    }

    setPendingReloadRequest(null);
    await openDocument(request.path, {
      forceReload: true,
      discardDirty: true,
      activate: true
    });
    setPendingSaveConflictRequest((current) => (current?.path === request.path ? null : current));
    setDocumentMessage(`已从磁盘重新载入 ${request.path}，本地未保存草稿已丢弃。`);
  }

  async function saveActiveDocument(options: { force?: boolean; path?: string } = {}): Promise<"saved" | "conflict" | "failed" | "missing"> {
    const targetPath = options.path || activeDocumentPathRef.current;
    const activeDocument = openDocumentsRef.current.find((item) => item.path === targetPath);
    if (!activeDocument) {
      return "missing";
    }

    if (activeDocument.stale && !options.force) {
      setPendingSaveConflictRequest({
        path: activeDocument.path,
        title: activeDocument.title,
        currentUpdatedAt: ""
      });
      setDocumentMessage(`${activeDocument.path} 磁盘已有后台更新，普通保存已暂停。请读取最新版或确认覆盖。`);
      setActiveTab("editor");
      return "conflict";
    }

    setDocumentBusy(true);
    setDocumentMessage("");
    setOpenDocuments((current) => current.map((item) => (item.path === activeDocument.path ? { ...item, saving: true } : item)));

    try {
      const saved = await client.saveDocument(activeDocument.path, activeDocument.content, {
        baseUpdatedAt: activeDocument.updatedAt,
        baseUpdatedAtMs: activeDocument.updatedAtMs,
        force: options.force
      });
      setOpenDocuments((current) =>
        applyDocumentContent(current, saved.path, {
          content: saved.content,
          updatedAt: saved.updated_at,
          updatedAtMs: saved.updated_at_ms
        })
      );
      setPendingSaveConflictRequest((current) => (current?.path === saved.path ? null : current));
      await refreshProjectChrome();
      setDocumentMessage(options.force ? `已确认覆盖并保存 ${saved.path}` : `已保存 ${saved.path}`);
      return "saved";
    } catch (nextError) {
      if (isSaveConflictError(nextError)) {
        setPendingSaveConflictRequest({
          path: activeDocument.path,
          title: activeDocument.title,
          currentUpdatedAt: conflictCurrentUpdatedAt(nextError)
        });
        setOpenDocuments((current) => current.map((item) => (item.path === activeDocument.path ? { ...item, saving: false, stale: true } : item)));
        setDocumentMessage(`${activeDocument.path} 磁盘已有新版，已暂停保存以避免覆盖。`);
        setActiveTab("editor");
        return "conflict";
      }
      setDocumentMessage(describeActionableError(nextError, "保存文档失败", "请确认目标文档仍存在，然后重试保存。"));
      setOpenDocuments((current) => current.map((item) => (item.path === activeDocument.path ? { ...item, saving: false } : item)));
      return "failed";
    } finally {
      setDocumentBusy(false);
    }
  }

  async function saveActiveDocumentCopy(): Promise<string> {
    const active = getActiveDocument();
    if (!active) {
      setDocumentMessage("请先打开要另存的文档。");
      return "";
    }
    const extensionMatch = /^(.*?)(\.[^./\\]+)?$/.exec(active.path);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\.\d{3}Z$/, "");
    const targetPath = `${extensionMatch?.[1] || active.path}-副本-${stamp}${extensionMatch?.[2] || ""}`;
    setDocumentBusy(true);
    try {
      const saved = await client.saveDocument(targetPath, active.content);
      await refreshProjectChrome();
      await openDocument(saved.path, { forceReload: true, discardDirty: true, activate: true });
      setPendingSaveConflictRequest(null);
      setDocumentMessage(`已另存为副本：${saved.path}`);
      return saved.path;
    } catch (nextError) {
      setDocumentMessage(describeActionableError(nextError, "另存副本失败", "请确认项目目录可写后重试。"));
      return "";
    } finally {
      setDocumentBusy(false);
    }
  }

  async function saveAllDocuments() {
    const dirtyPaths = openDocumentsRef.current.filter((item) => item.dirty).map((item) => item.path);
    if (!dirtyPaths.length) {
      setDocumentMessage("没有需要保存的文档。");
      return;
    }

    let savedCount = 0;
    for (const path of dirtyPaths) {
      const result = await saveActiveDocument({ path });
      if (result !== "saved") {
        if (savedCount > 0) {
          setDocumentMessage(`已保存 ${savedCount} 个文档；${path} 尚未保存，请先处理当前错误或冲突。`);
        }
        return;
      }
      savedCount += 1;
    }
    setDocumentMessage(`已保存全部 ${savedCount} 个文档。`);
  }

  function cancelSaveConflict() {
    setPendingSaveConflictRequest(null);
    setDocumentMessage("已保留当前本地草稿，普通保存仍会等待你处理磁盘新版。");
  }

  async function confirmSaveOverwrite() {
    const request = pendingSaveConflictRequest;
    if (!request) {
      return;
    }
    setActiveDocumentPath(request.path);
    await saveActiveDocument({ force: true, path: request.path });
  }

  async function rollbackTimelineEntry(entryId: string, confirmDelete = false) {
    if (!entryId) {
      return;
    }

    setDocumentBusy(true);
    setDocumentMessage("");
    try {
      const result = await client.rollbackTimelineEntry(entryId, confirmDelete);
      if (result.requires_confirmation) {
        setDocumentMessage(`${result.message} 如确认要删除本次新增文件，请再次点击“确认回滚”。`);
        setActiveTab("editor");
        return;
      }
      const changedPaths = timelineChangedPaths(result.entry);
      await refreshProjectChrome();
      if (changedPaths.length) {
        setOpenDocuments((current) => changedPaths.reduce((next, path) => markDocumentStale(next, path), current));
      }
      setActiveTab("editor");
      setDocumentMessage(changedPaths.length ? `已回滚，受影响文件已标记为需要读取最新版：${changedPaths.join("、")}` : result.message);
    } catch (nextError) {
      setDocumentMessage(describeActionableError(nextError, "回滚时间线失败", "请刷新时间线后重试。"));
    } finally {
      setDocumentBusy(false);
    }
  }

  async function clearRevisionLog(confirmDelete = false) {
    setProjectBusy(true);
    setProjectMessage("");
    try {
      await client.clearRevisionLog(confirmDelete);
      setSnapshot((current) => (current ? { ...current, revisionLog: [] } : current));
      setActiveTab("overview");
      setProjectMessage("修正日志已清空。");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "清空修正日志失败", "清空日志需要确认后再执行。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function addLedgerItem(desc: string) {
    const text = desc.trim();
    if (!text) {
      setProjectMessage("请先输入伏笔内容。");
      return;
    }

    setProjectBusy(true);
    setProjectMessage("");
    try {
      const item = await client.addLedgerItem(text);
      setSnapshot((current) => (current ? { ...current, ledger: [item, ...current.ledger] } : current));
      setActiveTab("overview");
      setProjectMessage("伏笔已加入账本。");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "新增伏笔失败", "请确认已打开项目后重试。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function toggleLedgerItem(itemId: string) {
    if (!itemId) {
      return;
    }

    setProjectBusy(true);
    setProjectMessage("");
    try {
      const item = await client.toggleLedgerItem(itemId);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              ledger: current.ledger.map((existing) => (existing.id === item.id ? item : existing))
            }
          : current
      );
      setActiveTab("overview");
      setProjectMessage(item.status === "closed" ? "伏笔已标记为已回收。" : "伏笔已重新打开。");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "更新伏笔状态失败", "请刷新工作台后重试。"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function selectSkill(skillId: string, options: { activateTab?: boolean } = {}) {
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.getSkill(skillId);
      setSelectedSkillId(skillId);
      setSelectedSkillDetail(skill);
      setLatestSkillResult(null);
      setPendingSkillPatchPreview(null);
      setSelectedSkillVersions([]);
      if (options.activateTab ?? true) {
        setActiveTab("operations");
      }
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "读取技能详情失败"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function importSkillFromPath(skillPath: string) {
    const path = skillPath.trim();
    if (!path) {
      setOperationsMessage("请输入本地 Skill 路径。");
      return;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.importSkill(path);
      await refreshSkillCatalog();
      await selectSkill(skill.id, { activateTab: true });
      setOperationsMessage(`已导入技能：${skill.name}`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "导入技能失败", "请确认路径内存在 SKILL.md，或直接选择 SKILL.md 文件。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function uploadSkillFile(file: File) {
    if (!file) {
      return;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.uploadSkill(file, file.name || "SKILL.md");
      await refreshSkillCatalog();
      await selectSkill(skill.id, { activateTab: true });
      setOperationsMessage(`已上传导入技能：${skill.name}`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "上传技能失败", "只支持 SKILL.md、Markdown、txt 或 zip。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function draftSkillPreview(input: SkillDraftPreviewInput) {
    const kind = input.kind || (input.url?.trim() ? "url" : "instruction");
    const instruction = (input.instruction || "").trim();
    const targetName = (input.targetName || "").trim();
    const targetId = (input.targetId || "").trim();
    const url = (input.url || "").trim();
    const explicitText = input.text || "";
    const activeDocument = getActiveDocument();

    if (kind === "url" && !url) {
      setOperationsMessage("请输入技能链接。");
      return null;
    }
    if (kind === "current_document" && !activeDocument?.path) {
      const message = "请先打开一个文档，再根据当前文档生成技能草稿。";
      setOperationsMessage(message);
      setDocumentMessage(message);
      setActiveTab("editor");
      return null;
    }
    if (kind !== "url" && kind !== "current_document" && !instruction && !explicitText.trim() && !targetName) {
      setOperationsMessage("请输入技能说明或技能名。");
      return null;
    }

    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const text = kind === "current_document" ? "" : explicitText;
      const draft = await client.draftSkill({
        kind,
        instruction,
        text,
        url,
        current_path: activeDocument?.path || "",
        selection: kind === "selection" ? text : "",
        attachment_ids: [],
        source_skill_id: input.sourceSkillId || "",
        target_name: targetName,
        target_id: targetId
      });
      setPendingSkillDraft(draft);
      setOperationsMessage(`已生成技能草稿：${draft.skill.name}。请预览后导入。`);
      return draft;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "生成技能草稿失败", "请确认模型配置可用，或改用更具体的技能说明。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function importPendingSkillDraft() {
    if (!pendingSkillDraft) {
      setOperationsMessage("当前没有待导入的技能草稿。");
      return null;
    }

    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.importSkillDraft(pendingSkillDraft);
      setPendingSkillDraft(null);
      await refreshSkillCatalog();
      await selectSkill(skill.id, { activateTab: true });
      setOperationsMessage(`已导入技能：${skill.name}`);
      return skill;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "导入技能草稿失败", "草稿仍保留，可调整后重试。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  function discardPendingSkillDraft() {
    if (!pendingSkillDraft) {
      return;
    }
    setPendingSkillDraft(null);
    setOperationsMessage("已丢弃技能草稿。");
  }

  async function importSkillFromUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
      setOperationsMessage("请输入技能链接。");
      return;
    }
    await draftSkillPreview({ kind: "url", url: trimmed });
  }

  async function openSkillFolder() {
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const result = await client.openSkillFolder();
      setOperationsMessage(`已打开技能目录：${result.path}`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "打开技能目录失败"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function deleteOrDisableSelectedSkill() {
    if (!selectedSkillDetail) {
      setOperationsMessage("请先选择一个技能。");
      return;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      if (selectedSkillDetail.builtin) {
        const disabled = !selectedSkillDetail.disabled;
        const skill = await client.toggleSkill(selectedSkillDetail.id, disabled);
        const skills = await refreshSkillCatalog();
        setSelectedSkillDetail(skill);
        setSelectedSkillId(skill.id);
        setOperationsMessage(disabled ? `默认技能已禁用：${skill.name}。AI 会自动尝试调用相近的可用技能。` : `默认技能已恢复：${skill.name}`);
        if (!skills.some((item) => item.id === skill.id)) {
          setSelectedSkillId("");
          setSelectedSkillDetail(null);
        }
        return;
      }

      const result = await client.deleteSkill(selectedSkillDetail.id);
      const skills = await refreshSkillCatalog();
      const nextSkill = skills.find((skill) => !skill.disabled) || skills[0] || null;
      if (nextSkill) {
        await selectSkill(nextSkill.id, { activateTab: false });
      } else {
        setSelectedSkillId("");
        setSelectedSkillDetail(null);
      }
      setOperationsMessage(result.deleted ? "已删除导入技能。" : "技能已处理。");
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "处理技能失败"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function setSkillEnabled(skillId: string, enabled: boolean): Promise<boolean> {
    const id = skillId.trim();
    if (!id) return false;
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.toggleSkill(id, !enabled);
      await refreshSkillCatalog();
      if (selectedSkillId === id || selectedSkillDetail?.id === id) setSelectedSkillDetail(skill);
      setOperationsMessage(`${skill.name}已${enabled ? "启用" : "禁用"}。`);
      return true;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, `${enabled ? "启用" : "禁用"}技能失败`));
      return false;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function restoreSelectedBuiltinSkill() {
    if (!selectedSkillDetail?.builtin) {
      return;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.toggleSkill(selectedSkillDetail.id, false);
      await refreshSkillCatalog();
      setSelectedSkillDetail(skill);
      setSelectedSkillId(skill.id);
      setOperationsMessage(`默认技能已恢复：${skill.name}`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "恢复默认技能失败"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function updateSkillDescription(skillId: string, description: string) {
    const id = skillId.trim();
    if (!id) {
      return null;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.updateSkillDescription(id, { description });
      await refreshSkillCatalog();
      if (selectedSkillId === skill.id || selectedSkillDetail?.id === skill.id) {
        setSelectedSkillId(skill.id);
        setSelectedSkillDetail(skill);
      }
      setOperationsMessage(`技能简介已保存：${skill.name}。AI 调用时会参考这段说明。`);
      return skill;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "保存技能简介失败", "默认技能不可编辑简介，导入技能可直接修改。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function cloneSelectedSkill(input: { targetName?: string; targetId?: string; instruction?: string } = {}) {
    if (!selectedSkillDetail) {
      setOperationsMessage("请先选择一个技能。");
      return null;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const skill = await client.cloneSkill(selectedSkillDetail.id, {
        target_name: input.targetName || "",
        target_id: input.targetId || "",
        instruction: input.instruction || ""
      });
      setPendingSkillPatchPreview(null);
      setSelectedSkillVersions([]);
      await refreshSkillCatalog();
      await selectSkill(skill.id, { activateTab: true });
      setOperationsMessage(`已复制为自定义技能：${skill.name}`);
      return skill;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "复制技能失败", "默认技能可复制为自定义技能后再编辑。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function previewSelectedSkillPatch(patch: Partial<SkillPatchRequest>) {
    if (!selectedSkillDetail) {
      setOperationsMessage("请先选择一个技能。");
      return null;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const expectedVersion = selectedSkillDetail.version || selectedSkillDetail.manifest?.version || "";
      const request: SkillPatchRequest = {
        ...patch,
        change_reason: patch.change_reason || "",
        expected_version: patch.expected_version || expectedVersion,
        dry_run: true
      };
      const response = await client.patchSkill(selectedSkillDetail.id, request);
      setPendingSkillPatchPreview({ skillId: selectedSkillDetail.id, request, response });
      setOperationsMessage(response.diff ? `已生成修改预览：${selectedSkillDetail.name}` : "没有检测到可保存的修改。");
      return response;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "生成技能修改预览失败", "默认技能不可原地编辑，请先复制为自定义技能。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function commitPendingSkillPatch() {
    if (!pendingSkillPatchPreview) {
      setOperationsMessage("当前没有待确认的技能修改。");
      return null;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const request: SkillPatchRequest = {
        ...pendingSkillPatchPreview.request,
        dry_run: false
      };
      const response = await client.patchSkill(pendingSkillPatchPreview.skillId, request);
      setPendingSkillPatchPreview(null);
      await refreshSkillCatalog();
      await selectSkill(response.skill.id, { activateTab: true });
      await loadSkillVersions(response.skill.id);
      setOperationsMessage(response.diff ? `技能修改已保存：${response.skill.name}` : "技能没有变化，不需要保存。");
      return response;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "保存技能修改失败", "请刷新技能详情后重新预览修改。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  function discardPendingSkillPatch() {
    if (!pendingSkillPatchPreview) {
      return;
    }
    setPendingSkillPatchPreview(null);
    setOperationsMessage("已丢弃技能修改预览。");
  }

  async function loadSkillVersions(skillId = selectedSkillId) {
    const id = skillId.trim();
    if (!id) {
      setSelectedSkillVersions([]);
      return [];
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const response = await client.getSkillVersions(id);
      setSelectedSkillVersions(response.versions);
      setOperationsMessage(response.versions.length ? `已读取 ${response.versions.length} 个历史版本。` : "这个技能还没有历史版本。");
      return response.versions;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "读取技能版本失败"));
      return [];
    } finally {
      setOperationsBusy(false);
    }
  }

  async function rollbackSelectedSkill(versionId: string) {
    if (!selectedSkillDetail) {
      setOperationsMessage("请先选择一个技能。");
      return null;
    }
    const id = versionId.trim();
    if (!id) {
      setOperationsMessage("请选择要回滚的版本。");
      return null;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const response = await client.rollbackSkill(selectedSkillDetail.id, {
        version_id: id,
        change_reason: "workbench rollback"
      });
      setPendingSkillPatchPreview(null);
      await refreshSkillCatalog();
      await selectSkill(response.skill.id, { activateTab: true });
      await loadSkillVersions(response.skill.id);
      setOperationsMessage(`已回滚技能：${response.skill.name}`);
      return response;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "回滚技能失败", "默认技能不可回滚，导入技能需先有版本历史。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function selectJob(jobId: string, options: { activateTab?: boolean } = {}) {
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const job = await client.getJob(jobId);
      setSelectedJobId(jobId);
      setSelectedJobDetail(job);
      if (shouldPollJob(job)) {
        liveJobIdsRef.current.add(job.id);
      }
      if (options.activateTab ?? true) {
        setActiveTab("operations");
      }
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "读取任务详情失败", "请刷新任务列表后重试。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function runJob(kind: string, payload: Record<string, unknown>, options: { activateTab?: boolean } = {}): Promise<JobInfo | null> {
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const job = await client.createJob(kind, payload);
      const jobs = await client.getJobs();
      liveJobIdsRef.current.add(job.id);
      setSelectedJobId(job.id);
      setSelectedJobDetail(job);
      setSnapshot((current) => (current ? { ...current, jobs } : current));
      setOperationsMessage(describeJobStarted(kind));
      if (options.activateTab ?? true) {
        setActiveTab("operations");
      }
      return job;
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "启动任务失败", "请刷新任务列表后重试。"));
      return null;
    } finally {
      setOperationsBusy(false);
    }
  }

  async function generateCardDraw(payload: CardDrawRequest) {
    setOperationsBusy(true);
    setOperationsMessage("");
    setLatestCardDrawResult(null);
    try {
      const activeDocument = getActiveDocument();
      const result = await client.generateCardDraw({
        ...payload,
        source_path: payload.source_path || activeDocument?.path || "",
        text: payload.text || activeDocument?.content || ""
      });
      setLatestCardDrawResult(result);
      await refreshProjectChrome().catch(() => null);
      setOperationsMessage(`已生成 ${result.candidates.length} 个候选。`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "抽卡失败", "请确认已打开项目、模型配置可用，且输入内容足够。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function selectCardDraw(drawId: string, payload: CardDrawSelectRequest) {
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const result = await client.selectCardDraw(drawId, payload);
      const targetPath = String((result as { target_path?: unknown }).target_path || payload.target_path || "");
      const archivedPaths = Array.isArray((result as { archived_paths?: unknown }).archived_paths)
        ? (result as { archived_paths: unknown[] }).archived_paths.map(String).filter(Boolean)
        : [];
      await refreshProjectWorkspace();
      if (targetPath) {
        await openDocument(targetPath);
      }
      setLatestCardDrawResult((current) =>
        current
          ? {
              ...current,
              selected_id: String((result as { selected_id?: unknown }).selected_id || payload.candidate_id),
              target_path: targetPath || current.target_path,
              archived_paths: archivedPaths
            }
          : current
      );
      setOperationsMessage(targetPath ? `已写入抽卡候选：${targetPath}` : "已选中抽卡候选。");
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "写入抽卡候选失败", "请确认候选仍存在，目标路径有效。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function cancelSelectedJob() {
    if (!selectedJobId) {
      return;
    }

    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const job = await client.cancelJob(selectedJobId);
      const jobs = await client.getJobs();
      liveJobIdsRef.current.delete(job.id);
      setSelectedJobDetail(job);
      setSnapshot((current) => (current ? { ...current, jobs } : current));
      setOperationsMessage(`已取消任务：${describeJobKind(job.kind)}`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "取消任务失败", "请刷新任务列表确认任务当前状态。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function resolveConversationReferenceIntent(content: string) {
    if (!shouldResolveProjectReferences(content)) {
      return null;
    }
    try {
      const activeDocument = getActiveDocument();
      return await client.resolveProjectFiles({
        text: content,
        current_path: activeDocument?.path || "",
        selection: "",
        attachment_ids: includedConversationAttachmentIds(),
        explicit_paths: [],
        max_candidates: 8
      });
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "文件引用解析失败", "将按普通消息继续发送。"));
      return null;
    }
  }

  function togglePendingReferenceCandidate(path: string) {
    const normalized = path.trim();
    if (!normalized) {
      return;
    }
    setPendingReferenceResolution((current) => {
      if (!current) {
        return current;
      }
      const selected = new Set(current.selectedPaths);
      if (selected.has(normalized)) {
        selected.delete(normalized);
      } else {
        selected.add(normalized);
      }
      return {
        ...current,
        selectedPaths: [...selected]
      };
    });
  }

  async function confirmPendingReferenceResolution() {
    const pending = pendingReferenceResolution;
    if (!pending) {
      return;
    }
    setPendingReferenceResolution(null);
    await sendConversationPrompt(pending.content, {
      checkActiveDocument: false,
      skipReferenceResolution: true,
      referencePaths: referenceCandidatePaths(pending.references),
      confirmedReferencePaths: pending.selectedPaths
    });
  }

  async function sendPendingReferenceResolutionWithoutCandidates() {
    const pending = pendingReferenceResolution;
    if (!pending) {
      return;
    }
    setPendingReferenceResolution(null);
    await sendConversationPrompt(pending.content, {
      checkActiveDocument: false,
      skipReferenceResolution: true,
      referencePaths: referenceCandidatePaths(pending.references),
      disableAutoReferences: true
    });
  }

  function discardPendingReferenceResolution() {
    if (!pendingReferenceResolution) {
      return;
    }
    setPendingReferenceResolution(null);
    setConversationMessage("已取消本次引用确认。");
  }

  async function resolvePendingAgentConfirmation(confirmation: AgentConfirmation, action: "approve" | "reject") {
    if (pendingAgentConfirmationBusy) {
      return;
    }
    const operationId = `op_assistant_confirmation_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    setPendingAgentConfirmationBusy(confirmation.confirmation_id);
    setAgentConfirmationExecution((current) => ({
      ...current,
      [confirmation.confirmation_id]: {
        status: action === "approve" ? "executing" : "rejected",
        message: action === "approve" ? "已确认，正在处理…" : "正在拒绝此操作…"
      }
    }));
    try {
      const payload = {
        operation_id: operationId,
        expected_version: confirmation.version,
        expected_scope_fingerprint: confirmation.scope_fingerprint || ""
      };
      const resolved = action === "approve"
        ? await client.approveAgentConfirmation(confirmation.confirmation_id, payload)
        : await client.rejectAgentConfirmation(confirmation.confirmation_id, payload);

      if (action === "approve" && resolved.status === "approved") {
        const run = await client.getAgentRun(confirmation.run_id);
        await client.resumeAgentRun(run.run_id, {
          operation_id: `${operationId}_resume`,
          expected_version: run.version
        });
        setAgentConfirmationExecution((current) => ({
          ...current,
          [confirmation.confirmation_id]: { status: "executing", message: "正在将已确认的文件移入项目回收站…" }
        }));
        let unsubscribe: (() => void) | undefined;
        unsubscribe = subscribeConversationPlanRun(
          run.run_id,
          (nextRun) => {
            if (!terminalLongTaskStatuses.has(nextRun.status)) {
              return;
            }
            unsubscribe?.();
            void (async () => {
              if (nextRun.status === "completed") {
                await refreshProjectWorkspace();
                await refreshActiveConversation();
                setAgentConfirmationExecution((current) => ({
                  ...current,
                  [confirmation.confirmation_id]: { status: "completed", message: "操作已完成，可在项目时间线恢复已归档文件。" }
                }));
                setConversationMessage("操作已完成，项目文件已刷新。");
              } else {
                const message = nextRun.status === "cancelled"
                  ? "操作已取消，未移入回收站。"
                  : `操作执行失败：${nextRun.error || "文件保持原样，请重新检查后再确认。"}`;
                setAgentConfirmationExecution((current) => ({
                  ...current,
                  [confirmation.confirmation_id]: {
                    status: "failed",
                    message: nextRun.status === "cancelled" ? "操作已取消，文件没有移动。" : (nextRun.error || "操作失败，文件保持原样。")
                  }
                }));
                setConversationMessage(message);
              }
            })().catch((error) => {
              setConversationMessage(describeActionableError(error, "刷新写入结果失败", "请点击页面刷新后查看已保存内容。"));
            });
          },
          (error) => {
            setConversationMessage(describeActionableError(error, "跟踪写入结果失败", "请刷新页面确认写入结果。"));
          }
        );
        setConversationMessage("操作已确认，正在继续执行。");
      } else {
        setConversationMessage("操作已拒绝，未执行对应写入。");
        setAgentConfirmationExecution((current) => ({
          ...current,
          [confirmation.confirmation_id]: { status: "rejected", message: "已拒绝，项目文件未改变。" }
        }));
      }
      if (action === "reject") {
        setPendingAgentConfirmations((current) => current.filter((item) => item.confirmation_id !== resolved.confirmation_id));
      }
    } catch (nextError) {
      const message = describeActionableError(nextError, action === "approve" ? "批准操作失败" : "拒绝操作失败");
      setConversationMessage(message);
      setAgentConfirmationExecution((current) => ({
        ...current,
        [confirmation.confirmation_id]: { status: "failed", message }
      }));
    } finally {
      setPendingAgentConfirmationBusy("");
    }
  }

  async function sendConversationPrompt(content: string, options: SendConversationOptions = {}) {
    const trimmed = content.trim();
    if (!trimmed || sendingMessage) {
      return;
    }

    const normalizedConfirmation = trimmed.replace(/\s+/g, "");
    if (
      pendingGeneratedSaves.length === 1 && pendingGeneratedSave &&
      /^(确认|确认保存|确认写入)$/.test(normalizedConfirmation)
    ) {
      setMessageInput("");
      await savePendingGenerated(pendingGeneratedSave.defaultMode || "replace");
      return;
    }

    if (pendingGeneratedSaves.length > 1 && /^(确认|确认保存|确认写入)$/.test(normalizedConfirmation)) {
      setConversationMessage("当前有多个待确认生成结果，请在对应预览卡片中选择具体内容后再确认。");
      return;
    }

    const actionableAgentConfirmations = pendingAgentConfirmations.filter((item) => {
      const status = agentConfirmationExecution[item.confirmation_id]?.status || "pending";
      return status === "pending";
    });
    const pendingAgentConfirmation = actionableAgentConfirmations.length === 1 ? actionableAgentConfirmations[0] : null;
    if (pendingAgentConfirmation && /^(确认|确认保存|确认写入)$/.test(normalizedConfirmation)) {
      setMessageInput("");
      await resolvePendingAgentConfirmation(pendingAgentConfirmation, "approve");
      return;
    }

    if (actionableAgentConfirmations.length > 0) {
      setConversationMessage("当前有多个待确认操作，请在确认卡片中选择具体操作后再继续。");
      return;
    }

    const activeDocument = getActiveDocument();
    if ((options.checkActiveDocument ?? true) && messageRequiresActiveDocument(trimmed) && !activeDocument) {
      const nextMessage = "这条请求看起来需要当前文档。请先到编辑页打开正文、章纲或设定文件，再发送。";
      setConversationMessage(nextMessage);
      setDocumentMessage(nextMessage);
      setActiveTab("editor");
      return;
    }

    let referencePaths = uniquePaths(options.referencePaths || []);
    const confirmedReferencePaths = uniquePaths(options.confirmedReferencePaths || []);
    const disableAutoReferences = Boolean(options.disableAutoReferences);
    if (!options.skipReferenceResolution && !disableAutoReferences) {
      const resolvedReferences = await resolveConversationReferenceIntent(trimmed);
      if (resolvedReferences?.ambiguous && resolvedReferences.candidates.length) {
        // References are read-only context. Do not make an ordinary question
        // wait behind a confirmation card: include the strongest bounded set
        // and show the selected paths in the run trace instead.
        referencePaths = uniquePaths([
          ...referencePaths,
          ...referenceCandidatePaths(resolvedReferences.references),
          ...referenceCandidatePaths(resolvedReferences.candidates.slice(0, 3))
        ]);
      }
      if (resolvedReferences?.references.length) {
        referencePaths = uniquePaths([...referencePaths, ...referenceCandidatePaths(resolvedReferences.references)]);
      }
    }

    setPendingReferenceResolution(null);
    setConversationMessage(referencePaths.length || confirmedReferencePaths.length ? `本轮将引用 ${referencePaths.length + confirmedReferencePaths.length} 个项目文件。` : "");
    setActiveTab("conversations");

    let conversationId = "";
    try {
      conversationId = await ensureConversationId();
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "创建会话失败", "请确认项目已打开后再发送。"));
      return;
    }

    const controller = new AbortController();
    const assistantMessage = makeLocalMessage("assistant", "");

    assistantAbortControllersRef.current.set(conversationId, controller);
    setSendingConversationIds((current) => current.includes(conversationId) ? current : [...current, conversationId]);
    appendLocalMessage(conversationId, "user", trimmed);
    setMessageInput("");

    let streamedText = "";
    let streamedReasoning = "";
    let streamedAssistantMetadata: Record<string, unknown> = {};
    const executionTrace: Array<{ stage: string; message: string }> = [];
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStream = () => {
      if (streamFlushTimer) {
        clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
      upsertLocalMessage(conversationId, {
        ...assistantMessage,
        content: streamedText,
        reasoning_content: streamedReasoning,
        metadata: streamedAssistantMetadata
      });
    };
    const scheduleStreamFlush = () => {
      if (streamFlushTimer) {
        return;
      }
      streamFlushTimer = setTimeout(flushStream, 40);
    };
    const recordExecutionStep = (stage: string, message: string) => {
      const normalized = String(message || "").trim();
      if (!normalized) return;
      const previous = executionTrace.at(-1);
      if (previous?.stage === stage && previous.message === normalized) return;
      executionTrace.push({ stage, message: normalized });
      streamedAssistantMetadata = { ...streamedAssistantMetadata, execution_trace: executionTrace.slice(-80) };
      scheduleStreamFlush();
    };
    try {
      await client.streamConversationMessage(
        conversationId,
        {
          content: trimmed,
          skill_id: "",
          agent_name: "",
          write_target: "",
          insert_mode: "none",
          current_path: activeDocument?.path || "",
          runtime_context: buildProjectContextHint(),
          attachment_ids: includedConversationAttachmentIds(),
          reference_paths: referencePaths,
          confirmed_reference_paths: confirmedReferencePaths,
          disable_auto_references: disableAutoReferences
        },
        {
          onStart: (event) => {
            const currentSkill = event.current_skill || event.skill_id || "";
            updateActiveConversationSkill(conversationId, event.skill_id || "", "");
            setConversationMessageFor(conversationId, currentSkill ? `正在调用技能：${currentSkill}` : "正在判断当前技能...");
            streamedAssistantMetadata = { ...streamedAssistantMetadata, intent: currentSkill ? "skill" : "chat" };
            if (event.inline_plan) {
              // Long workflows own a dedicated task card.  The chat stop
              // control may end its renderer stream, but must never cancel
              // that child task's durable run.
              if (!longTaskSkillIds.has(currentSkill as LongTaskProgress["skill_id"])) {
                activeConversationRunIdsRef.current.set(conversationId, event.inline_plan.run_id);
              }
              streamedAssistantMetadata = {
                ...streamedAssistantMetadata,
                inline_plan: event.inline_plan,
                skill_plan: event.skill_plan,
                skill_steps: event.skill_steps || []
              };
            }
            recordExecutionStep("created", currentSkill ? `已识别任务，准备调用：${currentSkill}` : "已创建任务，正在判断请求类型。");
          },
          onDelta: (event) => {
            if (event.stage === "workflow_start" || event.stage === "workflow_progress") {
              recordExecutionStep(event.stage === "workflow_start" ? "starting" : "working", event.text || (event.stage === "workflow_start" ? "正在启动任务…" : "正在处理…"));
              setConversationMessageFor(conversationId, String(event.text || "正在执行任务…").trim());
              return;
            }
            if (event.stage === "humanizer_start") {
              recordExecutionStep("polishing", "正在进行去AI味润色…");
              setConversationMessageFor(conversationId, "正在进行去AI味润色...");
              return;
            }
            if (!event.text) {
              return;
            }
            if (event.channel === "reasoning") {
              streamedReasoning += event.text;
              scheduleStreamFlush();
              return;
            }
            streamedText += event.text;
            scheduleStreamFlush();
          },
          onFinal: async (event) => {
            activeConversationRunIdsRef.current.delete(conversationId);
            flushStream();
            const reply = resolveAssistantReply(event.payload, streamedText);
            recordExecutionStep("completed", "任务已完成。");
            if (reply.trim()) {
              upsertLocalMessage(conversationId, { ...assistantMessage, content: reply, reasoning_content: streamedReasoning, metadata: streamedAssistantMetadata });
            }
            await handleAgentRunPayload(conversationId, reply, event.payload);
          },
          onError: async (event) => {
            activeConversationRunIdsRef.current.delete(conversationId);
            throw new Error(event.message || "发送失败");
          }
        },
        controller.signal
      );
    } catch (nextError) {
      flushStream();
      if (controller.signal.aborted) {
        recordExecutionStep("cancelled", "已请求停止任务。");
        setConversationMessageFor(conversationId, describeStoppedConversationResponse(streamedText));
      } else {
        recordExecutionStep("failed", `任务未完成：${nextError instanceof Error ? nextError.message : "未知错误"}`);
        setConversationMessageFor(conversationId, describeActionableError(nextError, "发送失败", "请检查模型配置或稍后重试；本次不会自动写入文件。"));
      }
      const persisted = await client.getConversation(conversationId).catch(() => null);
      if (persisted) setConversationDetail((current) => current?.id === conversationId ? persisted : current);
    } finally {
      if (streamFlushTimer) {
        clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
      if (assistantAbortControllersRef.current.get(conversationId) === controller) {
        assistantAbortControllersRef.current.delete(conversationId);
      }
      setSendingConversationIds((current) => current.filter((id) => id !== conversationId));
    }
  }

  async function sendMessage(content = messageInput.trim()) {
    await sendConversationPrompt(content, { checkActiveDocument: true });
  }

  async function sendLedgerRecoveryPrompt(item: LedgerItem) {
    if (!item?.desc?.trim()) {
      setConversationMessage("请选择要回收的伏笔。");
      return;
    }
    const activeDocument = getActiveDocument();
    const currentPath = activeDocument?.path ? `当前打开文件：${activeDocument.path}` : "当前没有打开文件，请先给出回收方案和可写入片段。";
    const prompt = [
      "请帮我回收下面这条伏笔，要求自然融入剧情，不要生硬解释，不改变既有人设、世界观和因果链。",
      currentPath,
      "伏笔内容：",
      item.desc,
      "输出要求：先给出回收思路，再给出可直接用于正文的段落或修改建议。如果适合写入当前打开文件，请明确写入位置和衔接方式。"
    ].join("\n");
    await sendConversationPrompt(prompt, { checkActiveDocument: false });
  }

  function stopMessage() {
    const conversationId = conversationDetail?.id || "";
    const controller = assistantAbortControllersRef.current.get(conversationId);
    if (!controller) {
      return;
    }

    setConversationMessageFor(conversationId, "正在停止响应...");
    controller.abort();
    const runId = activeConversationRunIdsRef.current.get(conversationId) || "";
    activeConversationRunIdsRef.current.delete(conversationId);
    if (runId) {
      void getConversationPlanRun(runId).then((run) => {
        // A stale renderer must never turn a normal chat stop into a control
        // action for a workflow owned by another conversation.
        if (run.conversation_id !== conversationId || workflowSkillIdFromRun(run)) {
          setConversationMessageFor(conversationId, "当前对话没有可终止的普通回复；后台任务请在其任务卡中控制。");
          return null;
        }
        return controlConversationPlanRun(runId, "cancel", "", conversationId);
      }).then((result) => {
        if (!result) return;
        setConversationMessageFor(conversationId, "已请求取消当前运行。");
      }).catch((error) => {
        setConversationMessageFor(conversationId, describeActionableError(error, "取消运行失败", "请在执行计划卡中重试取消。"));
      });
    }
  }

  async function invokeSelectedSkill() {
    if (!selectedSkillId) {
      return;
    }

    const activeDocument = getActiveDocument();
    if (skillRequiresActiveDocument(selectedSkillDetail) && !activeDocument) {
      const message = "这个技能需要当前文档内容。请先到编辑页打开正文、章纲或设定文件，再执行技能。";
      setOperationsMessage(message);
      setDocumentMessage(message);
      setActiveTab("editor");
      return;
    }

    const sourcePath = activeDocument?.path || "";
    const taskSpec = taskConversationSpecForWorkflow(selectedSkillId, {}, sourcePath);
    await runWorkflowSkill(selectedSkillId, {
      text: activeDocument?.content || "",
      // 写作、拆书等工作流必须由运行入口创建自己的任务线程，不能继承 AI 助手会话。
      conversation_id: taskSpec ? "" : conversationDetail?.id || "",
      source_path: sourcePath,
      target_path: sourcePath,
      write_result: false,
      attachment_ids: []
    });
  }

  async function handleSkillRunResult(result: SkillRunResponse, skillId: string, sourcePath = "") {
    setLatestSkillResult(result);

    if (result.data?.skill_imported) {
      await refreshSkillCatalog();
    }

    if (result.status === "job_created" && result.job) {
      liveJobIdsRef.current.add(result.job.id);
      setSelectedJobId(result.job.id);
      setSelectedJobDetail(result.job);
      upsertJobInSnapshot(result.job);
      await refreshJobsList();
      setOperationsMessage("技能已转入后台任务");
      return;
    }

    if (skillId === "disassemble_book" || skillId === "continue_disassemble" || skillId === "book_fusion") {
      await refreshDisassemblyLibrary();
    }

    const rawPendingSaves = pendingSavesFromSkill(result, "skill");
    if (rawPendingSaves.length) {
      const pendingSaves: PendingGeneratedSave[] = rawPendingSaves.map((rawPendingSave) => ({
        ...rawPendingSave,
        conversationId: conversationDetail?.id || undefined,
        createdAt: new Date().toISOString()
      }));
      for (const pendingSave of pendingSaves) {
        upsertPendingGeneratedSave(pendingSave);
        void trackDesktopGeneratedCache(pendingSave, "pending");
      }
      publishPendingSaveMessage(pendingSaves[0]!, "技能已生成内容，等待选择写入方式");
      return;
    }

    const savedPaths = skillSavedPaths(result);
    if (savedPaths.length) {
      await syncChangedPaths(savedPaths, { openFirst: true });
      const postprocessWarning = String(result.data?.postprocess_warning || "").trim();
      setOperationsMessage(postprocessWarning ? `技能已写入 ${savedPaths[0]}；大纲结构整理待重试：${postprocessWarning}` : `技能已写入 ${savedPaths[0]}`);
      return;
    }

    setOperationsMessage(result.result.trim() ? "技能执行完成，结果已显示在下方预览。" : "技能执行完成");
  }

  async function runWorkflowSkill(skillId: string, payload: Partial<SkillRunRequest> = {}) {
    if (!skillId) {
      return;
    }
    const workflowLabel = workflowProgressLabel(skillId);
    setOperationsBusy(true);
    setOperationsMessage(`${workflowLabel}：正在准备任务...`);
    setLatestSkillResult(null);
    let workflowController: AbortController | null = null;
    let startedLongTaskRunId = "";
    try {
      const activeDocument = getActiveDocument();
      const sourcePath = payload.source_path ?? activeDocument?.path ?? "";
      const autoRevision = Boolean(configDraft?.enable_consistency_revision);
      const scoreThreshold = configDraft?.consistency_revision_score || 80;
      const requestedConversationId = String(payload.conversation_id || "").trim();
      const taskSpec = taskConversationSpecForWorkflow(skillId, payload, sourcePath);
      // 即使调用方显式传入当前普通助手会话，任务也必须新建自己的线程。
      // 只有传入既有任务线程时才允许复用其会话 ID。
      let taskConversationId = taskSpec && (!requestedConversationId || requestedConversationId === conversationDetail?.id)
        ? ""
        : requestedConversationId;
      if (taskSpec) {
        if (!taskConversationId) {
          const taskConversation = await createTaskConversation({
            ...taskSpec,
            skillId,
            sourcePath,
            targetPaths: uniquePaths([sourcePath, String(payload.target_path || "")])
          });
          taskConversationId = taskConversation.id;
        }
      }
      const skillPayload = {
        ...(payload as Record<string, unknown>),
        text: payload.text ?? activeDocument?.content ?? "",
        chapter: payload.chapter && payload.chapter > 0 ? payload.chapter : undefined,
        end_chapter: payload.end_chapter && payload.end_chapter > 0 ? payload.end_chapter : undefined,
        target_words: payload.target_words ?? 2500,
        instruction: payload.instruction ?? "",
        target_path: payload.target_path ?? "",
        conversation_id: taskConversationId || (taskSpec ? "" : conversationDetail?.id || ""),
        source_path: sourcePath,
        write_result: payload.write_result ?? false,
        attachment_ids: payload.attachment_ids ?? [],
        auto_revision: (payload as any).auto_revision ?? autoRevision,
        score_threshold: (payload as any).score_threshold ?? scoreThreshold
      } as any;
      let content = String(skillPayload.instruction || skillPayload.text || "").trim();
      if (skillId === "batch_generate" && skillPayload.chapter && skillPayload.end_chapter) {
        content = `第${skillPayload.chapter}章到第${skillPayload.end_chapter}章 ${content}`.trim();
      } else if (skillPayload.chapter && !/第\s*\d+\s*章/.test(content)) {
        content = `第${skillPayload.chapter}章 ${content}`.trim();
      }
      if (skillPayload.target_words && /^(body_generate|batch_generate|outline_generate|detail_outline_generate|chapter_outline_generate)$/.test(skillId) && !/字|词|words?/i.test(content)) {
        content = `${content} 约${skillPayload.target_words}字`.trim();
      }
      if ((skillId === "body_generate" || skillId === "batch_generate") && skillPayload.write_result && !/(同步|写入|保存|更新|替换|覆盖|落到|写回|补充|补全|完善|补齐|填充|配置|设置|设定|建立|创建)/.test(content)) {
        content = `${content} 写入文件`.trim();
      }

      const controller = new AbortController();
      workflowController = controller;
      const workflowAbortKey = skillPayload.conversation_id || `${skillId}:${sourcePath}`;
      taskAbortControllersRef.current.get(workflowAbortKey)?.abort();
      taskAbortControllersRef.current.set(workflowAbortKey, controller);
      let streamed = "";
      const finalResponseRef: { current: AgentRunResponse | null } = { current: null };
      await client.streamAgentRun({
        conversation_id: skillPayload.conversation_id || "",
        content,
        current_path: sourcePath,
        selection: String(skillPayload.text || ""),
        project_context_hint: "",
        skill_id: skillId,
        attachment_ids: skillPayload.attachment_ids || [],
        ...skillPayload
      } as any, {
        onStart: (event) => {
          if (event.run_id && longTaskSkillIds.has(skillId as LongTaskProgress["skill_id"])) {
            startedLongTaskRunId = event.run_id;
            void refreshLongTask(event.run_id).catch(() => undefined);
          }
          setOperationsMessage(`${workflowLabel}：已启动，正在接收流式输出...`);
        },
        onDelta: (event) => {
          if (event.stage === "workflow_progress") {
            setOperationsMessage(`${workflowLabel}：${event.text.trim()}`);
            return;
          }
          if (event.stage === "workflow_start") {
            setOperationsMessage(`${workflowLabel}：正在启动工作流...`);
            return;
          }
          if (event.stage === "humanizer_start") {
            setOperationsMessage(`${workflowLabel}：正在进行去AI味润色...`);
            return;
          }
          streamed += event.text || "";
          setLatestSkillResult({
            status: "done",
            result: streamed,
            saved_path: "",
            data: {
              skill_id: skillId,
              result: streamed,
              cache_id: event.cache_id || "",
              target_paths: event.target_paths || []
            }
          });
          setOperationsMessage(`${workflowLabel}：正在生成...`);
        },
        onFinal: async (event) => {
          finalResponseRef.current = event.payload;
        },
        onError: (event) => {
          throw new Error(event.message);
        }
      }, controller.signal);

      taskAbortControllersRef.current.delete(workflowAbortKey);
      const finalResponse = finalResponseRef.current;
      const result = finalResponse?.skill_result || {
        status: "done",
        result: finalResponse?.reply || streamed,
        saved_path: finalResponse?.saved_paths?.[0] || "",
        data: {
          skill_id: skillId,
          result: finalResponse?.reply || streamed,
          saved_paths: finalResponse?.saved_paths || []
        }
      };
      await handleSkillRunResult(result, skillId, sourcePath);
      return result;
    } catch (nextError) {
      if (startedLongTaskRunId) {
        const durableTask = await refreshLongTask(startedLongTaskRunId).catch(() => null);
        if (durableTask && !terminalLongTaskStatuses.has(durableTask.status)) {
          setOperationsMessage(`${workflowLabel}：前台连接已断开，任务正在后台继续，可在任务进度中查看。`);
          return null;
        }
      }
      setOperationsMessage(describeActionableError(nextError, "执行技能失败", "请确认已打开目标文档、模型配置可用后重试。"));
      return null;
    } finally {
      if (workflowController) {
        for (const [key, controller] of taskAbortControllersRef.current) {
          if (controller === workflowController) taskAbortControllersRef.current.delete(key);
        }
      }
      setOperationsBusy(false);
    }
  }

  async function runNuwaStyleDistillation(options: { replace?: boolean; text?: string; sourcePath?: string; bookTitle?: string; sourceBookId?: string } = {}) {
    if (styleDistillationProfile && !options.replace) {
      setOperationsMessage("当前项目已经有蒸馏书籍。请在拆书面板确认替换后再执行。");
      return;
    }

    const activeDocument = getActiveDocument();
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const taskConversation = await createTaskConversation({
        type: "distillation",
        title: `蒸馏 · 《${options.bookTitle || activeDocument?.title || "未命名作品"}》`,
        skillId: "nuwa_style_distill",
        entry: "distill",
        sourcePath: options.sourcePath ?? activeDocument?.path ?? "",
        sourceBookId: options.sourceBookId || "",
        targetPaths: ["00_设定集/.agent/style_distillation/current.json"]
      });
      const result = await client.runSkill("nuwa_style_distill", {
        text: options.text ?? activeDocument?.content ?? "",
        conversation_id: taskConversation.id,
        source_path: options.sourcePath ?? activeDocument?.path ?? "",
        target_path: "",
        write_result: true,
        attachment_ids: [],
        action: "distill",
        replace_existing: Boolean(options.replace),
        book_title: options.bookTitle ?? activeDocument?.title ?? "",
        source_book_id: options.sourceBookId ?? ""
      });
      setLatestSkillResult(result);
      const profile = readStyleDistillationProfileFromResult(result);
      setStyleDistillationProfile(profile);
      await refreshProjectChrome().catch(() => null);
      setOperationsMessage(profile
        ? (result.data?.requires_confirmation
          ? `已蒸馏：${profile.book_title}。风格库草稿已生成，等待确认；当前档案仅作为本次试用文风。`
          : `已蒸馏：${profile.book_title}，并已启用为生成文风。`)
        : result.result || "蒸馏完成。");
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "执行蒸馏失败", "请确认已打开拆书原文、拆书产物存在，且模型配置可用。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function toggleNuwaStyleDistillation(enabled?: boolean) {
    if (!styleDistillationProfile) {
      setOperationsMessage("当前项目还没有蒸馏书籍。");
      return;
    }
    const nextEnabled = enabled ?? !styleDistillationProfile.enabled;
    setOperationsBusy(true);
    try {
      const taskConversation = await createTaskConversation({
        type: "distillation",
        title: `蒸馏 · 《${styleDistillationProfile.book_title || "当前作品"}》`,
        skillId: "nuwa_style_distill",
        entry: "toggle",
        sourceBookId: styleDistillationProfile.source_book_id || "",
        targetPaths: ["00_设定集/.agent/style_distillation/current.json"]
      });
      const result = await client.runSkill("nuwa_style_distill", {
        text: "",
        conversation_id: taskConversation.id,
        source_path: "",
        target_path: "",
        write_result: false,
        attachment_ids: [],
        action: "toggle",
        enabled: nextEnabled
      });
      const profile = readStyleDistillationProfileFromResult(result);
      setStyleDistillationProfile(profile);
      await refreshProjectChrome().catch(() => null);
      setOperationsMessage(result.result || (nextEnabled ? "已启用蒸馏文风。" : "已停用蒸馏文风。"));
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "切换蒸馏文风失败"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function deleteNuwaStyleDistillation() {
    if (!styleDistillationProfile) {
      return;
    }
    setOperationsBusy(true);
    try {
      const taskConversation = await createTaskConversation({
        type: "distillation",
        title: `蒸馏 · 《${styleDistillationProfile.book_title || "当前作品"}》`,
        skillId: "nuwa_style_distill",
        entry: "delete",
        sourceBookId: styleDistillationProfile.source_book_id || "",
        targetPaths: ["00_设定集/.agent/style_distillation/current.json"]
      });
      const result = await client.runSkill("nuwa_style_distill", {
        text: "",
        conversation_id: taskConversation.id,
        source_path: "",
        target_path: "",
        write_result: false,
        attachment_ids: [],
        action: "delete"
      });
      setStyleDistillationProfile(null);
      await refreshProjectChrome().catch(() => null);
      setOperationsMessage(result.result || "已删除当前蒸馏书籍。");
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "删除蒸馏书籍失败"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function savePendingGenerated(mode: "replace" | "append", cacheId = "", expectedTargetHashes?: Record<string, string>) {
    const currentPending = pendingSaveByCacheId(cacheId);
    if (!currentPending) {
      return;
    }

    if (currentPending.source === "skill") {
      setOperationsBusy(true);
    } else {
      setConversationBusy(true);
    }

    try {
      const result = await client.saveGeneratedResult({
        skill_id: currentPending.skillId,
        content: currentPending.content,
        cache_id: currentPending.cacheId,
        mode,
        target_path: currentPending.targetPath,
        target_paths: currentPending.targetPaths,
        chapter: currentPending.chapter,
        save_plan: currentPending.savePlan,
        expected_target_hashes: expectedTargetHashes
      });

      removePendingGeneratedSave(currentPending.cacheId);
      await syncChangedPaths(result.saved_paths, { openFirst: true });
      await trackDesktopGeneratedCache(currentPending, "saved", mode);
      const postprocess = result as Record<string, unknown>;
      const libraryDraft = recordValue(postprocess.library_draft);
      const draftRecords = Number(libraryDraft.records || 0);
      const postprocessWarning = String(postprocess.postprocess_warning || "").trim();
      const postprocessMessage = draftRecords > 0
        ? `；已自动提取 ${draftRecords} 条设定，等待确认`
        : postprocessWarning
          ? `；大纲已保存，结构整理待重试：${postprocessWarning}`
          : "";
      publishPendingSaveMessage(
        currentPending,
        `${describeSavedGeneratedResult(currentPending, mode, result.saved_paths)}${postprocessMessage}`
      );
    } catch (nextError) {
      const message = describeActionableError(nextError, "保存生成结果失败", "请确认目标文档仍存在；生成结果仍保留在待写入状态。");
      setPendingGeneratedSaveError(currentPending.cacheId, message);
      publishPendingSaveMessage(
        currentPending,
        message
      );
    } finally {
      setConversationBusy(false);
      setOperationsBusy(false);
    }
  }

  async function discardPendingGenerated(cacheId = "") {
    const currentPending = pendingSaveByCacheId(cacheId);
    if (!currentPending) {
      return;
    }

    if (currentPending.source === "skill") {
      setOperationsBusy(true);
    } else {
      setConversationBusy(true);
    }

    try {
      if (currentPending.cacheId) {
        await client.discardGeneratedCache(currentPending.cacheId);
      }
      await trackDesktopGeneratedCache(currentPending, "discarded");
      removePendingGeneratedSave(currentPending.cacheId);
      publishPendingSaveMessage(currentPending, "已丢弃生成结果，没有写入文件。");
    } catch (nextError) {
      const message = describeActionableError(nextError, "删除生成缓存失败", "生成结果仍保留，可稍后重试丢弃或直接保存。");
      setPendingGeneratedSaveError(currentPending.cacheId, message);
      publishPendingSaveMessage(
        currentPending,
        message
      );
    } finally {
      setConversationBusy(false);
      setOperationsBusy(false);
    }
  }

  async function savePendingGeneratedAsDraft(cacheId = "") {
    const currentPending = pendingSaveByCacheId(cacheId);
    if (!currentPending) {
      return;
    }
    if (currentPending.source === "skill") {
      setOperationsBusy(true);
    } else {
      setConversationBusy(true);
    }

    try {
      let content = currentPending.content;
      if (!content.trim() && currentPending.cacheId) {
        const detail = await client.getGeneratedCache(currentPending.cacheId);
        content = detail.content;
      }
      if (!content.trim()) {
        publishPendingSaveMessage(currentPending, "生成内容为空，不能另存为草稿。");
        return;
      }

      const draftPath = generatedDraftPath(currentPending);
      const result = await client.saveGeneratedResult({
        skill_id: currentPending.skillId,
        content,
        mode: "replace",
        target_path: draftPath,
        target_paths: [draftPath],
        chapter: currentPending.chapter
      });

      if (currentPending.cacheId) {
        await client.discardGeneratedCache(currentPending.cacheId).catch(() => {});
      }
      removePendingGeneratedSave(currentPending.cacheId);
      await syncChangedPaths(result.saved_paths.length ? result.saved_paths : [draftPath], { openFirst: true });
      setActiveTab("editor");
      await trackDesktopGeneratedCache(currentPending, "saved", "replace");
      publishPendingSaveMessage(currentPending, `已另存为草稿：${draftPath}，原目标文件没有改动。`);
    } catch (nextError) {
      const message = describeActionableError(nextError, "另存草稿失败", "生成结果仍保留在待写入状态。");
      setPendingGeneratedSaveError(currentPending.cacheId, message);
      publishPendingSaveMessage(
        currentPending,
        message
      );
    } finally {
      setConversationBusy(false);
      setOperationsBusy(false);
    }
  }

  async function copyPendingGeneratedContent(cacheId = "") {
    const currentPending = pendingSaveByCacheId(cacheId);
    if (!currentPending) {
      return;
    }
    try {
      let content = currentPending.content;
      if (!content.trim() && currentPending.cacheId) {
        const detail = await client.getGeneratedCache(currentPending.cacheId);
        content = detail.content;
      }
      if (!content.trim()) {
        publishPendingSaveMessage(currentPending, "生成内容为空，不能复制。");
        return;
      }
      await navigator.clipboard.writeText(content);
      publishPendingSaveMessage(currentPending, `已复制生成内容，共 ${content.length} 字。`);
    } catch (nextError) {
      const message = describeActionableError(nextError, "复制生成内容失败", "可以先另存为草稿或恢复缓存后再重试。");
      setPendingGeneratedSaveError(currentPending.cacheId, message);
      publishPendingSaveMessage(
        currentPending,
        message
      );
    }
  }

  async function restoreGeneratedCache(cache: LocalStateGeneratedCache) {
    setOperationsBusy(true);
    try {
      const detail = await client.getGeneratedCache(cache.cache_id);
      if (detail.meta.status !== "pending") {
        await window.xiaoshuoDesktop?.localState?.trackGeneratedCache({
          cache_id: cache.cache_id,
          project_path: cache.project_path,
          skill_id: detail.meta.skill_id || cache.skill_id,
          source: cache.source,
          target_path: cache.target_path,
          target_paths: cache.target_paths,
          status: detail.meta.status === "discarded" ? "discarded" : "saved",
          mode: detail.meta.mode,
          cache_path: detail.meta.cache_path || cache.cache_path,
          cache_chars: detail.meta.chars || cache.cache_chars,
          conversation_id: cache.conversation_id || detail.meta.conversation_id || undefined,
          message_id: cache.message_id,
          run_id: cache.run_id || detail.meta.commit_run_id || undefined
        }).then((localState) => setSnapshot((current) => (current ? { ...current, localState } : current)));
        setOperationsMessage("生成缓存已经处理，已同步本地记录。");
        return;
      }

      const targetPaths = detail.meta.target_paths.length ? detail.meta.target_paths : cache.target_paths;
      const targetPath = targetPaths[0] || cache.target_path;
      if (!targetPath) {
        setOperationsMessage("生成缓存没有目标文件，暂时不能恢复到保存面板。");
        return;
      }

      const restored: PendingGeneratedSave = {
        skillId: detail.meta.skill_id || cache.skill_id,
        content: detail.content,
        cacheId: detail.meta.cache_id,
        cachePath: detail.meta.cache_path || cache.cache_path || "",
        cacheChars: detail.meta.chars || cache.cache_chars || detail.content.length,
        targetPath,
        targetPaths: targetPaths.length ? targetPaths : [targetPath],
        chapter: 0,
        defaultMode: detail.meta.mode || cache.mode || "replace",
        source: cache.source,
        savePlan: detail.meta.save_plan,
        conversationId: cache.conversation_id || detail.meta.conversation_id || undefined,
        messageId: cache.message_id,
        runId: cache.run_id || detail.meta.commit_run_id || undefined,
        createdAt: cache.created_at
      };

      upsertPendingGeneratedSave(restored);
      publishPendingSaveMessage(restored, "已恢复生成结果，请确认内容和写入方式。");
      setActiveTab(restored.source === "chat" ? "conversations" : "operations");
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "恢复生成缓存失败", "缓存可能已被清理；可以刷新工作台或丢弃这条记录。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function copyGeneratedCacheContent(cache: LocalStateGeneratedCache) {
    setOperationsBusy(true);
    try {
      const detail = await client.getGeneratedCache(cache.cache_id);
      if (!detail.content.trim()) {
        setOperationsMessage("生成缓存内容为空，不能复制。");
        return;
      }
      await navigator.clipboard.writeText(detail.content);
      setOperationsMessage(`已复制生成缓存内容，共 ${detail.content.length} 字。`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "复制生成缓存失败", "缓存可能已被清理；可以刷新工作台后重试。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function discardGeneratedCacheRecord(cache: LocalStateGeneratedCache) {
    setOperationsBusy(true);
    try {
      await client.discardGeneratedCache(cache.cache_id);
    } catch {
      // The physical cache may already be gone; still mark the local index as discarded.
    }

    try {
      const localState = await window.xiaoshuoDesktop?.localState?.trackGeneratedCache({
        cache_id: cache.cache_id,
        project_path: cache.project_path,
        skill_id: cache.skill_id,
        source: cache.source,
        target_path: cache.target_path,
        target_paths: cache.target_paths,
        status: "discarded",
        mode: cache.mode,
        cache_path: cache.cache_path,
        cache_chars: cache.cache_chars
      });
      if (localState) {
        setSnapshot((current) => (current ? { ...current, localState } : current));
      }
      setOperationsMessage("已丢弃生成缓存记录。");
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "丢弃生成缓存记录失败"));
    } finally {
      setOperationsBusy(false);
    }
  }

  useEffect(() => {
    const liveJobIds = Array.from(liveJobIdsRef.current);
    if (!liveJobIds.length) {
      return;
    }

    const timer = window.setTimeout(async () => {
      void (async () => {
        for (const jobId of liveJobIds) {
          try {
            const job = await client.getJob(jobId);
            upsertJobInSnapshot(job);
            if (selectedJobIdRef.current === job.id) {
              setSelectedJobDetail(job);
            }

            if (shouldPollJob(job)) {
              continue;
            }

            liveJobIdsRef.current.delete(job.id);
            await handleCompletedJob(job);
          } catch (nextError) {
            liveJobIdsRef.current.delete(jobId);
            setOperationsMessage(describeActionableError(nextError, "刷新任务状态失败", "请刷新任务列表后重试。"));
          }
        }
      })();
    }, 1400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [client, selectedJobDetail, snapshot?.jobs]);

  useEffect(() => {
    if (!selectedJobDetail) {
      return;
    }

    if (shouldPollJob(selectedJobDetail)) {
      liveJobIdsRef.current.add(selectedJobDetail.id);
      return;
    }

    if (!liveJobIdsRef.current.has(selectedJobDetail.id)) {
      return;
    }

    liveJobIdsRef.current.delete(selectedJobDetail.id);
    void handleCompletedJob(selectedJobDetail);
  }, [selectedJobDetail]);

  useEffect(() => {
    if (!selectedJobDetail || selectedJobDetail.status !== "failed" || !selectedJobDetail.error) {
      return;
    }

    setOperationsMessage(selectedJobDetail.error);
  }, [selectedJobDetail]);

  function getActiveConversationSummary(): ConversationSummary | null {
    if (!snapshot || !conversationDetail) {
      return null;
    }
    return snapshot.conversations.find((item) => item.id === conversationDetail.id) || null;
  }

  return {
    runtime,
    status,
    snapshot,
    projectDataRevision,
    error,
    activeTab,
    setActiveTab,
    isRefreshing,
    refreshAll,
    projectBusy,
    projectMessage,
    recentProjectRemovingPath,
    vectorSearchBusy,
    vectorSearchMessage,
    vectorSearchResults,
    projectPathInput,
    setProjectPathInput,
    projectNameInput,
    setProjectNameInput,
    refreshProjectWorkspace,
    openProjectFromInput,
    createProjectFromInput,
    pickAndCreateProject,
    pickAndOpenProject,
    removeRecentProject,
    exportCurrentProject,
    importProjectArchive,
    renameCurrentProject,
    rebuildVectorIndex,
    processPendingVectorFiles,
    searchVectorIndex,
    configDraft,
    patchConfig,
    patchAndSaveConfig,
    saveConfig,
    testEmbeddingConnection,
    resetEmbeddingTestResult,
    refreshLicense,
    configMessage,
    configBusy,
    embeddingTestBusy,
    embeddingTestMessage,
    websiteAiDashboard,
    websiteAiBusy,
    websiteAiMessage,
    websiteAiRedeemBusy,
    websiteAiRedeemMessage,
    websiteAiRechargeBusy,
    websiteAiRechargeMessage,
    websiteAiRechargeOrder,
    manualModelCatalog,
    manualModelDiscoveryBusy,
    manualModelDiscoveryMessage,
    refreshManualModelCatalog,
    cloudProjectSlots,
    cloudProjectSummary,
    cloudProjectBusy,
    cloudProjectActivePath,
    cloudProjectMessage,
    refreshCloudProjects,
    uploadCurrentProjectToCloud,
    uploadProjectToCloud,
    restoreCloudProject,
    syncCloudProjectToCurrent,
    deleteCloudProject,
    loginWebsiteAi,
    refreshWebsiteAiDashboard,
    applyWebsiteAiConfig,
    applyWebsiteImageConfig,
    redeemWebsiteAiCode,
    createWebsiteAiRechargeOrder,
    refreshWebsiteAiRechargeOrder,
    conversationDetail,
    conversationBusy,
    conversationMessage,
    uploadingAttachment,
    disassemblyBooks,
    disassemblyLibraryBusy,
    refreshDisassemblyLibrary,
    archiveDisassemblySource,
    messageInput,
    setMessageInput,
    sendingMessage,
    conversationModelPreferences,
    conversationModelPreferenceBusy,
    updateConversationModelPreferences,
    updateConversationModelAndDefault,
    pendingReferenceResolution,
    loadConversation,
    getConversationPlanRun,
    subscribeConversationPlanRun,
    controlConversationPlanRun,
    createConversation,
    deleteConversation,
    updateConversationTitle,
    summarizeConversation,
    pinCurrentDocumentToConversation,
    pinTextToConversation,
    removePinnedConversationContext,
    uploadConversationAttachment,
    uploadWorkflowAttachment,
    deleteConversationAttachment,
    createProjectTreeFile,
    deleteProjectTreeFile,
    sendMessage,
    togglePendingReferenceCandidate,
    confirmPendingReferenceResolution,
    sendPendingReferenceResolutionWithoutCandidates,
    discardPendingReferenceResolution,
    sendLedgerRecoveryPrompt,
    stopMessage,
    activeConversationSummary: getActiveConversationSummary(),
    openDocuments,
    activeDocumentPath,
    documentBusy,
    documentMessage,
    pendingCloseRequest,
    pendingReloadRequest,
    pendingSaveConflictRequest,
    pendingProjectSwitchRequest,
    openDocument,
    reopenDocumentFromDisk,
    activateDocument,
    closeDocument,
    cancelCloseDocument,
    confirmCloseDocument,
    cancelReloadDocument,
    confirmReloadDocument,
    cancelSaveConflict,
    confirmSaveOverwrite,
    rollbackTimelineEntry,
    clearRevisionLog,
    addLedgerItem,
    toggleLedgerItem,
    cancelProjectSwitch,
    confirmProjectSwitch,
    updateActiveDocument,
    saveActiveDocument,
    saveActiveDocumentCopy,
    saveAllDocuments,
    selectedSkillId,
    selectedSkillDetail,
    selectedJobId,
    selectedJobDetail,
    operationsBusy,
    operationsMessage,
    longTasks,
    refreshLongTasks,
    controlLongTask,
    latestSkillResult,
    pendingSkillDraft,
    pendingSkillPatchPreview,
    selectedSkillVersions,
    latestCardDrawResult,
    pendingGeneratedSave,
    pendingGeneratedSaves,
    pendingLibraryDraftGroups,
    pendingReviews,
    pendingAgentConfirmations,
    pendingAgentConfirmationBusy,
    agentConfirmationExecution,
    styleDistillationProfile,
    selectSkill,
    refreshSkillCatalog,
    selectJob,
    openJobResultFile,
    continueJobResultInConversation,
    runJob,
    cancelSelectedJob,
    invokeSelectedSkill,
    runWorkflowSkill,
    generateCardDraw,
    selectCardDraw,
    importSkillFromPath,
    uploadSkillFile,
    importSkillFromUrl,
    draftSkillPreview,
    importPendingSkillDraft,
    discardPendingSkillDraft,
    openSkillFolder,
    deleteOrDisableSelectedSkill,
    setSkillEnabled,
    restoreSelectedBuiltinSkill,
    updateSkillDescription,
    cloneSelectedSkill,
    previewSelectedSkillPatch,
    commitPendingSkillPatch,
    discardPendingSkillPatch,
    loadSkillVersions,
    rollbackSelectedSkill,
    runNuwaStyleDistillation,
    toggleNuwaStyleDistillation,
    deleteNuwaStyleDistillation,
    savePendingGenerated,
    savePendingGeneratedAsDraft,
    commitPendingLibraryDraftGroup,
    discardPendingLibraryDraftGroup,
    refreshPendingLibraryDraftGroups,
    resolvePendingAgentConfirmation,
    copyPendingGeneratedContent,
    discardPendingGenerated,
    restoreGeneratedCache,
    copyGeneratedCacheContent,
    discardGeneratedCacheRecord
  };
}
