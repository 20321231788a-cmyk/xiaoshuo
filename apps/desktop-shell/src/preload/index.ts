import { contextBridge, ipcRenderer } from "electron";
import {
  backendStatusSchema,
  cloudProjectDeleteRequestSchema,
  cloudProjectDeleteResponseSchema,
  cloudProjectDownloadRequestSchema,
  cloudProjectDownloadResponseSchema,
  cloudProjectInspectRequestSchema,
  cloudProjectInspectResponseSchema,
  cloudProjectListResponseSchema,
  cloudProjectUploadRequestSchema,
  cloudProjectUploadResponseSchema,
  desktopProjectArchiveResponseSchema,
  desktopProjectExportRequestSchema,
  desktopShellCapabilitiesSchema,
  desktopProjectPickerResponseSchema,
  desktopVersionsSchema,
  ipcChannels,
  localStatePatchSettingsRequestSchema,
  localStateRecordProjectRequestSchema,
  localStateRemoveRecentProjectRequestSchema,
  localStateSnapshotSchema,
  localStateSyncProjectRequestSchema,
  localStateTrackGeneratedCacheRequestSchema,
  novelAgentWorkspaceSnapshotSchema,
  novelBackgroundTaskControlSchema,
  novelBackgroundTaskCreateSchema,
  novelBackgroundTaskSchema,
  novelMemoryBatchDesktopRequestSchema,
  novelMemoryBatchPrepareResultSchema,
  novelMemoryBatchReviewResultSchema,
  novelProjectTransferCommitRequestSchema,
  novelProjectTransferPlanRequestSchema,
  novelProjectTransferPlanSchema,
  novelProjectTransferResultSchema,
  novelProjectTransferSourceConfirmRequestSchema,
  novelProjectTransferSourceConfirmResultSchema,
  novelProjectRootRequestSchema,
  novelRoomDesktopRequestSchema,
  novelRoomResponseSchema,
  novelToolInstallProposalRequestSchema,
  novelToolInstallProposalSchema,
  novelToolInstallRequestSchema,
  novelToolInstallResultSchema,
  novelTypedActionRequestSchema,
  novelTypedActionResultSchema,
  novelWorkspaceProjectSchema,
  runtimeRequestSchema,
  runtimeResponseSchema,
  runtimeStreamEventSchema,
  runtimeStreamRequestSchema,
  runtimeStreamStartResponseSchema,
  desktopUpdateStatusSchema,
  terminalDataEventSchema,
  terminalExitEventSchema,
  terminalSessionSchema,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type XiaoShuoDesktopApi
} from "../shared/channels.js";
import { UserGestureTicket } from "./user-gesture-ticket.js";
import { NovelUserGestureTicket } from "./novel-user-gesture-ticket.js";

const terminalUserGesture = new UserGestureTicket();
const novelUserGesture = new NovelUserGestureTicket();
const recordTerminalUserGesture = (event: Event) => {
  if (terminalUserGesture.recordTrustedGesture(event)) {
    ipcRenderer.send(ipcChannels.terminalAuthorizeUserGesture);
  }
};
const recordNovelUserGesture = (event: Event) => {
  const action = novelUserGesture.recordTrustedGesture(event);
  if (action) ipcRenderer.send(ipcChannels.novelAuthorizeUserGesture, action);
};

window.addEventListener("pointerdown", recordTerminalUserGesture, true);
window.addEventListener("keydown", recordTerminalUserGesture, true);
window.addEventListener("pointerdown", recordNovelUserGesture, true);
window.addEventListener("keydown", recordNovelUserGesture, true);

const desktopApi: XiaoShuoDesktopApi = {
  versions: async () => desktopVersionsSchema.parse(await ipcRenderer.invoke(ipcChannels.appVersions)),
  backendStatus: async () => backendStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.backendStatus)),
  restartBackend: async () => backendStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.backendRestart)),
  runtimeRequest: async (request) =>
    runtimeResponseSchema.parse(await ipcRenderer.invoke(ipcChannels.runtimeRequest, runtimeRequestSchema.parse(request))),
  runtimeStream: {
    start: async (request) =>
      runtimeStreamStartResponseSchema.parse(
        await ipcRenderer.invoke(ipcChannels.runtimeStreamStart, runtimeStreamRequestSchema.parse(request))
      ),
    cancel: (requestId) => {
      ipcRenderer.send(ipcChannels.runtimeStreamCancel, requestId);
    },
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(runtimeStreamEventSchema.parse(payload));
      };
      ipcRenderer.on(ipcChannels.runtimeStreamEvent, listener);
      return () => ipcRenderer.off(ipcChannels.runtimeStreamEvent, listener);
    }
  },
  onOpenTutorial: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(ipcChannels.appOpenTutorial, listener);
    return () => ipcRenderer.off(ipcChannels.appOpenTutorial, listener);
  },
  onRequestRefresh: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(ipcChannels.appRequestRefresh, listener);
    return () => ipcRenderer.off(ipcChannels.appRequestRefresh, listener);
  },
  onRequestRun: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(ipcChannels.appRequestRun, listener);
    return () => ipcRenderer.off(ipcChannels.appRequestRun, listener);
  },
  onRequestVectorTest: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(ipcChannels.appRequestVectorTest, listener);
    return () => ipcRenderer.off(ipcChannels.appRequestVectorTest, listener);
  },
  onRequestSave: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(ipcChannels.appRequestSave, listener);
    return () => ipcRenderer.off(ipcChannels.appRequestSave, listener);
  },
  onRequestFind: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(ipcChannels.appRequestFind, listener);
    return () => ipcRenderer.off(ipcChannels.appRequestFind, listener);
  },
  onRequestReplace: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(ipcChannels.appRequestReplace, listener);
    return () => ipcRenderer.off(ipcChannels.appRequestReplace, listener);
  },
  capabilities: async () => desktopShellCapabilitiesSchema.parse(await ipcRenderer.invoke(ipcChannels.shellCapabilities)),
  pickProjectDirectory: async () => desktopProjectPickerResponseSchema.parse(await ipcRenderer.invoke(ipcChannels.shellPickProjectDirectory)),
  exportProject: async (request) =>
    desktopProjectArchiveResponseSchema.parse(
      await ipcRenderer.invoke(ipcChannels.shellExportProject, desktopProjectExportRequestSchema.parse(request))
    ),
  importProject: async () => desktopProjectArchiveResponseSchema.parse(await ipcRenderer.invoke(ipcChannels.shellImportProject)),
  cloudProjects: {
    list: async () => cloudProjectListResponseSchema.parse(await ipcRenderer.invoke(ipcChannels.shellCloudProjectsList)),
    inspect: async (request) =>
      cloudProjectInspectResponseSchema.parse(
        await ipcRenderer.invoke(ipcChannels.shellCloudProjectsInspect, cloudProjectInspectRequestSchema.parse(request))
      ),
    upload: async (request) =>
      cloudProjectUploadResponseSchema.parse(
        await ipcRenderer.invoke(ipcChannels.shellCloudProjectsUpload, cloudProjectUploadRequestSchema.parse(request))
      ),
    downloadToProject: async (request) =>
      cloudProjectDownloadResponseSchema.parse(
        await ipcRenderer.invoke(ipcChannels.shellCloudProjectsDownload, cloudProjectDownloadRequestSchema.parse(request))
      ),
    delete: async (request) =>
      cloudProjectDeleteResponseSchema.parse(
        await ipcRenderer.invoke(ipcChannels.shellCloudProjectsDelete, cloudProjectDeleteRequestSchema.parse(request))
      )
  },
  localState: {
    get: async () => localStateSnapshotSchema.parse(await ipcRenderer.invoke(ipcChannels.localStateGet)),
    recordProject: async (request) =>
      localStateSnapshotSchema.parse(await ipcRenderer.invoke(ipcChannels.localStateRecordProject, localStateRecordProjectRequestSchema.parse(request))),
    removeRecentProject: async (request) =>
      localStateSnapshotSchema.parse(await ipcRenderer.invoke(ipcChannels.localStateRemoveRecentProject, localStateRemoveRecentProjectRequestSchema.parse(request))),
    syncProject: async (request) =>
      localStateSnapshotSchema.parse(await ipcRenderer.invoke(ipcChannels.localStateSyncProject, localStateSyncProjectRequestSchema.parse(request))),
    patchSettings: async (request) =>
      localStateSnapshotSchema.parse(await ipcRenderer.invoke(ipcChannels.localStatePatchSettings, localStatePatchSettingsRequestSchema.parse(request))),
    trackGeneratedCache: async (request) =>
      localStateSnapshotSchema.parse(
        await ipcRenderer.invoke(ipcChannels.localStateTrackGeneratedCache, localStateTrackGeneratedCacheRequestSchema.parse(request))
      )
  },
  novelAgent: {
    identifyProject: async (request) => novelWorkspaceProjectSchema.parse(
      await ipcRenderer.invoke(ipcChannels.novelIdentifyProject, novelProjectRootRequestSchema.parse(request))
    ),
    snapshot: async (request) => novelAgentWorkspaceSnapshotSchema.parse(
      await ipcRenderer.invoke(ipcChannels.novelSnapshot, novelWorkspaceProjectSchema.parse(request))
    ),
    review: async (request) => novelRoomResponseSchema.parse(
      await ipcRenderer.invoke(ipcChannels.novelReview, novelRoomDesktopRequestSchema.parse(request))
    ),
    proposeTool: async (request) => novelToolInstallProposalSchema.parse(
      await ipcRenderer.invoke(ipcChannels.novelToolPropose, novelToolInstallProposalRequestSchema.parse(request))
    ),
    installTool: async (request) => {
      novelUserGesture.consume("install_tool");
      return novelToolInstallResultSchema.parse(
        await ipcRenderer.invoke(ipcChannels.novelToolInstall, novelToolInstallRequestSchema.parse(request))
      );
    },
    runAction: async (request) => {
      novelUserGesture.consume("typed_action");
      return novelTypedActionResultSchema.parse(
        await ipcRenderer.invoke(ipcChannels.novelActionRun, novelTypedActionRequestSchema.parse(request))
      );
    },
    createBackgroundTask: async (request) => {
      novelUserGesture.consume("background_create");
      return novelBackgroundTaskSchema.parse(
        await ipcRenderer.invoke(ipcChannels.novelBackgroundCreate, novelBackgroundTaskCreateSchema.parse(request))
      );
    },
    controlBackgroundTask: async (request) => {
      novelUserGesture.consume("background_control");
      return novelBackgroundTaskSchema.parse(
        await ipcRenderer.invoke(ipcChannels.novelBackgroundControl, novelBackgroundTaskControlSchema.parse(request))
      );
    },
    pickTransferProject: async () => {
      const value = await ipcRenderer.invoke(ipcChannels.novelTransferPickProject);
      return value === null ? null : novelWorkspaceProjectSchema.parse(value);
    },
    createTransferPlan: async (request) => {
      novelUserGesture.consume("transfer_plan");
      return novelProjectTransferPlanSchema.parse(
        await ipcRenderer.invoke(ipcChannels.novelTransferPlan, novelProjectTransferPlanRequestSchema.parse(request))
      );
    },
    confirmTransferSource: async (request) => {
      novelUserGesture.consume("transfer_source_confirm");
      return novelProjectTransferSourceConfirmResultSchema.parse(
        await ipcRenderer.invoke(
          ipcChannels.novelTransferConfirmSource,
          novelProjectTransferSourceConfirmRequestSchema.parse(request)
        )
      );
    },
    commitTransfer: async (request) => {
      novelUserGesture.consume("transfer_target_confirm");
      return novelProjectTransferResultSchema.parse(
        await ipcRenderer.invoke(ipcChannels.novelTransferCommit, novelProjectTransferCommitRequestSchema.parse(request))
      );
    },
    prepareMemoryBatch: async (request) => novelMemoryBatchPrepareResultSchema.parse(
      await ipcRenderer.invoke(ipcChannels.novelMemoryPrepare, novelWorkspaceProjectSchema.parse(request))
    ),
    confirmMemoryBatch: async (request) => {
      novelUserGesture.consume("memory_batch");
      return novelMemoryBatchReviewResultSchema.parse(
        await ipcRenderer.invoke(ipcChannels.novelMemoryConfirm, novelMemoryBatchDesktopRequestSchema.parse(request))
      );
    }
  },
  terminal: {
    create: async (request) => {
      terminalUserGesture.consume();
      return terminalSessionSchema.parse(await ipcRenderer.invoke(ipcChannels.terminalCreate, request || {}));
    },
    write: async (request) => {
      await ipcRenderer.invoke(ipcChannels.terminalWrite, request);
    },
    resize: async (request) => {
      await ipcRenderer.invoke(ipcChannels.terminalResize, request);
    },
    kill: async (request) => {
      await ipcRenderer.invoke(ipcChannels.terminalKill, request);
    },
    onData: (callback: (event: TerminalDataEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(terminalDataEventSchema.parse(payload));
      };
      ipcRenderer.on(ipcChannels.terminalData, listener);
      return () => ipcRenderer.off(ipcChannels.terminalData, listener);
    },
    onExit: (callback: (event: TerminalExitEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(terminalExitEventSchema.parse(payload));
      };
      ipcRenderer.on(ipcChannels.terminalExit, listener);
      return () => ipcRenderer.off(ipcChannels.terminalExit, listener);
    }
  },
  updates: {
    getStatus: async () => desktopUpdateStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.updatesGetStatus)),
    check: async () => desktopUpdateStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.updatesCheck)),
    download: async () => desktopUpdateStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.updatesDownload)),
    installAndRestart: async () => {
      await ipcRenderer.invoke(ipcChannels.updatesInstallAndRestart);
    },
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(desktopUpdateStatusSchema.parse(payload));
      };
      ipcRenderer.on(ipcChannels.updatesStatus, listener);
      return () => ipcRenderer.off(ipcChannels.updatesStatus, listener);
    }
  }
};

contextBridge.exposeInMainWorld("xiaoshuoDesktop", desktopApi);
