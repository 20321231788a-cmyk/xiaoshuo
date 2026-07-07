import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..", "..");
const desktopDir = path.join(rootDir, "apps", "desktop-shell");
const runtimeHealthUrl = "http://127.0.0.1:18453/api/health";

function runBackground(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    shell: false,
    stdio: options.stdio || "inherit",
    detached: false
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

async function waitForUrl(url, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isUrlReady(url)) {
      return;
    }
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

if (await isUrlReady(runtimeHealthUrl)) {
  process.exit(0);
}

const child = runBackground(process.execPath, [path.join(desktopDir, "dist", "e2e-runtime.js")], {
  cwd: desktopDir,
  env: {
    ...process.env,
    XIAOSHUO_E2E_RUNTIME: "1",
    XIAOSHUO_E2E_BYPASS_LICENSE: "1"
  },
  stdio: "inherit"
});

child.on("exit", (code) => {
  if (code && code !== 0) {
    process.exit(code);
  }
});

await waitForUrl(runtimeHealthUrl);
