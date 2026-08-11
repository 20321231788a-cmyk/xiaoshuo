import { describe, expect, it } from "vitest";
import { assembleContext, getContextBudget } from "./context-assembler.js";

describe("ContextAssembler", () => {
  it("keeps critical and high blocks before dropping low-priority overflow", () => {
    const result = assembleContext(
      [
        { id: "critical", title: "Critical", source: "runtime", priority: "critical", content: "123456" },
        { id: "low", title: "Low", source: "web", priority: "low", content: "abcdef" },
        { id: "high", title: "High", source: "project", priority: "high", content: "XYZ" }
      ],
      { budget: 9, separator: "" }
    );

    expect(result.text).toBe("123456XYZ");
    expect(result.blocks.find((block) => block.id === "critical")).toMatchObject({ included: true, includedChars: 6 });
    expect(result.blocks.find((block) => block.id === "high")).toMatchObject({ included: true, includedChars: 3 });
    expect(result.blocks.find((block) => block.id === "low")).toMatchObject({ included: false, includedChars: 0 });
  });

  it("clips critical blocks instead of dropping them", () => {
    const result = assembleContext(
      [{ id: "critical", title: "Critical", source: "runtime", priority: "critical", content: "1234567890" }],
      { budget: 4, separator: "" }
    );

    expect(result.text).toBe("1234");
    expect(result.blocks[0]).toMatchObject({ included: true, originalChars: 10, includedChars: 4 });
    expect(result.truncated).toBe(true);
  });

  it("applies per-block maxChars before global budget", () => {
    const result = assembleContext(
      [{ id: "doc", title: "Document", source: "document", priority: "high", content: "abcdefghij", maxChars: 5 }],
      { budget: 10, separator: "" }
    );

    expect(result.text).toBe("abcde");
    expect(result.blocks[0]).toMatchObject({ originalChars: 10, includedChars: 5 });
  });

  it("uses the compact retry budget", () => {
    const result = assembleContext(
      [{ id: "compact", title: "Compact", source: "runtime", priority: "critical", content: "x".repeat(20_000) }],
      { mode: "compact_retry", separator: "" }
    );

    expect(getContextBudget("compact_retry")).toBe(14_000);
    expect(result.text).toHaveLength(14_000);
    expect(result.blocks[0]?.includedChars).toBe(14_000);
  });
});
