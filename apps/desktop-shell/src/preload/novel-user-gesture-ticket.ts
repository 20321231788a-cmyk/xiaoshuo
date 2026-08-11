import { novelUserGestureActionSchema, type NovelUserGestureAction } from "@xiaoshuo/shared";

export const novelUserGestureAttribute = "data-novel-user-gesture";

type TrustedGestureEvent = Pick<Event, "isTrusted" | "composedPath">;

export class NovelUserGestureTicket {
  private action: NovelUserGestureAction | null = null;
  private expiresAt = 0;

  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs = 2_000) {}

  recordTrustedGesture(event: TrustedGestureEvent): NovelUserGestureAction | null {
    if (!event.isTrusted) return null;
    for (const target of event.composedPath()) {
      const candidate = target as EventTarget & { getAttribute?: (name: string) => string | null };
      const value = candidate.getAttribute?.(novelUserGestureAttribute);
      const parsed = novelUserGestureActionSchema.safeParse(value);
      if (!parsed.success) continue;
      this.action = parsed.data;
      this.expiresAt = this.now() + this.ttlMs;
      return parsed.data;
    }
    return null;
  }

  consume(action: NovelUserGestureAction): void {
    if (this.action !== action || !this.expiresAt || this.now() >= this.expiresAt) {
      throw Object.assign(new Error("[NOVEL_USER_GESTURE_REQUIRED] 该小说操作需要最近的真实用户手势"), { code: "NOVEL_USER_GESTURE_REQUIRED" });
    }
    this.action = null;
    this.expiresAt = 0;
  }
}
