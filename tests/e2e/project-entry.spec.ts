import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import http from "node:http";

const baseUrl = process.env.WORKBENCH_BASE_URL || "http://127.0.0.1:4180";
const runtimeApi = process.env.WORKBENCH_API_BASE || "http://127.0.0.1:18453";
const runtimeSessionToken = process.env.WORKBENCH_E2E_SESSION_TOKEN || "arcwriter-e2e-runtime-token";
const sandboxProjectsPath = "D:/xiaoshuo/ts-migration/sandbox-projects";
let mockModelServer: http.Server | null = null;
let mockModelBaseUrl = "";

function runtimeHeaders(headers: HeadersInit = {}): Headers {
  const next = new Headers(headers);
  next.set("Authorization", `Bearer ${runtimeSessionToken}`);
  return next;
}

async function runtimeFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtimeApi}${pathname}`, { ...init, headers: runtimeHeaders(init.headers) });
}

function workbenchUrl(route = "/home") {
  return `${baseUrl}?e2e=${Date.now()}&api=${encodeURIComponent(runtimeApi)}#${route}`;
}

function documentApiPath(relativePath: string) {
  return `/api/documents/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function createWritingProject(prefix: string) {
  const projectName = `${prefix}-${Date.now()}`;
  const response = await runtimeFetch("/api/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sandboxProjectsPath, project_name: projectName, create_in_parent: true })
  });
  expect(response.ok).toBe(true);
  return projectName;
}

async function saveRuntimeDocument(relativePath: string, content: string) {
  const response = await runtimeFetch(documentApiPath(relativePath), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, force: true })
  });
  expect(response.ok).toBe(true);
}

async function readRuntimeDocument(relativePath: string) {
  const response = await runtimeFetch(documentApiPath(relativePath));
  expect(response.ok).toBe(true);
  return await response.json() as { content: string };
}

async function configureMockModel() {
  const response = await runtimeFetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: "e2e-key",
      model: "e2e-model",
      base_url: mockModelBaseUrl,
      humanizer_enabled: false,
      auto_lore_extract_enabled: false,
      enable_consistency_revision: false
    })
  });
  expect(response.ok).toBe(true);
}

async function openEditorDocument(page: Page, chapterName: string) {
  const navigation = page.getByRole("complementary", { name: "主导航" });
  await navigation.getByRole("button", { name: "正文编辑", exact: true }).click();
  const chapterPanel = page.locator(".chapter-panel");
  await chapterPanel.getByRole("button", { name: chapterName, exact: true }).click();
  const editor = page.locator(".manuscript textarea");
  await expect(editor).toBeVisible();
  return editor;
}

test.beforeAll(async () => {
  mockModelServer = http.createServer((request, response) => {
    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404);
      response.end();
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "E2E 模型回复" } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    mockModelServer?.once("error", reject);
    mockModelServer?.listen(0, "127.0.0.1", () => {
      mockModelServer?.off("error", reject);
      const address = mockModelServer?.address();
      if (!address || typeof address === "string") {
        reject(new Error("Mock model server failed to bind a port"));
        return;
      }
      mockModelBaseUrl = `http://127.0.0.1:${address.port}/v1`;
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (!mockModelServer) return;
  mockModelServer.closeAllConnections?.();
  await new Promise<void>((resolve) => mockModelServer?.close(() => resolve()));
  mockModelServer = null;
});

test.beforeEach(async ({ page }) => {
  const health = await runtimeFetch("/api/health");
  expect(health.ok).toBe(true);
  expect((await health.json()).runtime).toBe("typescript-electron");
  await page.route(`${runtimeApi}/**`, async (route) => {
    await route.continue({ headers: Object.fromEntries(runtimeHeaders(route.request().headers())) });
  });
});

test("production navigation, settings history, and diagnostic isolation", async ({ page }) => {
  await page.goto(workbenchUrl());
  const navigation = page.getByRole("complementary", { name: "主导航" });
  const entries = [
    "项目首页", "正文编辑", "AI 助手", "故事大纲", "伏笔与时间线", "设定资料", "风格与题材",
    "小说编辑室", "全文审阅", "项目记忆", "拆书工作台", "批量章节生成", "素材迁移", "创作工具",
    "后台任务", "设置"
  ];

  for (const entry of entries) {
    const button = navigation.getByRole("button", { name: entry, exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
  }

  const settingsNav = page.getByRole("complementary", { name: "设置分类" });
  await settingsNav.getByRole("button", { name: "写作体验", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\/writing$/);
  await expect(page.getByLabel("自动提取明确设定")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings\/ai$/);
  await page.getByRole("tablist", { name: "AI 配置模式" }).getByRole("button", { name: "网站配置", exact: true }).click();
  const aiSections = page.getByRole("tablist", { name: "AI 配置分区" });
  await expect(aiSections).toBeVisible();
  await aiSections.getByRole("tab", { name: "网站服务", exact: true }).click();
  await expect(page.getByText("网站账号", { exact: true })).toBeVisible();
  await aiSections.getByRole("tab", { name: "模型", exact: true }).click();
  await expect(page.getByText("网站模型", { exact: true })).toBeVisible();
  await expect(page.getByText("网站账号", { exact: true })).toHaveCount(0);
  await aiSections.getByRole("tab", { name: "本地检索", exact: true }).click();
  await expect(page.getByText("本地检索与向量召回", { exact: true })).toBeVisible();
  await aiSections.getByRole("tab", { name: "联网搜索", exact: true }).click();
  await expect(page.getByText("联网素材搜索", { exact: true }).first()).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#\/settings\/writing$/);

  for (const diagnostic of ["traces", "terminal", "vector_test", "card_draw"]) {
    await page.goto(workbenchUrl(`/${diagnostic}`));
    await expect(navigation.getByRole("button", { name: "项目首页", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".xw-trace-page, .terminal-shell")).toHaveCount(0);
  }
});

test("shell has no page-level horizontal overflow at supported desktop widths", async ({ page }) => {
  for (const viewport of [
    { width: 1024, height: 720 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(workbenchUrl());
    await expect(page.getByRole("complementary", { name: "主导航" })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth, `${viewport.width}x${viewport.height} page overflow`).toBeLessThanOrEqual(dimensions.clientWidth);
  }
});

test("AI settings remain complete and reachable in a short desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(workbenchUrl("/settings/ai"));

  const modeTabs = page.getByRole("tablist", { name: "AI 配置模式" });
  await modeTabs.getByRole("button", { name: "手动配置", exact: true }).click();
  const sectionTabs = page.getByRole("tablist", { name: "AI 配置分区" });
  await sectionTabs.getByRole("tab", { name: "模型", exact: true }).click();

  const panel = page.getByRole("tabpanel", { name: "模型配置" });
  const actions = page.locator(".settings-ai-page > .xw-feature-actions");
  await expect(sectionTabs).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(actions).toBeVisible();

  const dimensions = await panel.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      overflowY: styles.overflowY
    };
  });
  expect(dimensions.clientHeight).toBeGreaterThan(180);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.overflowY).toBe("auto");

  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(panel.locator(".xw-settings-section-head > strong").filter({ hasText: "副模型" })).toBeVisible();
  await expect(sectionTabs).toBeVisible();
  await expect(actions).toBeVisible();
});

test("assistant conversation create, rename, read, and delete", async ({ page }) => {
  await createWritingProject("e2e-conversation-crud");
  await page.goto(workbenchUrl("/assistant"));
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(page.locator(".chat-title strong")).toHaveText("新对话");

  await page.getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByLabel("会话标题").fill("E2E 会话标题");
  await page.getByRole("button", { name: "保存标题", exact: true }).click();
  await expect(page.locator(".chat-title strong")).toHaveText("E2E 会话标题");

  await page.getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("button", { name: "删除会话", exact: true }).click();
  await page.getByRole("button", { name: "再次点击确认删除", exact: true }).click();
  await expect(page.locator(".chat-title strong")).toHaveText("自由会话");
  await expect.poll(async () => (await runtimeFetch("/api/conversations")).json()).toEqual([]);
});

test("automatic writing switches stay synchronized with settings", async ({ page }) => {
  await createWritingProject("e2e-automatic-settings");
  await page.goto(workbenchUrl("/tools"));
  await page.getByRole("tab", { name: "写作与审阅", exact: true }).click();
  const featureSwitch = page.getByRole("switch", { name: /自动提取明确设定/ });
  const original = await featureSwitch.getAttribute("aria-checked") === "true";

  await featureSwitch.click();
  await expect(featureSwitch).toHaveAttribute("aria-checked", String(!original));
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("complementary", { name: "设置分类" }).getByRole("button", { name: "写作体验", exact: true }).click();
  const settingsToggle = page.getByLabel("自动提取明确设定");
  await expect(settingsToggle).toBeChecked({ checked: !original });

  await settingsToggle.click();
  await expect(settingsToggle).toBeChecked({ checked: original });
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "创作工具", exact: true }).click();
  await page.getByRole("tab", { name: "写作与审阅", exact: true }).click();
  await expect(page.getByRole("switch", { name: /自动提取明确设定/ })).toHaveAttribute("aria-checked", String(original));
});

test("skill view, edit, versions, and import preview use tertiary routes", async ({ page }) => {
  await createWritingProject("e2e-skill-routes");
  await page.goto(workbenchUrl("/tools"));
  await page.getByRole("button", { name: "导入技能", exact: true }).click();
  await expect(page).toHaveURL(/#\/tools\/import$/);
  await expect(page.getByRole("heading", { name: "导入技能", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← 返回创作工具", exact: true }).click();

  await page.locator(".tool-row").filter({ hasText: "设定提取" }).first().click();
  await expect(page.getByRole("heading", { name: /技能详情：设定提取/ })).toBeVisible();
  await page.getByRole("button", { name: "编辑技能", exact: true }).click();
  await expect(page).toHaveURL(/#\/tools\/skills\/lore_extract\/edit$/);
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await expect(page).toHaveURL(/#\/tools\/skills\/lore_extract\/versions$/);
  await expect(page.getByRole("region", { name: "技能版本历史" })).toBeVisible();
});

test("editor punctuation, typing speed, save-all, and conflict recovery", async ({ page }) => {
  await createWritingProject("e2e-editor");
  await saveRuntimeDocument("02_正文/E2E甲.txt", "天地");
  await saveRuntimeDocument("02_正文/E2E乙.txt", "");
  await saveRuntimeDocument("02_正文/E2E冲突.txt", "磁盘初稿");
  await page.goto(workbenchUrl("/editor"));

  const editor = await openEditorDocument(page, "E2E甲");
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 2));
  await page.getByRole("toolbar", { name: "常用中文标点" }).getByRole("button", { name: "中文双引号" }).click();
  await expect(editor).toHaveValue("“天地”");
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
  await page.getByRole("toolbar", { name: "常用中文标点" }).getByRole("button", { name: "句号" }).click();
  await expect(editor).toHaveValue("“天地”。");
  await expect(page.locator(".format-tools").getByText("标题", { exact: true })).toHaveCount(0);

  const chapterPanel = page.locator(".chapter-panel");
  await chapterPanel.getByRole("button", { name: "E2E乙", exact: true }).click();
  const typingEditor = page.locator(".manuscript textarea");
  await typingEditor.pressSequentially("春夏秋冬风", { delay: 1100 });
  await expect(chapterPanel.locator(".typing-speed strong")).not.toHaveText("-- 字/分钟", { timeout: 8_000 });
  await chapterPanel.getByRole("button", { name: "E2E甲", exact: true }).click();
  await expect(chapterPanel.locator(".typing-speed strong")).toHaveText("-- 字/分钟");

  expect(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  await page.getByRole("button", { name: "保存全部", exact: true }).click();
  await expect.poll(async () => (await readRuntimeDocument("02_正文/E2E甲.txt")).content).toBe("“天地”。");
  await expect.poll(async () => (await readRuntimeDocument("02_正文/E2E乙.txt")).content).toBe("春夏秋冬风");
  expect(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);

  await chapterPanel.getByRole("button", { name: "E2E冲突", exact: true }).click();
  const conflictEditor = page.locator(".manuscript textarea");
  await conflictEditor.fill("本地修改稿");
  await saveRuntimeDocument("02_正文/E2E冲突.txt", "后台磁盘新版");
  await page.locator(".editor-meta").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "正文在另一处被修改", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看差异", exact: true }).click();
  await expect(page.getByRole("region", { name: "保存冲突差异" })).toContainText("后台磁盘新版");
  await page.getByRole("button", { name: "保留我的版本", exact: true }).click();
  await expect.poll(async () => (await readRuntimeDocument("02_正文/E2E冲突.txt")).content).toBe("本地修改稿");
});

test("skill generation requires preview confirmation before writing", async ({ page }) => {
  await createWritingProject("e2e-generated-confirmation");
  await saveRuntimeDocument("02_正文/E2E生成.txt", "生成前正文");
  await configureMockModel();
  await page.goto(workbenchUrl("/editor"));
  await openEditorDocument(page, "E2E生成");

  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "创作工具", exact: true }).click();
  await page.locator(".tool-row").filter({ hasText: "正文润色" }).first().click();
  await page.getByRole("button", { name: "运行技能", exact: true }).click();
  const confirmation = page.getByRole("region", { name: "AI 写入确认" });
  await expect(confirmation).toBeVisible({ timeout: 20_000 });
  await expect(confirmation).toContainText("E2E 模型回复");
  expect((await readRuntimeDocument("02_正文/E2E生成.txt")).content).toBe("生成前正文");

  await confirmation.getByRole("button", { name: "覆盖写入", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect.poll(async () => (await readRuntimeDocument("02_正文/润色结果.txt")).content).toContain("E2E 模型回复");
});
