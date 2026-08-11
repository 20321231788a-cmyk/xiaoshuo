import { createHash } from "node:crypto";

export const RC_DATASET_MANIFEST_SCHEMA_VERSION = 2;
export const CASE_MANIFEST_SCHEMA_VERSION = 1;
export const RC_DATASET_HASH_ALGORITHM = "sha256-raw-bytes-v1";
export const RC_CASE_HASH_ALGORITHM = "sha256-stable-json-v1";
export const WORKSPACE_DATASET_VERSION = "workspace-fixtures-v1";
export const WORKSPACE_DATASET_HASH_ALGORITHM = "sha256-stable-json-v1";
export const WORKSPACE_CASE_HASH_ALGORITHM = "sha256-case-id-v1";

export class EvalEvidenceContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvalEvidenceContractError";
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvalEvidenceContractError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function sha256String(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new EvalEvidenceContractError(`${label} must be a sha256 hex digest`);
  }
  return normalized;
}

export function rcCaseHash({ datasetId, datasetVersion, caseId, contentHash, expectedHash = "", partition, projectGroup }) {
  return sha256(stableJson({
    case_id: caseId,
    content_hash: contentHash,
    dataset_id: datasetId,
    dataset_version: datasetVersion,
    expected_hash: expectedHash,
    partition,
    project_group: projectGroup
  }));
}

export function normalizeCaseManifest(document, options = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new EvalEvidenceContractError("case manifest must be a JSON object");
  }
  if (document.schema_version !== CASE_MANIFEST_SCHEMA_VERSION || !Array.isArray(document.cases)) {
    throw new EvalEvidenceContractError(`case manifest must have schema_version ${CASE_MANIFEST_SCHEMA_VERSION} and a cases array`);
  }

  const datasetId = requiredString(document.dataset_id, "case manifest dataset_id");
  const datasetVersion = requiredString(document.dataset_version, "case manifest dataset_version");
  if (options.expectedDatasetId !== undefined && datasetId !== options.expectedDatasetId) {
    throw new EvalEvidenceContractError(`case manifest dataset_id ${datasetId} does not match ${options.expectedDatasetId}`);
  }
  if (options.expectedDatasetVersion !== undefined && datasetVersion !== options.expectedDatasetVersion) {
    throw new EvalEvidenceContractError(`case manifest dataset_version ${datasetVersion} does not match ${options.expectedDatasetVersion}`);
  }

  const seen = new Set();
  const cases = document.cases.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new EvalEvidenceContractError(`${datasetId} case manifest contains an invalid case`);
    }
    const caseId = requiredString(entry.case_id, `${datasetId}.case_id`);
    if (seen.has(caseId)) {
      throw new EvalEvidenceContractError(`${datasetId} contains a duplicate case_id: ${caseId}`);
    }
    seen.add(caseId);

    const projectGroup = requiredString(entry.project_group, `${datasetId}.${caseId}.project_group`);
    const partition = requiredString(entry.partition, `${datasetId}.${caseId}.partition`);
    if (partition !== "train" && partition !== "sealed_holdout") {
      throw new EvalEvidenceContractError(`${datasetId}.${caseId}.partition must be train or sealed_holdout`);
    }
    const contentHash = sha256String(entry.content_hash, `${datasetId}.${caseId}.content_hash`);
    const expectedHash = entry.expected_hash === undefined || entry.expected_hash === ""
      ? ""
      : sha256String(entry.expected_hash, `${datasetId}.${caseId}.expected_hash`);
    const caseHash = rcCaseHash({
      datasetId,
      datasetVersion,
      caseId,
      contentHash,
      expectedHash,
      partition,
      projectGroup
    });
    return {
      case_id: caseId,
      case_hash: caseHash,
      content_hash: contentHash,
      expected_hash: expectedHash,
      partition,
      project_group: projectGroup
    };
  });

  return {
    schema_version: CASE_MANIFEST_SCHEMA_VERSION,
    dataset_id: datasetId,
    dataset_version: datasetVersion,
    cases
  };
}

export function parseCaseManifestBytes(bytes, options = {}) {
  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new EvalEvidenceContractError(`case manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ...normalizeCaseManifest(document, options),
    dataset_hash: sha256(bytes)
  };
}
