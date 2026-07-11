import {
  InMemoryAgentFeatureFlagRegistry,
  parseAgentFeatureFlagOverrides,
  type AgentFeatureFlagOverrides,
  type AgentFeatureFlagRegistry
} from "@xiaoshuo/agent-runtime";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SAFE_AGENT_ARGUMENT = "--safe-agent";
export const AGENT_EXECUTION_V2_ON_ARGUMENT = "--agent-execution-v2=on";
export const AGENT_INLINE_PLAN_UI_ON_ARGUMENT = "--agent-inline-plan-ui=on";

export type DesktopAgentFeatureFlags = {
  featureFlags: AgentFeatureFlagRegistry;
  safeAgent: boolean;
  autoRecoverStaleRuns: boolean;
};

/**
 * Reads only the product-capability allowlist exported by agent-runtime. The
 * file is intentionally main-process-only: no IPC route exposes it to the
 * Workbench, so security controls cannot accidentally become user toggles.
 */
export async function loadDesktopAgentFeatureFlags(
  overridePath: string,
  argv: readonly string[] = process.argv
): Promise<DesktopAgentFeatureFlags> {
  const persisted = await readOverrides(overridePath);
  const safeAgent = argv.includes(SAFE_AGENT_ARGUMENT);
  const commandLineEnablesV2 = argv.includes(AGENT_EXECUTION_V2_ON_ARGUMENT);
  const commandLineEnablesInlinePlanUi = argv.includes(AGENT_INLINE_PLAN_UI_ON_ARGUMENT);
  const overrides: AgentFeatureFlagOverrides = safeAgent
    ? { ...persisted, agent_execution_v2_mode: "off" }
    : commandLineEnablesV2
      ? {
          ...persisted,
          agent_execution_v2_mode: "on",
          ...(commandLineEnablesInlinePlanUi ? { agent_inline_plan_ui: true } : {})
        }
      : persisted;
  const featureFlags = new InMemoryAgentFeatureFlagRegistry(overrides);
  return {
    featureFlags,
    safeAgent,
    // Recovery changes durable-run ownership, so disabled and unavailable
    // modes must leave stale runs untouched for an explicit operator action.
    autoRecoverStaleRuns: !safeAgent && featureFlags.snapshot().agent_execution_v2_mode === "on"
  };
}

/**
 * Kept as a main-process API for a future explicitly-approved product flag
 * surface. It validates a strict allowlist before an atomic userData write.
 */
export async function saveDesktopAgentFeatureFlagOverrides(overridePath: string, value: unknown): Promise<void> {
  const overrides = parseAgentFeatureFlagOverrides(value);
  await fs.mkdir(path.dirname(overridePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(overridePath), `.${path.basename(overridePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, overridePath);
}

async function readOverrides(overridePath: string): Promise<AgentFeatureFlagOverrides> {
  const raw = await fs.readFile(overridePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return {};
  }
  try {
    return parseAgentFeatureFlagOverrides(JSON.parse(raw));
  } catch {
    // A malformed userData file must fail closed rather than preserve a
    // potentially privileged, partially interpreted override.
    return {};
  }
}
