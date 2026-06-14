import { z } from "zod";

export const desktopIpcChannels = {
  appVersions: "app:versions",
  backendStatus: "backend:status",
  backendRestart: "backend:restart",
  appOpenTutorial: "app:open-tutorial",
  appRequestRefresh: "app:request-refresh",
  appRequestSave: "app:request-save",
  appRequestFind: "app:request-find",
  shellCapabilities: "shell:capabilities",
  shellPickProjectDirectory: "shell:pick-project-directory",
  shellExportProject: "shell:export-project",
  shellImportProject: "shell:import-project",
  shellCloudProjectsList: "shell:cloud-projects:list",
  shellCloudProjectsUpload: "shell:cloud-projects:upload",
  shellCloudProjectsDownload: "shell:cloud-projects:download",
  shellCloudProjectsDelete: "shell:cloud-projects:delete",
  localStateGet: "local-state:get",
  localStateRecordProject: "local-state:record-project",
  localStateSyncProject: "local-state:sync-project",
  localStatePatchSettings: "local-state:patch-settings",
  localStateTrackGeneratedCache: "local-state:track-generated-cache",
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  updatesGetStatus: "updates:get-status",
  updatesCheck: "updates:check",
  updatesDownload: "updates:download",
  updatesInstallAndRestart: "updates:install-and-restart",
  updatesStatus: "updates:status"
} as const;

export const desktopVersionsSchema = z.object({
  electron: z.string().optional(),
  chrome: z.string().optional(),
  node: z.string().optional()
});

export const desktopBackendStatusSchema = z.object({
  ready: z.boolean(),
  url: z.string(),
  pid: z.number().optional(),
  error: z.string().optional()
});

export const desktopShellCapabilitiesSchema = z.object({
  terminal: z.object({
    available: z.boolean(),
    package: z.literal("node-pty"),
    reason: z.string().optional()
  }),
  localDatabase: z.object({
    available: z.boolean(),
    package: z.union([z.literal("better-sqlite3"), z.literal("node:sqlite")]),
    reason: z.string().optional()
  }),
  downloads: z.object({
    available: z.boolean(),
    package: z.literal("electron-dl"),
    reason: z.string().optional()
  }),
  contextMenu: z.object({
    available: z.boolean(),
    package: z.literal("electron-context-menu"),
    reason: z.string().optional()
  }),
  monitoring: z.object({
    available: z.boolean(),
    package: z.literal("@sentry/electron"),
    reason: z.string().optional()
  }),
  websocket: z.object({
    available: z.boolean(),
    package: z.literal("ws"),
    reason: z.string().optional()
  })
});

export const desktopProjectPickerResponseSchema = z
  .object({
    path: z.string().default("")
  })
  .passthrough();

export const desktopProjectExportRequestSchema = z.object({
  project_path: z.string().min(1),
  project_name: z.string().default("")
});

export const desktopProjectArchiveResponseSchema = z
  .object({
    path: z.string().default(""),
    canceled: z.boolean().default(false)
  })
  .passthrough();

export const cloudProjectSlotSchema = z
  .object({
    id: z.string().default(""),
    slot_id: z.number().int().min(1).max(3),
    project_name: z.string().default(""),
    file_name: z.string().default(""),
    size: z.number().int().nonnegative().default(0),
    sha256: z.string().default(""),
    created_at: z.string().default(""),
    updated_at: z.string().default("")
  })
  .passthrough();

export const cloudProjectListResponseSchema = z
  .object({
    slots: z.array(cloudProjectSlotSchema).default([]),
    limit: z.number().int().default(3),
    max_upload_bytes: z.number().int().default(20 * 1024 * 1024)
  })
  .passthrough();

export const cloudProjectUploadRequestSchema = z.object({
  slot_id: z.number().int().min(1).max(3),
  project_path: z.string().min(1),
  project_name: z.string().default("")
});

export const cloudProjectDownloadRequestSchema = z.object({
  id: z.string().min(1),
  project_path: z.string().min(1),
  project_name: z.string().default("")
});

export const cloudProjectDeleteRequestSchema = z.object({
  id: z.string().min(1)
});

export const cloudProjectUploadResponseSchema = z
  .object({
    ok: z.boolean().default(true),
    slot: cloudProjectSlotSchema,
    uploaded_bytes: z.number().int().nonnegative().default(0)
  })
  .passthrough();

export const cloudProjectDownloadResponseSchema = z
  .object({
    ok: z.boolean().default(true),
    project_path: z.string().default(""),
    backup_path: z.string().default("")
  })
  .passthrough();

export const cloudProjectDeleteResponseSchema = z
  .object({
    ok: z.boolean().default(true),
    deleted_id: z.string().default("")
  })
  .passthrough();

export const desktopWorkbenchTabSchema = z.enum(["overview", "project", "editor", "config", "conversations", "operations", "terminal"]);

export const desktopWorkbenchSettingsSchema = z.object({
  active_tab: desktopWorkbenchTabSchema.default("overview"),
  project_path_input: z.string().default(""),
  project_name_input: z.string().default(""),
  updated_at: z.string().optional()
});

export const localStateProjectSchema = z.object({
  path: z.string(),
  name: z.string(),
  opened_at: z.string(),
  conversation_count: z.number().int().nonnegative().default(0),
  job_count: z.number().int().nonnegative().default(0),
  last_synced_at: z.string().optional()
});

export const localStateGeneratedCacheSchema = z.object({
  cache_id: z.string(),
  project_path: z.string(),
  skill_id: z.string(),
  source: z.enum(["chat", "skill"]),
  target_path: z.string(),
  target_paths: z.array(z.string()),
  status: z.enum(["pending", "saved", "discarded"]),
  mode: z.enum(["replace", "append"]).optional(),
  cache_path: z.string().optional(),
  cache_chars: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string()
});

export const localStateSnapshotSchema = z.object({
  db_path: z.string(),
  driver: z.union([z.literal("better-sqlite3"), z.literal("node:sqlite")]),
  recent_projects: z.array(localStateProjectSchema),
  generated_caches: z.array(localStateGeneratedCacheSchema).default([]),
  settings: desktopWorkbenchSettingsSchema.default({}),
  synced_at: z.string()
});

export const localStateRecordProjectRequestSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  opened_at: z.string().optional()
});

export const localStateSyncProjectRequestSchema = z.object({
  project: localStateRecordProjectRequestSchema,
  conversations: z.array(z.unknown()).default([]),
  jobs: z.array(z.unknown()).default([]),
  synced_at: z.string().optional()
});

export const localStatePatchSettingsRequestSchema = z.object({
  active_tab: desktopWorkbenchTabSchema.optional(),
  project_path_input: z.string().optional(),
  project_name_input: z.string().optional()
});

export const localStateTrackGeneratedCacheRequestSchema = z.object({
  cache_id: z.string().min(1),
  project_path: z.string().default(""),
  skill_id: z.string().default(""),
  source: z.enum(["chat", "skill"]),
  target_path: z.string().default(""),
  target_paths: z.array(z.string()).default([]),
  status: z.enum(["pending", "saved", "discarded"]),
  mode: z.enum(["replace", "append"]).optional(),
  cache_path: z.string().optional(),
  cache_chars: z.number().int().nonnegative().default(0),
  created_at: z.string().optional(),
  updated_at: z.string().optional()
});

export const terminalCreateRequestSchema = z.object({
  cwd: z.string().optional(),
  shell: z.string().optional(),
  cols: z.number().int().min(20).max(500).default(100),
  rows: z.number().int().min(5).max(200).default(30)
});

export const terminalSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  shell: z.string(),
  cols: z.number().int(),
  rows: z.number().int()
});

export const terminalWriteRequestSchema = z.object({
  id: z.string(),
  data: z.string()
});

export const terminalResizeRequestSchema = z.object({
  id: z.string(),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200)
});

export const terminalKillRequestSchema = z.object({
  id: z.string()
});

export const terminalDataEventSchema = z.object({
  id: z.string(),
  data: z.string()
});

export const terminalExitEventSchema = z.object({
  id: z.string(),
  exitCode: z.number().nullable(),
  signal: z.number().nullable().optional()
});

export const desktopUpdateStateSchema = z.enum(["idle", "checking", "available", "not_available", "downloading", "downloaded", "error"]);

export const desktopUpdateStatusSchema = z.object({
  state: desktopUpdateStateSchema,
  currentVersion: z.string(),
  updateSource: z.enum(["github", "mirror"]).optional(),
  latestVersion: z.string().optional(),
  releaseName: z.string().optional(),
  releaseNotes: z.string().optional(),
  downloadedFile: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  transferred: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  error: z.string().optional(),
  isPackaged: z.boolean(),
  canCheck: z.boolean(),
  checkedAt: z.string().optional()
});

export type DesktopIpcChannel = (typeof desktopIpcChannels)[keyof typeof desktopIpcChannels];
export type DesktopVersions = z.infer<typeof desktopVersionsSchema>;
export type DesktopBackendStatus = z.infer<typeof desktopBackendStatusSchema>;
export type DesktopShellCapabilities = z.infer<typeof desktopShellCapabilitiesSchema>;
export type DesktopProjectPickerResponse = z.infer<typeof desktopProjectPickerResponseSchema>;
export type DesktopProjectExportRequest = z.input<typeof desktopProjectExportRequestSchema>;
export type DesktopProjectArchiveResponse = z.infer<typeof desktopProjectArchiveResponseSchema>;
export type CloudProjectSlot = z.infer<typeof cloudProjectSlotSchema>;
export type CloudProjectListResponse = z.infer<typeof cloudProjectListResponseSchema>;
export type CloudProjectUploadRequest = z.input<typeof cloudProjectUploadRequestSchema>;
export type CloudProjectDownloadRequest = z.input<typeof cloudProjectDownloadRequestSchema>;
export type CloudProjectDeleteRequest = z.input<typeof cloudProjectDeleteRequestSchema>;
export type CloudProjectUploadResponse = z.infer<typeof cloudProjectUploadResponseSchema>;
export type CloudProjectDownloadResponse = z.infer<typeof cloudProjectDownloadResponseSchema>;
export type CloudProjectDeleteResponse = z.infer<typeof cloudProjectDeleteResponseSchema>;
export type DesktopWorkbenchTab = z.infer<typeof desktopWorkbenchTabSchema>;
export type DesktopWorkbenchSettings = z.infer<typeof desktopWorkbenchSettingsSchema>;
export type LocalStateProject = z.infer<typeof localStateProjectSchema>;
export type LocalStateGeneratedCache = z.infer<typeof localStateGeneratedCacheSchema>;
export type LocalStateSnapshot = z.infer<typeof localStateSnapshotSchema>;
export type LocalStateRecordProjectRequest = z.infer<typeof localStateRecordProjectRequestSchema>;
export type LocalStateSyncProjectRequest = z.infer<typeof localStateSyncProjectRequestSchema>;
export type LocalStatePatchSettingsRequest = z.infer<typeof localStatePatchSettingsRequestSchema>;
export type LocalStateTrackGeneratedCacheRequest = z.infer<typeof localStateTrackGeneratedCacheRequestSchema>;
export type TerminalCreateRequest = z.input<typeof terminalCreateRequestSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type TerminalWriteRequest = z.infer<typeof terminalWriteRequestSchema>;
export type TerminalResizeRequest = z.infer<typeof terminalResizeRequestSchema>;
export type TerminalKillRequest = z.infer<typeof terminalKillRequestSchema>;
export type TerminalDataEvent = z.infer<typeof terminalDataEventSchema>;
export type TerminalExitEvent = z.infer<typeof terminalExitEventSchema>;
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;
export type DesktopUpdateStatus = z.infer<typeof desktopUpdateStatusSchema>;

export type XiaoShuoDesktopApi = {
  versions: () => Promise<DesktopVersions>;
  backendStatus: () => Promise<DesktopBackendStatus>;
  restartBackend: () => Promise<DesktopBackendStatus>;
  onOpenTutorial: (callback: () => void) => () => void;
  onRequestRefresh: (callback: () => void) => () => void;
  onRequestSave: (callback: () => void) => () => void;
  onRequestFind: (callback: () => void) => () => void;
  capabilities: () => Promise<DesktopShellCapabilities>;
  pickProjectDirectory: () => Promise<DesktopProjectPickerResponse>;
  exportProject: (request: DesktopProjectExportRequest) => Promise<DesktopProjectArchiveResponse>;
  importProject: () => Promise<DesktopProjectArchiveResponse>;
  cloudProjects: {
    list: () => Promise<CloudProjectListResponse>;
    upload: (request: CloudProjectUploadRequest) => Promise<CloudProjectUploadResponse>;
    downloadToProject: (request: CloudProjectDownloadRequest) => Promise<CloudProjectDownloadResponse>;
    delete: (request: CloudProjectDeleteRequest) => Promise<CloudProjectDeleteResponse>;
  };
  localState: {
    get: () => Promise<LocalStateSnapshot>;
    recordProject: (request: LocalStateRecordProjectRequest) => Promise<LocalStateSnapshot>;
    syncProject: (request: LocalStateSyncProjectRequest) => Promise<LocalStateSnapshot>;
    patchSettings: (request: LocalStatePatchSettingsRequest) => Promise<LocalStateSnapshot>;
    trackGeneratedCache: (request: LocalStateTrackGeneratedCacheRequest) => Promise<LocalStateSnapshot>;
  };
  terminal: {
    create: (request?: TerminalCreateRequest) => Promise<TerminalSession>;
    write: (request: TerminalWriteRequest) => Promise<void>;
    resize: (request: TerminalResizeRequest) => Promise<void>;
    kill: (request: TerminalKillRequest) => Promise<void>;
    onData: (callback: (event: TerminalDataEvent) => void) => () => void;
    onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
  };
  updates: {
    getStatus: () => Promise<DesktopUpdateStatus>;
    check: () => Promise<DesktopUpdateStatus>;
    download: () => Promise<DesktopUpdateStatus>;
    installAndRestart: () => Promise<void>;
    onStatus: (callback: (status: DesktopUpdateStatus) => void) => () => void;
  };
};
