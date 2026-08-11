import type { SkillDefinition } from "@xiaoshuo/shared";
import { describe, expect, it, vi } from "vitest";
import { automaticFeatures, saveAutomaticFeature } from "./automaticFeatures.js";

describe("automatic writing features", () => {
  it("saves through the shared config source", async () => {
    const patchAndSaveConfig = vi.fn().mockResolvedValue(true);
    await expect(saveAutomaticFeature({
      feature: automaticFeatures[0]!,
      enabled: true,
      skills: [],
      setSkillEnabled: vi.fn(),
      patchAndSaveConfig
    })).resolves.toBe(true);
    expect(patchAndSaveConfig).toHaveBeenCalledWith({ auto_lore_extract_enabled: true }, "自动提取明确设定已开启。");
  });

  it("restores an associated skill before enabling the config", async () => {
    const calls: string[] = [];
    const setSkillEnabled = vi.fn(async (_id: string, enabled: boolean) => { calls.push(`skill:${enabled}`); return true; });
    const patchAndSaveConfig = vi.fn(async () => { calls.push("config"); return true; });
    await saveAutomaticFeature({
      feature: automaticFeatures[1]!,
      enabled: true,
      skills: [{ id: "humanizer_zh", disabled: true } as SkillDefinition],
      setSkillEnabled,
      patchAndSaveConfig
    });
    expect(calls).toEqual(["skill:true", "config"]);
  });

  it("rolls the skill state back when config persistence fails", async () => {
    const setSkillEnabled = vi.fn().mockResolvedValue(true);
    await expect(saveAutomaticFeature({
      feature: automaticFeatures[2]!,
      enabled: true,
      skills: [{ id: "consistency_check", disabled: true } as SkillDefinition],
      setSkillEnabled,
      patchAndSaveConfig: vi.fn().mockResolvedValue(false)
    })).resolves.toBe(false);
    expect(setSkillEnabled).toHaveBeenNthCalledWith(1, "consistency_check", true);
    expect(setSkillEnabled).toHaveBeenNthCalledWith(2, "consistency_check", false);
  });

  it("does not expose an enabled state when the required skill cannot be restored", async () => {
    const patchAndSaveConfig = vi.fn();
    await expect(saveAutomaticFeature({
      feature: automaticFeatures[0]!,
      enabled: true,
      skills: [{ id: "lore_extract", disabled: true } as SkillDefinition],
      setSkillEnabled: vi.fn().mockResolvedValue(false),
      patchAndSaveConfig
    })).resolves.toBe(false);
    expect(patchAndSaveConfig).not.toHaveBeenCalled();
  });
});
