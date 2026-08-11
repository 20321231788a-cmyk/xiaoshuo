export type WorkbenchRuntime = {
  apiBase: string;
  isDesktopShell: boolean;
  launchMode: "desktop" | "browser";
  fetchFn?: typeof fetch;
};

export function resolveWorkbenchRuntime(href = "http://127.0.0.1:4173/", hasDesktopBridge = false): WorkbenchRuntime {
  const url = new URL(href);
  const apiBase = url.searchParams.get("api") || "http://127.0.0.1:18453";
  const isLocalBackendPage = url.hostname === "127.0.0.1" && url.port === "18453";
  const isDesktopShell = hasDesktopBridge || url.searchParams.get("desktop") === "1" || isLocalBackendPage;

  return {
    apiBase,
    isDesktopShell,
    launchMode: isDesktopShell ? "desktop" : "browser"
  };
}

export function readWorkbenchRuntime(): WorkbenchRuntime {
  const runtime = resolveWorkbenchRuntime(window.location.href, Boolean(window.xiaoshuoDesktop));
  return window.xiaoshuoDesktop && runtime.isDesktopShell
    ? { ...runtime, fetchFn: createDesktopRuntimeFetch() }
    : runtime;
}

function createDesktopRuntimeFetch(): typeof fetch {
  return async (input, init) => {
    if (!window.xiaoshuoDesktop) {
      throw new Error("桌面运行时桥接不可用");
    }
    const request = new Request(input, init);
    if (request.signal.aborted) {
      throw request.signal.reason || createAbortError();
    }
    const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
    if (acceptsStream(request)) {
      return createDesktopRuntimeStreamResponse(window.xiaoshuoDesktop, request, body);
    }
    const result = await window.xiaoshuoDesktop.runtimeRequest({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body
    });
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    });
  };
}

async function createDesktopRuntimeStreamResponse(
  desktop: NonNullable<Window["xiaoshuoDesktop"]>,
  request: Request,
  body: Uint8Array | null
): Promise<Response> {
  const requestId = createRuntimeRequestId();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settled = false;
  let streamError: unknown = null;
  let unsubscribe = () => {};
  let abortHandler = () => {};

  const cleanup = () => {
    unsubscribe();
    request.signal.removeEventListener("abort", abortHandler);
  };
  const close = () => {
    if (settled) return;
    settled = true;
    streamController?.close();
    cleanup();
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    streamError = error;
    streamController?.error(error);
    cleanup();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      desktop.runtimeStream.cancel(requestId);
      settled = true;
      cleanup();
    }
  });

  unsubscribe = desktop.runtimeStream.onEvent((event) => {
    if (event.request_id !== requestId || settled) return;
    if (event.type === "chunk") {
      streamController?.enqueue(event.body);
      return;
    }
    if (event.type === "error") {
      fail(new Error(event.error));
      return;
    }
    close();
  });
  abortHandler = () => {
    desktop.runtimeStream.cancel(requestId);
    fail(request.signal.reason || createAbortError());
  };
  request.signal.addEventListener("abort", abortHandler, { once: true });

  try {
    const result = await desktop.runtimeStream.start({
      request_id: requestId,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body ? new Uint8Array(body) : null
    });
    if (streamError) throw streamError;
    if (request.signal.aborted) throw request.signal.reason || createAbortError();
    return new Response(stream, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    });
  } catch (error) {
    fail(error);
    throw error;
  }
}

function acceptsStream(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return /application\/x-ndjson|text\/event-stream/i.test(accept);
}

function createRuntimeRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
