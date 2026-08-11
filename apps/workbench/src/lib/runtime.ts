export type WorkbenchRuntime = {
  apiBase: string;
  isDesktopShell: boolean;
  launchMode: "desktop" | "browser";
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
  return resolveWorkbenchRuntime(window.location.href, Boolean(window.xiaoshuoDesktop));
}
