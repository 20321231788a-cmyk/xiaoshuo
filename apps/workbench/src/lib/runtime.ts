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
    if (init?.signal?.aborted) {
      throw init.signal.reason || new DOMException("The operation was aborted", "AbortError");
    }
    const request = new Request(input, init);
    const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
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
