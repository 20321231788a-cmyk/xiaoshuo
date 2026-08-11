export type AgentRunOptions = {
  signal?: AbortSignal;
  requiresConfirmation?: boolean;
};

export class AgentCancellationError extends Error {
  constructor(message = "操作已取消") {
    super(message);
    this.name = "AbortError";
  }
}

export function createCancellationError(message?: string): AgentCancellationError {
  return new AgentCancellationError(message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createCancellationError();
  }
}

export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const named = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = String(named.name || "");
  const code = String(named.code || "");
  const message = String(named.message || "").toLowerCase();
  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    message.includes("aborted") ||
    message.includes("aborterror") ||
    message.includes("操作已取消") ||
    message.includes("客户端已断开连接")
  );
}
