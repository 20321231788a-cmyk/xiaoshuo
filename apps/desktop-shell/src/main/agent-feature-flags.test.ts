import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_EXECUTION_V2_ON_ARGUMENT,
  AGENT_INLINE_PLAN_UI_ON_ARGUMENT,
  DESKTOP_PREVIEW_AGENT_FEATURE_FLAGS,
  SAFE_AGENT_ARGUMENT,
  loadDesktopAgentFeatureFlags,
  saveDesktopAgentFeatureFlagOverrides
} from "./agent-feature-flags.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("desktop agent feature flag overrides", () => {
  it("enables the integrated Preview profile for a normal desktop start", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");

    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter"]);

    expect(flags.safeAgent).toBe(false);
    expect(flags.autoRecoverStaleRuns).toBe(true);
    expect(flags.featureFlags.snapshot()).toMatchObject(DESKTOP_PREVIEW_AGENT_FEATURE_FLAGS);
    await expect(fs.access(overridePath)).rejects.toThrow();
  });

  it("persists only schema-validated product capability overrides", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");

    await saveDesktopAgentFeatureFlagOverrides(overridePath, {
      agent_execution_v2_mode: "on",
      model_gateway_v2: true
    });

    const onDisk = JSON.parse(await fs.readFile(overridePath, "utf8"));
    expect(onDisk).toEqual({ agent_execution_v2_mode: "on", model_gateway_v2: true });
    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter"]);
    expect(flags.featureFlags.snapshot()).toMatchObject({
      agent_execution_v2_mode: "on",
      model_gateway_v2: true,
      quality_gate_v2: true
    });
  });

  it("applies valid persisted overrides on top of the Preview profile", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");
    await saveDesktopAgentFeatureFlagOverrides(overridePath, {
      model_gateway_v2: false,
      quality_gate_v2: false
    });

    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter"]);

    expect(flags.featureFlags.snapshot()).toMatchObject({
      agent_execution_v2_mode: "on",
      model_gateway_v2: false,
      agent_replanning_v2: false,
      context_budget_v2: false,
      memory_v2: false,
      memory_context_selector_v2: false,
      quality_gate_v2: false,
      agent_event_stream_v2: true,
      agent_inline_plan_ui: true
    });
  });

  it("rejects unknown or invalid values and fails closed for malformed userData", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");

    await expect(saveDesktopAgentFeatureFlagOverrides(overridePath, { runtime_session_auth: false })).rejects.toThrow();
    await expect(saveDesktopAgentFeatureFlagOverrides(overridePath, { agent_execution_v2_mode: "unsafe" })).rejects.toThrow();
    await fs.mkdir(path.dirname(overridePath), { recursive: true });
    await fs.writeFile(overridePath, '{"agent_execution_v2_mode":"on","runtime_session_auth":false}', "utf8");

    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter"]);
    expect(flags.autoRecoverStaleRuns).toBe(false);
    expect(flags.featureFlags.snapshot()).toMatchObject(SAFE_AGENT_FEATURE_FLAGS_FOR_TEST);
  });

  it("forces execution off and prevents stale-run recovery under --safe-agent without rewriting userData", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");
    await saveDesktopAgentFeatureFlagOverrides(overridePath, {
      agent_execution_v2_mode: "on",
      model_gateway_v2: true
    });
    const before = await fs.readFile(overridePath, "utf8");

    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter", AGENT_EXECUTION_V2_ON_ARGUMENT, SAFE_AGENT_ARGUMENT]);

    expect(flags.safeAgent).toBe(true);
    expect(flags.autoRecoverStaleRuns).toBe(false);
    expect(flags.featureFlags.snapshot()).toMatchObject({
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
    });
    expect(await fs.readFile(overridePath, "utf8")).toBe(before);
  });

  it("keeps the legacy explicit arguments compatible with the Preview profile", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");

    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter", AGENT_EXECUTION_V2_ON_ARGUMENT, AGENT_INLINE_PLAN_UI_ON_ARGUMENT]);

    expect(flags.safeAgent).toBe(false);
    expect(flags.autoRecoverStaleRuns).toBe(true);
    expect(flags.featureFlags.snapshot()).toMatchObject({ agent_execution_v2_mode: "on", agent_inline_plan_ui: true });
    await expect(fs.access(overridePath)).rejects.toThrow();
  });
});

const SAFE_AGENT_FEATURE_FLAGS_FOR_TEST = {
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
};

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-agent-flags-"));
  temporaryRoots.push(root);
  return root;
}
