import { contextBridge, ipcRenderer } from "electron";
import {
  backendStatusSchema,
  cloudProjectDeleteRequestSchema,
  cloudProjectDeleteResponseSchema,
  cloudProjectDownloadRequestSchema,
  cloudProjectDownloadResponseSchema,
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
  localStateSnapshotSchema,
  localStateSyncProjectRequestSchema,
  localStateTrackGeneratedCacheRequestSchema,
  runtimeRequestSchema,
  runtimeResponseSchema,
  desktopUpdateStatusSchema,
  terminalDataEventSchema,
  terminalExitEventSchema,
  terminalSessionSchema,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type XiaoShuoDesktopApi
} from "../shared/channels.js";
import { UserGestureTicket } from "./user-gesture-ticket.js";

const terminalUserGesture = new UserGestureTicket();
const recordTerminalUserGesture = (event: Event) => {
  terminalUserGesture.recordTrustedGesture(event);
};

window.addEventListener("pointerdown", recordTerminalUserGesture, true);
window.addEventListener("keydown", recordTerminalUserGesture, true);

const desktopApi: XiaoShuoDesktopApi = {
  versions: async () => desktopVersionsSchema.parse(await ipcRenderer.invoke(ipcChannels.appVersions)),
  backendStatus: async () => backendStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.backendStatus)),
  restartBackend: async () => backendStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.backendRestart)),
  runtimeRequest: async (request) =>
    runtimeResponseSchema.parse(await ipcRenderer.invoke(ipcChannels.runtimeRequest, runtimeRequestSchema.parse(request))),
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
    syncProject: async (request) =>
      localStateSnapshotSchema.parse(await ipcRenderer.invoke(ipcChannels.localStateSyncProject, localStateSyncProjectRequestSchema.parse(request))),
    patchSettings: async (request) =>
      localStateSnapshotSchema.parse(await ipcRenderer.invoke(ipcChannels.localStatePatchSettings, localStatePatchSettingsRequestSchema.parse(request))),
    trackGeneratedCache: async (request) =>
      localStateSnapshotSchema.parse(
        await ipcRenderer.invoke(ipcChannels.localStateTrackGeneratedCache, localStateTrackGeneratedCacheRequestSchema.parse(request))
      )
  },
  terminal: {
    create: async (request) => {
      terminalUserGesture.consume();
      const ticket = await ipcRenderer.invoke(ipcChannels.terminalAcquireTicket);
      return terminalSessionSchema.parse(await ipcRenderer.invoke(ipcChannels.terminalCreate, { ...(request || {}), ticket }));
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
