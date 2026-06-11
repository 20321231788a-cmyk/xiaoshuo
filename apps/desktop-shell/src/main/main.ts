import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import contextMenu from "electron-context-menu";
import { download } from "electron-dl";
import path from "node:path";
import { resolveProjectRoot } from "./backend.js";
import { getShellCapabilities } from "./capabilities.js";
import {
  closeLocalState,
  getLocalStateSnapshot,
  patchWorkbenchSettings,
  recordRecentProject,
  syncProjectLocalState,
  trackGeneratedCacheMetadata
} from "./local-state.js";
import { createTerminalSession, killAllTerminals, killTerminal, resizeTerminal, writeTerminal } from "./terminal.js";
import { registerRuntimeShell, runtimeUrl, startRuntimeServer, stopRuntimeServer, type RuntimeServerState } from "./runtime-server.js";
import { UpdateService } from "./update-service.js";
import { ipcChannels } from "../shared/channels.js";

const runtimeState: RuntimeServerState = {};
const appIconPath = path.join(app.getAppPath(), "assets", "quill.ico");
const updateService = new UpdateService({
  beforeInstall: async () => {
    killAllTerminals();
    closeLocalState();
    await stopRuntimeServer(runtimeState);
  }
});

contextMenu();
registerRuntimeShell(shell);

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const rendererUrl = process.env.XIAOSHUO_RENDERER_URL;
  if (rendererUrl) {
    await window.loadURL(rendererUrl);
    return;
  }

  if (app.isPackaged) {
    await window.loadFile(path.join(process.resourcesPath, "workbench", "index.html"), {
      query: {
        desktop: "1",
        api: runtimeUrl
      }
    });
    return;
  }

  await window.loadURL(`${runtimeUrl}/?desktop=1&api=${encodeURIComponent(runtimeUrl)}`);
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: "ArcWriter",
    icon: appIconPath,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist/preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.session.on("will-download", (event, item) => {
    event.preventDefault();
    void download(window, item.getURL());
  });

  await loadRenderer(window);
  return window;
}

function registerIpc(): void {
  ipcMain.handle(ipcChannels.appVersions, () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));

  ipcMain.handle(ipcChannels.backendStatus, async () => ({
    ready: Boolean(runtimeState.ready),
    url: runtimeUrl,
    pid: undefined,
    error: runtimeState.lastError
  }));

  ipcMain.handle(ipcChannels.backendRestart, async () => {
    const projectRoot = resolveProjectRoot(app.getAppPath());
    await startRuntimeServer({
      projectRoot,
      stateFilePath: path.join(app.getPath("userData"), "state", "project-session.json"),
      state: runtimeState
    });
    return { ready: true, url: runtimeUrl, pid: undefined };
  });

  ipcMain.handle(ipcChannels.shellCapabilities, () => getShellCapabilities());
  ipcMain.handle(ipcChannels.shellPickProjectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择小说项目目录",
      properties: ["openDirectory", "createDirectory"]
    });
    return { path: result.canceled ? "" : result.filePaths[0] || "" };
  });
  ipcMain.handle(ipcChannels.localStateGet, () => getLocalStateSnapshot());
  ipcMain.handle(ipcChannels.localStateRecordProject, (_event, request) => recordRecentProject(request));
  ipcMain.handle(ipcChannels.localStateSyncProject, (_event, request) => syncProjectLocalState(request));
  ipcMain.handle(ipcChannels.localStatePatchSettings, (_event, request) => patchWorkbenchSettings(request));
  ipcMain.handle(ipcChannels.localStateTrackGeneratedCache, (_event, request) => trackGeneratedCacheMetadata(request));
  ipcMain.handle(ipcChannels.terminalCreate, (_event, request) => createTerminalSession(request));
  ipcMain.handle(ipcChannels.terminalWrite, (_event, request) => {
    writeTerminal(request);
  });
  ipcMain.handle(ipcChannels.terminalResize, (_event, request) => {
    resizeTerminal(request);
  });
  ipcMain.handle(ipcChannels.terminalKill, (_event, request) => {
    killTerminal(request);
  });
  ipcMain.handle(ipcChannels.updatesGetStatus, () => updateService.getStatus());
  ipcMain.handle(ipcChannels.updatesCheck, () => updateService.checkForUpdates());
  ipcMain.handle(ipcChannels.updatesDownload, () => updateService.downloadUpdate());
  ipcMain.handle(ipcChannels.updatesInstallAndRestart, () => updateService.installAndRestart());

  updateService.onStatus((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.updatesStatus, status);
    }
  });
}

app.whenReady().then(async () => {
  registerIpc();
  const projectRoot = resolveProjectRoot(app.getAppPath());
  try {
    await startRuntimeServer({
      projectRoot,
      stateFilePath: path.join(app.getPath("userData"), "state", "project-session.json"),
      state: runtimeState
    });
  } catch (error) {
    runtimeState.lastError = error instanceof Error ? error.message : "Runtime server failed to start";
  }
  await createWindow();
  updateService.scheduleStartupCheck();
});

app.on("before-quit", () => {
  killAllTerminals();
  closeLocalState();
  void stopRuntimeServer(runtimeState);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
