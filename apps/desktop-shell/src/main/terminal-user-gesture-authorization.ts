export const terminalUserGestureRequiredCode = "TERMINAL_USER_GESTURE_REQUIRED";

export type TerminalRendererAuthorizationIdentity = Readonly<{
  webContentsId: number;
  browserWindowId: number;
  rendererUrl: string;
}>;

type TerminalUserGestureAuthorization = TerminalRendererAuthorizationIdentity & {
  expiresAt: number;
};

export class TerminalUserGestureAuthorizationError extends Error {
  readonly code = terminalUserGestureRequiredCode;

  constructor(message: string) {
    super(`[${terminalUserGestureRequiredCode}] ${message}`);
    this.name = "TerminalUserGestureAuthorizationError";
  }
}

/** Main-process, renderer-bound, single-use terminal authorization. */
export class TerminalUserGestureAuthorizationStore {
  private readonly authorizations = new Map<number, TerminalUserGestureAuthorization>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 1_500
  ) {}

  authorize(identity: TerminalRendererAuthorizationIdentity): void {
    this.authorizations.set(identity.webContentsId, {
      ...identity,
      expiresAt: this.now() + this.ttlMs
    });
  }

  consume(identity: TerminalRendererAuthorizationIdentity): void {
    const authorization = this.authorizations.get(identity.webContentsId);
    if (!authorization) {
      throw new TerminalUserGestureAuthorizationError("拒绝创建终端：主进程未收到有效用户手势授权");
    }

    // Delete before validation so a same-renderer mismatch or expiry can never
    // be replayed. JavaScript execution in the main process makes this atomic.
    this.authorizations.delete(identity.webContentsId);
    if (
      authorization.browserWindowId !== identity.browserWindowId
      || authorization.rendererUrl !== identity.rendererUrl
    ) {
      throw new TerminalUserGestureAuthorizationError("拒绝创建终端：用户手势授权与窗口或页面不匹配");
    }
    if (this.now() >= authorization.expiresAt) {
      throw new TerminalUserGestureAuthorizationError("拒绝创建终端：主进程用户手势授权已过期");
    }
  }

  revoke(webContentsId: number): void {
    this.authorizations.delete(webContentsId);
  }
}
