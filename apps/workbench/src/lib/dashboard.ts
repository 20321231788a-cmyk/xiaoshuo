import { createApiClient } from "@xiaoshuo/api-client";
import type {
  AppConfig,
  ConversationSummary,
  Health,
  JobInfo,
  LedgerItem,
  LicenseStatus,
  DesktopBackendStatus,
  DesktopShellCapabilities,
  LocalStateSnapshot,
  ProjectChromeSnapshot,
  ProjectManifestStatus,
  RevisionLogEntry,
  SkillDefinition,
  TimelineEntry,
  VectorIndexStatus
} from "@xiaoshuo/shared";
import type { WorkbenchRuntime } from "./runtime.js";

export type DashboardSnapshot = {
  fetchedAt: string;
  health: Health;
  license: LicenseStatus;
  config: AppConfig;
  projectChrome: ProjectChromeSnapshot;
  projectManifest: ProjectManifestStatus;
  vectorIndex: VectorIndexStatus;
  currentProject: ProjectChromeSnapshot["current"];
  skills: SkillDefinition[];
  conversations: ConversationSummary[];
  jobs: JobInfo[];
  ledger: LedgerItem[];
  timeline: TimelineEntry[];
  revisionLog: RevisionLogEntry[];
  desktopBackend: DesktopBackendStatus | null;
  desktopCapabilities: DesktopShellCapabilities | null;
  localState: LocalStateSnapshot | null;
};

function emptyProjectChrome(): ProjectChromeSnapshot {
  return {
    tree: [],
    libraries: [],
    timeline: [],
    current: {
      path: "",
      name: ""
    },
    version: 0,
    generated_at: new Date().toISOString()
  };
}

function emptyProjectManifestStatus(): ProjectManifestStatus {
  return {
    ready: false,
    files: 0,
    version: 0,
    generated_at: "",
    source: "empty",
    path: ""
  };
}

function emptyVectorIndexStatus(): VectorIndexStatus {
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

export async function loadDashboardSnapshot(runtime: WorkbenchRuntime): Promise<DashboardSnapshot> {
  const client = createApiClient({ baseUrl: runtime.apiBase });
  const [desktopBackend, desktopCapabilities] =
    runtime.isDesktopShell && window.xiaoshuoDesktop
      ? await Promise.all([window.xiaoshuoDesktop.backendStatus(), window.xiaoshuoDesktop.capabilities()])
      : [null, null];
  const localState = runtime.isDesktopShell && window.xiaoshuoDesktop ? await window.xiaoshuoDesktop.localState.get().catch(() => null) : null;

  const [health, license, config] = await Promise.all([
    client.getHealth(),
    client.getLicenseStatus(),
    client.getConfig()
  ]);

  const [projectChromeResult, projectManifestResult, vectorStatusResult, skillsResult, conversationsResult, jobsResult, ledgerResult, revisionLogResult] = await Promise.allSettled([
    client.getProjectChrome(),
    client.getProjectManifestStatus(),
    client.getVectorStatus(),
    client.getSkills(),
    client.getConversations(),
    client.getJobs(),
    client.getLedger(),
    client.getRevisionLog()
  ]);

  const projectChrome = settledValue(projectChromeResult, emptyProjectChrome());
  const projectManifest = settledValue(projectManifestResult, emptyProjectManifestStatus());
  const vectorIndex = settledValue(vectorStatusResult, emptyVectorIndexStatus());
  const skills = settledValue(skillsResult, []);
  const conversations = settledValue(conversationsResult, []);
  const jobs = settledValue(jobsResult, []);
  const ledger = settledValue(ledgerResult, []);
  const revisionLog = settledValue(revisionLogResult, []);
  const syncedLocalState =
    runtime.isDesktopShell && window.xiaoshuoDesktop && projectChrome.current.path
      ? await window.xiaoshuoDesktop.localState
          .syncProject({
            project: {
              path: projectChrome.current.path,
              name: projectChrome.current.name || projectChrome.current.path,
              opened_at: new Date().toISOString()
            },
            conversations,
            jobs
          })
          .catch(() => localState)
      : localState;

  return {
    fetchedAt: new Date().toISOString(),
    health,
    license,
    config,
    projectChrome,
    projectManifest,
    vectorIndex,
    currentProject: projectChrome.current,
    skills,
    conversations,
    jobs,
    ledger,
    timeline: projectChrome.timeline,
    revisionLog,
    desktopBackend,
    desktopCapabilities,
    localState: syncedLocalState
  };
}
