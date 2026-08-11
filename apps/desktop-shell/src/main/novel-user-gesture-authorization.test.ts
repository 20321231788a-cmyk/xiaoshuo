import { describe, expect, it } from "vitest";
import { NovelUserGestureAuthorizationStore } from "./novel-user-gesture-authorization.js";

const owner = { webContentsId: 7, browserWindowId: 3, rendererUrl: "file:///workbench/index.html" };

describe("NovelUserGestureAuthorizationStore", () => {
  it("binds a single-use authorization to renderer and action", () => {
    const store = new NovelUserGestureAuthorizationStore(() => 1_000, 500);
    store.authorize(owner, "install_tool");
    expect(() => store.consume(owner, "typed_action")).toThrowError(expect.objectContaining({ code: "NOVEL_USER_GESTURE_REQUIRED" }));
    expect(() => store.consume(owner, "install_tool")).toThrowError(expect.objectContaining({ code: "NOVEL_USER_GESTURE_REQUIRED" }));
    store.authorize(owner, "install_tool");
    expect(() => store.consume(owner, "install_tool")).not.toThrow();
    expect(() => store.consume(owner, "install_tool")).toThrow();
  });

  it("rejects expired, navigated, and other-renderer tickets", () => {
    let now = 1_000;
    const store = new NovelUserGestureAuthorizationStore(() => now, 500);
    store.authorize(owner, "memory_batch");
    now = 1_500;
    expect(() => store.consume(owner, "memory_batch")).toThrow();
    store.authorize(owner, "transfer_source_confirm");
    expect(() => store.consume({ ...owner, rendererUrl: "file:///other.html" }, "transfer_source_confirm")).toThrow();
    store.authorize(owner, "transfer_target_confirm");
    expect(() => store.consume(owner, "transfer_target_confirm")).not.toThrow();
  });
});
