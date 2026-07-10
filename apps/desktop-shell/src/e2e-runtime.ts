import path from "node:path";
import fs from "node:fs/promises";
import { resolveProjectRoot } from "./main/backend.js";
import { runtimeUrl, startRuntimeServer, type RuntimeServerState } from "./main/runtime-server.js";

const runtimeState: RuntimeServerState = {};

async function main() {
  const projectRoot = resolveProjectRoot(process.cwd());
  const stateDirectory = path.join(projectRoot, "output", "e2e");
  // E2E sessions must never inherit a prior project's persisted identity.
  await fs.rm(stateDirectory, { recursive: true, force: true });
  const stateFilePath = path.join(stateDirectory, "project-session.json");
  await startRuntimeServer({
    projectRoot,
    stateFilePath,
    state: runtimeState
  });
  process.stdout.write(`[e2e-runtime] ready ${runtimeUrl}\n`);
}

void main().catch((error) => {
  process.stderr.write(`[e2e-runtime] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
