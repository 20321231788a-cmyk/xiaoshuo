import { test, expect } from "@playwright/test";
import http from "node:http";

const baseUrl = process.env.WORKBENCH_BASE_URL || "http://127.0.0.1:4180";
const runtimeApi = process.env.WORKBENCH_API_BASE || "http://127.0.0.1:18453";
let mockModelServer: http.Server | null = null;
let mockModelBaseUrl = "";

function workbenchUrl() {
  return `${baseUrl}?e2e=${Date.now()}&api=${encodeURIComponent(runtimeApi)}`;
}

test.beforeEach(async ({ page }) => {
  const health = await fetch(`${runtimeApi}/api/health`).then((response) => response.json());
  expect(health.runtime).toBe("typescript-electron");
  await page.goto(workbenchUrl());
});

test.beforeAll(async () => {
  mockModelServer = http.createServer((request, response) => {
    if (request.url?.includes("/chat/completions")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "当前项目已有大纲、设定、正文目录，建议先完善大纲。" } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404);
    response.end();
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
  if (!mockModelServer) {
    return;
  }
  await new Promise<void>((resolve) => mockModelServer?.close(() => resolve()));
  mockModelServer = null;
});

async function configureMockModel() {
  const response = await fetch(`${runtimeApi}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: "e2e-key",
      model: "e2e-model",
      base_url: mockModelBaseUrl,
      secondary_api_key: "e2e-key",
      secondary_model: "e2e-model",
      secondary_base_url: mockModelBaseUrl
    })
  });
  expect(response.ok).toBe(true);
}

test("create project auto-opens starter body document", async ({ page }) => {
  const uniqueName = `e2e-auto-open-${Date.now()}`;
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "项目", exact: true }).click();

  await expect(page.getByTestId("project-panel")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("project-path-input").fill("D:/xiaoshuo/ts-migration/sandbox-projects");
  await page.getByTestId("project-name-input").fill(uniqueName);
  await page.getByTestId("project-create-button").click();
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "编辑", exact: true }).click();

  await expect(page.getByRole("heading", { name: "文档编辑器", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "正文.txt", exact: true })).toBeVisible();
  await expect(page.getByText("02_正文/正文.txt", { exact: true }).first()).toBeVisible();
});

test("dirty tabs require confirmation before closing", async ({ page }) => {
  const uniqueName = `e2e-close-guard-${Date.now()}`;
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "项目", exact: true }).click();
  await page.getByTestId("project-path-input").fill("D:/xiaoshuo/ts-migration/sandbox-projects");
  await page.getByTestId("project-name-input").fill(uniqueName);
  await page.getByTestId("project-create-button").click();

  await expect(page.getByRole("heading", { name: "文档编辑器", exact: true })).toBeVisible();
  await page.locator(".editor-surface").fill("临时草稿");
  await page.locator(".tab-close").click();

  await expect(page.locator(".close-guard")).toBeVisible();
  await expect(page.locator(".editor-tab")).toHaveCount(1);

  await page.getByRole("button", { name: "仍然关闭", exact: true }).click();
  await expect(page.locator(".editor-tab")).toHaveCount(0);
});

test("dirty drafts require confirmation before switching projects", async ({ page }) => {
  const projectA = `e2e-switch-source-${Date.now()}`;
  const projectB = `e2e-switch-target-${Date.now()}`;
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "项目", exact: true }).click();
  await page.getByTestId("project-path-input").fill("D:/xiaoshuo/ts-migration/sandbox-projects");
  await page.getByTestId("project-name-input").fill(projectA);
  await page.getByTestId("project-create-button").click();

  await expect(page.locator(".editor-surface")).toBeVisible();
  await page.locator(".editor-surface").fill("这是一段还没保存的切换前草稿");
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "项目", exact: true }).click();

  await page.getByTestId("project-path-input").fill("D:/xiaoshuo/ts-migration/sandbox-projects");
  await page.getByTestId("project-name-input").fill(projectB);
  await page.getByTestId("project-create-button").click();

  await expect(page.getByTestId("project-switch-guard")).toBeVisible();
  await expect(page.getByTestId("project-panel").getByText(projectA, { exact: true })).toBeVisible();
  await expect(page.getByTestId("project-switch-cancel-button")).toBeVisible();

  await page.getByTestId("project-switch-confirm-button").click();
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "编辑", exact: true }).click();

  await expect(page.getByRole("heading", { name: "文档编辑器", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "正文.txt", exact: true })).toBeVisible();
  await expect(page.getByText("02_正文/正文.txt", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".editor-surface")).not.toHaveValue("这是一段还没保存的切换前草稿");
});

test("conversation draft also blocks project switching until confirmed", async ({ page }) => {
  const projectA = `e2e-chat-draft-source-${Date.now()}`;
  const projectB = `e2e-chat-draft-target-${Date.now()}`;
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "项目", exact: true }).click();
  await page.getByTestId("project-path-input").fill("D:/xiaoshuo/ts-migration/sandbox-projects");
  await page.getByTestId("project-name-input").fill(projectA);
  await page.getByTestId("project-create-button").click();

  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "会话", exact: true }).click();
  await page.getByTestId("conversation-message-input").fill("这条消息还没发出去");

  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "项目", exact: true }).click();
  await page.getByTestId("project-path-input").fill("D:/xiaoshuo/ts-migration/sandbox-projects");
  await page.getByTestId("project-name-input").fill(projectB);
  await page.getByTestId("project-create-button").click();

  await expect(page.getByTestId("project-switch-guard")).toBeVisible();
  await expect(page.getByTestId("project-switch-guard")).toContainText("会话输入框里还有草稿");

  await page.getByTestId("project-switch-cancel-button").click();
  await expect(page.getByTestId("project-switch-guard")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "会话", exact: true }).click();
  await expect(page.getByTestId("conversation-message-input")).toHaveValue("这条消息还没发出去");
});

test("conversation tab can send a real message through the TS runtime chain", async ({ page }) => {
  const uniqueName = `e2e-chat-send-${Date.now()}`;
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "项目", exact: true }).click();
  await page.getByTestId("project-path-input").fill("D:/xiaoshuo/ts-migration/sandbox-projects");
  await page.getByTestId("project-name-input").fill(uniqueName);
  await page.getByTestId("project-create-button").click();
  await configureMockModel();

  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "会话", exact: true }).click();
  await page.getByTestId("conversation-message-input").fill("请总结当前项目");
  await page.getByTestId("conversation-send-button").click();

  await expect(page.locator(".conversation-thread .assistant-card")).toContainText(/当前项目|建议先|大纲|设定|正文/, { timeout: 15000 });
});

test("terminal tab falls back cleanly in browser mode", async ({ page }) => {
  await page.getByRole("navigation", { name: "Workbench sections" }).getByRole("button", { name: "终端", exact: true }).click();

  await expect(page.getByTestId("terminal-placeholder")).toBeVisible();
  await expect(page.getByTestId("terminal-placeholder")).toContainText("等待桌面壳连接");
  await expect(page.getByTestId("terminal-command-grid")).toHaveCount(0);
});
