import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rcCaseHash, sha256 } from "./eval-evidence-contract.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(rootDir, "scripts", "run-rc-evals.mjs");

async function writeJson(target, value) {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("RC eval dispatcher binds a declared Vitest runner to its case manifest", async () => {
  const fixtureRoot = path.join(rootDir, "output", `run-rc-evals-test-${process.pid}-${Date.now()}`);
  const generatedTestPath = path.join(rootDir, "scripts", "fixtures", `run-rc-evals-${process.pid}-${Date.now()}.test.mjs`);
  const datasetRoot = path.join(fixtureRoot, "dataset");
  const outputRoot = path.join(fixtureRoot, "results");
  await fs.mkdir(datasetRoot, { recursive: true });
  try {
    const datasetId = "dispatcher_contract";
    const datasetVersion = "dispatcher-test-v1";
    const caseId = "dispatcher case passes";
    const contentHash = "a".repeat(64);
    const caseManifestPath = path.join(datasetRoot, "cases.json");
    await writeJson(caseManifestPath, {
      schema_version: 1,
      dataset_id: datasetId,
      dataset_version: datasetVersion,
      cases: [{
        case_id: caseId,
        content_hash: contentHash,
        expected_hash: "",
        partition: "sealed_holdout",
        project_group: "dispatcher-project"
      }]
    });
    const caseManifestHash = sha256(await fs.readFile(caseManifestPath));
    const datasetManifestPath = path.join(datasetRoot, "rc-dataset-manifest.json");
    await writeJson(datasetManifestPath, {
      schema_version: 2,
      dataset_version: datasetVersion,
      datasets: [{
        id: datasetId,
        eval_name: "dispatcher-contract",
        case_manifest_path: "cases.json",
        case_manifest_sha256: caseManifestHash
      }]
    });
    const testFile = path.relative(rootDir, generatedTestPath).replace(/\\/g, "/");
    await fs.mkdir(path.dirname(generatedTestPath), { recursive: true });
    await fs.writeFile(generatedTestPath, [
      'import { expect, test } from "vitest";',
      `test(${JSON.stringify(caseId)}, () => expect(true).toBe(true));`,
      ""
    ].join("\n"), "utf8");
    const runnerManifestPath = path.join(datasetRoot, "rc-runner-manifest.json");
    await writeJson(runnerManifestPath, {
      schema_version: 1,
      datasets: [{ id: datasetId, eval_name: "dispatcher-contract", test_files: [testFile] }]
    });

    const result = spawnSync(process.execPath, [
      runnerPath,
      "--dataset-manifest", datasetManifestPath,
      "--runner-manifest", runnerManifestPath,
      "--output-root", outputRoot
    ], { cwd: rootDir, encoding: "utf8", env: process.env });
    const debugManifest = await fs.readFile(path.join(outputRoot, "dispatcher-contract", "manifest.json"), "utf8").catch(() => "<missing manifest>");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${debugManifest}`);
    const manifest = JSON.parse(await fs.readFile(path.join(outputRoot, "dispatcher-contract", "manifest.json"), "utf8"));
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.dataset_id, datasetId);
    assert.equal(manifest.dataset_hash, caseManifestHash);
    assert.deepEqual(manifest.cases.map(({ case_id, case_hash }) => ({ case_id, case_hash })), [{
      case_id: caseId,
      case_hash: rcCaseHash({
        datasetId,
        datasetVersion,
        caseId,
        contentHash,
        expectedHash: "",
        partition: "sealed_holdout",
        projectGroup: "dispatcher-project"
      })
    }]);
  } finally {
    await fs.rm(generatedTestPath, { force: true });
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
