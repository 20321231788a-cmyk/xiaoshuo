import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

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

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
const datasetPath = path.resolve(args.get("dataset-manifest") || fail("--dataset-manifest is required"));
const evalRoot = path.resolve(args.get("eval-root") || fail("--eval-root is required"));
let declaration;
try {
  declaration = JSON.parse(await fs.readFile(datasetPath, "utf8"));
} catch (error) {
  fail(`unable to read RC dataset manifest ${datasetPath}: ${error instanceof Error ? error.message : String(error)}`);
}
if (declaration.schema_version !== 1 || !Array.isArray(declaration.datasets)) {
  fail("RC dataset manifest must have schema_version 1 and a datasets array");
}

const datasets = new Map();
for (const entry of declaration.datasets) {
  if (!entry || typeof entry !== "object") {
    fail("RC dataset manifest contains an invalid dataset entry");
  }
  const id = String(entry.id || "").trim();
  if (!id || datasets.has(id)) {
    fail(`RC dataset id is missing or duplicated: ${id || "<empty>"}`);
  }
  datasets.set(id, entry);
}

for (const [id, minimumCases] of REQUIREMENTS) {
  const entry = datasets.get(id);
  if (!entry) {
    fail(`missing required RC dataset declaration: ${id}`);
  }
  const evalName = String(entry.eval_name || "").trim();
  if (!evalName) {
    fail(`${id} must declare eval_name`);
  }
  const declaredCases = positiveInteger(entry.case_count, `${id}.case_count`);
  const sealedHoldoutCases = positiveInteger(entry.sealed_holdout_case_count, `${id}.sealed_holdout_case_count`);
  const projectGroups = positiveInteger(entry.project_group_count, `${id}.project_group_count`);
  const sealedHoldoutGroups = positiveInteger(entry.sealed_holdout_project_group_count, `${id}.sealed_holdout_project_group_count`);
  if (declaredCases < minimumCases) {
    fail(`${id} declares ${declaredCases} cases; minimum is ${minimumCases}`);
  }
  if (sealedHoldoutCases / declaredCases < 0.2) {
    fail(`${id} has fewer than 20% sealed holdout cases`);
  }
  if (projectGroups < 2 || sealedHoldoutGroups > projectGroups) {
    fail(`${id} must declare at least two project groups and valid sealed holdout groups`);
  }

  const manifestPath = path.join(evalRoot, evalName, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`${id} is missing eval manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.status !== "passed" || !Array.isArray(manifest.cases)) {
    fail(`${id} eval manifest is not a passed case-level manifest`);
  }
  if (manifest.cases.length < declaredCases) {
    fail(`${id} manifest has ${manifest.cases.length} cases; declaration requires ${declaredCases}`);
  }
}

console.log(`[rc-eval-evidence] verified ${REQUIREMENTS.length} datasets from ${datasetPath}`);
