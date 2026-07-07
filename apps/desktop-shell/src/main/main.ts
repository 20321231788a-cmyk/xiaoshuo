import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
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
import { defaultProjectArchiveName, ensureZipExtension, exportProjectArchive, importProjectArchive } from "./project-archive.js";
import { CloudProjectService } from "./cloud-projects.js";
import {
  cloudProjectDeleteRequestSchema,
  cloudProjectDownloadRequestSchema,
  cloudProjectUploadRequestSchema,
  desktopProjectExportRequestSchema,
  ipcChannels
} from "../shared/channels.js";

const runtimeState: RuntimeServerState = {};
const appIconPath = path.join(app.getAppPath(), "assets", "quill.ico");
const appDisplayTitle = `ArcWriter ${app.getVersion()}`;
const updateService = new UpdateService({
  beforeInstall: async () => {
    killAllTerminals();
    closeLocalState();
    await stopRuntimeServer(runtimeState);
  }
});

contextMenu();
registerRuntimeShell(shell);

function activeWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

function registerApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "退出",
      accelerator: "CommandOrControl+Q",
      click: () => app.quit()
    },
    {
      label: "刷新",
      accelerator: "CommandOrControl+R",
      click: () => activeWindow()?.webContents.send(ipcChannels.appRequestRefresh)
    },
    {
      label: "教程",
      accelerator: "F1",
      click: () => activeWindow()?.webContents.send(ipcChannels.appOpenTutorial)
    }
  ]);
  Menu.setApplicationMenu(menu);
}

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
    title: appDisplayTitle,
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
  window.webContents.on("did-finish-load", () => {
    window.setTitle(appDisplayTitle);
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta)) {
      return;
    }
    const key = input.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      window.webContents.send(ipcChannels.appRequestSave);
      return;
    }
    if (key === "f") {
      event.preventDefault();
      window.webContents.send(ipcChannels.appRequestFind);
      return;
    }
    if (key === "h") {
      event.preventDefault();
      window.webContents.send(ipcChannels.appRequestReplace);
      return;
    }
    if (key === "c") {
      event.preventDefault();
      window.webContents.copy();
      return;
    }
    if (key === "x") {
      event.preventDefault();
      window.webContents.cut();
      return;
    }
    if (key === "v") {
      event.preventDefault();
      window.webContents.paste();
      return;
    }
    if (key === "a") {
      event.preventDefault();
      window.webContents.selectAll();
    }
  });

  window.webContents.session.on("will-download", (event, item) => {
    event.preventDefault();
    void download(window, item.getURL());
  });

  await loadRenderer(window);
  return window;
}

function registerIpc(): void {
  const cloudProjectService = new CloudProjectService({
    appRoot: resolveProjectRoot(app.getAppPath()),
    tempRoot: app.getPath("temp")
  });

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
  ipcMain.handle(ipcChannels.shellExportProject, async (_event, request) => {
    const payload = desktopProjectExportRequestSchema.parse(request);
    const defaultPath = path.join(path.dirname(path.resolve(payload.project_path)), defaultProjectArchiveName(payload.project_name, payload.project_path));
    const result = await dialog.showSaveDialog({
      title: "导出项目",
      defaultPath,
      filters: [{ name: "ArcWriter 项目归档", extensions: ["zip"] }]
    });
    if (result.canceled || !result.filePath) {
      return { path: "", canceled: true };
    }

    const archivePath = await exportProjectArchive({
      projectPath: payload.project_path,
      targetPath: ensureZipExtension(result.filePath)
    });
    return { path: archivePath, canceled: false };
  });
  ipcMain.handle(ipcChannels.shellImportProject, async () => {
    const archiveResult = await dialog.showOpenDialog({
      title: "选择项目归档",
      properties: ["openFile"],
      filters: [{ name: "ArcWriter 项目归档", extensions: ["zip"] }]
    });
    if (archiveResult.canceled || !archiveResult.filePaths[0]) {
      return { path: "", canceled: true };
    }

    const targetResult = await dialog.showOpenDialog({
      title: "选择导入目标文件夹",
      properties: ["openDirectory", "createDirectory"]
    });
    if (targetResult.canceled || !targetResult.filePaths[0]) {
      return { path: "", canceled: true };
    }

    const projectPath = await importProjectArchive({
      archivePath: archiveResult.filePaths[0],
      targetParentPath: targetResult.filePaths[0]
    });
    return { path: projectPath, canceled: false };
  });
  ipcMain.handle(ipcChannels.shellCloudProjectsList, async () => cloudProjectService.list());
  ipcMain.handle(ipcChannels.shellCloudProjectsUpload, async (_event, request) =>
    cloudProjectService.upload(cloudProjectUploadRequestSchema.parse(request))
  );
  ipcMain.handle(ipcChannels.shellCloudProjectsDownload, async (_event, request) =>
    cloudProjectService.downloadToProject(cloudProjectDownloadRequestSchema.parse(request))
  );
  ipcMain.handle(ipcChannels.shellCloudProjectsDelete, async (_event, request) =>
    cloudProjectService.delete(cloudProjectDeleteRequestSchema.parse(request))
  );
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
  registerApplicationMenu();
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
  app.quit();
});
