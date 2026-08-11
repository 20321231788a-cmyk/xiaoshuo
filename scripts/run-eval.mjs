import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CASE_MANIFEST_SCHEMA_VERSION,
  RC_CASE_HASH_ALGORITHM,
  RC_DATASET_HASH_ALGORITHM,
  WORKSPACE_CASE_HASH_ALGORITHM,
  WORKSPACE_DATASET_HASH_ALGORITHM,
  WORKSPACE_DATASET_VERSION,
  parseCaseManifestBytes,
  sha256,
  stableJson
} from "./eval-evidence-contract.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { evalName, testFiles, caseManifestArgument } = parseRunArgs(process.argv.slice(2));

if (!evalName || !testFiles.length) {
  throw new Error("Usage: node scripts/run-eval.mjs <eval-name> [--case-manifest <path>] <vitest test files...>");
}

const outputDir = path.resolve(process.env.XIAOSHUO_EVAL_OUTPUT_DIR || path.join(rootDir, "output", "evals"), evalName);
const resultPath = path.join(outputDir, "vitest-result.json");
const manifestPath = path.join(outputDir, "manifest.json");
const seed = String(process.env.XIAOSHUO_EVAL_SEED || "20260713");
const startedAt = new Date();
const caseManifestPath = caseManifestArgument ? path.resolve(rootDir, caseManifestArgument) : "";
const caseManifest = caseManifestPath
  ? parseCaseManifestBytes(await fs.readFile(caseManifestPath))
  : null;

await fs.mkdir(outputDir, { recursive: true });
await fs.rm(resultPath, { force: true });

const vitestEntry = path.join(rootDir, "node_modules", "vitest", "vitest.mjs");
const command = [vitestEntry, "run", ...testFiles, "--reporter=json", "--outputFile", resultPath];
const result = await run(process.execPath, command, {
  cwd: rootDir,
  env: {
    ...process.env,
    XIAOSHUO_EVAL_SEED: seed,
    ...(caseManifestPath ? { XIAOSHUO_EVAL_CASE_MANIFEST: caseManifestPath } : {})
  }
});

const vitestResult = await readJson(resultPath);
const extractedCases = extractCases(vitestResult, result);
const cases = caseManifest ? bindCasesToManifest(extractedCases, caseManifest) : extractedCases;
const fixtureHashes = await collectFixtureHashes(rootDir, testFiles);
const failures = cases.filter((testCase) => testCase.status !== "passed");
const manifest = {
  manifest_schema_version: 1,
  eval_name: evalName,
  dataset_id: caseManifest?.dataset_id || evalName,
  dataset_version: caseManifest?.dataset_version || WORKSPACE_DATASET_VERSION,
  dataset_hash: caseManifest?.dataset_hash || sha256(stableJson(fixtureHashes)),
  dataset_hash_algorithm: caseManifest ? RC_DATASET_HASH_ALGORITHM : WORKSPACE_DATASET_HASH_ALGORITHM,
  case_manifest_schema_version: caseManifest ? CASE_MANIFEST_SCHEMA_VERSION : null,
  case_hash_algorithm: caseManifest ? RC_CASE_HASH_ALGORITHM : WORKSPACE_CASE_HASH_ALGORITHM,
  fixture_hashes: fixtureHashes,
  code_commit: await gitCommit(rootDir),
  command: `${process.execPath} ${command.join(" ")}`,
  runner: "vitest",
  operating_system: `${process.platform}-${os.release()}`,
  model_provider: "none",
  model_id: "deterministic-local",
  capabilities: [],
  prompt_hash: "",
  skill_versions: {},
  rubric_versions: {},
  temperature: null,
  top_p: null,
  seed,
  seed_policy: "fixed XIAOSHUO_EVAL_SEED; deterministic local fixtures",
  started_at: startedAt.toISOString(),
  duration_ms: Date.now() - startedAt.getTime(),
  token_usage: null,
  estimated_cost: 0,
  pass_rate: cases.length ? (cases.length - failures.length) / cases.length : 0,
  cases,
  failure_cases: failures,
  status: result.code === 0 && !failures.length ? "passed" : "failed"
};

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "failure-cases.json"), `${JSON.stringify(failures, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "redacted-trace.json"), `${JSON.stringify({
  eval_name: evalName,
  status: manifest.status,
  failure_cases: failures.map(({ case_id, status, failure }) => ({ case_id, status, failure }))
}, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "performance-baseline.json"), `${JSON.stringify({
  eval_name: evalName,
  duration_ms: manifest.duration_ms,
  case_count: cases.length,
  pass_rate: manifest.pass_rate
}, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "security-recovery-counters.json"), `${JSON.stringify({
  eval_name: evalName,
  failed_cases: failures.length,
  security_failures: evalName.includes("security") || evalName.includes("excluded") ? failures.length : 0,
  recovery_failures: evalName.includes("recovery") ? failures.length : 0
}, null, 2)}\n`, "utf8");
await fs.rm(resultPath, { force: true });
console.log(`[eval-manifest] ${manifest.status} ${manifestPath}`);
process.exitCode = result.code || failures.length ? 1 : 0;

function parseRunArgs(argv) {
  const [evalName, ...values] = argv;
  const testFiles = [];
  let caseManifestArgument = String(process.env.XIAOSHUO_EVAL_CASE_MANIFEST || "").trim();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--case-manifest") {
      const candidate = values[index + 1];
      if (!candidate || candidate.startsWith("--")) {
        throw new Error("--case-manifest requires a path");
      }
      if (caseManifestArgument && path.resolve(rootDir, caseManifestArgument) !== path.resolve(rootDir, candidate)) {
        throw new Error("case manifest differs between --case-manifest and XIAOSHUO_EVAL_CASE_MANIFEST");
      }
      caseManifestArgument = candidate;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new Error(`Unknown run-eval option: ${value}`);
    }
    testFiles.push(value);
  }
  return { evalName, testFiles, caseManifestArgument };
}

function bindCasesToManifest(observedCases, caseManifest) {
  const expected = new Map(caseManifest.cases.map((entry) => [entry.case_id, entry]));
  const seen = new Set();
  const bound = observedCases.map((observed) => {
    if (seen.has(observed.case_id)) {
      return {
        ...observed,
        status: "failed",
        failure: `Duplicate observed case_id: ${observed.case_id}`
      };
    }
    seen.add(observed.case_id);
    const expectedCase = expected.get(observed.case_id);
    if (!expectedCase) {
      return {
        ...observed,
        status: "failed",
        failure: `Observed case is absent from the bound case manifest: ${observed.case_id}`
      };
    }
    return {
      ...observed,
      case_hash: expectedCase.case_hash,
      content_hash: expectedCase.content_hash,
      expected_hash: expectedCase.expected_hash,
      partition: expectedCase.partition,
      project_group: expectedCase.project_group
    };
  });
  for (const expectedCase of caseManifest.cases) {
    if (seen.has(expectedCase.case_id)) continue;
    bound.push({
      case_id: expectedCase.case_id,
      case_hash: expectedCase.case_hash,
      content_hash: expectedCase.content_hash,
      expected_hash: expectedCase.expected_hash,
      partition: expectedCase.partition,
      project_group: expectedCase.project_group,
      status: "failed",
      duration_ms: 0,
      failure: `Bound case was not emitted by Vitest: ${expectedCase.case_id}`
    });
  }
  return bound;
}

async function run(commandName, args, options) {
  return new Promise((resolve) => {
    try {
      const child = spawn(commandName, args, { ...options, stdio: "inherit", shell: false });
      child.once("error", (error) => resolve({ code: 1, error: error.message }));
      child.once("exit", (code) => resolve({ code: code ?? 1, error: "" }));
    } catch (error) {
      resolve({ code: 1, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function readJson(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

function extractCases(result, processResult) {
  const cases = [];
  const seen = new Set();
  const add = (entry) => {
    const name = String(entry.fullName || entry.name || entry.title || "unnamed case");
    const status = normalizeStatus(entry.status || entry.state || entry.result?.state);
    const key = `${name}:${status}`;
    if (seen.has(key)) return;
    seen.add(key);
    cases.push({
      case_id: name,
      case_hash: sha256(name),
      status,
      duration_ms: Number(entry.duration ?? entry.duration_ms ?? entry.result?.duration ?? 0) || 0,
      failure: status === "passed" ? "" : redact(entry.failureMessages || entry.errors || entry.result?.errors || processResult.error || "Vitest failure")
    });
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (Array.isArray(value.assertionResults)) value.assertionResults.forEach(add);
    if (value.type === "test" || value.type === "custom" || value.assertionResult) add(value);
    if (Array.isArray(value.tasks)) value.tasks.forEach(visit);
    if (Array.isArray(value.testResults)) value.testResults.forEach(visit);
  };
  visit(result);
  if (!cases.length) {
    cases.push({
      case_id: `${evalName}:runner`,
      case_hash: sha256(evalName),
      status: processResult.code === 0 ? "passed" : "failed",
      duration_ms: 0,
      failure: processResult.code === 0 ? "" : redact(processResult.error || "Vitest did not emit a parseable JSON result")
    });
  }
  return cases;
}

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  return status === "pass" || status === "passed" ? "passed" : "failed";
}

async function collectFixtureHashes(root, testFiles) {
  const targets = new Set(testFiles.map((file) => path.resolve(root, file)));
  const evalDir = path.join(root, "packages", "agent-runtime", "evals");
  for (const file of await walk(evalDir)) targets.add(file);
  const hashes = {};
  for (const target of [...targets].sort()) {
    if (!existsSync(target)) continue;
    const relative = path.relative(root, target).replace(/\\/g, "/");
    hashes[relative] = sha256(await fs.readFile(target));
  }
  return hashes;
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function gitCommit(cwd) {
  const fromCi = String(process.env.GITHUB_SHA || "").trim();
  if (fromCi) return fromCi;
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd, env: process.env, shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.once("error", () => resolve("workspace-uncommitted"));
    child.once("exit", (code) => resolve(code === 0 && output.trim() ? output.trim() : "workspace-uncommitted"));
  });
}

function redact(value) {
  return String(Array.isArray(value) ? value.join("\n") : value || "")
    .replace(/(?:api[_-]?key|authorization|bearer|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 1200);
}
