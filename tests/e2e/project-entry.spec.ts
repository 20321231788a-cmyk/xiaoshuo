import { test, expect } from "@playwright/test";
import http from "node:http";

const baseUrl = process.env.WORKBENCH_BASE_URL || "http://127.0.0.1:4180";
const runtimeApi = process.env.WORKBENCH_API_BASE || "http://127.0.0.1:18453";
const runtimeSessionToken = process.env.WORKBENCH_E2E_SESSION_TOKEN || "arcwriter-e2e-runtime-token";
const sandboxProjectsPath = "D:/xiaoshuo/ts-migration/sandbox-projects";
const heldModelResponses = new Set<http.ServerResponse>();
let mockModelServer: http.Server | null = null;
let mockModelBaseUrl = "";
let retryFailureCount = 0;

function releaseHeldModelResponses(content = "E2E 模型回复") {
  for (const response of heldModelResponses) {
    try {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      }
    } catch {
      response.destroy();
    } finally {
      heldModelResponses.delete(response);
    }
  }
}

function runtimeHeaders(headers: HeadersInit = {}): Headers {
  const next = new Headers(headers);
  next.set("Authorization", `Bearer ${runtimeSessionToken}`);
  return next;
}

async function runtimeFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtimeApi}${pathname}`, { ...init, headers: runtimeHeaders(init.headers) });
}

function workbenchUrl() {
  return `${baseUrl}?e2e=${Date.now()}&api=${encodeURIComponent(runtimeApi)}`;
}

test.beforeAll(async () => {
  mockModelServer = http.createServer((request, response) => {
    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404);
      response.end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const isAssistantChat = body.includes("你是 ArcWriter 的本地项目助手");
      if (body.includes("E2E 重试失败") && isAssistantChat && retryFailureCount++ === 0) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { message: "E2E forced first-attempt failure" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      // Planning and intent classification must resolve before the chat stream
      // emits its durable start event. Hold only the actual chat completion.
      if (body.includes("E2E 保持运行") && isAssistantChat) {
        // Keep the model call open so the UI can exercise a genuine durable-run control.
        heldModelResponses.add(response);
        response.flushHeaders();
        response.once("close", () => heldModelResponses.delete(response));
        return;
      }
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
  releaseHeldModelResponses();
  if (!mockModelServer) {
    return;
  }
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

async function configureMockModel() {
  const response = await runtimeFetch("/api/config", {
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

async function prepareTraceRun() {
  const projectName = `e2e-agent-trace-${Date.now()}`;
  const projectResponse = await runtimeFetch("/api/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sandboxProjectsPath, project_name: projectName, create_in_parent: true })
  });
  expect(projectResponse.ok).toBe(true);
  await configureMockModel();

  const requestId = `e2e-agent-trace-run-${Date.now()}`;
  const runResponse = await runtimeFetch("/api/agent/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      content: "E2E 保持运行，用于验证 Agent Trace 暂停控制。",
      current_path: "01_大纲/大纲.txt"
    })
  });
  expect(runResponse.status).toBe(201);
  const run = await runResponse.json() as { run_id: string; request_id: string };
  expect(run.run_id).not.toBe("");
  expect(run.request_id).toBe(requestId);
  return run;
}

async function prepareConfirmationRun() {
  const projectName = `e2e-agent-confirmation-${Date.now()}`;
  const projectResponse = await runtimeFetch("/api/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sandboxProjectsPath, project_name: projectName, create_in_parent: true })
  });
  expect(projectResponse.ok).toBe(true);

  const requestId = `e2e-agent-confirmation-run-${Date.now()}`;
  const runResponse = await runtimeFetch("/api/agent/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      // A file operation creates a confirmation checkpoint. The selected text
      // keeps the test fully local and independent from a model response.
      content: "请保存到大纲文件",
      selection: "E2E durable confirmation content.",
      current_path: "01_大纲/大纲.txt"
    })
  });
  expect(runResponse.status).toBe(201);
  const run = await runResponse.json() as { run_id: string; request_id: string };
  expect(run.request_id).toBe(requestId);
  // Creation returns as soon as the durable attempt is scheduled. Wait for
  // its independent confirmation checkpoint before loading the UI so the
  // assertion cannot race Workbench's initial confirmation-list request.
  await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(run.run_id)}/confirmations`);
    if (!response.ok) {
      return "";
    }
    const confirmations = await response.json() as Array<{ status: string }>;
    return confirmations[0]?.status || "";
  }, { timeout: 15_000 }).toBe("pending");
  return run;
}

test("status menu opens Agent Trace and pauses a durable run", async ({ page }) => {
  const run = await prepareTraceRun();
  await page.goto(workbenchUrl());

  await expect(page.locator("summary.xw-status-summary")).toBeVisible({ timeout: 15_000 });
  await page.locator("summary.xw-status-summary").click();
  await page.getByRole("menuitem", { name: "运行", exact: true }).click();

  const tracePage = page.locator(".xw-trace-page");
  await expect(tracePage.getByText("Agent 运行", { exact: true })).toBeVisible();
  await expect(tracePage.getByLabel("Agent trace runs")).toContainText("E2E 保持运行", { timeout: 15_000 });

  const detail = tracePage.getByLabel("Agent trace detail");
  await expect(detail).toContainText(run.run_id);
  const pause = detail.getByRole("button", { name: "暂停运行", exact: true });
  await expect(pause).toBeEnabled({ timeout: 15_000 });
  await pause.click();

  // An active run pauses cooperatively at its next durable checkpoint. The
  // immediate user-visible contract is the persisted pause request event.
  await expect(detail.getByText("run.pause_requested", { exact: true })).toBeVisible();
});

test("conversation inline plan controls the real durable run through the API client", async ({ page }) => {
  const projectName = `e2e-inline-plan-${Date.now()}`;
  const projectResponse = await runtimeFetch("/api/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sandboxProjectsPath, project_name: projectName, create_in_parent: true })
  });
  expect(projectResponse.ok).toBe(true);
  await configureMockModel();
  await page.goto(workbenchUrl());

  await page.getByRole("button", { name: "新开对话", exact: true }).click();
  await page.getByRole("button", { name: "AI 对话框", exact: true }).click();
  const composer = page.getByPlaceholder("输入写作目标、修稿要求或拆书要求，系统会按内容自动调用合适的技能。");
  await composer.fill("E2E 保持运行，用于验证会话内计划卡暂停控制。");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  let card = page.getByLabel("Agent 执行计划");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /智能执行计划/ }).click();
  await expect(card).toContainText(/运行 run_/, { timeout: 15_000 });
  const runId = (await card.textContent() || "").match(/运行 (run_[^\s·]+)/)?.[1] || "";
  expect(runId).toMatch(/^run_/);

  // The NDJSON response is deliberately still open. A renderer reload must
  // recover the persisted pending assistant metadata and re-subscribe to the
  // same durable run instead of cancelling or losing the plan card.
  await page.reload();
  await page.getByRole("button", { name: "AI 对话", exact: true }).click();
  card = page.getByLabel("Agent 执行计划");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /智能执行计划/ }).click();
  await expect(card).toContainText(`运行 ${runId}`, { timeout: 15_000 });

  const pause = card.getByRole("button", { name: "暂停", exact: true });
  await expect(pause).toBeEnabled({ timeout: 15_000 });
  await pause.click();
  await expect(card.getByText("操作已提交。", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
    const payload = await response.json() as { events?: Array<{ event_type?: string }> };
    return payload.events?.some((event) => event.event_type === "run.pause_requested") || false;
  }, { timeout: 15_000 }).toBe(true);

  // A pause becomes durable at the next checkpoint. Release the held model
  // stream, resume from the newly-versioned run, then cancel through the same
  // card so this verifies all three real control paths.
  releaseHeldModelResponses();
  await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}`);
    return (await response.json() as { status: string }).status;
  }, { timeout: 15_000 }).toBe("paused");
  const resume = card.getByRole("button", { name: "恢复", exact: true });
  await expect(resume).toBeEnabled({ timeout: 15_000 });
  await resume.click();
  await expect(card.getByText("操作已提交。", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
    const payload = await response.json() as { events?: Array<{ event_type?: string }> };
    return payload.events?.some((event) => event.event_type === "run.resume_started") || false;
  }, { timeout: 15_000 }).toBe(true);

  const cancel = card.getByRole("button", { name: "取消", exact: true });
  await expect(cancel).toBeEnabled({ timeout: 15_000 });
  await cancel.click();
  await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}`);
    return (await response.json() as { status: string }).status;
  }, { timeout: 15_000 }).toBe("cancelled");
});

test("conversation inline plan refreshes after a version conflict without replaying pause", async ({ page }) => {
  const projectName = `e2e-inline-plan-conflict-${Date.now()}`;
  const projectResponse = await runtimeFetch("/api/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sandboxProjectsPath, project_name: projectName, create_in_parent: true })
  });
  expect(projectResponse.ok).toBe(true);
  await configureMockModel();
  await page.goto(workbenchUrl());

  await page.getByRole("button", { name: "新开对话", exact: true }).click();
  await page.getByRole("button", { name: "AI 对话框", exact: true }).click();
  const composer = page.getByPlaceholder("输入写作目标、修稿要求或拆书要求，系统会按内容自动调用合适的技能。");
  await composer.fill("E2E 保持运行，用于验证会话内计划卡冲突刷新。");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const card = page.getByLabel("Agent 执行计划");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /智能执行计划/ }).click();
  const runId = (await card.textContent() || "").match(/运行 (run_[^\s·]+)/)?.[1] || "";
  expect(runId).toMatch(/^run_/);

  let preempted = false;
  await page.route(`${runtimeApi}/api/agent/runs/${encodeURIComponent(runId)}/pause`, async (route) => {
    if (!preempted) {
      preempted = true;
      const requestBody = route.request().postDataJSON() as { expected_version?: number };
      const preempt = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation_id: `e2e-preempt-${Date.now()}`,
          expected_version: requestBody.expected_version
        })
      });
      expect(preempt.ok).toBe(true);
    }
    await route.continue({ headers: Object.fromEntries(runtimeHeaders(route.request().headers())) });
  });

  await card.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(card.getByText("运行状态已在其他位置更新；本次操作没有自动重放。", { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(preempted).toBe(true);
  releaseHeldModelResponses();
});

test("conversation inline plan retries the failed durable step by its real step ID", async ({ page }) => {
  const projectName = `e2e-inline-plan-retry-${Date.now()}`;
  const projectResponse = await runtimeFetch("/api/projects/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sandboxProjectsPath, project_name: projectName, create_in_parent: true })
  });
  expect(projectResponse.ok).toBe(true);
  await configureMockModel();
  await page.goto(workbenchUrl());

  await page.getByRole("button", { name: "新开对话", exact: true }).click();
  await page.getByRole("button", { name: "AI 对话框", exact: true }).click();
  const composer = page.getByPlaceholder("输入写作目标、修稿要求或拆书要求，系统会按内容自动调用合适的技能。");
  await composer.fill("E2E 重试失败，用于验证会话内计划卡真实 step 重试。");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const card = page.getByLabel("Agent 执行计划");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /智能执行计划/ }).click();
  const runId = (await card.textContent() || "").match(/运行 (run_[^\s·]+)/)?.[1] || "";
  expect(runId).toMatch(/^run_/);
  const failedRun = await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}`);
    return await response.json() as { status: string; steps: Array<{ step_id: string; status: string }> };
  }, { timeout: 15_000 }).toMatchObject({ status: "failed" });
  const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}`);
  const run = await response.json() as { steps: Array<{ step_id: string; status: string }> };
  const failedStep = run.steps.find((step) => step.status === "failed");
  expect(failedStep?.step_id).toMatch(/^step_/);
  const retryRequest = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().includes(`/api/agent/runs/${runId}/steps/${failedStep!.step_id}/retry`)
  );
  await card.getByRole("button", { name: "重试此步", exact: true }).click();
  await retryRequest;
  await expect(card.getByText("操作已提交。", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const eventsResponse = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
    const payload = await eventsResponse.json() as { events?: Array<{ event_type?: string; step_id?: string }> };
    return payload.events?.some((event) => event.event_type === "run.retry_started" && event.step_id === failedStep?.step_id) || false;
  }, { timeout: 15_000 }).toBe(true);
});

test("Agent Trace approves a durable confirmation and requires an explicit resume", async ({ page }) => {
  const run = await prepareConfirmationRun();
  await page.goto(workbenchUrl());

  await expect(page.locator("summary.xw-status-summary")).toBeVisible({ timeout: 15_000 });
  await page.locator("summary.xw-status-summary").click();
  await page.getByRole("menuitem", { name: "运行", exact: true }).click();

  const detail = page.locator("[aria-label='Agent trace detail']");
  await expect(detail).toContainText(run.run_id, { timeout: 15_000 });
  await expect(detail.getByText(/^待确认\s*·\s*01_大纲\/大纲\.txt$/)).toBeVisible();

  await detail.getByRole("button", { name: "批准", exact: true }).click();
  await expect(detail.getByText("已批准。请使用“继续”显式恢复任务。", { exact: true })).toBeVisible();

  const resume = detail.getByRole("button", { name: "恢复运行", exact: true });
  await expect(resume).toBeEnabled();
  await resume.click();

  await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(run.run_id)}`);
    return (await response.json() as { status: string }).status;
  }, { timeout: 15_000 }).toBe("completed");
});

test("Agent Trace rejects a durable confirmation and fails its run", async ({ page }) => {
  const run = await prepareConfirmationRun();
  await page.goto(workbenchUrl());

  await expect(page.locator("summary.xw-status-summary")).toBeVisible({ timeout: 15_000 });
  await page.locator("summary.xw-status-summary").click();
  await page.getByRole("menuitem", { name: "运行", exact: true }).click();

  const detail = page.locator("[aria-label='Agent trace detail']");
  await expect(detail).toContainText(run.run_id, { timeout: 15_000 });
  await expect(detail.getByText(/^待确认\s*·\s*01_大纲\/大纲\.txt$/)).toBeVisible();
  await detail.getByRole("button", { name: "拒绝", exact: true }).click();

  await expect(detail.getByText(/^已拒绝\s*·\s*01_大纲\/大纲\.txt$/)).toBeVisible();
  await expect(detail.getByText("失败", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "恢复运行", exact: true })).toBeEnabled();

  await expect.poll(async () => {
    const response = await runtimeFetch(`/api/agent/runs/${encodeURIComponent(run.run_id)}`);
    return (await response.json() as { status: string; error_code: string }).status;
  }, { timeout: 15_000 }).toBe("failed");
});
