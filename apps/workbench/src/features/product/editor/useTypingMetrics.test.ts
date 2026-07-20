import { describe, expect, it } from "vitest";
import { calculateTypingMetrics, typedCharacterCount } from "./useTypingMetrics.js";

describe("typing metrics", () => {
  it("counts direct keyboard text and line breaks", () => {
    expect(typedCharacterCount({ inputType: "insertText", data: "你好" }, "", "你好")).toBe(2);
    expect(typedCharacterCount({ inputType: "insertLineBreak" }, "你好", "你好\n")).toBe(1);
  });

  it("excludes composition updates, paste, undo and programmatic replacement", () => {
    expect(typedCharacterCount({ inputType: "insertCompositionText", isComposing: true, data: "你" }, "", "你")).toBe(0);
    expect(typedCharacterCount({ inputType: "insertFromPaste", data: "粘贴" }, "", "粘贴")).toBe(0);
    expect(typedCharacterCount({ inputType: "historyUndo" }, "你好", "你")).toBe(0);
    expect(typedCharacterCount({ inputType: "insertReplacementText", data: "替换" }, "旧", "替换")).toBe(0);
  });

  it("waits for five characters and five seconds before showing a speed", () => {
    expect(calculateTypingMetrics([{ at: 0, count: 4 }], 5_000).ready).toBe(false);
    expect(calculateTypingMetrics([{ at: 0, count: 5 }], 4_999).ready).toBe(false);
    expect(calculateTypingMetrics([{ at: 0, count: 5 }], 5_000)).toMatchObject({
      ready: true,
      realtimeCharsPerMinute: 60,
      averageCharsPerMinute: 60
    });
  });

  it("pauses realtime speed after thirty seconds without input", () => {
    const metrics = calculateTypingMetrics([{ at: 0, count: 5 }, { at: 5_000, count: 5 }], 35_000);
    expect(metrics.ready).toBe(true);
    expect(metrics.realtimeCharsPerMinute).toBe(0);
    expect(metrics.averageCharsPerMinute).toBeGreaterThan(0);
  });
});
