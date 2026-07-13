import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  CASE_MANIFEST_SCHEMA_VERSION,
  RC_CASE_HASH_ALGORITHM,
  RC_DATASET_HASH_ALGORITHM,
  RC_DATASET_MANIFEST_SCHEMA_VERSION,
  parseCaseManifestBytes,
  requiredString as contractRequiredString,
  sha256String as contractSha256String
} from "./eval-evidence-contract.mjs";

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

function fail(message) {
  throw new Error(`[rc-eval-evidence] ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      fail(`expected --key value pairs, received: ${argv.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

function requiredString(value, label) {
  try {
    return contractRequiredString(value, label);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function sha256String(value, label) {
  try {
    return contractSha256String(value, label);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function resolveWithin(root, relativePath, label) {
  const resolved = path.resolve(root, requiredString(relativePath, label));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must stay within ${root}`);
  }
  return resolved;
}

async function readJson(target, label) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    fail(`unable to read ${label} ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1));
  return sortedValues[index];
}

const args = parseArgs(process.argv.slice(2));
const datasetPath = path.resolve(args.get("dataset-manifest") || fail("--dataset-manifest is required"));
const datasetRoot = path.dirname(datasetPath);
const evalRoot = path.resolve(args.get("eval-root") || fail("--eval-root is required"));
const outputPath = args.get("out") ? path.resolve(args.get("out")) : "";
const sourceCommit = String(process.env.XIAOSHUO_SOURCE_COMMIT || process.env.GITHUB_SHA || "").trim();
if (!/^[0-9a-f]{7,64}$/i.test(sourceCommit)) {
  fail("GITHUB_SHA or XIAOSHUO_SOURCE_COMMIT must contain the candidate commit");
}

const declaration = await readJson(datasetPath, "RC dataset manifest");
if (declaration.schema_version !== RC_DATASET_MANIFEST_SCHEMA_VERSION || !Array.isArray(declaration.datasets)) {
  fail(`RC dataset manifest must have schema_version ${RC_DATASET_MANIFEST_SCHEMA_VERSION} and a datasets array`);
}
const datasetVersion = requiredString(declaration.dataset_version, "dataset_version");
const datasets = new Map();
for (const entry of declaration.datasets) {
  if (!entry || typeof entry !== "object") {
    fail("RC dataset manifest contains an invalid dataset entry");
  }
  const id = requiredString(entry.id, "dataset id");
  if (datasets.has(id)) {
    fail(`RC dataset id is duplicated: ${id}`);
  }
  datasets.set(id, entry);
}

const summaries = [];
for (const [id, minimumCases] of REQUIREMENTS) {
  const entry = datasets.get(id);
  if (!entry) {
    fail(`missing required RC dataset declaration: ${id}`);
  }
  const evalName = requiredString(entry.eval_name, `${id}.eval_name`);
  const caseManifestPath = resolveWithin(datasetRoot, entry.case_manifest_path, `${id}.case_manifest_path`);
  const caseManifestBytes = await fs.readFile(caseManifestPath);
  let caseManifest;
  try {
    caseManifest = parseCaseManifestBytes(caseManifestBytes, {
      expectedDatasetId: id,
      expectedDatasetVersion: datasetVersion
    });
  } catch (error) {
    fail(`${id} ${error instanceof Error ? error.message : String(error)}`);
  }
  const caseManifestHash = caseManifest.dataset_hash;
  if (caseManifestHash !== sha256String(entry.case_manifest_sha256, `${id}.case_manifest_sha256`)) {
    fail(`${id} case manifest hash does not match its dataset declaration`);
  }

  const expectedCases = new Map();
  const groupPartitions = new Map();
  for (const normalized of caseManifest.cases) {
    const existingPartition = groupPartitions.get(normalized.project_group);
    if (existingPartition && existingPartition !== normalized.partition) {
      fail(`${id} project group ${normalized.project_group} spans train and sealed_holdout`);
    }
    groupPartitions.set(normalized.project_group, normalized.partition);
    expectedCases.set(normalized.case_id, normalized);
  }
  if (expectedCases.size < minimumCases) {
    fail(`${id} has ${expectedCases.size} actual cases; minimum is ${minimumCases}`);
  }
  const holdoutCases = [...expectedCases.values()].filter((item) => item.partition === "sealed_holdout");
  if (holdoutCases.length / expectedCases.size < 0.2) {
    fail(`${id} has fewer than 20% sealed holdout cases from its actual case manifest`);
  }
  const holdoutGroups = new Set(holdoutCases.map((item) => item.project_group));
  if (groupPartitions.size < 2 || holdoutGroups.size < 1 || holdoutGroups.size >= groupPartitions.size) {
    fail(`${id} must have isolated train and sealed-holdout project groups`);
  }

  const manifestPath = path.join(evalRoot, evalName, "manifest.json");
  const manifest = await readJson(manifestPath, `${id} eval manifest`);
  if (manifest.manifest_schema_version !== 1 || manifest.status !== "passed" || !Array.isArray(manifest.cases)) {
    fail(`${id} eval manifest is not a passed case-level manifest`);
  }
  if (manifest.eval_name !== evalName || manifest.dataset_id !== id) {
    fail(`${id} eval manifest identity does not match eval_name and dataset_id`);
  }
  if (manifest.code_commit !== sourceCommit) {
    fail(`${id} eval manifest commit ${manifest.code_commit || "<missing>"} does not match ${sourceCommit}`);
  }
  if (manifest.dataset_version !== datasetVersion || manifest.dataset_hash !== caseManifestHash) {
    fail(`${id} eval manifest is not bound to the declared dataset version and case manifest hash`);
  }
  if (manifest.dataset_hash_algorithm !== RC_DATASET_HASH_ALGORITHM
    || manifest.case_manifest_schema_version !== CASE_MANIFEST_SCHEMA_VERSION
    || manifest.case_hash_algorithm !== RC_CASE_HASH_ALGORITHM) {
    fail(`${id} eval manifest uses an incompatible dataset or case hash contract`);
  }

  const observedCases = new Map();
  for (const observed of manifest.cases) {
    const caseId = requiredString(observed?.case_id, `${id}.manifest.case_id`);
    if (observedCases.has(caseId)) {
      fail(`${id} eval manifest contains a duplicate case_id: ${caseId}`);
    }
    observedCases.set(caseId, observed);
  }
  if (observedCases.size !== expectedCases.size) {
    fail(`${id} eval manifest has ${observedCases.size} cases; expected exactly ${expectedCases.size}`);
  }
  const durations = [];
  let passed = 0;
  for (const [caseId, expected] of expectedCases) {
    const observed = observedCases.get(caseId);
    if (!observed) {
      fail(`${id} eval manifest is missing case ${caseId}`);
    }
    if (observed.case_hash !== expected.case_hash) {
      fail(`${id} case hash mismatch for ${caseId}`);
    }
    const duration = Number(observed.duration_ms || 0);
    if (!Number.isFinite(duration) || duration < 0) {
      fail(`${id} has invalid duration for ${caseId}`);
    }
    durations.push(duration);
    if (observed.status === "passed") passed += 1;
  }
  if (passed !== expectedCases.size) {
    fail(`${id} has ${expectedCases.size - passed} failed actual cases`);
  }
  durations.sort((left, right) => left - right);
  summaries.push({
    id,
    eval_name: evalName,
    case_manifest_sha256: caseManifestHash,
    metrics: {
      case_count: expectedCases.size,
      passed,
      pass_rate: passed / expectedCases.size,
      sealed_holdout_case_count: holdoutCases.length,
      project_group_count: groupPartitions.size,
      sealed_holdout_project_group_count: holdoutGroups.size,
      p50_duration_ms: percentile(durations, 0.5),
      p95_duration_ms: percentile(durations, 0.95)
    }
  });
}

const evidence = {
  schema_version: 2,
  source_commit: sourceCommit,
  dataset_version: datasetVersion,
  dataset_hash_algorithm: RC_DATASET_HASH_ALGORITHM,
  case_manifest_schema_version: CASE_MANIFEST_SCHEMA_VERSION,
  case_hash_algorithm: RC_CASE_HASH_ALGORITHM,
  verified_at: new Date().toISOString(),
  datasets: summaries
};
if (outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
console.log(`[rc-eval-evidence] verified ${summaries.length} case-level datasets for ${sourceCommit}`);
