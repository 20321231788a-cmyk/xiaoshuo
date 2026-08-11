import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("RC eval harness receives the normalized case manifest path", async () => {
  const manifestPath = String(process.env.XIAOSHUO_EVAL_CASE_MANIFEST || "");
  if (!manifestPath) {
    return;
  }
  expect(path.isAbsolute(manifestPath)).toBe(true);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  expect(manifest).toMatchObject({
    schema_version: 1,
    dataset_id: "routing"
  });
});
