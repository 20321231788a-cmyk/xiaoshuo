import { describe, expect, it } from "vitest";
import {
  terminalUserGestureAttribute,
  terminalUserGestureRequiredCode,
  UserGestureTicket
} from "./user-gesture-ticket.js";

function gesture({ trusted = true, marked = true }: { trusted?: boolean; marked?: boolean } = {}) {
  const target: EventTarget & { hasAttribute: (name: string) => boolean } = {
    addEventListener: () => undefined,
    dispatchEvent: () => true,
    hasAttribute: (name: string) => marked && name === terminalUserGestureAttribute,
    removeEventListener: () => undefined
  };
  return {
    isTrusted: trusted,
    composedPath: () => [target]
  } satisfies Pick<Event, "isTrusted" | "composedPath">;
}

function expectGestureRequired(invoke: () => void) {
  try {
    invoke();
    throw new Error("Expected a user-gesture rejection");
  } catch (error) {
    expect(error).toMatchObject({ code: terminalUserGestureRequiredCode });
  }
}

describe("UserGestureTicket", () => {
  it("requires a fresh gesture and consumes it exactly once", () => {
    let now = 1_000;
    const ticket = new UserGestureTicket(() => now, 500);

    expectGestureRequired(() => ticket.consume());
    expect(ticket.recordTrustedGesture(gesture())).toBe(true);
    ticket.consume();
    expectGestureRequired(() => ticket.consume());
  });

  it("ignores trusted gestures outside the dedicated terminal control", () => {
    const ticket = new UserGestureTicket(() => 1_000, 500);

    expect(ticket.recordTrustedGesture(gesture({ marked: false }))).toBe(false);
    expectGestureRequired(() => ticket.consume());
  });

  it("ignores synthetic gestures even when their path contains the marker", () => {
    const ticket = new UserGestureTicket(() => 1_000, 500);

    expect(ticket.recordTrustedGesture(gesture({ trusted: false }))).toBe(false);
    expectGestureRequired(() => ticket.consume());
  });

  it("rejects an expired gesture", () => {
    let now = 1_000;
    const ticket = new UserGestureTicket(() => now, 500);
    ticket.recordTrustedGesture(gesture());
    now = 1_500;

    expectGestureRequired(() => ticket.consume());
  });
});
