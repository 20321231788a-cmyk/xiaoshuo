import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CASE_MANIFEST_SCHEMA_VERSION,
  RC_CASE_HASH_ALGORITHM,
  RC_DATASET_HASH_ALGORITHM,
  RC_DATASET_MANIFEST_SCHEMA_VERSION,
  parseCaseManifestBytes,
  rcCaseHash,
  sha256
} from "./eval-evidence-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_SCRIPT = path.join(ROOT, "scripts", "verify-rc-eval-evidence.mjs");
const RUN_EVAL_SCRIPT = path.join(ROOT, "scripts", "run-eval.mjs");
const SOURCE_COMMIT = "a".repeat(40);
const DATASET_VERSION = "rc-contract-test-v1";
const REQUIREMENTS = Object.freeze([
  ["routing", 150],
  ["skill_selection", 120],
  ["file_references", 100],
  ["planning", 80],
  ["replanning", 50],
  ["memory", 60],
  ["canon_conflict", 60],
  ["save_safety", 60],
  ["strict_format", 50],
  ["recovery", 30],
  ["author_e2e", 50],
  ["context_citation", 80],
  ["canon_timeline_perspective", 60]
]);
const ROUTING_CASE_IDS = Object.freeze([
  "P4 agent routing eval keeps routing accuracy above the eval threshold",
  "P4 agent routing eval keeps skill selection accuracy above the eval threshold",
  "P4 agent routing eval only enables web search for explicit material-search requests",
  "P4 context assembly eval matches context fixture expectations"
]);

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

describe("eval evidence hash contract", () => {
  it("binds a case hash to its dataset identity and version", () => {
    const base = {
      caseId: "case-1",
      contentHash: sha256("content"),
      expectedHash: sha256("expected"),
      partition: "train",
      projectGroup: "project-1"
    };
    const first = rcCaseHash({ ...base, datasetId: "routing", datasetVersion: "v1" });
    const changedDataset = rcCaseHash({ ...base, datasetId: "memory", datasetVersion: "v1" });
    const changedVersion = rcCaseHash({ ...base, datasetId: "routing", datasetVersion: "v2" });

    expect(first).not.toBe(changedDataset);
    expect(first).not.toBe(changedVersion);
  });

  it("makes run-eval emit the same RC dataset and case hashes", async () => {
    const directory = await makeTemporaryDirectory();
    const caseManifestPath = path.join(directory, "routing-cases.json");
    const outputRoot = path.join(directory, "output");
    const document = makeCaseManifest("routing", ROUTING_CASE_IDS.length, ROUTING_CASE_IDS);
    const bytes = await writeJson(caseManifestPath, document);
    const normalized = parseCaseManifestBytes(bytes);

    const result = await runNode([
      RUN_EVAL_SCRIPT,
      "rc-routing",
      "--case-manifest",
      caseManifestPath,
      "packages/agent-runtime/src/routing-eval.test.ts"
    ], {
      GITHUB_SHA: SOURCE_COMMIT,
      XIAOSHUO_EVAL_CASE_MANIFEST: "",
      XIAOSHUO_EVAL_OUTPUT_DIR: outputRoot
    });
    expect(result.code, result.stderr || result.stdout).toBe(0);

    const manifest = await readJson(path.join(outputRoot, "rc-routing", "manifest.json"));
    expect(manifest).toMatchObject({
      manifest_schema_version: 1,
      eval_name: "rc-routing",
      dataset_id: "routing",
      dataset_version: DATASET_VERSION,
      dataset_hash: sha256(bytes),
      dataset_hash_algorithm: RC_DATASET_HASH_ALGORITHM,
      case_manifest_schema_version: CASE_MANIFEST_SCHEMA_VERSION,
      case_hash_algorithm: RC_CASE_HASH_ALGORITHM,
      code_commit: SOURCE_COMMIT,
      status: "passed"
    });
    expect(manifest.cases.map(({ case_id, case_hash }) => ({ case_id, case_hash }))).toEqual(
      normalized.cases.map(({ case_id, case_hash }) => ({ case_id, case_hash }))
    );
  }, 30_000);

  it("makes run-eval fail when observed tests do not match the bound case manifest", async () => {
    const directory = await makeTemporaryDirectory();
    const caseManifestPath = path.join(directory, "routing-cases.json");
    const outputRoot = path.join(directory, "output");
    const document = makeCaseManifest("routing", ROUTING_CASE_IDS.length, ROUTING_CASE_IDS);
    document.cases[0].case_id = "forged-case-id";
    await writeJson(caseManifestPath, document);

    const result = await runNode([
      RUN_EVAL_SCRIPT,
      "rc-routing-mismatch",
      "--case-manifest",
      caseManifestPath,
      "packages/agent-runtime/src/routing-eval.test.ts"
    ], {
      GITHUB_SHA: SOURCE_COMMIT,
      XIAOSHUO_EVAL_CASE_MANIFEST: "",
      XIAOSHUO_EVAL_OUTPUT_DIR: outputRoot
    });
    expect(result.code).toBe(1);

    const manifest = await readJson(path.join(outputRoot, "rc-routing-mismatch", "manifest.json"));
    expect(manifest.status).toBe("failed");
    expect(manifest.failure_cases.map((entry) => entry.failure)).toEqual(expect.arrayContaining([
      expect.stringContaining("Observed case is absent from the bound case manifest"),
      expect.stringContaining("Bound case was not emitted by Vitest: forged-case-id")
    ]));
  }, 30_000);

  it("passes the normalized case manifest path to the RC eval harness", async () => {
    const directory = await makeTemporaryDirectory();
    const caseManifestPath = path.join(directory, "routing-cases.json");
    const outputRoot = path.join(directory, "output");
    await writeJson(caseManifestPath, makeCaseManifest("routing", 1, [
      "RC eval harness receives the normalized case manifest path"
    ]));

    const result = await runNode([
      RUN_EVAL_SCRIPT,
      "rc-routing-env",
      "--case-manifest",
      caseManifestPath,
      "scripts/fixtures/case-manifest-env.test.mjs"
    ], {
      GITHUB_SHA: SOURCE_COMMIT,
      XIAOSHUO_EVAL_CASE_MANIFEST: "",
      XIAOSHUO_EVAL_OUTPUT_DIR: outputRoot
    });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    await expect(readJson(path.join(outputRoot, "rc-routing-env", "manifest.json"))).resolves.toMatchObject({
      dataset_id: "routing",
      status: "passed"
    });
  }, 30_000);
});

describe("RC eval evidence verifier", () => {
  it("accepts canonical case-level evidence and computes its metrics", async () => {
    const fixture = await createRcEvidenceFixture();
    const result = await runVerifier(fixture);

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const evidence = await readJson(fixture.outputPath);
    expect(evidence).toMatchObject({
      schema_version: RC_DATASET_MANIFEST_SCHEMA_VERSION,
      source_commit: SOURCE_COMMIT,
      dataset_version: DATASET_VERSION,
      dataset_hash_algorithm: RC_DATASET_HASH_ALGORITHM,
      case_manifest_schema_version: CASE_MANIFEST_SCHEMA_VERSION,
      case_hash_algorithm: RC_CASE_HASH_ALGORITHM
    });
    expect(evidence.datasets).toHaveLength(REQUIREMENTS.length);
    expect(evidence.datasets[0].metrics).toMatchObject({
      case_count: REQUIREMENTS[0][1],
      pass_rate: 1,
      sealed_holdout_case_count: REQUIREMENTS[0][1] * 0.2
    });
  });

  it("rejects a declaration version forged independently of case manifests", async () => {
    const fixture = await createRcEvidenceFixture();
    const declaration = await readJson(fixture.datasetPath);
    declaration.dataset_version = "forged-version";
    await writeJson(fixture.datasetPath, declaration);
    for (const { evalManifestPath } of fixture.datasets.values()) {
      const manifest = await readJson(evalManifestPath);
      manifest.dataset_version = declaration.dataset_version;
      await writeJson(evalManifestPath, manifest);
    }

    const result = await runVerifier(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("case manifest dataset_version rc-contract-test-v1 does not match forged-version");
  });

  it("rejects case-manifest bytes changed without updating the declaration hash", async () => {
    const fixture = await createRcEvidenceFixture();
    const routing = fixture.datasets.get("routing");
    const caseManifest = await readJson(routing.caseManifestPath);
    caseManifest.cases[0].expected_hash = sha256("forged expected output");
    await writeJson(routing.caseManifestPath, caseManifest);

    const result = await runVerifier(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("routing case manifest hash does not match its dataset declaration");
  });

  it("rejects a forged per-case result hash", async () => {
    const fixture = await createRcEvidenceFixture();
    const routing = fixture.datasets.get("routing");
    const manifest = await readJson(routing.evalManifestPath);
    manifest.cases[0].case_hash = "f".repeat(64);
    await writeJson(routing.evalManifestPath, manifest);

    const result = await runVerifier(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`routing case hash mismatch for ${manifest.cases[0].case_id}`);
  });

  it("rejects a forged eval-manifest dataset hash", async () => {
    const fixture = await createRcEvidenceFixture();
    const routing = fixture.datasets.get("routing");
    const manifest = await readJson(routing.evalManifestPath);
    manifest.dataset_hash = "0".repeat(64);
    await writeJson(routing.evalManifestPath, manifest);

    const result = await runVerifier(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("routing eval manifest is not bound to the declared dataset version and case manifest hash");
  });

  it("rejects a result manifest relabeled as another dataset", async () => {
    const fixture = await createRcEvidenceFixture();
    const routing = fixture.datasets.get("routing");
    const manifest = await readJson(routing.evalManifestPath);
    manifest.dataset_id = "planning";
    await writeJson(routing.evalManifestPath, manifest);

    const result = await runVerifier(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("routing eval manifest identity does not match eval_name and dataset_id");
  });

  it("rejects evidence that omits the hash-algorithm contract", async () => {
    const fixture = await createRcEvidenceFixture();
    const routing = fixture.datasets.get("routing");
    const manifest = await readJson(routing.evalManifestPath);
    delete manifest.case_hash_algorithm;
    await writeJson(routing.evalManifestPath, manifest);

    const result = await runVerifier(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("routing eval manifest uses an incompatible dataset or case hash contract");
  });
});

async function createRcEvidenceFixture() {
  const directory = await makeTemporaryDirectory();
  const casesRoot = path.join(directory, "cases");
  const evalRoot = path.join(directory, "evals");
  const datasetPath = path.join(directory, "rc-dataset-manifest.json");
  const outputPath = path.join(directory, "verified-evidence.json");
  const declarations = [];
  const datasets = new Map();

  for (const [id, minimumCases] of REQUIREMENTS) {
    const evalName = `rc-${id}`;
    const caseManifestPath = path.join(casesRoot, `${id}.json`);
    const caseManifestBytes = await writeJson(caseManifestPath, makeCaseManifest(id, minimumCases));
    const normalized = parseCaseManifestBytes(caseManifestBytes);
    const evalManifestPath = path.join(evalRoot, evalName, "manifest.json");
    await writeJson(evalManifestPath, {
      manifest_schema_version: 1,
      eval_name: evalName,
      dataset_id: id,
      dataset_version: DATASET_VERSION,
      dataset_hash: normalized.dataset_hash,
      dataset_hash_algorithm: RC_DATASET_HASH_ALGORITHM,
      case_manifest_schema_version: CASE_MANIFEST_SCHEMA_VERSION,
      case_hash_algorithm: RC_CASE_HASH_ALGORITHM,
      code_commit: SOURCE_COMMIT,
      status: "passed",
      cases: normalized.cases.map((entry, index) => ({
        case_id: entry.case_id,
        case_hash: entry.case_hash,
        status: "passed",
        duration_ms: index + 1
      }))
    });
    declarations.push({
      id,
      eval_name: evalName,
      case_manifest_path: `cases/${id}.json`,
      case_manifest_sha256: normalized.dataset_hash
    });
    datasets.set(id, { caseManifestPath, evalManifestPath });
  }
  await writeJson(datasetPath, {
    schema_version: RC_DATASET_MANIFEST_SCHEMA_VERSION,
    dataset_version: DATASET_VERSION,
    datasets: declarations
  });
  return { datasetPath, datasets, evalRoot, outputPath };
}

function makeCaseManifest(datasetId, count, caseIds = []) {
  const holdoutCount = Math.ceil(count * 0.2);
  return {
    schema_version: CASE_MANIFEST_SCHEMA_VERSION,
    dataset_id: datasetId,
    dataset_version: DATASET_VERSION,
    cases: Array.from({ length: count }, (_, index) => {
      const partition = index >= count - holdoutCount ? "sealed_holdout" : "train";
      return {
        case_id: caseIds[index] || `${datasetId}-case-${String(index + 1).padStart(4, "0")}`,
        project_group: `${datasetId}-${partition}-project`,
        partition,
        content_hash: sha256(`${datasetId}:content:${index}`),
        expected_hash: sha256(`${datasetId}:expected:${index}`)
      };
    })
  };
}

async function makeTemporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-eval-contract-"));
  temporaryDirectories.add(directory);
  return directory;
}

async function writeJson(target, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return bytes;
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function runVerifier(fixture) {
  return runNode([
    VERIFY_SCRIPT,
    "--dataset-manifest",
    fixture.datasetPath,
    "--eval-root",
    fixture.evalRoot,
    "--out",
    fixture.outputPath
  ], { XIAOSHUO_SOURCE_COMMIT: SOURCE_COMMIT });
}

async function runNode(args, environment = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...environment },
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
