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
      return url.pathname === runtime.pathname;
    }

    if (!config.rendererUrl) {
      return false;
    }
    const renderer = new URL(config.rendererUrl);
    return url.origin === renderer.origin && url.pathname === renderer.pathname;
  } catch {
    return false;
  }
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
