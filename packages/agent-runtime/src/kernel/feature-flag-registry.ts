import {
  DEFAULT_AGENT_FEATURE_FLAG_SNAPSHOT,
  agentFeatureFlagSnapshotSchema,
  type AgentFeatureFlagSnapshot
} from "@xiaoshuo/shared";
import { z } from "zod";

export type AgentFeatureFlagKey = Exclude<keyof AgentFeatureFlagSnapshot, "schema_version">;
export type AgentFeatureFlagOverrides = Partial<Omit<AgentFeatureFlagSnapshot, "schema_version">>;

export type AgentFeatureFlagDefinition = {
  key: AgentFeatureFlagKey;
  owner: string;
  defaultValue: AgentFeatureFlagSnapshot[AgentFeatureFlagKey];
  introducedIn: string;
  dependencies: readonly AgentFeatureFlagKey[];
  plannedRemovalVersion: string | null;
  productionVisible: boolean;
};

export const AGENT_FEATURE_FLAG_DEFINITIONS: readonly AgentFeatureFlagDefinition[] = [
  flag("agent_execution_v2_mode", "off", []),
  flag("model_gateway_v2", false, ["agent_execution_v2_mode"]),
  flag("agent_replanning_v2", false, ["agent_execution_v2_mode", "model_gateway_v2"]),
  flag("context_budget_v2", false, ["agent_execution_v2_mode", "model_gateway_v2"]),
  flag("memory_v2", false, ["agent_execution_v2_mode", "model_gateway_v2", "agent_replanning_v2", "context_budget_v2"]),
  flag("memory_context_selector_v2", false, ["context_budget_v2", "memory_v2"]),
  flag("quality_gate_v2", false, ["agent_execution_v2_mode"]),
  flag("agent_event_stream_v2", false, ["agent_execution_v2_mode"]),
  flag("agent_inline_plan_ui", false, ["agent_execution_v2_mode"])
];

/**
 * This is deliberately a product-capability allowlist. Transport security,
 * filesystem policy and redaction controls are code-only settings and cannot
 * be persisted or surfaced through this registry.
 */
export const AGENT_PERSISTABLE_FEATURE_FLAG_KEYS: readonly AgentFeatureFlagKey[] = [
  "agent_execution_v2_mode",
  "model_gateway_v2",
  "agent_replanning_v2",
  "context_budget_v2",
  "memory_v2",
  "memory_context_selector_v2",
  "quality_gate_v2",
  "agent_event_stream_v2",
  "agent_inline_plan_ui"
];

export const agentFeatureFlagOverridesSchema = z
  .object({
    agent_execution_v2_mode: z.enum(["off", "shadow", "on"]).optional(),
    model_gateway_v2: z.boolean().optional(),
    agent_replanning_v2: z.boolean().optional(),
    context_budget_v2: z.boolean().optional(),
    memory_v2: z.boolean().optional(),
    memory_context_selector_v2: z.boolean().optional(),
    quality_gate_v2: z.boolean().optional(),
    agent_event_stream_v2: z.boolean().optional(),
    agent_inline_plan_ui: z.boolean().optional()
  })
  .strict();

export function parseAgentFeatureFlagOverrides(value: unknown): AgentFeatureFlagOverrides {
  return agentFeatureFlagOverridesSchema.parse(value);
}

export interface AgentFeatureFlagRegistry {
  snapshot(): AgentFeatureFlagSnapshot;
}

export type AgentExecutionV2AdmissionErrorCode = "AGENT_EXECUTION_V2_DISABLED" | "AGENT_V2_SHADOW_UNAVAILABLE";

/**
 * `shadow` has no legacy adapter or comparison protocol yet. Treating it as
 * executable would silently make it equivalent to `on`, so both non-on modes
 * reject durable execution until a zero-side-effect comparison path exists.
 */
export function assertAgentExecutionV2Enabled(snapshot: AgentFeatureFlagSnapshot): AgentFeatureFlagSnapshot {
  if (snapshot.agent_execution_v2_mode === "on") {
    return snapshot;
  }
  const code: AgentExecutionV2AdmissionErrorCode = snapshot.agent_execution_v2_mode === "shadow"
    ? "AGENT_V2_SHADOW_UNAVAILABLE"
    : "AGENT_EXECUTION_V2_DISABLED";
  const message = code === "AGENT_V2_SHADOW_UNAVAILABLE"
    ? "Agent v2 shadow mode is unavailable until its legacy comparison adapter is implemented"
    : "Agent v2 execution is disabled";
  throw Object.assign(new Error(message), { code });
}

export function isAgentExecutionV2Enabled(snapshot: AgentFeatureFlagSnapshot): boolean {
  return snapshot.agent_execution_v2_mode === "on";
}

export class InMemoryAgentFeatureFlagRegistry implements AgentFeatureFlagRegistry {
  private overrides: Partial<AgentFeatureFlagSnapshot>;

  constructor(overrides: AgentFeatureFlagOverrides = {}) {
    this.overrides = { ...parseAgentFeatureFlagOverrides(overrides) };
  }

  snapshot(): AgentFeatureFlagSnapshot {
    return agentFeatureFlagSnapshotSchema.parse(normalize({ ...DEFAULT_AGENT_FEATURE_FLAG_SNAPSHOT, ...this.overrides }));
  }

  update(overrides: AgentFeatureFlagOverrides): void {
    this.overrides = { ...this.overrides, ...parseAgentFeatureFlagOverrides(overrides) };
  }
}

function flag(
  key: AgentFeatureFlagKey,
  defaultValue: AgentFeatureFlagSnapshot[AgentFeatureFlagKey],
  dependencies: readonly AgentFeatureFlagKey[]
): AgentFeatureFlagDefinition {
  return {
    key,
    owner: "agent-runtime",
    defaultValue,
    introducedIn: "P0",
    dependencies,
    plannedRemovalVersion: null,
    productionVisible: false
  };
}

function normalize(snapshot: AgentFeatureFlagSnapshot): AgentFeatureFlagSnapshot {
  if (snapshot.agent_execution_v2_mode === "off" || snapshot.agent_execution_v2_mode === "shadow") {
    return {
      ...snapshot,
      model_gateway_v2: false,
      agent_replanning_v2: false,
      context_budget_v2: false,
      memory_v2: false,
      memory_context_selector_v2: false,
      quality_gate_v2: false,
      agent_event_stream_v2: false,
      agent_inline_plan_ui: false
    };
  }

  if (!snapshot.model_gateway_v2) {
    snapshot = { ...snapshot, agent_replanning_v2: false, context_budget_v2: false, memory_v2: false, memory_context_selector_v2: false };
  }
  if (!snapshot.context_budget_v2 || !snapshot.memory_v2) {
    snapshot = { ...snapshot, memory_context_selector_v2: false };
  }
  return snapshot;
}
