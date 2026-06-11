import { contextBridge, ipcRenderer } from "electron";
import {
  backendStatusSchema,
  desktopShellCapabilitiesSchema,
  desktopProjectPickerResponseSchema,
  desktopVersionsSchema,
  ipcChannels,
  localStatePatchSettingsRequestSchema,
  localStateRecordProjectRequestSchema,
  localStateSnapshotSchema,
  localStateSyncProjectRequestSchema,
  localStateTrackGeneratedCacheRequestSchema,
  desktopUpdateStatusSchema,
  terminalDataEventSchema,
  terminalExitEventSchema,
  terminalSessionSchema,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type XiaoShuoDesktopApi
} from "../shared/channels.js";

const desktopApi: XiaoShuoDesktopApi = {
  versions: async () => desktopVersionsSchema.parse(await ipcRenderer.invoke(ipcChannels.appVersions)),
  backendStatus: async () => backendStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.backendStatus)),
  restartBackend: async () => backendStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.backendRestart)),
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
  capabilities: async () => desktopShellCapabilitiesSchema.parse(await ipcRenderer.invoke(ipcChannels.shellCapabilities)),
  pickProjectDirectory: async () => desktopProjectPickerResponseSchema.parse(await ipcRenderer.invoke(ipcChannels.shellPickProjectDirectory)),
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
    create: async (request) => terminalSessionSchema.parse(await ipcRenderer.invoke(ipcChannels.terminalCreate, request || {})),
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
