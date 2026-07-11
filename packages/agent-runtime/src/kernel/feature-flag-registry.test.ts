import { describe, expect, it } from "vitest";
import {
  AGENT_FEATURE_FLAG_DEFINITIONS,
  AGENT_PERSISTABLE_FEATURE_FLAG_KEYS,
  InMemoryAgentFeatureFlagRegistry,
  parseAgentFeatureFlagOverrides
} from "./feature-flag-registry.js";

describe("InMemoryAgentFeatureFlagRegistry", () => {
  it("declares the P0 flags and defaults every future capability to off", () => {
    const registry = new InMemoryAgentFeatureFlagRegistry();
    const snapshot = registry.snapshot();

    expect(AGENT_FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key)).toEqual([
      "agent_execution_v2_mode",
      "model_gateway_v2",
      "agent_replanning_v2",
      "context_budget_v2",
      "memory_v2",
      "memory_context_selector_v2",
      "quality_gate_v2",
      "agent_event_stream_v2",
      "agent_inline_plan_ui"
    ]);
    expect(snapshot).toEqual({
      schema_version: 1,
      agent_execution_v2_mode: "off",
      model_gateway_v2: false,
      agent_replanning_v2: false,
      context_budget_v2: false,
      memory_v2: false,
      memory_context_selector_v2: false,
      quality_gate_v2: false,
      agent_event_stream_v2: false,
      agent_inline_plan_ui: false
    });
  });

  it("normalizes invalid dependency combinations to the nearest safe configuration", () => {
    const registry = new InMemoryAgentFeatureFlagRegistry({
      agent_execution_v2_mode: "off",
      agent_replanning_v2: true,
      memory_context_selector_v2: true
    });

    expect(registry.snapshot()).toMatchObject({
      agent_execution_v2_mode: "off",
      agent_replanning_v2: false,
      memory_context_selector_v2: false
    });
  });

  it("treats shadow as non-executable until a legacy comparison adapter exists", () => {
    const registry = new InMemoryAgentFeatureFlagRegistry({
      agent_execution_v2_mode: "shadow",
      model_gateway_v2: true,
      agent_replanning_v2: true,
      memory_v2: true,
      agent_event_stream_v2: true
    });

    expect(registry.snapshot()).toMatchObject({
      agent_execution_v2_mode: "shadow",
      model_gateway_v2: false,
      agent_replanning_v2: false,
      memory_v2: false,
      agent_event_stream_v2: false
    });
  });

  it("accepts only product capability overrides and never creates security toggles", () => {
    expect(AGENT_PERSISTABLE_FEATURE_FLAG_KEYS).toEqual(AGENT_FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key));
    expect(parseAgentFeatureFlagOverrides({ agent_execution_v2_mode: "shadow" })).toEqual({ agent_execution_v2_mode: "shadow" });
    expect(() => parseAgentFeatureFlagOverrides({ runtime_session_auth: false })).toThrow();
  });
});
