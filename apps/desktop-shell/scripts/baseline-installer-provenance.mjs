import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const METADATA_KEYS = [
  "asset_id",
  "asset_name",
  "asset_url",
  "baseline_version",
  "candidate_version",
  "published_at",
  "release_id",
  "repository",
  "schema_version",
  "sha256",
  "tag",
  "version_relation"
].sort();

function fail(message) {
  throw new Error(`[baseline-provenance] ${message}`);
}

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) fail(`${label} must be a non-empty string`);
  return normalized;
}

function requiredHash(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    fail(`${label} must be a SHA-256 hash`);
  }
  return normalized;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function parseVersion(value, pattern, label) {
  const normalized = requiredString(value, label);
  const match = pattern.exec(normalized);
  if (!match) fail(`${label} is not a valid semantic version`);
  return {
    normalized,
    core: match.slice(1, 4).map((part) => BigInt(part)),
    prerelease: match[4] || ""
  };
}

function baselineVersionRelation(baseline, candidate) {
  for (let index = 0; index < baseline.core.length; index += 1) {
    if (baseline.core[index] < candidate.core[index]) return "previous";
    if (baseline.core[index] > candidate.core[index]) return "newer";
  }
  // A stable version is newer than a prerelease with the same core. Build
  // metadata does not affect precedence, so a stable/build-only candidate is equal.
  return candidate.prerelease ? "newer" : "equal";
}

async function fileSha256(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateBaselineInstallerMetadata(metadata, options) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("metadata must be a JSON object");
  }
  const actualKeys = Object.keys(metadata).sort();
  if (actualKeys.length !== METADATA_KEYS.length || actualKeys.some((key, index) => key !== METADATA_KEYS[index])) {
    fail(`metadata must contain exactly: ${METADATA_KEYS.join(", ")}`);
  }
  if (metadata.schema_version !== 1) {
    fail("metadata has an unsupported schema version");
  }

  const repository = requiredString(metadata.repository, "repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    fail("repository must use GitHub owner/repo form");
  }
  const expectedRepository = requiredString(options?.repository, "expected repository");
  if (repository.toLowerCase() !== expectedRepository.toLowerCase()) {
    fail(`repository ${repository} does not match ${expectedRepository}`);
  }

  const candidate = parseVersion(metadata.candidate_version, SEMVER_PATTERN, "candidate_version");
  const expectedCandidate = parseVersion(options?.candidateVersion, SEMVER_PATTERN, "expected candidate version");
  if (candidate.normalized !== expectedCandidate.normalized) {
    fail(`candidate_version ${candidate.normalized} does not match ${expectedCandidate.normalized}`);
  }
  const baseline = parseVersion(metadata.baseline_version, STABLE_VERSION_PATTERN, "baseline_version");
  const versionRelation = baselineVersionRelation(baseline, candidate);
  if (versionRelation !== "previous") {
    fail(`baseline_version ${baseline.normalized} must be lower than candidate_version ${candidate.normalized}`);
  }
  if (metadata.version_relation !== versionRelation) {
    fail(`version_relation must be ${versionRelation}`);
  }

  const tag = requiredString(metadata.tag, "tag");
  if (tag !== baseline.normalized && tag !== `v${baseline.normalized}`) {
    fail("tag must identify the exact stable baseline_version");
  }
  const assetName = requiredString(metadata.asset_name, "asset_name");
  const expectedAssetName = `ArcWriter-Setup-${baseline.normalized}.exe`;
  if (assetName !== expectedAssetName) {
    fail(`asset_name must be ${expectedAssetName}`);
  }

  const assetUrl = requiredString(metadata.asset_url, "asset_url");
  let parsedAssetUrl;
  try {
    parsedAssetUrl = new URL(assetUrl);
  } catch {
    fail("asset_url must be an absolute URL");
  }
  const expectedAssetUrl = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
  if (parsedAssetUrl.href !== expectedAssetUrl || parsedAssetUrl.username || parsedAssetUrl.password || parsedAssetUrl.search || parsedAssetUrl.hash) {
    fail("asset_url is not the exact GitHub release asset URL declared by the metadata");
  }

  const publishedAt = requiredString(metadata.published_at, "published_at");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) {
    fail("published_at must be a valid UTC timestamp");
  }
  const canonicalPublishedAt = new Date(publishedAt).toISOString();

  const sha256 = requiredHash(metadata.sha256, "sha256");
  const expectedBaselineHash = requiredHash(options?.baselineInstallerSha256, "expected baseline installer hash");
  if (sha256 !== expectedBaselineHash) {
    fail("metadata SHA-256 does not match the baseline installer used by the smoke test");
  }

  return {
    schema_version: 1,
    repository,
    candidate_version: candidate.normalized,
    baseline_version: baseline.normalized,
    version_relation: versionRelation,
    tag,
    release_id: requiredPositiveInteger(metadata.release_id, "release_id"),
    asset_id: requiredPositiveInteger(metadata.asset_id, "asset_id"),
    asset_name: assetName,
    asset_url: assetUrl,
    sha256,
    published_at: canonicalPublishedAt
  };
}

export async function readBaselineInstallerMetadata(metadataPath, options) {
  const bytes = await fs.readFile(metadataPath);
  let metadata;
  try {
    metadata = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`unable to parse metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    metadata_sha256: createHash("sha256").update(bytes).digest("hex"),
    metadata: validateBaselineInstallerMetadata(metadata, options)
  };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      fail(`expected --key value pairs, received: ${argv.join(" ")}`);
    }
    const normalized = key.slice(2);
    if (args.has(normalized)) fail(`duplicate argument: ${key}`);
    args.set(normalized, value);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const metadataPath = path.resolve(args.get("metadata") || fail("--metadata is required"));
  const baselineInstallerPath = path.resolve(args.get("baseline-installer") || fail("--baseline-installer is required"));
  const candidateInstallerPath = path.resolve(args.get("candidate-installer") || fail("--candidate-installer is required"));
  const candidateVersion = requiredString(args.get("candidate-version") || fail("--candidate-version is required"), "candidate version");
  const repository = requiredString(args.get("repository") || fail("--repository is required"), "repository");
  const expectedCandidateName = `ArcWriter-Setup-${candidateVersion}.exe`;
  if (path.basename(candidateInstallerPath) !== expectedCandidateName) {
    fail(`candidate installer must be named ${expectedCandidateName}`);
  }
  const candidateStat = await fs.stat(candidateInstallerPath);
  if (!candidateStat.isFile() || candidateStat.size < 1) {
    fail("candidate installer must be a non-empty file");
  }
  const result = await readBaselineInstallerMetadata(metadataPath, {
    repository,
    candidateVersion,
    baselineInstallerSha256: await fileSha256(baselineInstallerPath)
  });
  console.log(JSON.stringify(result));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
if (entryPath === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
