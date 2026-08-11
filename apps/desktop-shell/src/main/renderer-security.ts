import path from "node:path";
import { fileURLToPath } from "node:url";

export type RendererTrustConfig = {
  runtimeUrl: string;
  rendererUrl?: string;
  packagedWorkbenchIndex: string;
};

export function isTrustedRendererUrl(value: string, config: RendererTrustConfig): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      const requestedPath = path.resolve(fileURLToPath(url));
      return trustedFileEntrypoints(config).some((entrypoint) => requestedPath === entrypoint);
    }

    const runtime = new URL(config.runtimeUrl);
    if (url.origin === runtime.origin) {
      return isTrustedWorkbenchPath(url.pathname, runtime.pathname);
    }

    if (!config.rendererUrl) {
      return false;
    }
    const renderer = new URL(config.rendererUrl);
    return url.origin === renderer.origin && isTrustedWorkbenchPath(url.pathname, renderer.pathname);
  } catch {
    return false;
  }
}

const PRODUCT_PATHS = new Set([
  "/home",
  "/editor",
  "/assistant",
  "/outline",
  "/clues",
  "/sources",
  "/style",
  "/studio",
  "/review",
  "/memory",
  "/disassembly",
  "/batch",
  "/transfer",
  "/tools",
  "/tasks"
]);

function isTrustedWorkbenchPath(pathname: string, entrypoint: string): boolean {
  if (pathname === entrypoint) return true;
  if (entrypoint !== "/" && entrypoint !== "/index.html") return false;
  if (PRODUCT_PATHS.has(pathname)) return true;
  if (pathname === "/tools/import") return true;
  if (/^\/settings\/(?:ai|writing|backup|privacy|shortcuts|about)$/.test(pathname)) return true;
  return /^\/tools\/skills\/[^/]+(?:\/(?:edit|versions))?$/.test(pathname);
}

function trustedFileEntrypoints(config: RendererTrustConfig): string[] {
  const entrypoints = [path.resolve(config.packagedWorkbenchIndex)];
  if (!config.rendererUrl) {
    return entrypoints;
  }
  try {
    const renderer = new URL(config.rendererUrl);
    if (renderer.protocol === "file:") {
      entrypoints.push(path.resolve(fileURLToPath(renderer)));
    }
  } catch {
    // Invalid development renderer URLs are never trusted.
  }
  return [...new Set(entrypoints)];
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
