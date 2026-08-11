import path from "node:path";
import { resolveProjectRoot } from "./main/backend.js";
import { runtimeUrl, startRuntimeServer, type RuntimeServerState } from "./main/runtime-server.js";

const runtimeState: RuntimeServerState = {};

async function main() {
  const projectRoot = resolveProjectRoot(process.cwd());
  const stateFilePath = path.join(projectRoot, "output", "e2e", "project-session.json");
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
