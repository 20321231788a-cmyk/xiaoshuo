import { describe, expect, it } from "vitest";
import { skillRunResponseRequiresConfirmation } from "./pending-confirmation.js";

describe("skillRunResponseRequiresConfirmation", () => {
  it("recognizes generated-cache and library-draft confirmations", () => {
    expect(skillRunResponseRequiresConfirmation({
      status: "done",
      result: "",
      saved_path: "",
      data: { pending_save: true }
    })).toBe(true);
    expect(skillRunResponseRequiresConfirmation({
      status: "done",
      result: "",
      saved_path: "",
      data: { library_draft: { draft_id: "draft-1", domain: "style" } }
    })).toBe(true);
  });

  it("preserves explicit false for informational results", () => {
    expect(skillRunResponseRequiresConfirmation({
      status: "done",
      result: "完成",
      saved_path: "",
      data: { requires_confirmation: false }
    })).toBe(false);
  });
});
