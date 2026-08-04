import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import http from "node:http";

const baseUrl = process.env.WORKBENCH_BASE_URL || "http://127.0.0.1:4180";
const runtimeApi = process.env.WORKBENCH_API_BASE || "http://127.0.0.1:18453";
const runtimeSessionToken = process.env.WORKBENCH_E2E_SESSION_TOKEN || "arcwriter-e2e-runtime-token";
const sandboxProjectsPath = "D:/xiaoshuo/ts-migration/sandbox-projects";
const coverPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
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
      ai_config_mode: "manual",
      api_key: "e2e-key",
      model: "e2e-model",
      base_url: mockModelBaseUrl,
      manual_profile: {
        api_key: "e2e-key",
        model: "e2e-model",
        base_url: mockModelBaseUrl,
        temp: 0.7,
        top_p: 1
      },
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
    if (request.url?.includes("/models")) {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        data: [
          { id: "gpt-5-mini", display_name: "GPT 5 Mini", owned_by: "openai" },
          { id: "deepseek-reasoner", display_name: "DeepSeek Reasoner", owned_by: "deepseek" },
          { id: "text-embedding-3-small", owned_by: "openai" }
        ]
      }));
      return;
    }
    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      const delayed = Buffer.concat(chunks).toString("utf8").includes("E2E 延迟回复");
      const reply = () => {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "E2E 模型回复" } }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      };
      if (delayed) setTimeout(reply, 2_000).unref();
      else reply();
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
    "小说编辑室", "全文审阅", "项目记忆", "拆书工作台", "批量章节生成", "素材迁移", "封面生成", "创作工具",
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
  await expect(aiSections.getByRole("tab", { name: "模型", exact: true })).toHaveCount(0);
  await aiSections.getByRole("tab", { name: "连接参数", exact: true }).click();
  await expect(page.getByText("文本模型统一在 AI 助手中选择；这里仅管理生成参数。", { exact: true })).toBeVisible();
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

test("home creates named novels inline and keeps cancellation non-destructive", async ({ page }) => {
  const projectName = `home-create-${Date.now()}`;
  let cancelNextPick = true;
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.route(`${runtimeApi}/api/projects/pick`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ path: cancelNextPick ? "" : sandboxProjectsPath })
    });
    cancelNextPick = false;
  });

  await page.goto(workbenchUrl("/home"));
  await page.getByRole("button", { name: "新建小说", exact: true }).click();
  const createPanel = page.getByRole("form", { name: "新建小说" });
  await expect(createPanel).toBeVisible();
  await createPanel.getByLabel("小说名称").fill(projectName);
  await createPanel.getByRole("button", { name: "选择位置并创建", exact: true }).click();
  await expect(page.getByText("已取消创建，新小说尚未写入磁盘。")).toBeVisible();

  await createPanel.getByRole("button", { name: "选择位置并创建", exact: true }).click();
  await expect(page.locator(".title-stack span")).toHaveText(projectName, { timeout: 20_000 });
  await expect(page.getByText(/新项目已创建并打开/)).toBeVisible();

  await page.getByRole("button", { name: "新建小说", exact: true }).click();
  const duplicatePanel = page.getByRole("form", { name: "新建小说" });
  await duplicatePanel.getByLabel("小说名称").fill(projectName);
  await duplicatePanel.getByRole("button", { name: "选择位置并创建", exact: true }).click();
  await expect(page.locator(".title-stack span")).toHaveText(`${projectName} (2)`, { timeout: 20_000 });
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("new novel creation confirms before leaving an unsaved chapter", async ({ page }) => {
  const currentProjectName = await createWritingProject("unsaved-create-guard");
  const nextProjectName = `guard-target-${Date.now()}`;
  await page.route(`${runtimeApi}/api/projects/pick`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ path: sandboxProjectsPath })
  }));

  await page.goto(workbenchUrl("/editor"));
  const editor = await openEditorDocument(page, "正文");
  await editor.fill("尚未保存的章节内容");
  const navigation = page.getByRole("complementary", { name: "主导航" });
  await navigation.getByRole("button", { name: "项目首页", exact: true }).click();
  await page.getByRole("button", { name: "新建小说", exact: true }).click();
  const createPanel = page.getByRole("form", { name: "新建小说" });
  await createPanel.getByLabel("小说名称").fill(nextProjectName);
  await createPanel.getByRole("button", { name: "选择位置并创建", exact: true }).click();

  await expect(page.getByRole("heading", { name: "当前有未保存内容，确认要新建并切换项目吗？" })).toBeVisible();
  await page.getByRole("button", { name: "返回当前项目", exact: true }).click();
  await expect(page.locator(".title-stack span")).toHaveText(currentProjectName);

  await createPanel.getByRole("button", { name: "选择位置并创建", exact: true }).click();
  await page.getByRole("button", { name: "仍然继续", exact: true }).click();
  await expect(page.locator(".title-stack span")).toHaveText(nextProjectName, { timeout: 20_000 });
});

test("cover workspace keeps four inputs, website-only model selection and version preview", async ({ page }) => {
  const projectName = await createWritingProject("cover-e2e");
  let generated = false;
  const record = {
    id: "cover-e2e-record",
    book_title: projectName,
    author_name: "南山",
    font_style: "行草",
    genre_style: "悬疑",
    mode: "text_to_image",
    model: "gpt-image-2",
    provider: "website",
    original_path: "封面/e2e-原图.png",
    final_path: "封面/e2e-600x800.png",
    original_media_type: "image/png",
    width: 600,
    height: 800,
    created_at: "2026-07-20T06:00:00.000Z"
  };
  await page.route(`${runtimeApi}/api/website-ai/dashboard`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      logged_in: true,
      account: { name: "E2E", email: "e2e@example.test", enabled: true },
      models: [],
      embedding_models: [],
      image_models: [{
        id: "gpt-image-2",
        name: "GPT Image 2",
        provider: "website",
        category: "image",
        selectable: true,
        capabilities: { text_generation: false, streaming: false, reasoning: false, image_generation: true, image_edit: true },
        reasoning_efforts: [],
        supported_sizes: ["768x1024"]
      }],
      selected_model: "",
      selected_embedding_model: "",
      selected_image_model: "gpt-image-2",
      config: { ai_config_mode: "manual", website_profile: { api_key: "masked", license_account_key: "masked", image_model: "gpt-image-2" } }
    })
  }));
  await page.route(`${runtimeApi}/api/project-libraries/genre`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      schema_version: 1,
      domain: "genre",
      revision: 1,
      updated_at: "2026-07-20T06:00:00.000Z",
      status: "ready",
      projection_paths: [],
      records: [{
        id: "genre-suspense",
        kind: "genre_profile",
        name: "悬疑",
        summary: "雨夜追凶",
        description: "冷峻悬疑氛围",
        tags: [],
        order: 0,
        status: "active",
        origin: "manual",
        created_at: "2026-07-20T06:00:00.000Z",
        updated_at: "2026-07-20T06:00:00.000Z",
        needs_review: false,
        notes: "",
        active: true
      }]
    })
  }));
  await page.route(`${runtimeApi}/api/covers**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/image")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: coverPng });
      return;
    }
    if (url.pathname === "/api/covers/generate") {
      const payload = route.request().postDataJSON();
      expect(payload).toMatchObject({ book_title: projectName, author_name: "南山", font_style: "行草", genre_style: "悬疑" });
      generated = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(record) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: generated ? [record] : [] }) });
  });

  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto(workbenchUrl("/cover"));
  await expect(page.getByRole("heading", { name: "封面生成" })).toBeVisible();
  await expect(page.getByLabel("书名")).toHaveValue(projectName);
  await page.getByLabel("作者名").fill("南山");
  await expect(page.getByLabel("字体风格")).toHaveValue("行草");
  await expect(page.getByLabel("题材风格")).toHaveValue("悬疑");
  await expect(page.getByText("网站模型：GPT Image 2")).toBeVisible();
  await page.getByRole("button", { name: "生成封面", exact: true }).click();
  await expect(page.getByAltText(`《${projectName}》封面`).first()).toBeVisible();
  await expect(page.getByText("封面已保存，请核对书名和作者署名。")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

  await page.goto(workbenchUrl("/settings/ai"));
  await page.getByRole("tablist", { name: "AI 配置模式" }).getByRole("button", { name: "手动配置", exact: true }).click();
  const settingsTabs = page.getByRole("tablist", { name: "AI 配置分区" });
  await settingsTabs.getByRole("tab", { name: "网站服务", exact: true }).click();
  await expect(page.getByLabel("封面生图模型")).toHaveValue("gpt-image-2");
  await expect(settingsTabs.getByRole("tab", { name: "模型", exact: true })).toHaveCount(0);
  await settingsTabs.getByRole("tab", { name: "连接参数", exact: true }).click();
  await expect(page.getByText(/文本模型统一在 AI 助手中选择/)).toBeVisible();
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

test("AI settings keep the primary route reachable in a short desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(workbenchUrl("/settings/ai"));

  const modeTabs = page.getByRole("tablist", { name: "AI 配置模式" });
  await modeTabs.getByRole("button", { name: "手动配置", exact: true }).click();
  const sectionTabs = page.getByRole("tablist", { name: "AI 配置分区" });
  await sectionTabs.getByRole("tab", { name: "连接参数", exact: true }).click();

  const panel = page.getByRole("tabpanel", { name: "连接参数配置" });
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

  await panel.evaluate((element) => { element.scrollTop = 0; });
  await expect(panel.locator(".xw-settings-section-head > strong").filter({ hasText: "主线路" })).toBeVisible();
  await expect(panel.getByText("备用线路", { exact: true })).toHaveCount(0);
  await expect(sectionTabs).toBeVisible();
  await expect(actions).toBeVisible();
});

test("assistant conversation create, rename, read, and delete", async ({ page }) => {
  await createWritingProject("e2e-conversation-crud");
  await page.goto(workbenchUrl("/assistant"));
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(page.locator(".chat-title strong")).toHaveText("新对话");

  await page.getByRole("button", { name: "修改会话标题", exact: true }).click();
  await page.getByLabel("会话标题", { exact: true }).fill("E2E 会话标题");
  await page.getByRole("button", { name: "保存会话标题", exact: true }).click();
  await expect(page.locator(".chat-title strong")).toHaveText("E2E 会话标题");
  await expect(page.getByRole("button", { name: "整理会话摘要", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "删除会话", exact: true }).click();
  await page.getByRole("button", { name: "确认删除会话", exact: true }).click();
  await expect(page.locator(".chat-title strong")).toHaveText("自由会话");
  await expect.poll(async () => (await runtimeFetch("/api/conversations")).json()).toEqual([]);
});

test("assistant reference candidates show an actionable confirmation panel", async ({ page }) => {
  await createWritingProject("e2e-reference-confirm");
  await configureMockModel();
  await saveRuntimeDocument("02_设定/人物设定.txt", "林默：谨慎的调查员。");
  await saveRuntimeDocument("02_设定/主要角色.md", "# 主要角色\n林默与周宁存在立场冲突。");
  await page.goto(workbenchUrl("/assistant"));
  await page.getByRole("button", { name: "新建对话", exact: true }).click();

  await page.getByLabel("消息内容").fill("参考角色完善人物关系");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const confirmation = page.getByRole("region", { name: "确认参考文件" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("checkbox").first()).toBeVisible();
  await confirmation.getByRole("checkbox").first().check();
  await confirmation.getByRole("button", { name: /引用 \d+ 个并发送/ }).click();

  const assistantMessage = page.locator('.assistant-message.ai[data-message-role="assistant"]').last();
  await expect(assistantMessage).toContainText("E2E 模型回复", { timeout: 20_000 });
  await expect(confirmation).toHaveCount(0);
});

test("assistant model discovery and reasoning preferences persist per conversation", async ({ page }) => {
  await createWritingProject("e2e-conversation-model");
  await configureMockModel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(workbenchUrl("/assistant"));
  await page.getByRole("button", { name: "新建对话", exact: true }).click();

  const trigger = page.locator(".assistant-model-trigger");
  await expect(trigger).toContainText("e2e-model");
  await trigger.click();
  await page.getByPlaceholder("搜索模型").fill("GPT 5");
  await page.locator(".assistant-model-list").getByRole("option", { name: /GPT 5 Mini/ }).click();
  await expect(trigger).toHaveText("GPT 5 Mini");

  const reasoningPanel = page.locator(".assistant-reasoning-panel");
  await expect(reasoningPanel).toBeVisible();
  await reasoningPanel.getByRole("switch", { name: "开启思考模式", exact: true }).click();
  await expect(trigger).toContainText("GPT 5 Mini · 中");
  await reasoningPanel.getByRole("button", { name: "高", exact: true }).click();
  await expect(reasoningPanel.getByRole("button", { name: "高", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(trigger).toContainText("GPT 5 Mini · 高");

  await page.getByPlaceholder("搜索模型").fill("DeepSeek");
  await page.locator(".assistant-model-list").getByRole("option", { name: /DeepSeek Reasoner/ }).click();
  await expect(trigger).toContainText("DeepSeek Reasoner · 高");
  await expect(reasoningPanel.getByRole("button", { name: "低", exact: true })).toBeDisabled();
  await expect(reasoningPanel.getByRole("button", { name: "中", exact: true })).toBeDisabled();
  await expect(reasoningPanel.getByRole("button", { name: "高", exact: true })).toHaveAttribute("aria-pressed", "true");

  const taskModelSelect = page.locator(".assistant-task-model-panel select");
  await expect(taskModelSelect).toBeVisible();
  await taskModelSelect.selectOption("gpt-5-mini");
  await expect(taskModelSelect).toHaveValue("gpt-5-mini");

  await page.reload();
  await expect(trigger).toContainText("DeepSeek Reasoner · 高");
  await trigger.click();
  await expect(page.locator(".assistant-task-model-panel select")).toHaveValue("gpt-5-mini");
  const conversations = await (await runtimeFetch("/api/conversations")).json() as Array<{ model_override: string; reasoning_effort: string }>;
  expect(conversations[0]).toMatchObject({ model_override: "deepseek-reasoner", reasoning_effort: "high" });

  await page.setViewportSize({ width: 1024, height: 720 });
  await expect(page.locator(".assistant-reasoning-panel")).toBeVisible();
  await expect(page.locator(".assistant-model-list")).not.toContainText("text-embedding-3-small");
});

test("assistant uses split message alignment and a compact keyboard-first composer", async ({ page }) => {
  await createWritingProject("e2e-assistant-layout");
  await configureMockModel();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(workbenchUrl("/assistant"));
  await page.getByRole("button", { name: "新建对话", exact: true }).click();

  const composer = page.getByLabel("消息内容");
  await composer.fill("第一行");
  await composer.press("Shift+Enter");
  await composer.type("第二行");
  await expect(composer).toHaveValue("第一行\n第二行");

  const initialHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  await composer.fill(Array.from({ length: 12 }, (_, index) => `第${index + 1}行`).join("\n"));
  const expandedHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  expect(expandedHeight).toBeGreaterThan(initialHeight);
  expect(expandedHeight).toBeLessThanOrEqual(160);

  await composer.fill("请回复这条消息");
  await composer.press("Enter");
  const userMessage = page.locator('.assistant-message.user[data-message-role="user"]').last();
  const assistantMessage = page.locator('.assistant-message.ai[data-message-role="assistant"]').last();
  await expect(userMessage).toContainText("请回复这条消息");
  await expect(assistantMessage).toContainText("E2E 模型回复", { timeout: 20_000 });
  await expect(userMessage.locator(".assistant-message-body")).toBeVisible();
  await expect(assistantMessage.locator(".assistant-message-body")).toBeVisible();

  const [userBox, assistantBox] = await Promise.all([
    userMessage.locator(".assistant-message-body").boundingBox(),
    assistantMessage.locator(".assistant-message-body").boundingBox()
  ]);
  expect(userBox).not.toBeNull();
  expect(assistantBox).not.toBeNull();
  expect(userBox!.x).toBeGreaterThan(assistantBox!.x);

  await composer.fill("E2E 延迟回复");
  await composer.press("Enter");
  const stopButton = page.getByRole("button", { name: "停止生成", exact: true });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
});

test("assistant context popover stays synchronized with the full context panel", async ({ page }) => {
  await createWritingProject("e2e-assistant-context");
  await saveRuntimeDocument("02_正文/E2E上下文.txt", "用于上下文测试的正文");
  await page.goto(workbenchUrl("/editor"));
  await openEditorDocument(page, "E2E上下文");
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "AI 助手", exact: true }).click();
  await page.getByRole("button", { name: "新建对话", exact: true }).click();

  const contextTrigger = page.locator(".assistant-context-trigger");
  await expect(contextTrigger).toContainText("上下文 0 项");
  await contextTrigger.click();
  const contextPopover = page.locator(".assistant-context-popover");
  await contextPopover.getByRole("button", { name: "固定当前文档", exact: true }).click();
  await expect(contextTrigger).toContainText("上下文 1 项");
  await expect(page.locator(".context-panel")).toContainText("E2E上下文");

  const attachmentInput = page.locator('.assistant-composer input[type="file"]');
  await attachmentInput.setInputFiles({ name: "人物关系.txt", mimeType: "text/plain", buffer: Buffer.from("甲与乙是盟友", "utf8") });
  await expect(contextTrigger).toContainText("上下文 2 项");
  await expect(contextPopover).toContainText("人物关系.txt");
  await expect(page.locator(".context-panel")).toContainText("人物关系.txt");

  await page.getByRole("button", { name: "删除附件人物关系.txt", exact: true }).first().click();
  await expect(contextTrigger).toContainText("上下文 1 项");
  await contextPopover.locator(".assistant-context-row").filter({ hasText: "E2E上下文" }).getByRole("button").click();
  await expect(contextTrigger).toContainText("上下文 0 项");
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

test("assistant sidebar synchronizes automatic lore and saves chapter consistency reports", async ({ page }) => {
  await createWritingProject("e2e-assistant-writing-tools");
  await saveRuntimeDocument("02_正文/E2E一致性.txt", "林默在雨夜抵达旧城，准备寻找失踪多年的兄长。");
  await configureMockModel();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(workbenchUrl("/editor"));
  await openEditorDocument(page, "E2E一致性");
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "AI 助手", exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 720 });

  const sidebar = page.locator(".context-panel");
  const autoLoreSwitch = sidebar.getByRole("switch", { name: /自动提取设定/ });
  await expect(autoLoreSwitch).toHaveAttribute("aria-checked", "false");
  await autoLoreSwitch.click();
  await expect(autoLoreSwitch).toHaveAttribute("aria-checked", "true");
  await expect(sidebar).toContainText("自动提取设定已开启");

  await sidebar.getByRole("button", { name: "检查当前章节", exact: true }).click();
  await expect(sidebar).toContainText("检查完成，报告已保存。", { timeout: 20_000 });
  await expect(sidebar).toContainText("得分 0");
  await sidebar.getByRole("button", { name: "查看完整报告", exact: true }).click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page.getByRole("heading", { name: "全文审阅", exact: true })).toBeVisible();
  await expect(page.locator(".review-score strong")).toHaveText("0");

  await page.goto(workbenchUrl("/settings/writing"));
  await expect(page.getByLabel("自动提取明确设定")).toBeChecked();
  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
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
  await expect(conflictEditor).toHaveValue("磁盘初稿");
  await conflictEditor.fill("本地修改稿");
  await expect(conflictEditor).toHaveValue("本地修改稿");
  await saveRuntimeDocument("02_正文/E2E冲突.txt", "后台磁盘新版");
  await page.locator(".editor-meta").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "正文在另一处被修改", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看差异", exact: true }).click();
  await expect(page.getByRole("region", { name: "保存冲突差异" })).toContainText("后台磁盘新版");
  await page.getByRole("button", { name: "保留我的版本", exact: true }).click();
  await expect.poll(
    async () => (await readRuntimeDocument("02_正文/E2E冲突.txt")).content,
    { timeout: 15_000 }
  ).toBe("本地修改稿");
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
