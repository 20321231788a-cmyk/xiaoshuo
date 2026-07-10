import {
  DEFAULT_AGENT_FEATURE_FLAG_SNAPSHOT,
  agentFeatureFlagSnapshotSchema,
  type AgentFeatureFlagSnapshot
} from "@xiaoshuo/shared";

export type AgentFeatureFlagKey = Exclude<keyof AgentFeatureFlagSnapshot, "schema_version">;

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

export interface AgentFeatureFlagRegistry {
  snapshot(): AgentFeatureFlagSnapshot;
}

export class InMemoryAgentFeatureFlagRegistry implements AgentFeatureFlagRegistry {
  private overrides: Partial<AgentFeatureFlagSnapshot>;

  constructor(overrides: Partial<AgentFeatureFlagSnapshot> = {}) {
    this.overrides = { ...overrides };
  }

  snapshot(): AgentFeatureFlagSnapshot {
    return agentFeatureFlagSnapshotSchema.parse(normalize({ ...DEFAULT_AGENT_FEATURE_FLAG_SNAPSHOT, ...this.overrides }));
  }

  update(overrides: Partial<AgentFeatureFlagSnapshot>): void {
    this.overrides = { ...this.overrides, ...overrides };
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
  if (snapshot.agent_execution_v2_mode === "off") {
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
