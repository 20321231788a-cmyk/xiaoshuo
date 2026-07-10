import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeExternalUrl, isTrustedRendererUrl } from "./renderer-security.js";

const config = {
  runtimeUrl: "http://127.0.0.1:4312/",
  rendererUrl: "http://localhost:5173/",
  packagedWorkbenchIndex: path.resolve("C:/ArcWriter/resources/workbench/index.html")
};

describe("renderer security", () => {
  it("only trusts the configured renderer entry points", () => {
    expect(isTrustedRendererUrl("http://127.0.0.1:4312/?desktop=1", config)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5173/?desktop=1", config)).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:4312/api/agent/runs", config)).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:5173/untrusted.html", config)).toBe(false);
  });

  it("does not grant trust to arbitrary file URLs", () => {
    expect(isTrustedRendererUrl("file:///C:/ArcWriter/resources/workbench/index.html", config)).toBe(true);
    expect(isTrustedRendererUrl("file:///C:/Users/Administrator/Downloads/attack.html", config)).toBe(false);
  });

  it("only opens web links externally", () => {
    expect(isSafeExternalUrl("https://example.com/docs")).toBe(true);
    expect(isSafeExternalUrl("file:///C:/Windows/System32/cmd.exe")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
