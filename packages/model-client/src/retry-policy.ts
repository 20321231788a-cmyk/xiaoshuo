export type RetryOptions = {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

export class ModelRetryPolicy {
  static isRetryableStatus(status: number): boolean {
    return [408, 429, 502, 503, 504].includes(status);
  }

  static isRetryableError(error: unknown): boolean {
    if (!error) return false;
    const message = error instanceof Error ? error.message : String(error);
    
    if (this.isAbortError(error)) {
      return false;
    }

    const statusMatch = message.match(/status:?\s*(\d+)/i) || message.match(/code:?\s*(\d+)/i) || message.match(/(\d{3})/);
    if (statusMatch && statusMatch[1]) {
      const status = parseInt(statusMatch[1], 10);
      if (this.isRetryableStatus(status)) {
        return true;
      }
      if ([400, 401, 403].includes(status)) {
        return false;
      }
    }

    const lowered = message.toLowerCase();
    if (
      lowered.includes("rate limit") ||
      lowered.includes("too many requests") ||
      lowered.includes("timeout") ||
      lowered.includes("502") ||
      lowered.includes("503") ||
      lowered.includes("504") ||
      lowered.includes("gateway") ||
      lowered.includes("bad gateway") ||
      lowered.includes("connect") ||
      lowered.includes("refused")
    ) {
      return true;
    }

    return false;
  }

  static isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const err = error as { name?: string; code?: string; message?: string };
    return (
      err.name === "AbortError" ||
      err.code === "ABORT_ERR" ||
      String(err.message || "").toLowerCase().includes("aborted")
    );
  }

  static isStreamUnsupportedError(error: unknown): boolean {
    if (!error) return false;
    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    return (
      lowered.includes("stream") &&
      (lowered.includes("not support") ||
        lowered.includes("unsupported") ||
        lowered.includes("not implemented") ||
        lowered.includes("invalid parameter") ||
        lowered.includes("unknown parameter"))
    );
  }

  static async executeWithRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions = {}
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const initialDelayMs = options.initialDelayMs ?? 1000;
    const maxDelayMs = options.maxDelayMs ?? 10000;
    const factor = options.factor ?? 2;
    const signal = options.signal;

    let attempt = 0;
    while (true) {
      if (signal?.aborted) {
        throw this.createAbortError();
      }
      try {
        return await fn(attempt + 1);
      } catch (error) {
        attempt++;
        if (attempt > maxRetries || !this.isRetryableError(error) || signal?.aborted) {
          throw error;
        }

        const delay = Math.min(initialDelayMs * Math.pow(factor, attempt - 1), maxDelayMs);
        const jitter = Math.random() * 200;
        const finalDelay = delay + jitter;

        if (options.onRetry) {
          options.onRetry(error, attempt, finalDelay);
        }

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, finalDelay);
          if (signal) {
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(this.createAbortError());
            }, { once: true });
          }
        });
      }
    }
  }

  private static createAbortError(): Error {
    const error = new Error("操作已取消");
    error.name = "AbortError";
    return error;
  }
}
