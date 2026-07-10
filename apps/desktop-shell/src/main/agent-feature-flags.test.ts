import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAFE_AGENT_ARGUMENT,
  loadDesktopAgentFeatureFlags,
  saveDesktopAgentFeatureFlagOverrides
} from "./agent-feature-flags.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("desktop agent feature flag overrides", () => {
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
      model_gateway_v2: true
    });
  });

  it("rejects unknown or invalid values and fails closed for malformed userData", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");

    await expect(saveDesktopAgentFeatureFlagOverrides(overridePath, { runtime_session_auth: false })).rejects.toThrow();
    await expect(saveDesktopAgentFeatureFlagOverrides(overridePath, { agent_execution_v2_mode: "unsafe" })).rejects.toThrow();
    await fs.mkdir(path.dirname(overridePath), { recursive: true });
    await fs.writeFile(overridePath, '{"agent_execution_v2_mode":"on","runtime_session_auth":false}', "utf8");

    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter"]);
    expect(flags.featureFlags.snapshot().agent_execution_v2_mode).toBe("off");
  });

  it("forces execution off and prevents stale-run recovery under --safe-agent without rewriting userData", async () => {
    const overridePath = path.join(await temporaryRoot(), "state", "agent-feature-flags.json");
    await saveDesktopAgentFeatureFlagOverrides(overridePath, {
      agent_execution_v2_mode: "on",
      model_gateway_v2: true
    });
    const before = await fs.readFile(overridePath, "utf8");

    const flags = await loadDesktopAgentFeatureFlags(overridePath, ["arcwriter", SAFE_AGENT_ARGUMENT]);

    expect(flags.safeAgent).toBe(true);
    expect(flags.autoRecoverStaleRuns).toBe(false);
    expect(flags.featureFlags.snapshot()).toMatchObject({
      agent_execution_v2_mode: "off",
      model_gateway_v2: false
    });
    expect(await fs.readFile(overridePath, "utf8")).toBe(before);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-agent-flags-"));
  temporaryRoots.push(root);
  return root;
}
