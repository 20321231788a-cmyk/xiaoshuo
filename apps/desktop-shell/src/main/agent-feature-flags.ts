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

export const DESKTOP_PREVIEW_AGENT_FEATURE_FLAGS = Object.freeze({
  agent_execution_v2_mode: "on",
  model_gateway_v2: true,
  agent_replanning_v2: true,
  context_budget_v2: true,
  memory_v2: true,
  memory_context_selector_v2: true,
  quality_gate_v2: true,
  agent_event_stream_v2: true,
  agent_inline_plan_ui: true,
  novel_agent_room_v1: true,
  novel_tool_catalog_v1: true,
  novel_typed_actions_v1: true,
  novel_background_tasks_v1: true,
  novel_project_transfer_v1: true,
  novel_memory_batch_review_v1: true
}) satisfies Readonly<AgentFeatureFlagOverrides>;

const SAFE_AGENT_FEATURE_FLAGS = Object.freeze({
  agent_execution_v2_mode: "off",
  model_gateway_v2: false,
  agent_replanning_v2: false,
  context_budget_v2: false,
  memory_v2: false,
  memory_context_selector_v2: false,
  quality_gate_v2: false,
  agent_event_stream_v2: false,
  agent_inline_plan_ui: false,
  novel_agent_room_v1: false,
  novel_tool_catalog_v1: false,
  novel_typed_actions_v1: false,
  novel_background_tasks_v1: false,
  novel_project_transfer_v1: false,
  novel_memory_batch_review_v1: false
}) satisfies Readonly<AgentFeatureFlagOverrides>;

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
  const overrides: AgentFeatureFlagOverrides = safeAgent || !persisted.valid
    ? { ...SAFE_AGENT_FEATURE_FLAGS }
    : {
        ...DESKTOP_PREVIEW_AGENT_FEATURE_FLAGS,
        ...persisted.overrides,
        ...(commandLineEnablesV2 ? { agent_execution_v2_mode: "on" as const } : {}),
        ...(commandLineEnablesInlinePlanUi ? { agent_inline_plan_ui: true } : {})
      };
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

async function readOverrides(
  overridePath: string
): Promise<{ overrides: AgentFeatureFlagOverrides; valid: boolean }> {
  const raw = await fs.readFile(overridePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return { overrides: {}, valid: true };
  }
  try {
    return { overrides: parseAgentFeatureFlagOverrides(JSON.parse(raw)), valid: true };
  } catch {
    // A malformed userData file must fail closed rather than preserve a
    // potentially privileged, partially interpreted override.
    return { overrides: {}, valid: false };
  }
}
