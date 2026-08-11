import type { NovelUserGestureAction } from "@xiaoshuo/shared";

export const novelUserGestureRequiredCode = "NOVEL_USER_GESTURE_REQUIRED";

export type NovelRendererAuthorizationIdentity = Readonly<{
  webContentsId: number;
  browserWindowId: number;
  rendererUrl: string;
}>;

type Authorization = NovelRendererAuthorizationIdentity & {
  action: NovelUserGestureAction;
  expiresAt: number;
};

export class NovelUserGestureAuthorizationStore {
  private readonly authorizations = new Map<number, Authorization>();

  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs = 2_000) {}

  authorize(identity: NovelRendererAuthorizationIdentity, action: NovelUserGestureAction): void {
    this.authorizations.set(identity.webContentsId, { ...identity, action, expiresAt: this.now() + this.ttlMs });
  }

  consume(identity: NovelRendererAuthorizationIdentity, action: NovelUserGestureAction): void {
    const authorization = this.authorizations.get(identity.webContentsId);
    this.authorizations.delete(identity.webContentsId);
    if (!authorization) throw this.error("主进程未收到有效用户手势授权");
    if (authorization.browserWindowId !== identity.browserWindowId || authorization.rendererUrl !== identity.rendererUrl) {
      throw this.error("用户手势授权与窗口或页面不匹配");
    }
    if (authorization.action !== action) throw this.error("用户手势授权与小说操作不匹配");
    if (this.now() >= authorization.expiresAt) throw this.error("用户手势授权已过期");
  }

  revoke(webContentsId: number): void {
    this.authorizations.delete(webContentsId);
  }

  private error(message: string): Error {
    return Object.assign(new Error(`[${novelUserGestureRequiredCode}] ${message}`), { code: novelUserGestureRequiredCode });
  }
}
