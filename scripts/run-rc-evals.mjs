import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RC_DATASET_MANIFEST_SCHEMA_VERSION,
  parseCaseManifestBytes,
  requiredString,
  sha256String
} from "./eval-evidence-contract.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`[rc-eval-runner] ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      fail(`expected --key value pairs, received: ${argv.join(" ")}`);
    }
    const normalized = key.slice(2);
    if (values.has(normalized)) fail(`duplicate argument: ${key}`);
    values.set(normalized, value);
  }
  return values;
}

function resolveWithin(root, relativePath, label) {
  const candidate = requiredString(relativePath, label);
  if (path.isAbsolute(candidate)) fail(`${label} must be relative`);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must stay within ${root}`);
  }
  return { resolved, relative: relative.replace(/\\/g, "/") };
}

async function readJson(target, label) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    fail(`unable to read ${label} ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requireFile(target, label) {
  const stats = await fs.stat(target).catch(() => null);
  if (!stats?.isFile()) fail(`${label} is missing: ${target}`);
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env,
      shell: false,
      stdio: "inherit"
    });
    child.once("error", (error) => resolve({ code: 1, error: error.message }));
    child.once("exit", (code) => resolve({ code: code ?? 1, error: "" }));
  });
}

const args = parseArgs(process.argv.slice(2));
const datasetManifestPath = path.resolve(args.get("dataset-manifest") || fail("--dataset-manifest is required"));
const runnerManifestPath = path.resolve(args.get("runner-manifest") || fail("--runner-manifest is required"));
const outputRoot = path.resolve(args.get("output-root") || fail("--output-root is required"));
const allowedOutputRoot = path.join(rootDir, "output");
const outputRelative = path.relative(allowedOutputRoot, outputRoot);
if (!outputRelative || outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) {
  fail("--output-root must be a dedicated directory beneath the repository output directory");
}
const datasetRoot = path.dirname(datasetManifestPath);
const datasetDeclaration = await readJson(datasetManifestPath, "RC dataset manifest");
const runnerDeclaration = await readJson(runnerManifestPath, "RC runner manifest");

if (datasetDeclaration.schema_version !== RC_DATASET_MANIFEST_SCHEMA_VERSION || !Array.isArray(datasetDeclaration.datasets)) {
  fail(`RC dataset manifest must have schema_version ${RC_DATASET_MANIFEST_SCHEMA_VERSION} and a datasets array`);
}
if (runnerDeclaration.schema_version !== 1 || !Array.isArray(runnerDeclaration.datasets)) {
  fail("RC runner manifest must have schema_version 1 and a datasets array");
}
const datasetVersion = requiredString(datasetDeclaration.dataset_version, "dataset_version");
const datasets = new Map();
for (const entry of datasetDeclaration.datasets) {
  const id = requiredString(entry?.id, "dataset id");
  if (datasets.has(id)) fail(`duplicate RC dataset id: ${id}`);
  datasets.set(id, entry);
}
const runners = new Map();
for (const entry of runnerDeclaration.datasets) {
  const id = requiredString(entry?.id, "runner dataset id");
  if (runners.has(id)) fail(`duplicate RC runner dataset id: ${id}`);
  runners.set(id, entry);
}
if (datasets.size !== runners.size || [...datasets.keys()].some((id) => !runners.has(id))) {
  fail("RC runner manifest must declare exactly one runner for every dataset");
}

const evalNames = new Set();
const jobs = [];
for (const [id, dataset] of datasets) {
  const runner = runners.get(id);
  const evalName = requiredString(dataset.eval_name, `${id}.eval_name`);
  if (requiredString(runner.eval_name, `${id}.runner.eval_name`) !== evalName || evalNames.has(evalName)) {
    fail(`${id} runner has a mismatched or duplicate eval_name`);
  }
  evalNames.add(evalName);
  const caseManifest = resolveWithin(datasetRoot, dataset.case_manifest_path, `${id}.case_manifest_path`);
  await requireFile(caseManifest.resolved, `${id} case manifest`);
  const caseManifestBytes = await fs.readFile(caseManifest.resolved);
  const parsedCases = parseCaseManifestBytes(caseManifestBytes, {
    expectedDatasetId: id,
    expectedDatasetVersion: datasetVersion
  });
  if (parsedCases.dataset_hash !== sha256String(dataset.case_manifest_sha256, `${id}.case_manifest_sha256`)) {
    fail(`${id} case manifest hash does not match its dataset declaration`);
  }
  if (!Array.isArray(runner.test_files) || !runner.test_files.length) {
    fail(`${id} runner must declare at least one Vitest file`);
  }
  const testFiles = [];
  const seenFiles = new Set();
  for (const testFile of runner.test_files) {
    const resolved = resolveWithin(rootDir, testFile, `${id}.test_file`);
    if (!/\.test\.[cm]?[jt]sx?$/i.test(resolved.relative) || seenFiles.has(resolved.relative)) {
      fail(`${id} runner contains an invalid or duplicate Vitest file: ${resolved.relative}`);
    }
    await requireFile(resolved.resolved, `${id} Vitest file`);
    seenFiles.add(resolved.relative);
    testFiles.push(resolved.relative);
  }
  jobs.push({ id, evalName, caseManifest: path.relative(rootDir, caseManifest.resolved).replace(/\\/g, "/"), testFiles });
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });
for (const job of jobs) {
  console.log(`[rc-eval-runner] running ${job.id} as ${job.evalName}`);
  const result = await runNode([
    path.join("scripts", "run-eval.mjs"),
    job.evalName,
    "--case-manifest",
    job.caseManifest,
    ...job.testFiles
  ], {
    ...process.env,
    XIAOSHUO_EVAL_OUTPUT_DIR: outputRoot
  });
  if (result.code !== 0) {
    fail(`${job.id} evaluation failed${result.error ? `: ${result.error}` : ""}`);
  }
}

console.log(`[rc-eval-runner] completed ${jobs.length} manifest-bound datasets`);
