import { describe, expect, it } from "vitest";
import { shouldSubmitAssistantMessage } from "./assistantComposerUtils.js";

const baseState = {
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  value: "继续写下一段",
  locked: false
};

describe("assistant composer keyboard behavior", () => {
  it("submits a non-empty message with Enter", () => {
    expect(shouldSubmitAssistantMessage(baseState)).toBe(true);
  });

  it("keeps Shift+Enter for a newline", () => {
    expect(shouldSubmitAssistantMessage({ ...baseState, shiftKey: true })).toBe(false);
  });

  it("does not submit during Chinese IME composition", () => {
    expect(shouldSubmitAssistantMessage({ ...baseState, isComposing: true })).toBe(false);
    expect(shouldSubmitAssistantMessage({ ...baseState, keyCode: 229 })).toBe(false);
  });

  it("does not submit empty or locked input", () => {
    expect(shouldSubmitAssistantMessage({ ...baseState, value: "  " })).toBe(false);
    expect(shouldSubmitAssistantMessage({ ...baseState, locked: true })).toBe(false);
  });
});
