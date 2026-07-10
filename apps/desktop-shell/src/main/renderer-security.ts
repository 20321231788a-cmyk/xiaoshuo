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
      return path.resolve(fileURLToPath(url)) === path.resolve(config.packagedWorkbenchIndex);
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

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
