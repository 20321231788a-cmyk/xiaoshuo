import { describe, expect, it } from "vitest";
import { NovelUserGestureTicket, novelUserGestureAttribute } from "./novel-user-gesture-ticket.js";

function event(value: string, trusted = true) {
  return {
    isTrusted: trusted,
    composedPath: () => [{ getAttribute: (name: string) => name === novelUserGestureAttribute ? value : null }]
  } as unknown as Pick<Event, "isTrusted" | "composedPath">;
}

describe("NovelUserGestureTicket", () => {
  it("accepts only known action markers and consumes the matching action once", () => {
    const ticket = new NovelUserGestureTicket(() => 1_000, 500);
    expect(ticket.recordTrustedGesture(event("shell_execute"))).toBeNull();
    expect(ticket.recordTrustedGesture(event("transfer_commit"))).toBeNull();
    expect(ticket.recordTrustedGesture(event("install_tool"))).toBe("install_tool");
    expect(() => ticket.consume("typed_action")).toThrow();
    expect(() => ticket.consume("install_tool")).not.toThrow();
    expect(() => ticket.consume("install_tool")).toThrow();
  });

  it("ignores synthetic events and expires tickets", () => {
    let now = 1_000;
    const ticket = new NovelUserGestureTicket(() => now, 500);
    expect(ticket.recordTrustedGesture(event("memory_batch", false))).toBeNull();
    ticket.recordTrustedGesture(event("memory_batch"));
    now = 1_500;
    expect(() => ticket.consume("memory_batch")).toThrow();
  });
});
