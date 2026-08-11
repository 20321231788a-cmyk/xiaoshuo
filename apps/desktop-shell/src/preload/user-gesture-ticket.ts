export const terminalUserGestureRequiredCode = "TERMINAL_USER_GESTURE_REQUIRED";
export const terminalUserGestureAttribute = "data-terminal-user-gesture";

type TrustedGestureEvent = Pick<Event, "isTrusted" | "composedPath">;

function hasTerminalGestureMarker(target: EventTarget): boolean {
  const candidate = target as EventTarget & {
    hasAttribute?: (name: string) => boolean;
  };
  return typeof candidate?.hasAttribute === "function" && candidate.hasAttribute(terminalUserGestureAttribute);
}

/**
 * A closure-owned, single-use lease. The renderer receives terminal methods
 * but never this object, so model content cannot mint a terminal permission.
 */
export class UserGestureTicket {
  private expiresAt = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 1_500
  ) {}

  recordTrustedGesture(event: TrustedGestureEvent): boolean {
    if (!event.isTrusted || !event.composedPath().some(hasTerminalGestureMarker)) {
      return false;
    }
    this.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  consume(): void {
    if (this.expiresAt === 0 || this.now() >= this.expiresAt) {
      throw Object.assign(new Error(`[${terminalUserGestureRequiredCode}] 拒绝创建终端：需要最近的真实用户手势`), {
        code: terminalUserGestureRequiredCode
      });
    }
    this.expiresAt = 0;
  }
}
