import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import contextMenu from "electron-context-menu";
import { download } from "electron-dl";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { DocumentService } from "@xiaoshuo/document-service";
import { ProjectManifestService, readExistingProjectId } from "@xiaoshuo/project-manifest";
import type { NovelTypedActionRequest, NovelTypedActionResult, NovelUserGestureAction } from "@xiaoshuo/shared";
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
import { createTerminalSession, killAllTerminals, killTerminal, killTerminalsForOwner, resizeTerminal, writeTerminal } from "./terminal.js";
import { registerRuntimeShell, runtimeUrl, startRuntimeServer, stopRuntimeServer, type RuntimeServerState } from "./runtime-server.js";
import { UpdateService } from "./update-service.js";
import { defaultProjectArchiveName, ensureZipExtension, exportProjectArchive, importProjectArchive } from "./project-archive.js";
import { CloudProjectService } from "./cloud-projects.js";
import { isSafeExternalUrl, isTrustedRendererUrl as hasTrustedRendererUrl } from "./renderer-security.js";
import { parseUpgradeSmokeProbeRequest, runUpgradeSmokeProbe } from "./upgrade-smoke-probe.js";
import {
  TerminalUserGestureAuthorizationStore,
  type TerminalRendererAuthorizationIdentity
} from "./terminal-user-gesture-authorization.js";
import { NovelAgentControlService } from "./novel-agent-control-service.js";
import {
  NovelUserGestureAuthorizationStore,
  type NovelRendererAuthorizationIdentity
} from "./novel-user-gesture-authorization.js";
import {
  cloudProjectDeleteRequestSchema,
  cloudProjectDownloadRequestSchema,
  cloudProjectUploadRequestSchema,
  desktopProjectExportRequestSchema,
  ipcChannels,
  novelBackgroundTaskControlSchema,
  novelBackgroundTaskCreateSchema,
  novelMemoryBatchDesktopRequestSchema,
  novelProjectTransferCommitRequestSchema,
  novelProjectTransferPlanRequestSchema,
  novelProjectTransferSourceConfirmRequestSchema,
  novelProjectRootRequestSchema,
  novelRoomDesktopRequestSchema,
  novelToolInstallProposalRequestSchema,
  novelToolInstallRequestSchema,
  novelTypedActionRequestSchema,
  novelUserGestureActionSchema,
  novelWorkspaceProjectSchema,
  runtimeRequestSchema
} from "../shared/channels.js";

const runtimeState: RuntimeServerState = {};
const terminalUserGestureAuthorizations = new TerminalUserGestureAuthorizationStore();
const novelUserGestureAuthorizations = new NovelUserGestureAuthorizationStore();
let novelAgentControlService: NovelAgentControlService | null = null;
const appIconPath = path.join(app.getAppPath(), "assets", "quill.ico");
const appDisplayTitle = `ArcWriter ${app.getVersion()}`;
const updateService = new UpdateService({
  beforeInstall: async () => {
    await novelAgentControlService?.pauseAll();
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
      label: "状态",
      submenu: [
        {
          label: "刷新",
          accelerator: "CommandOrControl+R",
          click: () => activeWindow()?.webContents.send(ipcChannels.appRequestRefresh)
        },
        {
          label: "运行",
          click: () => activeWindow()?.webContents.send(ipcChannels.appRequestRun)
        },
        {
          label: "向量测试",
          click: () => activeWindow()?.webContents.send(ipcChannels.appRequestVectorTest)
        }
      ]
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
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(appDisplayTitle);
  });
  const windowWebContentsId = window.webContents.id;
  window.on("closed", () => {
    terminalUserGestureAuthorizations.revoke(windowWebContentsId);
    novelUserGestureAuthorizations.revoke(windowWebContentsId);
    killTerminalsForOwner(windowWebContentsId);
  });
  window.webContents.on("did-start-navigation", () => {
    terminalUserGestureAuthorizations.revoke(windowWebContentsId);
    novelUserGestureAuthorizations.revoke(windowWebContentsId);
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
  novelAgentControlService = new NovelAgentControlService({
    appRoot: resolveProjectRoot(app.getAppPath()),
    statePath: path.join(app.getPath("userData"), "state", "novel-agent-control.json"),
    getFeatureFlags: () => runtimeState.featureFlags,
    getRuntimeRegistry: () => runtimeState.agentRuntimes ?? (runtimeState.agentRuntimes = new Map()),
    getProjectIdentityRegistry: () => runtimeState.projectIdentityRegistry
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
      projectIdentityRegistryPath: path.join(app.getPath("userData"), "state", "project-identities.json"),
      agentFeatureFlagOverridesPath: path.join(app.getPath("userData"), "state", "agent-feature-flags.json"),
      safeAgent: process.argv.includes("--safe-agent"),
      state: runtimeState
    });
    return { ready: true, url: runtimeUrl, pid: undefined };
  });
  ipcMain.handle(ipcChannels.runtimeRequest, async (event, request) => proxyRuntimeRequest(event, request));

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
  ipcMain.on(ipcChannels.novelAuthorizeUserGesture, (event, value) => {
    if (!isTrustedRuntimeRenderer(event)) return;
    const action = novelUserGestureActionSchema.safeParse(value);
    if (action.success) novelUserGestureAuthorizations.authorize(novelRendererIdentity(event), action.data);
  });
  ipcMain.handle(ipcChannels.novelSnapshot, (event, request) => {
    assertTrustedNovelRenderer(event);
    return requireNovelAgentService().snapshot(novelWorkspaceProjectSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelIdentifyProject, async (event, request) => {
    assertTrustedNovelRenderer(event);
    const payload = novelProjectRootRequestSchema.parse(request);
    const projectId = await readExistingProjectId(payload.project_root);
    if (!projectId || !runtimeState.projectIdentityRegistry) throw new Error("当前目录不是已确认的 ArcWriter 小说项目");
    runtimeState.projectIdentityRegistry.assertWritable(payload.project_root, projectId);
    return { project_id: projectId, project_root: path.resolve(payload.project_root) };
  });
  ipcMain.handle(ipcChannels.novelReview, (event, request) => {
    assertTrustedNovelRenderer(event);
    return requireNovelAgentService().review(novelRoomDesktopRequestSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelToolPropose, (event, request) => {
    assertTrustedNovelRenderer(event);
    return requireNovelAgentService().proposeTool(novelToolInstallProposalRequestSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelToolInstall, (event, request) => {
    consumeNovelGesture(event, "install_tool");
    return requireNovelAgentService().installTool(novelToolInstallRequestSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelActionRun, (event, request) => {
    consumeNovelGesture(event, "typed_action");
    return requireNovelAgentService().runTypedAction(
      novelTypedActionRequestSchema.parse(request),
      executeNovelTypedAction
    );
  });
  ipcMain.handle(ipcChannels.novelBackgroundCreate, (event, request) => {
    consumeNovelGesture(event, "background_create");
    return requireNovelAgentService().createBackgroundTask(novelBackgroundTaskCreateSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelBackgroundControl, (event, request) => {
    consumeNovelGesture(event, "background_control");
    return requireNovelAgentService().controlBackgroundTask(novelBackgroundTaskControlSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelTransferPickProject, async (event) => {
    assertTrustedNovelRenderer(event);
    const result = await dialog.showOpenDialog({ title: "选择小说素材迁移项目", properties: ["openDirectory"] });
    const projectRoot = result.canceled ? "" : result.filePaths[0] || "";
    if (!projectRoot) return null;
    const projectId = await readExistingProjectId(projectRoot);
    if (!projectId || !runtimeState.projectIdentityRegistry) throw new Error("所选目录不是具有稳定 UUID 的 ArcWriter 小说项目");
    const claim = await runtimeState.projectIdentityRegistry.reconfirm(projectRoot, projectId);
    return { project_id: claim.projectId, project_root: claim.canonicalPath };
  });
  ipcMain.handle(ipcChannels.novelTransferPlan, (event, request) => {
    consumeNovelGesture(event, "transfer_plan");
    return requireNovelAgentService().createTransferPlan(novelProjectTransferPlanRequestSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelTransferConfirmSource, (event, request) => {
    consumeNovelGesture(event, "transfer_source_confirm");
    return requireNovelAgentService().confirmTransferSource(
      novelProjectTransferSourceConfirmRequestSchema.parse(request)
    );
  });
  ipcMain.handle(ipcChannels.novelTransferCommit, (event, request) => {
    consumeNovelGesture(event, "transfer_target_confirm");
    const payload = novelProjectTransferCommitRequestSchema.parse(request);
    return requireNovelAgentService().commitTransfer({
      ...payload,
      target_confirmation_id: `transfer_target_${randomUUID().replace(/-/g, "")}`
    });
  });
  ipcMain.handle(ipcChannels.novelMemoryPrepare, (event, request) => {
    assertTrustedNovelRenderer(event);
    return requireNovelAgentService().prepareMemoryBatch(novelWorkspaceProjectSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.novelMemoryConfirm, (event, request) => {
    consumeNovelGesture(event, "memory_batch");
    const payload = novelMemoryBatchDesktopRequestSchema.parse(request);
    return requireNovelAgentService().confirmMemoryBatch(payload.project_root, {
      ...payload.request,
      confirmation_ids: Object.fromEntries(payload.request.items.map((item) => [
        item.claim_id,
        `memory_claim_${randomUUID().replace(/-/g, "")}`
      ]))
    });
  });
  ipcMain.on(ipcChannels.terminalAuthorizeUserGesture, (event) => {
    if (!isTrustedRuntimeRenderer(event)) {
      return;
    }
    terminalUserGestureAuthorizations.authorize(terminalRendererIdentity(event));
  });
  ipcMain.handle(ipcChannels.terminalCreate, (event, request) => {
    assertTrustedTerminalRenderer(event);
    terminalUserGestureAuthorizations.consume(terminalRendererIdentity(event));
    return createTerminalSession(request, event.sender.id);
  });
  ipcMain.handle(ipcChannels.terminalWrite, (event, request) => {
    assertTrustedTerminalRenderer(event);
    writeTerminal(request, event.sender.id);
  });
  ipcMain.handle(ipcChannels.terminalResize, (event, request) => {
    assertTrustedTerminalRenderer(event);
    resizeTerminal(request, event.sender.id);
  });
  ipcMain.handle(ipcChannels.terminalKill, (event, request) => {
    assertTrustedTerminalRenderer(event);
    killTerminal(request, event.sender.id);
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

async function proxyRuntimeRequest(event: IpcMainInvokeEvent, request: unknown) {
  if (!isTrustedRuntimeRenderer(event)) {
    throw new Error("拒绝非受信任渲染进程访问本地运行时");
  }
  const payload = runtimeRequestSchema.parse(request);
  const target = new URL(payload.url);
  if (target.origin !== runtimeUrl) {
    throw new Error("桌面运行时代理仅允许访问本地 ArcWriter API");
  }
  if (!runtimeState.sessionToken) {
    throw new Error("本地运行时尚未就绪");
  }

  const headers = new Headers(payload.headers);
  headers.delete("authorization");
  headers.delete("host");
  headers.set("Authorization", `Bearer ${runtimeState.sessionToken}`);
  const response = await fetch(target, {
    method: payload.method,
    headers,
    body: payload.body ?? undefined
  });
  const body = response.status === 204 || response.status === 304 ? null : new Uint8Array(await response.arrayBuffer());
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body
  };
}

function isTrustedRuntimeRenderer(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  return Boolean(
    window &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame.url === event.sender.getURL() &&
      isTrustedRendererUrl(event.senderFrame.url)
  );
}

function assertTrustedTerminalRenderer(event: IpcMainInvokeEvent): void {
  if (!isTrustedRuntimeRenderer(event)) {
    throw new Error("拒绝非受信任渲染进程访问本地终端");
  }
}

function terminalRendererIdentity(event: IpcMainEvent | IpcMainInvokeEvent): TerminalRendererAuthorizationIdentity {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !event.senderFrame) {
    throw new Error("拒绝无法绑定窗口的渲染进程访问本地终端");
  }
  return {
    webContentsId: event.sender.id,
    browserWindowId: window.id,
    rendererUrl: event.senderFrame.url
  };
}

function novelRendererIdentity(event: IpcMainEvent | IpcMainInvokeEvent): NovelRendererAuthorizationIdentity {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !event.senderFrame) throw new Error("拒绝无法绑定窗口的渲染进程访问小说 Agent 控制面");
  return { webContentsId: event.sender.id, browserWindowId: window.id, rendererUrl: event.senderFrame.url };
}

function assertTrustedNovelRenderer(event: IpcMainInvokeEvent): void {
  if (!isTrustedRuntimeRenderer(event)) throw new Error("拒绝非受信任渲染进程访问小说 Agent 控制面");
}

function consumeNovelGesture(event: IpcMainInvokeEvent, action: NovelUserGestureAction): void {
  assertTrustedNovelRenderer(event);
  novelUserGestureAuthorizations.consume(novelRendererIdentity(event), action);
}

function requireNovelAgentService(): NovelAgentControlService {
  if (!novelAgentControlService) throw new Error("小说 Agent 主进程服务尚未初始化");
  return novelAgentControlService;
}

async function executeNovelTypedAction(request: NovelTypedActionRequest): Promise<NovelTypedActionResult> {
  const documents = new DocumentService({ projectRoot: request.project_root });
  const baseResult = { action: request.action, operation_id: request.operation_id, ok: true, output_path: "", message: "" };
  if (request.action === "backup_project") {
    const backupRoot = path.join(path.dirname(request.project_root), "ArcWriter Backups");
    await fs.mkdir(backupRoot, { recursive: true });
    const target = path.join(backupRoot, defaultProjectArchiveName(path.basename(request.project_root), request.project_root));
    const output = await exportProjectArchive({ projectPath: request.project_root, targetPath: ensureZipExtension(target) });
    return { ...baseResult, output_path: output, message: "小说项目备份已完成" };
  }
  if (request.action === "export_project") {
    const result = await dialog.showSaveDialog({
      title: "导出小说项目",
      defaultPath: path.join(path.dirname(request.project_root), defaultProjectArchiveName(path.basename(request.project_root), request.project_root)),
      filters: [{ name: "ArcWriter 项目归档", extensions: ["zip"] }]
    });
    if (result.canceled || !result.filePath) return { ...baseResult, ok: false, message: "用户取消导出" };
    const output = await exportProjectArchive({ projectPath: request.project_root, targetPath: ensureZipExtension(result.filePath) });
    return { ...baseResult, output_path: output, message: "小说项目导出完成" };
  }
  if (request.action === "open_project_folder") {
    await shell.openPath(await documents.canonicalProjectRoot());
    return { ...baseResult, output_path: request.project_root, message: "已打开小说项目目录" };
  }
  if (request.action === "rebuild_index") {
    const output = "00_设定集/.agent/story-index.md";
    const manifest = new ProjectManifestService(request.project_root);
    const projectDocuments = (await manifest.listDocuments({ force: true }))
      .map((item) => item.path.replace(/\\/g, "/"))
      .filter((item) => /^(00_设定集|01_大纲|02_正文)\//.test(item) && /\.(md|txt)$/i.test(item) && !item.includes("/.agent/"));
    const indexLines = ["# 本地故事索引", "", `重建时间：${new Date().toISOString()}`, "", "## 小说文档"];
    for (const relativePath of projectDocuments) {
      const content = await documents.readRawText(relativePath, 100_000).catch(() => "");
      const headings = content.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^(#{1,6}\s+|第.{1,20}章|人物[:：]|伏笔[:：]|时间线[:：])/.test(line))
        .slice(0, 8);
      indexLines.push("", `### ${relativePath}`, "", `- 字符数：${content.length}`);
      if (headings.length) indexLines.push(`- 标题线索：${headings.join(" / ")}`);
    }
    if (!projectDocuments.length) indexLines.push("", "当前项目没有可索引的设定、大纲或正文文本。");
    await documents.saveDocument(output, `${indexLines.join("\n")}\n`, {
      source: "novel_typed_action",
      summary: "重建本地故事索引"
    });
    return { ...baseResult, output_path: output, message: "本地故事索引已重建" };
  }
  const selected = await dialog.showOpenDialog({
    title: request.action === "import_material" ? "选择小说参考素材" : "选择要转换的小说文档",
    properties: ["openFile"],
    filters: [{ name: "小说文档", extensions: request.action === "import_material" ? ["txt", "md", "epub"] : ["txt", "md"] }]
  });
  const sourcePath = selected.canceled ? "" : selected.filePaths[0] || "";
  if (!sourcePath) return { ...baseResult, ok: false, message: "用户取消选择文件" };
  const sourceContent = await readNovelMaterial(sourcePath);
  const sourceName = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 80) || "material";
  const extension = request.action === "convert_document"
    ? (request.format === "md" ? ".md" : ".txt")
    : ".txt";
  const relative = `00_设定集/参考素材/${sourceName}${extension}`;
  await documents.saveDocument(relative, sourceContent, { source: "novel_typed_action", summary: "导入小说参考素材" });
  return { ...baseResult, output_path: relative, message: request.action === "convert_document" ? "小说文档已转换并导入" : "小说参考素材已导入" };
}

async function readNovelMaterial(sourcePath: string): Promise<string> {
  const stats = await fs.stat(sourcePath);
  if (!stats.isFile() || stats.size > 20 * 1024 * 1024) throw new Error("小说素材必须是 20MB 以内的普通文件");
  if (path.extname(sourcePath).toLowerCase() !== ".epub") return fs.readFile(sourcePath, "utf8");
  const zip = new AdmZip(sourcePath);
  const text = zip.getEntries()
    .filter((entry) => !entry.isDirectory && /\.(xhtml|html|htm)$/i.test(entry.entryName))
    .map((entry) => entry.getData().toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) throw new Error("EPUB 中没有可导入的正文内容");
  return text;
}

function isTrustedRendererUrl(value: string): boolean {
  return hasTrustedRendererUrl(value, {
    runtimeUrl,
    rendererUrl: process.env.XIAOSHUO_RENDERER_URL,
    packagedWorkbenchIndex: path.join(process.resourcesPath, "workbench", "index.html")
  });
}

app.whenReady().then(async () => {
  const upgradeSmokeProbe = parseUpgradeSmokeProbeRequest(process.argv, app.isPackaged);
  registerApplicationMenu();
  registerIpc();
  const projectRoot = resolveProjectRoot(app.getAppPath());
  try {
    await startRuntimeServer({
      projectRoot,
      stateFilePath: path.join(app.getPath("userData"), "state", "project-session.json"),
      projectIdentityRegistryPath: path.join(app.getPath("userData"), "state", "project-identities.json"),
      agentFeatureFlagOverridesPath: path.join(app.getPath("userData"), "state", "agent-feature-flags.json"),
      safeAgent: process.argv.includes("--safe-agent"),
      state: runtimeState
    });
  } catch (error) {
    runtimeState.lastError = error instanceof Error ? error.message : "Runtime server failed to start";
  }
  await createWindow();
  if (upgradeSmokeProbe) {
    try {
      await runUpgradeSmokeProbe(upgradeSmokeProbe, {
        runtimeUrl,
        sessionToken: runtimeState.sessionToken || "",
        appVersion: app.getVersion()
      });
    } catch (error) {
      runtimeState.lastError = error instanceof Error ? error.message : String(error);
    }
  }
  updateService.scheduleStartupCheck();
});

let quitCleanupComplete = false;
app.on("before-quit", (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();
  killAllTerminals();
  closeLocalState();
  void Promise.all([novelAgentControlService?.pauseAll(), stopRuntimeServer(runtimeState)]).finally(() => {
    quitCleanupComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
