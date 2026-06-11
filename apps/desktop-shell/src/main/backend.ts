import { existsSync } from "node:fs";
import path from "node:path";

export function resolveProjectRoot(appPath: string): string {
  let current = path.resolve(appPath);

  for (let index = 0; index < 8; index += 1) {
    if (existsSync(path.join(current, "packages", "shared"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.resolve(appPath, "..", "..", "..");
}
