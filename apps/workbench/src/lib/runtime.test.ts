import { describe, expect, it } from "vitest";
import { resolveWorkbenchRuntime } from "./runtime.js";

describe("resolveWorkbenchRuntime", () => {
  it("defaults to the local runtime backend url", () => {
    expect(resolveWorkbenchRuntime("http://127.0.0.1:4173/")).toMatchObject({
      apiBase: "http://127.0.0.1:18453",
      isDesktopShell: false,
      launchMode: "browser"
    });
  });

  it("honors explicit api and desktop query params", () => {
    expect(resolveWorkbenchRuntime("http://127.0.0.1:4173/?api=http://localhost:9999&desktop=1")).toMatchObject({
      apiBase: "http://localhost:9999",
      isDesktopShell: true,
      launchMode: "desktop"
    });
  });

  it("detects desktop mode from the preload bridge", () => {
    expect(resolveWorkbenchRuntime("http://127.0.0.1:4173/", true)).toMatchObject({
      apiBase: "http://127.0.0.1:18453",
      isDesktopShell: true,
      launchMode: "desktop"
    });
  });
});
