import { createApiClient } from "@xiaoshuo/api-client";
import type {
  AppConfig,
  AgentRunResponse,
  CardDrawRequest,
  CardDrawResult,
  CardDrawSelectRequest,
  ConversationDetail,
  ConversationAttachment,
  ConversationMessage,
  ConversationSummary,
  CurrentProject,
  JobInfo,
  LedgerItem,
  LocalStateGeneratedCache,
  ProjectChromeSnapshot,
  ProjectManifestStatus,
  SkillDefinition,
  SkillRunRequest,
  SkillRunResponse,
  StyleDistillationProfile,
  TimelineEntry,
  VectorSearchHit,
  VectorIndexStatus,
  WebsiteAiApplyRequest,
  WebsiteAiDashboard,
  WebsiteAiRechargeOrder
} from "@xiaoshuo/shared";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { normalizeConfigDraft } from "../lib/config.js";
import type { DashboardSnapshot } from "../lib/dashboard.js";
import { loadDashboardSnapshot } from "../lib/dashboard.js";
import { applyDocumentContent, markDocumentStale } from "../lib/editorState.js";
import { findStarterDocumentPath } from "../lib/projectWorkspace.js";
import type { WorkbenchRuntime } from "../lib/runtime.js";
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
  resolveAssistantReply,
  shouldPollJob,
  skillRequiresActiveDocument,
  summarizeJobResult,
  summarizeOperationResults,
  type PendingGeneratedSave
} from "../lib/workflow.js";

type LoadStatus = "loading" | "ready" | "error";

export type WorkbenchTab = "overview" | "project" | "editor" | "config" | "conversations" | "operations" | "terminal";

const workbenchTabs = new Set<WorkbenchTab>(["overview", "project", "editor", "config", "conversations", "operations", "terminal"]);
const outlineGenerationSkillIds = new Set(["outline_generate", "detail_outline_generate", "chapter_outline_generate"]);
const outlineGeneratedPaths = new Set(["01_大纲/大纲.txt", "01_大纲/细纲.txt", "01_大纲/章纲.txt"]);

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
  id: string;
  title: string;
  dir: string;
  created_at: string;
  updated_at: string;
  origin: string;
  source_path: string;
  source_summary: string;
  chars: number;
  legacy?: boolean;
  paths: {
    source?: string;
    lore?: string;
    reverse_outline?: string;
    detail_outline?: string;
  };
};

type OpenDocumentOptions = {
  forceReload?: boolean;
  discardDirty?: boolean;
  activate?: boolean;
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
  return {
    id,
    title,
    dir: String(raw.dir || ""),
    created_at: String(raw.created_at || ""),
    updated_at: String(raw.updated_at || raw.created_at || ""),
    origin: String(raw.origin || ""),
    source_path: String(raw.source_path || ""),
    source_summary: String(raw.source_summary || ""),
    chars: Number(raw.chars || 0),
    legacy: Boolean(raw.legacy),
    paths: {
      source: String(paths.source || ""),
      lore: String(paths.lore || ""),
      reverse_outline: String(paths.reverse_outline || ""),
      detail_outline: String(paths.detail_outline || "")
    }
  };
}

function readDisassemblyBooksFromUnknown(value: unknown): DisassemblyBookSummary[] {
  return Array.isArray(value)
    ? value.map(readDisassemblyBookFromUnknown).filter((item): item is DisassemblyBookSummary => Boolean(item))
    : [];
}

function stringListFromUnknown(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function isOutlineGenerationResult(input: { skillId?: string; targetPath?: string; targetPaths?: string[] }): boolean {
  if (input.skillId && outlineGenerationSkillIds.has(input.skillId)) {
    return true;
  }
  return [input.targetPath || "", ...(input.targetPaths || [])].some((item) => outlineGeneratedPaths.has(item));
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState("");
  const [vectorSearchBusy, setVectorSearchBusy] = useState(false);
  const [vectorSearchMessage, setVectorSearchMessage] = useState("");
  const [vectorSearchResults, setVectorSearchResults] = useState<VectorSearchHit[]>([]);
  const [projectPathInput, setProjectPathInput] = useState("");
  const [projectNameInput, setProjectNameInput] = useState("");
  const [configDraft, setConfigDraft] = useState<AppConfig | null>(null);
  const [configMessage, setConfigMessage] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [websiteAiDashboard, setWebsiteAiDashboard] = useState<WebsiteAiDashboard | null>(null);
  const [websiteAiBusy, setWebsiteAiBusy] = useState(false);
  const [websiteAiMessage, setWebsiteAiMessage] = useState("");
  const [websiteAiRedeemBusy, setWebsiteAiRedeemBusy] = useState(false);
  const [websiteAiRedeemMessage, setWebsiteAiRedeemMessage] = useState("");
  const [websiteAiRechargeBusy, setWebsiteAiRechargeBusy] = useState(false);
  const [websiteAiRechargeMessage, setWebsiteAiRechargeMessage] = useState("");
  const [websiteAiRechargeOrder, setWebsiteAiRechargeOrder] = useState<WebsiteAiRechargeOrder | null>(null);
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationMessage, setConversationMessage] = useState("");
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
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
  const [latestCardDrawResult, setLatestCardDrawResult] = useState<CardDrawResult | null>(null);
  const [pendingGeneratedSave, setPendingGeneratedSave] = useState<PendingGeneratedSave | null>(null);
  const [styleDistillationProfile, setStyleDistillationProfile] = useState<StyleDistillationProfile | null>(null);
  const [disassemblyBooks, setDisassemblyBooks] = useState<DisassemblyBookSummary[]>([]);
  const [disassemblyLibraryBusy, setDisassemblyLibraryBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const liveJobIdsRef = useRef<Set<string>>(new Set());
  const selectedJobIdRef = useRef("");
  const lastSyncedProjectRef = useRef<CurrentProject>({ path: "", name: "" });
  const openDocumentsRef = useRef<OpenDocumentTab[]>([]);
  const activeDocumentPathRef = useRef("");
  const restoredSettingsRef = useRef(false);
  const skipNextSettingsPersistRef = useRef(false);
  const lastConfigSignatureRef = useRef("");
  const configDraftDirtyRef = useRef(false);
  const websiteAiRefreshKeyRef = useRef("");
  const client = useMemo(() => createApiClient({ baseUrl: runtime.apiBase }), [runtime.apiBase]);

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

  useEffect(() => () => abortRef.current?.abort(), []);

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
    const websiteToken = `${websiteProfile?.api_key || websiteProfile?.license_account_key || ""}`.trim();
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
        opened_at: new Date().toISOString()
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
        cache_chars: pendingSave.cacheChars || pendingSave.content.length
      });
      setSnapshot((current) => (current ? { ...current, localState } : current));
    } catch {
      // This is metadata only; generated save/discard must not depend on the local cache index.
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
      attachment_count: detail.attachment_count
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
    setSnapshot((current) => (current ? { ...current, conversations } : current));
    return conversations;
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
    abortRef.current?.abort();
    abortRef.current = null;
    liveJobIdsRef.current.clear();
    setSendingMessage(false);
    setOpenDocuments([]);
    setActiveDocumentPath("");
    setDocumentBusy(false);
    setDocumentMessage("");
    setVectorSearchBusy(false);
    setVectorSearchMessage("");
    setVectorSearchResults([]);
    setPendingCloseRequest(null);
    setPendingReloadRequest(null);
    setPendingSaveConflictRequest(null);
    setPendingProjectSwitchRequest(null);
    setConversationDetail(null);
    setConversationBusy(false);
    setConversationMessage("");
    setMessageInput("");
    setPendingGeneratedSave(null);
    setLatestSkillResult(null);
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

  async function finalizeProjectSwitch(nextProject: CurrentProject, successMessage: string) {
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
    const nextConversations = conversationsResult.status === "fulfilled" ? conversationsResult.value : [];
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

    setConversationMessage(message);
    setActiveTab("conversations");
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

    const detail = await client.createConversation();
    const conversations = await client.getConversations();
    setConversationDetail(detail);
    setSnapshot((current) => (current ? { ...current, conversations } : current));
    return detail.id;
  }

  function includedConversationAttachmentIds(detail = conversationDetail): string[] {
    return detail?.attachments.map((attachment) => attachment.id) || [];
  }

  async function autoExtractLoreFromGeneratedOutline(input: {
    skillId?: string;
    content?: string;
    targetPath?: string;
    targetPaths?: string[];
    sourcePath?: string;
  }): Promise<string> {
    if (!configDraft?.auto_lore_extract_enabled || !isOutlineGenerationResult(input)) {
      return "";
    }

    const text = String(input.content || "").trim();
    if (!text) {
      return "";
    }

    try {
      const result = await client.runSkill("lore_extract", {
        text,
        conversation_id: conversationDetail?.id || "",
        source_path: input.sourcePath || input.targetPath || input.targetPaths?.[0] || "",
        target_path: "",
        instruction: "自动提取设定：只提取这段新生成大纲、细纲或章纲中明确出现的人物、体系、地图、道具设定，并与现有设定合并，避免臆造。",
        write_result: true,
        attachment_ids: []
      });
      const savedPaths = skillSavedPaths(result);
      if (savedPaths.length) {
        await syncChangedPaths(savedPaths, { openFirst: false });
        return `；已自动提取设定并写入 ${savedPaths.length} 个设定文件`;
      }
      return "；自动提取设定完成，但未发现可写入的设定段落";
    } catch (nextError) {
      return `；自动提取设定失败：${nextError instanceof Error ? nextError.message : "未知错误"}`;
    }
  }

  async function handleAgentRunPayload(_conversationId: string, reply: string, payload: AgentRunResponse) {
    const pendingSave = pendingSaveFromSkill(payload.skill_result, "chat");
    const skillResultData = payload.skill_result?.data || {};
    const completionMessage = pendingSave
      ? "生成完成，等待选择写入方式"
      : payload.requires_confirmation
        ? "已生成待确认的操作预览，下一步把确认执行接进新工作台"
        : payload.results.length
          ? "智能体已完成文件改动"
          : payload.skill_result?.status === "job_created"
            ? "已创建后台任务，工作台会继续追踪它"
            : reply || payload.reply || "智能体已完成";

    if (payload.conversation) {
      setConversationDetail(payload.conversation);
      await refreshConversationsList();
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

    if (pendingSave) {
      setPendingGeneratedSave(pendingSave);
      void trackDesktopGeneratedCache(pendingSave, "pending");
      publishPendingSaveMessage(pendingSave, completionMessage);
      const autoLoreMessage = await autoExtractLoreFromGeneratedOutline({
        skillId: pendingSave.skillId,
        content: pendingSave.content,
        targetPath: pendingSave.targetPath,
        targetPaths: pendingSave.targetPaths
      });
      if (autoLoreMessage) {
        publishPendingSaveMessage(pendingSave, `${completionMessage}${autoLoreMessage}`);
      }
      return;
    }

    if (payload.saved_paths.length) {
      await syncChangedPaths(payload.saved_paths, { openFirst: true });
    }

    const autoLoreMessage = await autoExtractLoreFromGeneratedOutline({
      skillId: String(skillResultData.skill_id || ""),
      content: String(skillResultData.result || payload.skill_result?.result || payload.reply || reply || ""),
      targetPath: String(skillResultData.target_path || payload.saved_paths[0] || ""),
      targetPaths: uniquePaths([...stringListFromUnknown(skillResultData.target_paths), ...payload.saved_paths])
    });

    setConversationMessage(`${completionMessage}${autoLoreMessage}`);
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

  async function performCreateProject(parentPath: string, projectName: string) {
    setProjectBusy(true);
    setProjectMessage("");
    try {
      const created = await client.createProject(parentPath, projectName);
      await finalizeProjectSwitch(created, "新项目已创建并打开");
    } catch (nextError) {
      setProjectMessage(describeActionableError(nextError, "创建项目失败", "请确认父目录存在并且允许写入。"));
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
      hasPendingGeneratedSave: Boolean(pendingGeneratedSave)
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

  async function createProjectFromInput(pathOverride?: string) {
    const parentPath = (pathOverride ?? projectPathInput).trim();
    const projectName = projectNameInput.trim();
    if (!parentPath) {
      setProjectMessage("先填一个父目录，再创建项目。");
      return;
    }
    if (!projectName) {
      setProjectMessage("给新项目起个名字吧。");
      return;
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
      return;
    }

    await performCreateProject(parentPath, projectName);
  }

  async function pickAndOpenProject(mode: "open" | "create") {
    setProjectBusy(true);
    setProjectMessage(mode === "create" ? "请选择一个父目录，用来生成新项目。" : "请选择要打开的项目目录。");
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
      if (mode === "create") {
        await createProjectFromInput(picked.path);
      } else {
        await openProjectFromInput(picked.path);
      }
    } catch (nextError) {
      setProjectMessage(
        describeActionableError(nextError, mode === "create" ? "选择目录失败" : "选择项目失败", "请重新选择一个可访问的目录。")
      );
    } finally {
      setProjectBusy(false);
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
      setProjectMessage("项目显示名已更新");
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

  function patchConfig(patch: Partial<AppConfig>) {
    configDraftDirtyRef.current = true;
    setConfigDraft((current) => (current ? normalizeConfigDraft({ ...current, ...patch }) : current));
  }

  async function patchAndSaveConfig(patch: Partial<AppConfig>, message = "设置已保存。") {
    const baseConfig = configDraft;
    if (!baseConfig) {
      return;
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
      setConfigMessage(message);
    } catch (nextError) {
      configDraftDirtyRef.current = true;
      setConfigMessage(describeActionableError(nextError, "配置保存失败", "请检查联网搜索配置后重试。"));
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

  async function applyWebsiteAiConfig(payload: WebsiteAiApplyRequest) {
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
    } catch (nextError) {
      setWebsiteAiMessage(describeActionableError(nextError, "应用网站配置失败", "请先登录网站账号并选择可用模型。"));
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
      if (options.activateTab ?? true) {
        setActiveTab("conversations");
      }
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "读取会话失败"));
    } finally {
      setConversationBusy(false);
    }
  }

  async function createConversation() {
    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.createConversation();
      const list = await client.getConversations();
      setConversationDetail(detail);
      setSnapshot((current) => (current ? { ...current, conversations: list } : current));
      setActiveTab("conversations");
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "新建对话失败"));
    } finally {
      setConversationBusy(false);
    }
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
    if (!conversationDetail?.id || !activeDocumentPathRef.current) {
      setConversationMessage("请先选择会话并打开一个文档。");
      return;
    }

    setConversationBusy(true);
    setConversationMessage("");
    try {
      const detail = await client.pinConversationContext(conversationDetail.id, {
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

  async function uploadConversationAttachment(file: File | null) {
    if (!file) {
      return;
    }

    setUploadingAttachment(true);
    setConversationMessage("");
    try {
      const conversationId = await ensureConversationId();
      const attachment = await client.uploadConversationAttachment(conversationId, file, file.name || "attachment.txt");
      const detail = await client.getConversation(conversationId);
      const conversations = await client.getConversations();
      setConversationDetail(detail);
      setSnapshot((current) => (current ? { ...current, conversations } : current));
      setActiveTab("conversations");
      setConversationMessage(`已上传附件：${attachment.name}，发送消息时会作为上下文一起使用。`);
    } catch (nextError) {
      setConversationMessage(describeActionableError(nextError, "上传附件失败", "请确认文件可读取后重新上传。"));
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function uploadWorkflowAttachment(file: File | null): Promise<ConversationAttachment | null> {
    if (!file) {
      return null;
    }

    setUploadingAttachment(true);
    setOperationsMessage("");
    try {
      const conversationId = await ensureConversationId();
      const attachment = await client.uploadConversationAttachment(conversationId, file, file.name || "attachment.txt");
      const detail = await client.getConversation(conversationId);
      const conversations = await client.getConversations();
      setConversationDetail(detail);
      setSnapshot((current) => (current ? { ...current, conversations } : current));
      setOperationsMessage(`已上传拆书文件：${attachment.name}`);
      return attachment;
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
        conversation_id: conversationDetail?.id || "",
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

  async function archiveDisassemblySource(attachmentId: string, bookTitle = ""): Promise<DisassemblyBookSummary | null> {
    if (!attachmentId) {
      return null;
    }

    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const conversationId = await ensureConversationId();
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

  async function openDocument(path: string, options: OpenDocumentOptions = {}): Promise<boolean> {
    const existing = openDocumentsRef.current.find((item) => item.path === path);
    const shouldActivate = options.activate ?? true;

    if (existing && !options.forceReload) {
      if (shouldActivate) {
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

    setDocumentBusy(true);
    setDocumentMessage("");
    try {
      const document = await client.getDocument(path);
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
        setActiveDocumentPath(document.path);
        setActiveTab("editor");
      }
      return true;
    } catch (nextError) {
      setDocumentMessage(describeActionableError(nextError, "打开文档失败"));
      return false;
    } finally {
      setDocumentBusy(false);
    }
  }

  function activateDocument(path: string) {
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
    if (!activeDocumentPath) {
      return;
    }

    setPendingReloadRequest((current) => (current?.path === activeDocumentPath ? null : current));
    setOpenDocuments((current) =>
      current.map((item) =>
        item.path === activeDocumentPath
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

  async function saveActiveDocument(options: { force?: boolean; path?: string } = {}) {
    const targetPath = options.path || activeDocumentPathRef.current;
    const activeDocument = openDocumentsRef.current.find((item) => item.path === targetPath);
    if (!activeDocument) {
      return;
    }

    if (activeDocument.stale && !options.force) {
      setPendingSaveConflictRequest({
        path: activeDocument.path,
        title: activeDocument.title,
        currentUpdatedAt: ""
      });
      setDocumentMessage(`${activeDocument.path} 磁盘已有后台更新，普通保存已暂停。请读取最新版或确认覆盖。`);
      setActiveTab("editor");
      return;
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
        return;
      }
      setDocumentMessage(describeActionableError(nextError, "保存文档失败", "请确认目标文档仍存在，然后重试保存。"));
      setOpenDocuments((current) => current.map((item) => (item.path === activeDocument.path ? { ...item, saving: false } : item)));
    } finally {
      setDocumentBusy(false);
    }
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

  async function importSkillFromUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
      setOperationsMessage("请输入技能链接。");
      return;
    }
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const draft = await client.draftSkillFromUrl(trimmed);
      const skill = await client.importSkillDraft(draft);
      await refreshSkillCatalog();
      await selectSkill(skill.id, { activateTab: true });
      setOperationsMessage(`已从链接导入技能：${skill.name}`);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "从链接导入技能失败", "请确认链接可访问，且模型配置可用于整理普通网页内容。"));
    } finally {
      setOperationsBusy(false);
    }
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
        const skill = await client.toggleSkill(selectedSkillDetail.id, true);
        const skills = await refreshSkillCatalog();
        setSelectedSkillDetail(skill);
        setSelectedSkillId(skill.id);
        setOperationsMessage(`默认技能已禁用：${skill.name}。AI 会自动尝试调用相近的可用技能。`);
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

  async function sendConversationPrompt(content: string, options: { checkActiveDocument?: boolean } = {}) {
    const trimmed = content.trim();
    if (!trimmed || sendingMessage) {
      return;
    }

    if (pendingGeneratedSave) {
      publishPendingSaveMessage(pendingGeneratedSave, "还有待写入的生成结果，请先保存或丢弃后再发送新请求。");
      return;
    }

    if ((options.checkActiveDocument ?? true) && messageRequiresActiveDocument(trimmed) && !getActiveDocument()) {
      const nextMessage = "这条请求看起来需要当前文档。请先到编辑页打开正文、章纲或设定文件，再发送。";
      setConversationMessage(nextMessage);
      setDocumentMessage(nextMessage);
      setActiveTab("editor");
      return;
    }

    setConversationMessage("");
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

    abortRef.current = controller;
    setSendingMessage(true);
    appendLocalMessage(conversationId, "user", trimmed);
    setMessageInput("");

    let streamedText = "";
    try {
      await client.streamConversationMessage(
        conversationId,
        {
          content: trimmed,
          skill_id: "",
          agent_name: "",
          write_target: "",
          insert_mode: "none",
          runtime_context: buildProjectContextHint(),
          attachment_ids: includedConversationAttachmentIds()
        },
        {
          onStart: (event) => {
            const currentSkill = event.current_skill || event.skill_id || "";
            updateActiveConversationSkill(conversationId, event.skill_id || "", "");
            setConversationMessage(currentSkill ? `正在调用技能：${currentSkill}` : "正在判断当前技能...");
          },
          onDelta: (event) => {
            streamedText += event.text;
            upsertLocalMessage(conversationId, { ...assistantMessage, content: streamedText });
          },
          onFinal: async (event) => {
            const reply = resolveAssistantReply(event.payload, streamedText);
            if (reply.trim()) {
              upsertLocalMessage(conversationId, { ...assistantMessage, content: reply });
            }
            await handleAgentRunPayload(conversationId, reply, event.payload);
          },
          onError: async (event) => {
            throw new Error(event.message || "发送失败");
          }
        },
        controller.signal
      );
    } catch (nextError) {
      if (controller.signal.aborted) {
        setConversationMessage(describeStoppedConversationResponse(streamedText));
      } else {
        setConversationMessage(describeActionableError(nextError, "发送失败", "请检查模型配置或稍后重试；本次不会自动写入文件。"));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setSendingMessage(false);
    }
  }

  async function sendMessage() {
    const content = messageInput.trim();
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
    if (!abortRef.current) {
      return;
    }

    setConversationMessage("正在停止响应...");
    abortRef.current.abort();
  }

  async function invokeSelectedSkill() {
    if (!selectedSkillId) {
      return;
    }

    if (pendingGeneratedSave) {
      publishPendingSaveMessage(pendingGeneratedSave, "还有待写入的生成结果，请先保存或丢弃后再执行新技能。");
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

    await runWorkflowSkill(selectedSkillId, {
      text: activeDocument?.content || "",
      conversation_id: conversationDetail?.id || "",
      source_path: activeDocument?.path || "",
      target_path: activeDocument?.path || "",
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

    const pendingSave = pendingSaveFromSkill(result, "skill");
    if (pendingSave) {
      setPendingGeneratedSave(pendingSave);
      void trackDesktopGeneratedCache(pendingSave, "pending");
      publishPendingSaveMessage(pendingSave, "技能已生成内容，等待选择写入方式");
      const autoLoreMessage = await autoExtractLoreFromGeneratedOutline({
        skillId: pendingSave.skillId,
        content: pendingSave.content,
        targetPath: pendingSave.targetPath,
        targetPaths: pendingSave.targetPaths,
        sourcePath
      });
      if (autoLoreMessage) {
        publishPendingSaveMessage(pendingSave, `技能已生成内容，等待选择写入方式${autoLoreMessage}`);
      }
      return;
    }

    const savedPaths = skillSavedPaths(result);
    if (savedPaths.length) {
      await syncChangedPaths(savedPaths, { openFirst: true });
      const autoLoreMessage = await autoExtractLoreFromGeneratedOutline({
        skillId: String(result.data?.skill_id || skillId),
        content: String(result.data?.result || result.result || ""),
        targetPath: String(result.data?.target_path || savedPaths[0] || ""),
        targetPaths: uniquePaths([...stringListFromUnknown(result.data?.target_paths), ...savedPaths]),
        sourcePath
      });
      setOperationsMessage(`技能已写入 ${savedPaths[0]}${autoLoreMessage}`);
      return;
    }

    const autoLoreMessage = await autoExtractLoreFromGeneratedOutline({
      skillId: String(result.data?.skill_id || skillId),
      content: String(result.data?.result || result.result || ""),
      targetPath: String(result.data?.target_path || ""),
      targetPaths: stringListFromUnknown(result.data?.target_paths),
      sourcePath
    });
    setOperationsMessage(result.result.trim() ? `技能执行完成，结果已显示在下方预览。${autoLoreMessage}` : `技能执行完成${autoLoreMessage}`);
  }

  async function runWorkflowSkill(skillId: string, payload: Partial<SkillRunRequest> = {}) {
    if (!skillId) {
      return;
    }
    if (pendingGeneratedSave) {
      publishPendingSaveMessage(pendingGeneratedSave, "还有待写入的生成结果，请先保存或丢弃后再执行新技能。");
      return;
    }

    setOperationsBusy(true);
    setOperationsMessage("");
    setLatestSkillResult(null);
    try {
      const activeDocument = getActiveDocument();
      const sourcePath = payload.source_path ?? activeDocument?.path ?? "";
      const autoRevision = Boolean(configDraft?.enable_consistency_revision);
      const scoreThreshold = configDraft?.consistency_revision_score || 80;
      const result = await client.runSkill(skillId, {
        ...(payload as Record<string, unknown>),
        text: payload.text ?? activeDocument?.content ?? "",
        chapter: payload.chapter ?? 0,
        end_chapter: payload.end_chapter ?? 0,
        target_words: payload.target_words ?? 2500,
        instruction: payload.instruction ?? "",
        target_path: payload.target_path ?? "",
        conversation_id: payload.conversation_id ?? conversationDetail?.id ?? "",
        source_path: sourcePath,
        write_result: payload.write_result ?? false,
        attachment_ids: payload.attachment_ids ?? [],
        auto_revision: (payload as any).auto_revision ?? autoRevision,
        score_threshold: (payload as any).score_threshold ?? scoreThreshold
      } as any);
      await handleSkillRunResult(result, skillId, sourcePath);
    } catch (nextError) {
      setOperationsMessage(describeActionableError(nextError, "执行技能失败", "请确认已打开目标文档、模型配置可用后重试。"));
    } finally {
      setOperationsBusy(false);
    }
  }

  async function runNuwaStyleDistillation(options: { replace?: boolean; text?: string; sourcePath?: string; bookTitle?: string; sourceBookId?: string } = {}) {
    if (pendingGeneratedSave) {
      publishPendingSaveMessage(pendingGeneratedSave, "还有待写入的生成结果，请先保存或丢弃后再执行蒸馏。");
      return;
    }
    if (styleDistillationProfile && !options.replace) {
      setOperationsMessage("当前项目已经有蒸馏书籍。请在拆书面板确认替换后再执行。");
      return;
    }

    const activeDocument = getActiveDocument();
    setOperationsBusy(true);
    setOperationsMessage("");
    try {
      const result = await client.runSkill("nuwa_style_distill", {
        text: options.text ?? activeDocument?.content ?? "",
        conversation_id: conversationDetail?.id || "",
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
      setOperationsMessage(profile ? `已蒸馏：${profile.book_title}，并已启用为生成文风。` : result.result || "蒸馏完成。");
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
      const result = await client.runSkill("nuwa_style_distill", {
        text: "",
        conversation_id: conversationDetail?.id || "",
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
      const result = await client.runSkill("nuwa_style_distill", {
        text: "",
        conversation_id: conversationDetail?.id || "",
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

  async function savePendingGenerated(mode: "replace" | "append") {
    if (!pendingGeneratedSave) {
      return;
    }

    const currentPending = pendingGeneratedSave;

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
        save_plan: currentPending.savePlan
      });

      setPendingGeneratedSave(null);
      await syncChangedPaths(result.saved_paths, { openFirst: true });
      await trackDesktopGeneratedCache(currentPending, "saved", mode);
      publishPendingSaveMessage(
        currentPending,
        describeSavedGeneratedResult(currentPending, mode, result.saved_paths)
      );
    } catch (nextError) {
      publishPendingSaveMessage(
        currentPending,
        describeActionableError(nextError, "保存生成结果失败", "请确认目标文档仍存在；生成结果仍保留在待写入状态。")
      );
    } finally {
      setConversationBusy(false);
      setOperationsBusy(false);
    }
  }

  async function discardPendingGenerated() {
    if (!pendingGeneratedSave) {
      return;
    }

    const currentPending = pendingGeneratedSave;

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
      setPendingGeneratedSave(null);
      publishPendingSaveMessage(currentPending, "已丢弃生成结果，没有写入文件。");
    } catch (nextError) {
      publishPendingSaveMessage(
        currentPending,
        describeActionableError(nextError, "删除生成缓存失败", "生成结果仍保留，可稍后重试丢弃或直接保存。")
      );
    } finally {
      setConversationBusy(false);
      setOperationsBusy(false);
    }
  }

  async function savePendingGeneratedAsDraft() {
    if (!pendingGeneratedSave) {
      return;
    }

    const currentPending = pendingGeneratedSave;
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
      setPendingGeneratedSave(null);
      await syncChangedPaths(result.saved_paths.length ? result.saved_paths : [draftPath], { openFirst: true });
      await trackDesktopGeneratedCache(currentPending, "saved", "replace");
      publishPendingSaveMessage(currentPending, `已另存为草稿：${draftPath}，原目标文件没有改动。`);
    } catch (nextError) {
      publishPendingSaveMessage(
        currentPending,
        describeActionableError(nextError, "另存草稿失败", "生成结果仍保留在待写入状态。")
      );
    } finally {
      setConversationBusy(false);
      setOperationsBusy(false);
    }
  }

  async function copyPendingGeneratedContent() {
    if (!pendingGeneratedSave) {
      return;
    }

    const currentPending = pendingGeneratedSave;
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
      publishPendingSaveMessage(
        currentPending,
        describeActionableError(nextError, "复制生成内容失败", "可以先另存为草稿或恢复缓存后再重试。")
      );
    }
  }

  async function restoreGeneratedCache(cache: LocalStateGeneratedCache) {
    if (pendingGeneratedSave) {
      const message = "还有待写入的生成结果，请先保存或丢弃后再恢复其他缓存。";
      setOperationsMessage(message);
      setConversationMessage(message);
      return;
    }

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
          cache_chars: detail.meta.chars || cache.cache_chars
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
        savePlan: detail.meta.save_plan
      };

      setPendingGeneratedSave(restored);
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
    error,
    activeTab,
    setActiveTab,
    isRefreshing,
    refreshAll,
    projectBusy,
    projectMessage,
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
    pickAndOpenProject,
    renameCurrentProject,
    rebuildVectorIndex,
    processPendingVectorFiles,
    searchVectorIndex,
    configDraft,
    patchConfig,
    patchAndSaveConfig,
    saveConfig,
    refreshLicense,
    configMessage,
    configBusy,
    websiteAiDashboard,
    websiteAiBusy,
    websiteAiMessage,
    websiteAiRedeemBusy,
    websiteAiRedeemMessage,
    websiteAiRechargeBusy,
    websiteAiRechargeMessage,
    websiteAiRechargeOrder,
    loginWebsiteAi,
    refreshWebsiteAiDashboard,
    applyWebsiteAiConfig,
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
    loadConversation,
    createConversation,
    updateConversationTitle,
    summarizeConversation,
    pinCurrentDocumentToConversation,
    pinTextToConversation,
    removePinnedConversationContext,
    uploadConversationAttachment,
    uploadWorkflowAttachment,
    deleteConversationAttachment,
    sendMessage,
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
    selectedSkillId,
    selectedSkillDetail,
    selectedJobId,
    selectedJobDetail,
    operationsBusy,
    operationsMessage,
    latestSkillResult,
    latestCardDrawResult,
    pendingGeneratedSave,
    styleDistillationProfile,
    selectSkill,
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
    openSkillFolder,
    deleteOrDisableSelectedSkill,
    restoreSelectedBuiltinSkill,
    updateSkillDescription,
    runNuwaStyleDistillation,
    toggleNuwaStyleDistillation,
    deleteNuwaStyleDistillation,
    savePendingGenerated,
    savePendingGeneratedAsDraft,
    copyPendingGeneratedContent,
    discardPendingGenerated,
    restoreGeneratedCache,
    copyGeneratedCacheContent,
    discardGeneratedCacheRecord
  };
}
