import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "..", "..");
const workbenchDir = path.join(rootDir, "apps", "workbench");
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const npxCommand = isWindows ? "npx.cmd" : "npx";
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: npm run dev:desktop [-- --port 4190]

Starts the migration Electron shell.

Options:
  --no-preview     Do not build/start the workbench preview. Uses XIAOSHUO_RENDERER_URL or the backend URL.
  --port <port>    Preview port when the script starts workbench preview. Default: 4190.
  --help           Show this help text.
`);
  process.exit(0);
}

const noPreview = args.has("--no-preview");
const port = readOption("--port") || process.env.XIAOSHUO_WORKBENCH_PORT || "4190";
const runtimeUrl = process.env.XIAOSHUO_RUNTIME_URL || "http://127.0.0.1:18453";
const previewUrl = `http://127.0.0.1:${port}/?desktop=1&api=${encodeURIComponent(runtimeUrl)}`;
const rendererUrl = process.env.XIAOSHUO_RENDERER_URL || (noPreview ? "" : previewUrl);
let previewProcess = null;

function readOption(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnArgs = isWindows ? ["/d", "/s", "/c", command, ...commandArgs] : commandArgs;
    const child = spawn(isWindows ? "cmd.exe" : command, spawnArgs, {
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
      reject(new Error(`${command} ${commandArgs.join(" ")} exited with code ${code ?? "unknown"}`));
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

async function startPreviewIfNeeded() {
  if (noPreview || process.env.XIAOSHUO_RENDERER_URL) {
    return;
  }

  console.log("[desktop] building workbench preview assets");
  await run(npmCommand, ["run", "build:workbench"]);

  if (await isUrlReady(previewUrl)) {
    console.log(`[desktop] reusing existing workbench preview at ${previewUrl}`);
    return;
  }

  console.log(`[desktop] starting workbench preview at ${previewUrl}`);
  const previewArgs = ["vite", "preview", "--host", "127.0.0.1", "--port", port];
  previewProcess = spawn(isWindows ? "cmd.exe" : npxCommand, isWindows ? ["/d", "/s", "/c", npxCommand, ...previewArgs] : previewArgs, {
    cwd: workbenchDir,
    env: process.env,
    shell: false,
    stdio: "inherit"
  });
  previewProcess.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[desktop] workbench preview exited with code ${code}`);
    }
  });

  await waitForUrl(previewUrl);
}

function cleanup() {
  if (previewProcess && !previewProcess.killed) {
    previewProcess.kill();
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  await startPreviewIfNeeded();

  console.log("[desktop] building Electron shell");
  await run(npmCommand, ["run", "build", "-w", "@xiaoshuo/desktop-shell"]);

  console.log(`[desktop] launching Electron${rendererUrl ? ` -> ${rendererUrl}` : ""}`);
  await run(npxCommand, ["electron", "."], {
    cwd: desktopDir,
    env: {
      ...process.env,
      ...(rendererUrl ? { XIAOSHUO_RENDERER_URL: rendererUrl } : {})
    }
  });
} finally {
  cleanup();
}
