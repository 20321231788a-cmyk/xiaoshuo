import { defineConfig } from "@playwright/test";

const runtimePort = process.env.XIAOSHUO_E2E_RUNTIME_PORT || "18453";
const previewPort = process.env.XIAOSHUO_E2E_PREVIEW_PORT || "4180";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  webServer: [
    {
      command: "npm run build:desktop && node tests/e2e/start-runtime.mjs",
      url: `http://127.0.0.1:${runtimePort}/api/health`,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    },
    {
      command: `npm run build:workbench && npm run preview -w @xiaoshuo/workbench -- --port ${previewPort}`,
      url: `http://127.0.0.1:${previewPort}`,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    }
  ],
  use: {
    trace: "retain-on-failure"
  }
});
