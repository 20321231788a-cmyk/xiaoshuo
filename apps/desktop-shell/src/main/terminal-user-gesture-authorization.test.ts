import { describe, expect, it } from "vitest";
import {
  terminalUserGestureRequiredCode,
  TerminalUserGestureAuthorizationStore,
  type TerminalRendererAuthorizationIdentity
} from "./terminal-user-gesture-authorization.js";

const owner = identity(101, 1, "file:///trusted/workbench/index.html");
const otherRenderer = identity(202, 2, "file:///trusted/workbench/index.html");

describe("TerminalUserGestureAuthorizationStore", () => {
  it("requires authorization and consumes it exactly once", () => {
    const store = new TerminalUserGestureAuthorizationStore(() => 1_000, 500);

    expectRequired(() => store.consume(owner));
    store.authorize(owner);
    expect(() => store.consume(owner)).not.toThrow();
    expectRequired(() => store.consume(owner));
  });

  it("binds authorization to the creating renderer without stealing another renderer's authorization", () => {
    const store = new TerminalUserGestureAuthorizationStore(() => 1_000, 500);
    store.authorize(owner);

    expectRequired(() => store.consume(otherRenderer));
    expect(() => store.consume(owner)).not.toThrow();
  });

  it("rejects and consumes an authorization after a window or renderer URL change", () => {
    const store = new TerminalUserGestureAuthorizationStore(() => 1_000, 500);
    store.authorize(owner);

    expectRequired(() => store.consume({ ...owner, browserWindowId: 9 }));
    expectRequired(() => store.consume(owner));

    store.authorize(owner);
    expectRequired(() => store.consume({ ...owner, rendererUrl: "file:///trusted/workbench/other.html" }));
    expectRequired(() => store.consume(owner));
  });

  it("rejects an expired authorization", () => {
    let now = 1_000;
    const store = new TerminalUserGestureAuthorizationStore(() => now, 500);
    store.authorize(owner);
    now = 1_500;

    expectRequired(() => store.consume(owner));
  });

  it("revokes pending authorization when its webContents is closed or navigated", () => {
    const store = new TerminalUserGestureAuthorizationStore(() => 1_000, 500);
    store.authorize(owner);

    store.revoke(owner.webContentsId);
    expectRequired(() => store.consume(owner));
  });
});

function identity(webContentsId: number, browserWindowId: number, rendererUrl: string): TerminalRendererAuthorizationIdentity {
  return { webContentsId, browserWindowId, rendererUrl };
}

function expectRequired(invoke: () => void): void {
  expect(invoke).toThrow(expect.objectContaining({ code: terminalUserGestureRequiredCode }));
}
