import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  webServer: [
    {
      command: "npm run build:desktop && node tests/e2e/start-runtime.mjs",
      url: "http://127.0.0.1:18453/api/health",
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    },
    {
      command: "npm run build:workbench && npm run preview -w @xiaoshuo/workbench -- --port 4180",
      url: "http://127.0.0.1:4180",
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
