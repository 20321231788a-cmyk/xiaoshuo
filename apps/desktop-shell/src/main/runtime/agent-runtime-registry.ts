import { AgentRuntimeService } from "@xiaoshuo/agent-runtime";
import path from "node:path";
import type { RuntimeContext } from "./types.js";

export function getProjectAgentRuntime(context: RuntimeContext, projectRoot: string): AgentRuntimeService {
  context.projectIdentityRegistry?.assertWritable(projectRoot);
  const resolved = path.resolve(projectRoot);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const registry = context.agentRuntimes ?? new Map<string, AgentRuntimeService>();
  context.agentRuntimes = registry;
  const existing = registry.get(key);
  if (existing) {
    return existing;
  }
  const runtime = new AgentRuntimeService({
    projectRoot: resolved,
    config: { rootDir: context.projectRoot, env: process.env }
  });
  registry.set(key, runtime);
  return runtime;
}

export function closeProjectAgentRuntimes(registry?: Map<string, AgentRuntimeService>): void {
  if (!registry) {
    return;
  }
  for (const runtime of registry.values()) {
    runtime.close();
  }
  registry.clear();
}
