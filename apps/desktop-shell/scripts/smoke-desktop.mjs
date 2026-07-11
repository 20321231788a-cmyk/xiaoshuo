import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "..", "..");
const workbenchDir = path.join(rootDir, "apps", "workbench");
const smokeRendererUrl = new URL("../smoke/bridge.html", import.meta.url).href;
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const npxCommand = isWindows ? "npx.cmd" : "npx";
const port = process.env.XIAOSHUO_SMOKE_PORT || "4192";
const rendererUrl = process.env.XIAOSHUO_RENDERER_URL || smokeRendererUrl;
let previewProcess = null;
let mockModelServer = null;
let mockModelBaseUrl = "";
let smokeConfigDir = "";
let smokeConfigPath = "";
let previousStudioConfigEnv;
let previousRuntimePortEnv;
let smokeRuntimePort = "";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[desktop-smoke] run ${command} ${args.join(" ")}`);
    const commandArgs = isWindows ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(isWindows ? "cmd.exe" : command, commandArgs, {
      cwd: options.cwd || rootDir,
      env: options.env || process.env,
      shell: false,
      stdio: options.stdio || "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function isUrlReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isUrlReady(url)) {
      return;
    }
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function findAvailablePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      probe.off("error", reject);
      resolve();
    });
  });
  const address = probe.address();
  await new Promise((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate an available runtime port");
  }
  return String(address.port);
}

async function ensurePreview() {
  if (process.env.XIAOSHUO_RENDERER_URL || rendererUrl.startsWith("file:")) {
    console.log(`[desktop-smoke] using renderer ${rendererUrl}`);
    return;
  }

  console.log("[desktop-smoke] building workbench");
  await run(npmCommand, ["run", "build:workbench"]);

  if (await isUrlReady(rendererUrl)) {
    console.log(`[desktop-smoke] reusing preview ${rendererUrl}`);
    return;
  }

  console.log(`[desktop-smoke] starting preview ${rendererUrl}`);
  const previewArgs = ["vite", "preview", "--host", "127.0.0.1", "--port", port];
  previewProcess = spawn(isWindows ? "cmd.exe" : npxCommand, isWindows ? ["/d", "/s", "/c", npxCommand, ...previewArgs] : previewArgs, {
    cwd: workbenchDir,
    env: process.env,
    shell: false,
    stdio: "inherit"
  });
  await waitForUrl(rendererUrl);
}

function cleanup() {
  if (previewProcess && !previewProcess.killed) {
    previewProcess.kill();
  }
}

async function startMockModelServer() {
  if (mockModelServer) {
    return mockModelBaseUrl;
  }

  mockModelServer = http.createServer(async (request, response) => {
    if (request.method === "POST" && String(request.url || "") === "/api/software-license/verify") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        ok: true,
        licensed: true,
        status: "licensed",
        message: "smoke account licensed",
        license: {
          planType: "lifetime",
          expiresAt: ""
        }
      }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end("method not allowed");
      return;
    }
    if (!String(request.url || "").endsWith("/chat/completions")) {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let content = "TS本地技能生成结果";
    try {
      const payload = JSON.parse(rawBody);
      const promptText = Array.isArray(payload.messages)
        ? payload.messages.map((item) => String(item?.content || "")).join("\n")
        : "";
      if (promptText.includes("你是 ArcWriter 的本地项目助手") || promptText.includes("【本轮动态上下文】")) {
        content = "TS本地聊天回复";
      } else if (promptText.includes("附件里的剧情素材")) {
        content = "TS附件技能生成结果";
      }
    } catch {
      // keep default content
    }

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content
          },
          finish_reason: "stop"
        }
      ]
    }));
  });

  await new Promise((resolve, reject) => {
    mockModelServer.once("error", reject);
    mockModelServer.listen(0, "127.0.0.1", () => {
      mockModelServer.off("error", reject);
      const address = mockModelServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Mock model server did not expose a TCP port"));
        return;
      }
      mockModelBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  return mockModelBaseUrl;
}

async function prepareSmokeConfig() {
  const baseUrl = await startMockModelServer();
  smokeConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-desktop-smoke-"));
  smokeConfigPath = path.join(smokeConfigDir, "studio_config.json");
  previousStudioConfigEnv = process.env.XIAOSHUO_STUDIO_CONFIG;
  previousRuntimePortEnv = process.env.XIAOSHUO_RUNTIME_PORT;
  smokeRuntimePort = process.env.XIAOSHUO_SMOKE_RUNTIME_PORT || await findAvailablePort();
  process.env.XIAOSHUO_STUDIO_CONFIG = smokeConfigPath;
  process.env.XIAOSHUO_RUNTIME_PORT = smokeRuntimePort;
  await fs.writeFile(
    smokeConfigPath,
    `${JSON.stringify({
      api_key: "smoke-key",
      base_url: `${baseUrl}/v1`,
      model: "smoke-model",
      temp: 0.2,
      license_account_key: "smoke-license-key",
      website_profile: {
        api_key: "smoke-license-key",
        license_account_key: "smoke-license-key"
      }
    }, null, 2)}\n`,
    "utf8"
  );
}

async function cleanupSmokeResources() {
  if (mockModelServer) {
    await new Promise((resolve) => mockModelServer.close(() => resolve()));
    mockModelServer = null;
    mockModelBaseUrl = "";
  }
  if (smokeConfigDir) {
    await fs.rm(smokeConfigDir, { recursive: true, force: true });
    smokeConfigDir = "";
    smokeConfigPath = "";
  }
  if (previousStudioConfigEnv === undefined) {
    delete process.env.XIAOSHUO_STUDIO_CONFIG;
  } else {
    process.env.XIAOSHUO_STUDIO_CONFIG = previousStudioConfigEnv;
  }
  if (previousRuntimePortEnv === undefined) {
    delete process.env.XIAOSHUO_RUNTIME_PORT;
  } else {
    process.env.XIAOSHUO_RUNTIME_PORT = previousRuntimePortEnv;
  }
  previousStudioConfigEnv = undefined;
  previousRuntimePortEnv = undefined;
  smokeRuntimePort = "";
}

async function expectMissing(targetPath, message) {
  try {
    await fs.access(targetPath);
  } catch {
    return;
  }
  throw new Error(message);
}

async function readNdjson(response) {
  const text = await response.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Replays a request through the same preload -> IPC -> authenticated runtime
 * path used by the packaged Workbench. The Node process intentionally never
 * receives the runtime session token.
 */
async function fetchRuntimeThroughDesktopBridge(page, input, init) {
  const request = new Request(input, init);
  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : Array.from(new Uint8Array(await request.arrayBuffer()));
  const response = await page.evaluate(async (payload) => {
    const result = await window.xiaoshuoDesktop.runtimeRequest({
      url: payload.url,
      method: payload.method,
      headers: payload.headers,
      body: payload.body ? new Uint8Array(payload.body) : null
    });
    return {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: result.body ? Array.from(result.body) : null
    };
  }, {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body
  });
  return new Response(response.body ? new Uint8Array(response.body) : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/**
 * Keeps the health probe intentionally unauthenticated, while every other
 * request aimed at this smoke runtime uses the desktop bridge. Calls to the
 * mock model server and any unrelated origin continue using Node fetch.
 */
function installAuthenticatedRuntimeFetch(page, runtimeBaseUrl) {
  const nodeFetch = globalThis.fetch;
  const runtimeOrigin = new URL(runtimeBaseUrl).origin;
  globalThis.fetch = async (input, init) => {
    const value = input instanceof Request ? input.url : String(input);
    let target;
    try {
      target = new URL(value);
    } catch {
      return nodeFetch(input, init);
    }
    if (target.origin !== runtimeOrigin || target.pathname === "/health" || target.pathname === "/api/health") {
      return nodeFetch(input, init);
    }
    return fetchRuntimeThroughDesktopBridge(page, input, init);
  };
  return () => {
    globalThis.fetch = nodeFetch;
  };
}

try {
  await ensurePreview();
  await prepareSmokeConfig();
  await run(npmCommand, ["run", "build:desktop"]);

  console.log("[desktop-smoke] launching Electron");
    const electronApp = await electron.launch({
      cwd: desktopDir,
      args: [".", "--agent-execution-v2=on"],
      env: {
        ...process.env,
        XIAOSHUO_RENDERER_URL: rendererUrl,
        XIAOSHUO_STUDIO_CONFIG: smokeConfigPath,
        XIAOSHUO_RUNTIME_PORT: smokeRuntimePort,
        XIAOSHUO_WEBSITE_BASE_URL: mockModelBaseUrl
      }
    });

  try {
    const closeTimer = setTimeout(() => {
      void electronApp.close();
    }, 60_000);
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.xiaoshuoDesktop?.terminal), null, { timeout: 15_000 });

    const versions = await page.evaluate(() => window.xiaoshuoDesktop.versions());
    const capabilities = await page.evaluate(() => window.xiaoshuoDesktop.capabilities());
    const backendStatus = await page.evaluate(() => window.xiaoshuoDesktop.backendStatus());
    if (!versions.electron) {
      throw new Error("Desktop bridge did not return Electron version");
    }
    if (!backendStatus.url.includes(`:${smokeRuntimePort}`)) {
      throw new Error(`Desktop runtime did not report the TS gateway URL: ${backendStatus.url}`);
    }
    const runtimeHealth = await fetch(`${backendStatus.url}/api/health`).then((response) => response.json());
    if (runtimeHealth.runtime !== "typescript-electron" || runtimeHealth.ts_services?.config !== "active") {
      throw new Error("TS runtime health check did not report active migrated services");
    }
    const unauthenticatedProbe = await fetch(`${backendStatus.url}/api/jobs/_ts-runtime`);
    if (unauthenticatedProbe.status !== 401) {
      throw new Error(`Unauthenticated runtime probe returned ${unauthenticatedProbe.status} instead of 401`);
    }
    const unauthenticatedPayload = await unauthenticatedProbe.json();
    if (unauthenticatedPayload.code !== "RUNTIME_SESSION_REQUIRED") {
      throw new Error("Unauthenticated runtime probe did not return the expected session error");
    }
    const restoreRuntimeFetch = installAuthenticatedRuntimeFetch(page, backendStatus.url);
    try {
    const runtimeJobs = await fetch(`${backendStatus.url}/api/jobs/_ts-runtime`).then((response) => response.json());
    if (!runtimeJobs.active || runtimeJobs.routed !== "local-ts") {
      throw new Error("TS runtime job manager probe did not respond");
    }
    const smokeProjectName = `smoke-project-${Date.now()}`;
    const createdProject = await fetch(`${backendStatus.url}/api/projects/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "D:/xiaoshuo/ts-migration/sandbox-projects",
        project_name: smokeProjectName,
        create_in_parent: true
      })
    }).then((response) => response.json());
    if (!createdProject.path || createdProject.name !== smokeProjectName) {
      throw new Error("TS runtime project creation did not return the expected project info");
    }
    const currentProject = await fetch(`${backendStatus.url}/api/projects/current`).then((response) => response.json());
    if (currentProject.path !== createdProject.path || currentProject.name !== smokeProjectName) {
      throw new Error("TS runtime current-project route did not track the created project");
    }
    const manifestStatus = await fetch(`${backendStatus.url}/api/project/manifest/status`).then((response) => response.json());
    if (!manifestStatus.ready || !String(manifestStatus.path || "").includes("project_manifest.json")) {
      throw new Error("TS runtime manifest-status route did not return a ready manifest");
    }
    const projectChrome = await fetch(`${backendStatus.url}/api/project/chrome?force=1`).then((response) => response.json());
    if (!Array.isArray(projectChrome.tree) || !projectChrome.tree.some((node) => node.path === "01_大纲")) {
      throw new Error("TS runtime project-chrome route did not include the starter tree");
    }
    const starterOutlineResponse = await fetch(
      `${backendStatus.url}/api/documents/${["01_大纲", "大纲.txt"].map((segment) => encodeURIComponent(segment)).join("/")}`
    ).then((response) => response.json());
    if (starterOutlineResponse.path !== "01_大纲/大纲.txt" || typeof starterOutlineResponse.content !== "string") {
      throw new Error("TS runtime document-read route did not return the starter outline");
    }
    const savedOutlineResponse = await fetch(`${backendStatus.url}/api/documents/${["01_大纲", "大纲.txt"].map((segment) => encodeURIComponent(segment)).join("/")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "smoke timeline save" })
    }).then((response) => response.json());
    if (savedOutlineResponse.path !== "01_大纲/大纲.txt" || savedOutlineResponse.content !== "smoke timeline save") {
      throw new Error("TS runtime document-save route did not persist the starter outline");
    }
    const timelineEntries = await fetch(`${backendStatus.url}/api/timeline?limit=5`).then((response) => response.json());
    if (!Array.isArray(timelineEntries) || !timelineEntries.some((entry) => String(entry.summary || "").includes("保存 01_大纲/大纲.txt"))) {
      throw new Error("TS runtime timeline route did not include the saved outline entry");
    }
    const refreshedChrome = await fetch(`${backendStatus.url}/api/project/chrome?force=1`).then((response) => response.json());
    if (!Array.isArray(refreshedChrome.timeline) || !refreshedChrome.timeline.some((entry) => String(entry.summary || "").includes("保存 01_大纲/大纲.txt"))) {
      throw new Error("TS runtime project-chrome route did not compose the TS timeline");
    }
    const agentPlan = await fetch(`${backendStatus.url}/api/agent/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "把当前文件文件名修改为新大纲",
        current_path: "01_大纲/大纲.txt",
        selection: "",
        project_context_hint: ""
      })
    }).then((response) => response.json());
    if (!agentPlan.can_execute || !Array.isArray(agentPlan.operations) || agentPlan.operations[0]?.action !== "move_file") {
      throw new Error("TS runtime agent-plan route did not return the expected rename plan");
    }
    if (agentPlan.operations[0]?.target_path !== "01_大纲/新大纲.txt") {
      throw new Error("TS runtime agent-plan route did not normalize the rename target path");
    }
    const createdLedger = await fetch(`${backendStatus.url}/api/ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desc: "smoke ledger clue" })
    }).then((response) => response.json());
    if (createdLedger.desc !== "smoke ledger clue" || createdLedger.status !== "open") {
      throw new Error("TS runtime ledger-create route did not return the expected ledger item");
    }
    const toggledLedger = await fetch(`${backendStatus.url}/api/ledger/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: createdLedger.id })
    }).then((response) => response.json());
    if (toggledLedger.id !== createdLedger.id || toggledLedger.status !== "closed") {
      throw new Error("TS runtime ledger-toggle route did not close the created item");
    }
    const ledgerItems = await fetch(`${backendStatus.url}/api/ledger`).then((response) => response.json());
    if (!Array.isArray(ledgerItems) || !ledgerItems.some((item) => item.id === createdLedger.id && item.status === "closed")) {
      throw new Error("TS runtime ledger list did not include the toggled item");
    }
    const revisionLogPath = path.join(createdProject.path, "00_设定集", "修正日志", "正文二次修正日志.txt");
    await fs.mkdir(path.dirname(revisionLogPath), { recursive: true });
    await fs.writeFile(
      revisionLogPath,
      [
        "==== 二次修正 | 2026-06-01 20:00:00",
        "文件: 02_正文/正文.txt",
        "评分: 91",
        "- smoke-risk",
        "",
        "==== 二次修正 | 2026-06-01 21:00:00",
        "文件: 01_大纲/大纲.txt",
        "评分: 88",
        "- smoke-risk-2"
      ].join("\n"),
      "utf8"
    );
    const revisionLogEntries = await fetch(`${backendStatus.url}/api/revision-log`).then((response) => response.json());
    if (!Array.isArray(revisionLogEntries) || revisionLogEntries.length !== 2 || revisionLogEntries[0]?.path !== "01_大纲/大纲.txt") {
      throw new Error("TS runtime revision-log route did not parse the revision log file");
    }
    const starterOutline = path.join(createdProject.path, "01_大纲", "大纲.txt");
    await fs.access(starterOutline);
    if ((await fs.readFile(starterOutline, "utf8")) !== "smoke timeline save") {
      throw new Error("Starter outline on disk did not match the TS runtime save");
    }
    await fs.writeFile(path.join(createdProject.path, "00_设定集", "风格库", "写作风格.txt"), "测试风格内容", "utf8");
    const retiredExecuteResponse = await fetch(`${backendStatus.url}/api/agent/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operations: [] })
    });
    if (retiredExecuteResponse.status !== 410) {
      throw new Error(`Retired agent-execute route returned ${retiredExecuteResponse.status} instead of 410`);
    }
    const retiredExecutePayload = await retiredExecuteResponse.json();
    if (retiredExecutePayload.code !== "AGENT_EXECUTE_RETIRED") {
      throw new Error("Retired agent-execute route did not return the expected safety code");
    }
    if ((await fs.readFile(starterOutline, "utf8")) !== "smoke timeline save") {
      throw new Error("Retired agent-execute route modified the outline");
    }
    if ((await fs.readFile(path.join(createdProject.path, "00_设定集", "风格库", "写作风格.txt"), "utf8")) !== "测试风格内容") {
      throw new Error("Retired agent-execute route modified the style source");
    }
    // DELETE /api/documents/{rel_path} archive smoke test
    await fs.writeFile(path.join(createdProject.path, "02_正文", "待归档.txt"), "归档测试内容", "utf8");
    const deleteResponse = await fetch(`${backendStatus.url}/api/documents/${["02_正文", "待归档.txt"].map((segment) => encodeURIComponent(segment)).join("/")}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_delete: true })
    }).then((response) => response.json());
    if (!deleteResponse.ok || deleteResponse.path !== "02_正文/待归档.txt" || !deleteResponse.archived_path?.startsWith("99_回收站/")) {
      throw new Error("TS runtime DELETE document route did not return valid archive result");
    }
    await expectMissing(path.join(createdProject.path, "02_正文", "待归档.txt"), "TS runtime DELETE document route did not remove the source file");
    const archivedDeletedFile = path.join(createdProject.path, deleteResponse.archived_path);
    if ((await fs.readFile(archivedDeletedFile, "utf8")) !== "归档测试内容") {
      throw new Error("TS runtime DELETE document route did not preserve the file content in trash");
    }
    const deleteTimeline = await fetch(`${backendStatus.url}/api/timeline?limit=3`).then((response) => response.json());
    if (!Array.isArray(deleteTimeline) || !deleteTimeline.some((entry) => String(entry.summary || "").includes("归档 02_正文/待归档.txt"))) {
      throw new Error("TS runtime DELETE document route did not record archive in timeline");
    }

    // Conversation and Attachments integration tests
    const boundary = `----WebKitFormBoundarySmoke${Date.now().toString(16)}`;
    const attachmentContent = "这是测试附件文本内容。";
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="test_attachment.txt"\r\n`),
      Buffer.from(`Content-Type: text/plain\r\n\r\n`),
      Buffer.from(attachmentContent),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const smokeConv = await fetch(`${backendStatus.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Smoke Test Conversation" })
    }).then((res) => res.json());

    if (!smokeConv.id || smokeConv.title !== "Smoke Test Conversation") {
      throw new Error("TS runtime conversation-create route failed");
    }

    const uploadedAttachment = await fetch(`${backendStatus.url}/api/conversations/${smokeConv.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(multipartBody.length)
      },
      body: multipartBody
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed: ${text}`);
      }
      return res.json();
    });

    if (!uploadedAttachment.id || uploadedAttachment.name !== "test_attachment.txt") {
      throw new Error("TS runtime conversation-upload attachment failed");
    }

    const getConv = await fetch(`${backendStatus.url}/api/conversations/${smokeConv.id}`).then((res) => res.json());
    const matchedAttachment = getConv.attachments?.find((a) => a.id === uploadedAttachment.id);
    if (!matchedAttachment) {
      throw new Error("TS runtime conversation detail did not include uploaded attachment");
    }

    const rawAttachmentPath = path.join(createdProject.path, "00_设定集", ".agent", "attachments", smokeConv.id, `${uploadedAttachment.id}__test_attachment.txt`);
    const extractedAttachmentPath = path.join(createdProject.path, "00_设定集", ".agent", "attachments", smokeConv.id, `${uploadedAttachment.id}.txt`);
    
    if ((await fs.readFile(rawAttachmentPath, "utf8")) !== attachmentContent) {
      throw new Error("Raw uploaded attachment content mismatch on disk");
    }
    if ((await fs.readFile(extractedAttachmentPath, "utf8")) !== attachmentContent) {
      throw new Error("Extracted attachment content mismatch on disk");
    }

    const conversationMessageResponse = await fetch(`${backendStatus.url}/api/conversations/${smokeConv.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "继续分析这一段剧情",
        skill_id: "",
        agent_name: "smoke-agent",
        write_target: "",
        insert_mode: "none",
        runtime_context: "前端传入上下文",
        attachment_ids: [uploadedAttachment.id]
      })
    }).then(async (res) => {
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    });

    if (conversationMessageResponse.reply !== "TS本地聊天回复" || conversationMessageResponse.conversation?.id !== smokeConv.id) {
      throw new Error(
        `TS runtime conversation-message route did not return the expected non-stream reply: ${JSON.stringify({
          reply: conversationMessageResponse.reply,
          conversation_id: conversationMessageResponse.conversation?.id,
          current_skill: conversationMessageResponse.conversation?.current_skill,
          skill_result: conversationMessageResponse.skill_result
        })}`
      );
    }

    const conversationMessageStreamResponse = await fetch(`${backendStatus.url}/api/conversations/${smokeConv.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson"
      },
      body: JSON.stringify({
        content: "我们继续",
        skill_id: "",
        agent_name: "smoke-agent",
        write_target: "",
        insert_mode: "none",
        runtime_context: "前端传入上下文",
        attachment_ids: [uploadedAttachment.id]
      })
    });
    if (!conversationMessageStreamResponse.ok) {
      throw new Error(await conversationMessageStreamResponse.text());
    }
    const conversationMessageEvents = await readNdjson(conversationMessageStreamResponse);
    if (conversationMessageEvents.map((event) => event.type).join(",") !== "start,delta,final") {
      throw new Error("TS runtime conversation-message route did not emit the expected NDJSON sequence");
    }
    if (conversationMessageEvents[2]?.payload?.conversation?.id !== smokeConv.id) {
      throw new Error("TS runtime conversation-message stream final payload did not include the expected conversation");
    }

    const agentRunConv = await fetch(`${backendStatus.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Smoke Agent Run Conversation" })
    }).then((res) => res.json());
    if (!agentRunConv.id) {
      throw new Error("TS runtime conversation-create route failed for agent run smoke");
    }

    const localAgentRun = await fetch(`${backendStatus.url}/api/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: agentRunConv.id,
        content: "请总结当前项目",
        current_path: "01_大纲/大纲.txt",
        selection: "",
        project_context_hint: "",
        skill_id: "",
        attachment_ids: []
      })
    }).then(async (res) => {
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    });

    if (localAgentRun.intent !== "read_context" || localAgentRun.reply !== "TS本地聊天回复") {
      throw new Error("TS runtime agent-run route did not return the expected local chat reply");
    }
    if (localAgentRun.conversation?.id !== agentRunConv.id || localAgentRun.conversation?.messages?.length !== 2) {
      throw new Error("TS runtime agent-run route did not persist the first local chat turn");
    }

    const streamResponse = await fetch(`${backendStatus.url}/api/agent/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: agentRunConv.id,
        content: "我们继续聊这个项目",
        current_path: "",
        selection: "",
        project_context_hint: "当前文档：01_大纲/大纲.txt\n\n上下文片段",
        skill_id: "",
        attachment_ids: [uploadedAttachment.id]
      })
    });
    if (!streamResponse.ok) {
      throw new Error(await streamResponse.text());
    }
    const streamEvents = await readNdjson(streamResponse);
    if (streamEvents.map((event) => event.type).join(",") !== "start,delta,final") {
      throw new Error("TS runtime agent-run-stream route did not emit the expected NDJSON sequence");
    }
    if (streamEvents[0]?.intent !== "chat" || streamEvents[0]?.conversation_id !== agentRunConv.id) {
      throw new Error("TS runtime agent-run-stream route did not emit the expected start event");
    }
    if (streamEvents[1]?.text !== "TS本地聊天回复") {
      throw new Error("TS runtime agent-run-stream route did not emit the expected fallback delta");
    }
    if (streamEvents[2]?.payload?.intent !== "chat" || streamEvents[2]?.payload?.reply !== "TS本地聊天回复") {
      throw new Error("TS runtime agent-run-stream route did not emit the expected final payload");
    }

    const updatedConv = await fetch(`${backendStatus.url}/api/conversations/${agentRunConv.id}`).then((res) => res.json());
    if (updatedConv.messages?.length !== 4 || updatedConv.messages?.[3]?.content !== "TS本地聊天回复") {
      throw new Error("TS runtime local chat routes did not persist both run and stream turns");
    }

    const conversationFile = path.join(createdProject.path, "00_设定集", ".agent", "conversations", `${agentRunConv.id}.json`);
    const persistedConversation = JSON.parse(await fs.readFile(conversationFile, "utf8"));
    if (persistedConversation.messages?.length !== 4 || persistedConversation.messages?.[0]?.role !== "user") {
      throw new Error("TS runtime local chat routes did not write the conversation file as expected");
    }

    const deleteAttachmentRes = await fetch(`${backendStatus.url}/api/conversations/${smokeConv.id}/attachments/${uploadedAttachment.id}`, {
      method: "DELETE"
    }).then((res) => res.json());

    if (!deleteAttachmentRes.id) {
      throw new Error("TS runtime delete-attachment route failed");
    }

    await expectMissing(rawAttachmentPath, "Raw attachment file was not deleted after deletion");
    await expectMissing(extractedAttachmentPath, "Extracted attachment text file was not deleted after deletion");

    // Skill catalog/import integration tests
    const importedSkillsDirResponse = await fetch(`${backendStatus.url}/api/skills/open-folder`, {
      method: "POST"
    }).then((res) => res.json());
    const expectedSkillsDir = path.join(createdProject.path, "00_设定集", ".agent", "skills");
    if (importedSkillsDirResponse.path !== expectedSkillsDir) {
      throw new Error("TS runtime skill open-folder route returned an unexpected directory");
    }

    const localSkillDir = path.join(createdProject.path, "skill-import-fixture");
    await fs.mkdir(localSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(localSkillDir, "SKILL.md"),
      ["---", "name: Smoke Local Skill", "description: local skill", "---", "", "本地技能提示词"].join("\n"),
      "utf8"
    );
    const importedLocalSkill = await fetch(`${backendStatus.url}/api/skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: localSkillDir })
    }).then((res) => res.json());
    if (importedLocalSkill.id !== "smoke_local_skill" || importedLocalSkill.name !== "Smoke Local Skill") {
      throw new Error("TS runtime skill import route did not import the local SKILL.md");
    }

    const skillUploadBoundary = `----WebKitFormBoundarySkill${Date.now().toString(16)}`;
    const skillUploadBody = Buffer.concat([
      Buffer.from(`--${skillUploadBoundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="upload-skill.md"\r\n`),
      Buffer.from(`Content-Type: text/markdown\r\n\r\n`),
      Buffer.from(["---", "name: Smoke Upload Skill", "description: uploaded skill", "---", "", "上传技能提示词"].join("\n"), "utf8"),
      Buffer.from(`\r\n--${skillUploadBoundary}--\r\n`)
    ]);
    const uploadedSkill = await fetch(`${backendStatus.url}/api/skills/upload`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${skillUploadBoundary}`,
        "Content-Length": String(skillUploadBody.length)
      },
      body: skillUploadBody
    }).then(async (res) => {
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    });
    if (uploadedSkill.id !== "smoke_upload_skill" || uploadedSkill.imported_from !== "upload:upload-skill.md") {
      throw new Error("TS runtime skill upload route did not import uploaded markdown");
    }

    const draftImportedSkill = await fetch(`${backendStatus.url}/api/skills/import-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skill: {
          id: "Smoke Draft Skill",
          name: "Smoke Draft Skill",
          description: "draft skill",
          input_mode: "text",
          context_requirements: ["project_state"],
          handler_type: "workflow",
          linked_targets: ["01_大纲/大纲.txt"],
          prompt: "草稿技能提示词",
          imported_from: "",
          writable: true
        },
        source_url: "https://example.com/skill",
        source_name: "draft-skill.md",
        source_text: "草稿技能提示词"
      })
    }).then((res) => res.json());
    if (draftImportedSkill.id !== "smoke_draft_skill" || draftImportedSkill.imported_from !== "https://example.com/skill") {
      throw new Error("TS runtime skill import-draft route did not normalize and save the draft skill");
    }

    const skillCatalog = await fetch(`${backendStatus.url}/api/skills`).then((res) => res.json());
    if (!Array.isArray(skillCatalog) || !skillCatalog.some((skill) => skill.id === "smoke_local_skill") || !skillCatalog.some((skill) => skill.id === "smoke_upload_skill")) {
      throw new Error("TS runtime skill catalog route did not include imported skills");
    }
    const fetchedUploadedSkill = await fetch(`${backendStatus.url}/api/skills/smoke_upload_skill`).then((res) => res.json());
    if (fetchedUploadedSkill.name !== "Smoke Upload Skill") {
      throw new Error("TS runtime skill detail route did not return the imported uploaded skill");
    }
    const importedSkillIndex = JSON.parse(await fs.readFile(path.join(expectedSkillsDir, "imported.json"), "utf8"));
    if (!Array.isArray(importedSkillIndex) || importedSkillIndex.length < 3) {
      throw new Error("TS runtime skill import routes did not persist imported.json");
    }

    const localSkillRun = await fetch(`${backendStatus.url}/api/skills/outline_generate/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "这是 smoke skill 输入",
        target_path: "01_大纲/大纲.txt",
        write_result: false,
        conversation_id: smokeConv.id,
        attachment_ids: []
      })
    }).then((res) => res.json());
    if (!localSkillRun.data?.pending_save || !localSkillRun.data?.cache_id || localSkillRun.result !== "TS本地技能生成结果") {
      throw new Error("TS runtime local prompt skill route did not return pending-save result");
    }
    if (localSkillRun.data?.target_path !== "01_大纲/大纲.txt") {
      throw new Error("TS runtime local prompt skill route did not preserve the expected target path");
    }

    const committedSkillRun = await fetch(`${backendStatus.url}/api/agent/generated/cache/${localSkillRun.data.cache_id}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace" })
    }).then((res) => res.json());
    if (!Array.isArray(committedSkillRun.saved_paths) || !committedSkillRun.saved_paths.includes("01_大纲/大纲.txt")) {
      throw new Error("TS runtime skill-generated cache commit did not save to the expected file");
    }
    const committedOutline = await fs.readFile(path.join(createdProject.path, "01_大纲", "大纲.txt"), "utf8");
    if (committedOutline !== "TS本地技能生成结果") {
      throw new Error("TS runtime local prompt skill cache commit did not persist generated content");
    }

    // TS Jobs integration tests
    // 1. 创建 scan_project 本地任务并轮询
    const scanJob = await fetch(`${backendStatus.url}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "scan_project", payload: {} })
    }).then((res) => res.json());

    if (!scanJob.id || !scanJob.id.startsWith("ts-") || scanJob.kind !== "scan_project") {
      throw new Error("TS runtime scan_project job creation failed");
    }

    let scanJobFinished = false;
    for (let i = 0; i < 20; i++) {
      await delay(150);
      const j = await fetch(`${backendStatus.url}/api/jobs/${scanJob.id}`).then((res) => res.json());
      if (j.status === "done") {
        scanJobFinished = true;
        if (!Array.isArray(j.result) || !j.result.some((doc) => doc.path === "01_大纲/大纲.txt")) {
          throw new Error("TS runtime scan_project result verification failed");
        }
        break;
      }
      if (j.status === "failed") {
        throw new Error(`TS runtime scan_project job failed: ${j.error}`);
      }
    }
    if (!scanJobFinished) {
      throw new Error("TS runtime scan_project job polling timeout");
    }

    // 2. 创建 build_continuity_context 本地任务并轮询
    const contextJob = await fetch(`${backendStatus.url}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "build_continuity_context", payload: {} })
    }).then((res) => res.json());

    if (!contextJob.id || !contextJob.id.startsWith("ts-") || contextJob.kind !== "build_continuity_context") {
      throw new Error("TS runtime build_continuity_context job creation failed");
    }

    let contextJobFinished = false;
    for (let i = 0; i < 20; i++) {
      await delay(150);
      const j = await fetch(`${backendStatus.url}/api/jobs/${contextJob.id}`).then((res) => res.json());
      if (j.status === "done") {
        contextJobFinished = true;
        if (!j.result.outline || !j.result.previous_chapters) {
          throw new Error("TS runtime build_continuity_context result verification failed");
        }
        break;
      }
      if (j.status === "failed") {
        throw new Error(`TS runtime build_continuity_context job failed: ${j.error}`);
      }
    }
    if (!contextJobFinished) {
      throw new Error("TS runtime build_continuity_context job polling timeout");
    }

    // 3. 校验 GET /api/jobs 列表合并与去重
    const jobsList = await fetch(`${backendStatus.url}/api/jobs`).then((res) => res.json());
    if (!Array.isArray(jobsList) || !jobsList.some((j) => j.id === scanJob.id) || !jobsList.some((j) => j.id === contextJob.id)) {
      throw new Error("TS runtime unified jobs list did not include created TS jobs");
    }

    // 4. 创建任务并测试取消 (cancel)
    const cancelJob = await fetch(`${backendStatus.url}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "scan_project", payload: {} })
    }).then((res) => res.json());

    await fetch(`${backendStatus.url}/api/jobs/${cancelJob.id}/cancel`, {
      method: "POST"
    }).then((res) => res.json());

    await delay(100);
    const finalJob = await fetch(`${backendStatus.url}/api/jobs/${cancelJob.id}`).then((res) => res.json());

    if (finalJob.status !== "cancelled" && finalJob.status !== "done") {
      throw new Error("TS runtime job cancel action failed to transition status");
    }

    // Generated cache API integration tests
    // 1. POST /api/agent/generated/save - save direct content
    const saveResponse = await fetch(`${backendStatus.url}/api/agent/generated/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "新生成的测试正文内容",
        target_paths: ["02_正文/执行测试.txt"],
        mode: "replace"
      })
    }).then((response) => response.json());
    if (!saveResponse.saved_paths || !saveResponse.saved_paths.includes("02_正文/执行测试.txt")) {
      throw new Error("TS runtime generated-save did not return saved paths");
    }
    const savedFileContent = await fs.readFile(path.join(createdProject.path, "02_正文", "执行测试.txt"), "utf8");
    if (savedFileContent !== "新生成的测试正文内容") {
      throw new Error("TS runtime generated-save did not write file content");
    }

    // 2. POST /api/agent/generated/cache/{cache_id}/commit - commit from file cache
    const mockCacheId = "abcdefabcdefabcdefabcdef12345678";
    const cacheDir = path.join(createdProject.path, "00_设定集", ".agent", "generated_cache", mockCacheId);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "content.txt"), " 缓存待确认的章节段落 ", "utf8");
    await fs.writeFile(path.join(cacheDir, "metadata.json"), JSON.stringify({
      cache_id: mockCacheId,
      status: "pending",
      source: "chat",
      skill_id: "write_chapter",
      mode: "replace",
      target_paths: ["02_正文/执行测试.txt"],
      cache_path: `00_设定集/.agent/generated_cache/${mockCacheId}/content.txt`,
      chars: 12,
      created_at: "2026-06-03 12:00:00",
      updated_at: "2026-06-03 12:00:00"
    }), "utf8");

    const commitResponse = await fetch(`${backendStatus.url}/api/agent/generated/cache/${mockCacheId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "replace"
      })
    }).then((response) => response.json());
    if (!commitResponse.saved_paths || !commitResponse.saved_paths.includes("02_正文/执行测试.txt")) {
      throw new Error("TS runtime generated-cache commit failed");
    }
    const committedContent = await fs.readFile(path.join(createdProject.path, "02_正文", "执行测试.txt"), "utf8");
    if (committedContent !== "缓存待确认的章节段落") {
      throw new Error("TS runtime generated-cache commit did not update the target file correctly");
    }
    await expectMissing(path.join(cacheDir, "content.txt"), "TS runtime commit did not delete the cache content file");

    // 3. DELETE /api/agent/generated/cache/{cache_id} - discard cache
    const mockDiscardId = "87654321fedcfedcfedcfedcba987654";
    const discardDir = path.join(createdProject.path, "00_设定集", ".agent", "generated_cache", mockDiscardId);
    await fs.mkdir(discardDir, { recursive: true });
    await fs.writeFile(path.join(discardDir, "content.txt"), "要丢弃的内容", "utf8");
    await fs.writeFile(path.join(discardDir, "metadata.json"), JSON.stringify({
      cache_id: mockDiscardId,
      status: "pending",
      created_at: "2026-06-03 12:00:00",
      updated_at: "2026-06-03 12:00:00"
    }), "utf8");

    const discardResponse = await fetch(`${backendStatus.url}/api/agent/generated/cache/${mockDiscardId}`, {
      method: "DELETE"
    }).then((response) => response.json());
    if (discardResponse.status !== "discarded") {
      throw new Error("TS runtime generated-cache discard failed to return discarded status");
    }
    await expectMissing(path.join(discardDir, "content.txt"), "TS runtime discard did not delete the cache content file");

    // 4. POST /api/agent/generated/cache/cleanup - cleanup
    const cleanupResponse = await fetch(`${backendStatus.url}/api/agent/generated/cache/cleanup`, {
      method: "POST"
    }).then((response) => response.json());
    if (!cleanupResponse.ok) {
      throw new Error("TS runtime generated-cache cleanup failed");
    }

    if (!capabilities.terminal.available) {
      throw new Error(`Terminal capability unavailable: ${capabilities.terminal.reason || "unknown reason"}`);
    }
    if (!capabilities.localDatabase.available) {
      throw new Error(`Local database capability unavailable: ${capabilities.localDatabase.reason || "unknown reason"}`);
    }

    const localState = await page.evaluate(() =>
      window.xiaoshuoDesktop.localState.syncProject({
        project: {
        path: "D:\\xiaoshuo\\ts-migration\\sandbox-projects\\smoke-desktop",
        name: "smoke-desktop"
        },
        conversations: [
          {
            id: "smoke-conversation",
            title: "Smoke conversation",
            created_at: "2026-05-30T10:00:00.000Z",
            updated_at: "2026-05-30T10:00:00.000Z",
            current_skill: "",
            current_agent: "",
            message_count: 1,
            attachment_count: 0
          }
        ],
        jobs: [
          {
            id: "smoke-job",
            kind: "smoke",
            status: "done",
            progress: 1,
            message: "ok"
          }
        ]
      })
    );
    const smokeProject = localState.recent_projects.find((project) => project.name === "smoke-desktop");
    if (!localState.db_path || !smokeProject || smokeProject.conversation_count !== 1 || smokeProject.job_count !== 1) {
      throw new Error("Local state smoke check did not persist the recent project marker");
    }
    const patchedSettings = await page.evaluate(() =>
      window.xiaoshuoDesktop.localState.patchSettings({
        active_tab: "terminal",
        project_path_input: "D:\\xiaoshuo\\ts-migration\\sandbox-projects\\smoke-desktop",
        project_name_input: "smoke-desktop"
      })
    );
    if (patchedSettings.settings.active_tab !== "terminal" || patchedSettings.settings.project_name_input !== "smoke-desktop") {
      throw new Error("Local state smoke check did not persist workbench settings");
    }
    const trackedCache = await page.evaluate(() =>
      window.xiaoshuoDesktop.localState.trackGeneratedCache({
        cache_id: "smoke-cache",
        project_path: "D:\\xiaoshuo\\ts-migration\\sandbox-projects\\smoke-desktop",
        skill_id: "smoke-skill",
        source: "skill",
        target_path: "02_正文\\正文.txt",
        target_paths: ["02_正文\\正文.txt"],
        status: "pending",
        mode: "append",
        cache_path: "00_设定集\\.agent\\generated\\smoke-cache.json",
        cache_chars: 42
      })
    );
    const smokeCache = trackedCache.generated_caches.find((cache) => cache.cache_id === "smoke-cache");
    if (!smokeCache || smokeCache.status !== "pending" || smokeCache.cache_chars !== 42) {
      throw new Error("Local state smoke check did not persist generated cache metadata");
    }

    await page.getByTestId("terminal-shell").waitFor({ state: "visible", timeout: 15_000 });
    const terminalWithoutGesture = await page.evaluate(async () => {
      try {
        await window.xiaoshuoDesktop.terminal.create({ cols: 100, rows: 24 });
        return "";
      } catch (error) {
        return String(error?.code || error?.message || error);
      }
    });
    if (!terminalWithoutGesture.includes("TERMINAL_USER_GESTURE_REQUIRED")) {
      throw new Error("Terminal creation unexpectedly succeeded without a user gesture");
    }
    const exerciseTerminalSession = async ({ activate, expectedText }) => {
      await activate();
      const output = await page.evaluate(
        (expected) =>
        new Promise(async (resolve, reject) => {
          const session = await window.xiaoshuoDesktop.terminal.create({ cols: 100, rows: 24 });
          let output = "";
          const timer = window.setTimeout(async () => {
            unsubscribeData();
            unsubscribeExit();
            await window.xiaoshuoDesktop.terminal.kill({ id: session.id });
            reject(new Error(`Timed out waiting for terminal output: ${expected}`));
          }, 12_000);
          const finish = async (value) => {
            window.clearTimeout(timer);
            unsubscribeData();
            unsubscribeExit();
            await window.xiaoshuoDesktop.terminal.kill({ id: session.id });
            resolve(value);
          };
          const unsubscribeData = window.xiaoshuoDesktop.terminal.onData((event) => {
            if (event.id !== session.id) {
              return;
            }
            output += event.data;
            if (output.includes(expected)) {
              void finish(output);
            }
          });
          const unsubscribeExit = window.xiaoshuoDesktop.terminal.onExit((event) => {
            if (event.id === session.id && !output.includes(expected)) {
              void finish(output);
            }
          });

          await window.xiaoshuoDesktop.terminal.write({ id: session.id, data: `echo ${expected}\r` });
        }),
        expectedText
      );
      if (!output.includes(expectedText)) {
        throw new Error(`Terminal smoke command did not echo the expected marker: ${expectedText}`);
      }
    };

    // Only a control carrying the Workbench marker can mint the one-shot
    // preload lease. The smoke bridge exercises the same pointer/keyboard contract.
    await exerciseTerminalSession({
      activate: () => page.getByTestId("terminal-start").click(),
      expectedText: "XIAOSHUO_TERMINAL_POINTER_SMOKE"
    });
    await exerciseTerminalSession({
      activate: async () => {
        await page.getByTestId("terminal-start").focus();
        await page.keyboard.press("Enter");
      },
      expectedText: "XIAOSHUO_TERMINAL_KEYBOARD_SMOKE"
    });

    const terminalAfterConsumedGesture = await page.evaluate(async () => {
      try {
        await window.xiaoshuoDesktop.terminal.create({ cols: 100, rows: 24 });
        return "";
      } catch (error) {
        return String(error?.code || error?.message || error);
      }
    });
    if (!terminalAfterConsumedGesture.includes("TERMINAL_USER_GESTURE_REQUIRED")) {
      throw new Error("Terminal user gesture ticket was not consumed exactly once");
    }

    console.log(`[desktop-smoke] ok electron=${versions.electron} terminal=${capabilities.terminal.package} localState=${capabilities.localDatabase.package}`);
    clearTimeout(closeTimer);
    } finally {
      restoreRuntimeFetch();
    }
  } finally {
    await electronApp.close();
  }
} finally {
  cleanup();
  await cleanupSmokeResources();
}
