import { describe, expect, it } from "vitest";
import {
  skillDraftRequestSchema,
  skillPatchRequestSchema,
  skillRollbackRequestSchema,
  skillRunRequestSchema
} from "./skill.js";

describe("skill schemas", () => {
  it("applies draft request defaults", () => {
    const parsed = skillDraftRequestSchema.parse({});

    expect(parsed).toMatchObject({
      kind: "instruction",
      instruction: "",
      text: "",
      url: "",
      current_path: "",
      selection: "",
      attachment_ids: [],
      source_skill_id: "",
      target_name: "",
      target_id: ""
    });
  });

  it("supports dry-run patch defaults", () => {
    const parsed = skillPatchRequestSchema.parse({
      prompt: "新的提示词"
    });

    expect(parsed.prompt).toBe("新的提示词");
    expect(parsed.change_reason).toBe("");
    expect(parsed.expected_version).toBe("");
    expect(parsed.dry_run).toBe(false);
  });

  it("keeps old skill run payloads compatible with reference fields", () => {
    const parsed = skillRunRequestSchema.parse({
      text: "输入"
    });

    expect(parsed.reference_paths).toEqual([]);
    expect(parsed.confirmed_reference_paths).toEqual([]);
    expect(parsed.disable_auto_references).toBe(false);
  });

  it("defaults rollback change reason", () => {
    const parsed = skillRollbackRequestSchema.parse({
      version_id: "v1"
    });

    expect(parsed.change_reason).toBe("rollback");
  });
});
