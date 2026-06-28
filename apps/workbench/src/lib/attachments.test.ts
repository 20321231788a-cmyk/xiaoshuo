import { describe, expect, it } from "vitest";
import { attachmentDisplayName } from "./attachments.js";

describe("attachments", () => {
  it("shows the first four unicode characters from the filename stem", () => {
    expect(attachmentDisplayName("同档格罗主模板.md")).toBe("同档格罗");
  });

  it("keeps short names and strips extensions", () => {
    expect(attachmentDisplayName("设定.txt")).toBe("设定");
    expect(attachmentDisplayName("archive")).toBe("arch");
  });
});
