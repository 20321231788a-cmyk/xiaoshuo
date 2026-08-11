import { AgentRuntimeService } from "@xiaoshuo/agent-runtime";
import { CanonicalProjectPathGuard } from "@xiaoshuo/document-service";
import { MANIFEST_REL_PATH, readExistingProjectId } from "@xiaoshuo/project-manifest";
import path from "node:path";
import {
  ProjectIdentityRegistryError,
  projectIdentityConflictCode,
  projectIdentityUnconfirmedCode
} from "../project-identity-registry.js";
import type { RuntimeContext } from "./types.js";

export async function getProjectAgentRuntime(context: RuntimeContext, projectRoot: string): Promise<AgentRuntimeService> {
  const resolved = path.resolve(projectRoot);
  const pathGuard = new CanonicalProjectPathGuard(resolved);
  await pathGuard.assertPath(path.join(resolved, MANIFEST_REL_PATH), { allowMissing: false });
  const projectId = await readExistingProjectId(resolved);
  if (!projectId) {
    throw new ProjectIdentityRegistryError(projectIdentityConflictCode, "项目 manifest 未提供有效 UUID，已拒绝创建可写运行时");
  }
  if (!context.projectIdentityRegistry) {
    throw new ProjectIdentityRegistryError(projectIdentityUnconfirmedCode, "项目身份注册表不可用，已拒绝创建可写运行时");
  }
  context.projectIdentityRegistry.assertWritable(resolved, projectId);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const registry = context.agentRuntimes ?? new Map<string, AgentRuntimeService>();
  context.agentRuntimes = registry;
  const existing = registry.get(key);
  if (existing) {
    return existing;
  }
  const runtime = new AgentRuntimeService({
    projectRoot: resolved,
    config: { rootDir: context.projectRoot, env: process.env },
    featureFlags: context.featureFlags,
    autoRecoverStaleRuns: context.autoRecoverStaleRuns
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
