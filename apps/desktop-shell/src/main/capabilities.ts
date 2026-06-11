import type { DesktopShellCapabilities } from "@xiaoshuo/shared";
import { probeLocalStateDriver } from "./local-state.js";

async function probePackage(packageName: string): Promise<{ available: boolean; reason?: string }> {
  try {
    await import(packageName);
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "Package could not be loaded"
    };
  }
}

export async function getShellCapabilities(): Promise<DesktopShellCapabilities> {
  const [terminal, localDatabase, downloads, contextMenu, monitoring, websocket] = await Promise.all([
    probePackage("node-pty"),
    probeLocalStateDriver(),
    probePackage("electron-dl"),
    probePackage("electron-context-menu"),
    probePackage("@sentry/electron"),
    probePackage("ws")
  ]);

  return {
    terminal: { ...terminal, package: "node-pty" },
    localDatabase,
    downloads: { ...downloads, package: "electron-dl" },
    contextMenu: { ...contextMenu, package: "electron-context-menu" },
    monitoring: { ...monitoring, package: "@sentry/electron" },
    websocket: { ...websocket, package: "ws" }
  };
}
