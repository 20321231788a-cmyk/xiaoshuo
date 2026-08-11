import { createHash } from "node:crypto";
import path from "node:path";
import { nextExecutionVersion } from "./execution-state-machine.js";

export const IDEMPOTENCY_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_IDEMPOTENCY_INPUT",
  IDEMPOTENCY_KEY_CONFLICT: "IDEMPOTENCY_KEY_CONFLICT",
  OPERATION_ID_CONFLICT: "OPERATION_ID_CONFLICT",
  ATTEMPT_NOT_MONOTONIC: "ATTEMPT_NOT_MONOTONIC",
  ATTEMPT_LIMIT_EXCEEDED: "ATTEMPT_LIMIT_EXCEEDED",
  LEASE_HELD: "LEASE_HELD",
  LEASE_RESOURCE_MISMATCH: "LEASE_RESOURCE_MISMATCH",
  LEASE_EXPIRED: "LEASE_EXPIRED",
  LEASE_OWNER_MISMATCH: "LEASE_OWNER_MISMATCH",
  STALE_FENCING_TOKEN: "STALE_FENCING_TOKEN",
  FENCING_TOKEN_MISMATCH: "FENCING_TOKEN_MISMATCH",
  FENCING_TOKEN_EXHAUSTED: "FENCING_TOKEN_EXHAUSTED"
} as const);

export type IdempotencyErrorCode = (typeof IDEMPOTENCY_ERROR_CODES)[keyof typeof IDEMPOTENCY_ERROR_CODES];

export class IdempotencyInvariantError extends Error {
  readonly code: IdempotencyErrorCode;
  readonly retryable: boolean;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: IdempotencyErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    retryable = false
  ) {
    super(message);
    this.name = "IdempotencyInvariantError";
    this.code = code;
    this.retryable = retryable;
    this.detail = Object.freeze({ ...detail });
  }
}

export type IdempotencyKeyInput = {
  run_id: string;
  step_id: string;
  attempt: number;
  action: string;
  target_path: string;
  base_document_version?: number | null;
  content_hash?: string | null;
};

export type StartedIdempotencyRecord = Readonly<{
  idempotency_key: string;
  state: "started";
}>;

export type CompletedIdempotencyRecord<Result> = Readonly<{
  idempotency_key: string;
  state: "completed";
  result: Result;
}>;

export type IdempotencyRecord<Result> = StartedIdempotencyRecord | CompletedIdempotencyRecord<Result>;

export type IdempotencyResolution<Result> =
  | Readonly<{ kind: "execute"; idempotency_key: string }>
  | Readonly<{ kind: "in_progress"; idempotency_key: string }>
  | Readonly<{ kind: "replay"; idempotency_key: string; result: Result }>;

export type ControlOperationRequest = Readonly<{
  operation_id: string;
  operation: string;
  resource_type: "run" | "step" | "confirmation";
  resource_id: string;
  expected_version: number;
  payload_digest?: string | null;
}>;

type ControlOperationRecordBase = Readonly<{
  operation_id: string;
  request_fingerprint: string;
}>;

export type StartedControlOperation = ControlOperationRecordBase & Readonly<{ state: "started" }>;

export type CompletedControlOperation<Result> = ControlOperationRecordBase &
  Readonly<{
    state: "completed";
    result: Result;
  }>;

export type ControlOperationRecord<Result> = StartedControlOperation | CompletedControlOperation<Result>;

export type ControlOperationResolution<Result> =
  | Readonly<{
      kind: "execute";
      operation_id: string;
      request_fingerprint: string;
      expected_version: number;
      next_version: number;
    }>
  | Readonly<{
      kind: "in_progress";
      operation_id: string;
      request_fingerprint: string;
    }>
  | Readonly<{
      kind: "replay";
      operation_id: string;
      request_fingerprint: string;
      result: Result;
    }>;

export type RuntimeOwnerLease = Readonly<{
  runtime_instance_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  fencing_token: number;
}>;

export type AcquireRuntimeOwnerLeaseInput = Readonly<{
  runtime_instance_id: string;
  acquired_at: Date | string | number;
  ttl_ms: number;
}>;

export type CreateRuntimeOwnerLeaseInput = AcquireRuntimeOwnerLeaseInput & Readonly<{ fencing_token: number }>;

export type RenewRuntimeOwnerLeaseInput = Readonly<{
  runtime_instance_id: string;
  fencing_token: number;
  heartbeat_at: Date | string | number;
  ttl_ms: number;
}>;

export type WriteLease = Readonly<{
  target_path: string;
  owner: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  fencing_token: number;
}>;

export type WriteLeaseAcquireInput = Readonly<{
  target_path: string;
  owner: string;
  acquired_at: Date | string | number;
  ttl_ms: number;
}>;

export type CreateWriteLeaseInput = WriteLeaseAcquireInput & Readonly<{ fencing_token: number }>;

export type WriteLeaseRenewInput = Readonly<{
  owner: string;
  fencing_token: number;
  heartbeat_at: Date | string | number;
  ttl_ms: number;
}>;

export function normalizeIdempotencyAction(action: string): string {
  const normalized = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    throw invalidInput("Idempotency action must not be empty", { field: "action" });
  }
  return normalized;
}

export function normalizeIdempotencyTargetPath(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw invalidInput("Idempotency target path must not be empty", { field: "target_path" });
  }

  const normalized = path.win32.normalize(trimmed).replace(/\\/g, "/").toLowerCase();
  if (normalized === "/" || /^[a-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

export function createIdempotencyKey(input: IdempotencyKeyInput): string {
  const runId = requireNonEmpty(input.run_id, "run_id");
  const stepId = requireNonEmpty(input.step_id, "step_id");
  assertPositiveSafeInteger(input.attempt, "attempt");

  const contentHash = input.content_hash?.trim() || null;
  const baseDocumentVersion = input.base_document_version ?? null;
  if (baseDocumentVersion !== null) {
    assertNonNegativeSafeInteger(baseDocumentVersion, "base_document_version");
  }
  if (baseDocumentVersion === null && contentHash === null) {
    throw invalidInput("Idempotency key requires a base document version or content hash", {
      field: "base_document_version"
    });
  }

  return hashCanonical({
    run_id: runId,
    step_id: stepId,
    attempt: input.attempt,
    action: normalizeIdempotencyAction(input.action),
    target_path: normalizeIdempotencyTargetPath(input.target_path),
    base_document_version: baseDocumentVersion,
    content_hash: contentHash
  });
}

export function resolveIdempotentResult<Result>(
  idempotencyKey: string,
  existing: IdempotencyRecord<Result> | null
): IdempotencyResolution<Result> {
  const normalizedKey = requireNonEmpty(idempotencyKey, "idempotency_key");
  if (existing === null) {
    return Object.freeze({ kind: "execute", idempotency_key: normalizedKey });
  }

  if (existing.idempotency_key !== normalizedKey) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
      "Stored idempotency record does not match the requested key",
      { requested_key: normalizedKey, stored_key: existing.idempotency_key }
    );
  }

  if (existing.state === "started") {
    return Object.freeze({ kind: "in_progress", idempotency_key: normalizedKey });
  }
  return Object.freeze({ kind: "replay", idempotency_key: normalizedKey, result: existing.result });
}

export function createControlOperationFingerprint(request: ControlOperationRequest): string {
  const payloadDigest = request.payload_digest?.trim() || null;
  assertNonNegativeSafeInteger(request.expected_version, "expected_version");

  return hashCanonical({
    operation: normalizeIdempotencyAction(request.operation),
    resource_type: request.resource_type,
    resource_id: requireNonEmpty(request.resource_id, "resource_id"),
    expected_version: request.expected_version,
    payload_digest: payloadDigest
  });
}

export function resolveControlOperation<Result>(
  request: ControlOperationRequest,
  actualVersion: number,
  existing: ControlOperationRecord<Result> | null
): ControlOperationResolution<Result> {
  const operationId = requireNonEmpty(request.operation_id, "operation_id");
  const requestFingerprint = createControlOperationFingerprint(request);

  // Replay must be resolved before CAS because the first execution already advanced the version.
  if (existing !== null) {
    if (existing.operation_id !== operationId || existing.request_fingerprint !== requestFingerprint) {
      throw new IdempotencyInvariantError(
        IDEMPOTENCY_ERROR_CODES.OPERATION_ID_CONFLICT,
        "operation_id was already used for a different control request",
        {
          operation_id: operationId,
          requested_fingerprint: requestFingerprint,
          stored_fingerprint: existing.request_fingerprint
        }
      );
    }
    if (existing.state === "started") {
      return Object.freeze({
        kind: "in_progress",
        operation_id: operationId,
        request_fingerprint: requestFingerprint
      });
    }
    return Object.freeze({
      kind: "replay",
      operation_id: operationId,
      request_fingerprint: requestFingerprint,
      result: existing.result
    });
  }

  return Object.freeze({
    kind: "execute",
    operation_id: operationId,
    request_fingerprint: requestFingerprint,
    expected_version: request.expected_version,
    next_version: nextExecutionVersion(actualVersion, request.expected_version)
  });
}

export function nextStepAttempt(lastAttempt: number, maxAttempts?: number): number {
  assertNonNegativeSafeInteger(lastAttempt, "last_attempt");
  if (lastAttempt === Number.MAX_SAFE_INTEGER) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.ATTEMPT_NOT_MONOTONIC,
      "Step attempt sequence is exhausted",
      { last_attempt: lastAttempt }
    );
  }

  const nextAttempt = lastAttempt + 1;
  if (maxAttempts !== undefined) {
    assertPositiveSafeInteger(maxAttempts, "max_attempts");
    if (nextAttempt > maxAttempts) {
      throw new IdempotencyInvariantError(
        IDEMPOTENCY_ERROR_CODES.ATTEMPT_LIMIT_EXCEEDED,
        `Step attempt ${nextAttempt} exceeds max_attempts ${maxAttempts}`,
        { last_attempt: lastAttempt, next_attempt: nextAttempt, max_attempts: maxAttempts }
      );
    }
  }
  return nextAttempt;
}

export function assertNextStepAttempt(lastAttempt: number, candidateAttempt: number, maxAttempts?: number): void {
  assertPositiveSafeInteger(candidateAttempt, "candidate_attempt");
  const expectedAttempt = nextStepAttempt(lastAttempt, maxAttempts);
  if (candidateAttempt !== expectedAttempt) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.ATTEMPT_NOT_MONOTONIC,
      `Expected step attempt ${expectedAttempt}, received ${candidateAttempt}`,
      { last_attempt: lastAttempt, expected_attempt: expectedAttempt, candidate_attempt: candidateAttempt }
    );
  }
}

export function assertStepAttemptSequence(attempts: readonly number[]): void {
  let lastAttempt = 0;
  for (const attempt of attempts) {
    assertNextStepAttempt(lastAttempt, attempt);
    lastAttempt = attempt;
  }
}

export function nextFencingToken(currentToken: number): number {
  assertNonNegativeSafeInteger(currentToken, "fencing_token");
  if (currentToken === Number.MAX_SAFE_INTEGER) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.FENCING_TOKEN_EXHAUSTED,
      "Fencing token cannot be incremented beyond Number.MAX_SAFE_INTEGER",
      { fencing_token: currentToken }
    );
  }
  return currentToken + 1;
}

export function createRuntimeOwnerLease(input: CreateRuntimeOwnerLeaseInput): RuntimeOwnerLease {
  const runtimeInstanceId = requireNonEmpty(input.runtime_instance_id, "runtime_instance_id");
  assertPositiveSafeInteger(input.fencing_token, "fencing_token");
  const times = createLeaseTimes(input.acquired_at, input.ttl_ms);
  return Object.freeze({
    runtime_instance_id: runtimeInstanceId,
    acquired_at: times.at,
    heartbeat_at: times.at,
    expires_at: times.expires_at,
    fencing_token: input.fencing_token
  });
}

export function acquireRuntimeOwnerLease(
  current: RuntimeOwnerLease | null,
  input: AcquireRuntimeOwnerLeaseInput
): RuntimeOwnerLease {
  if (current !== null && !isRuntimeOwnerLeaseExpired(current, input.acquired_at)) {
    throw leaseHeld(current.runtime_instance_id, current.expires_at, current.fencing_token);
  }
  return createRuntimeOwnerLease({
    ...input,
    fencing_token: nextFencingToken(current?.fencing_token ?? 0)
  });
}

export function renewRuntimeOwnerLease(
  lease: RuntimeOwnerLease,
  input: RenewRuntimeOwnerLeaseInput
): RuntimeOwnerLease {
  assertRuntimeOwnerLeaseAuthority(
    lease,
    input.runtime_instance_id,
    input.fencing_token,
    input.heartbeat_at
  );
  const times = createLeaseTimes(input.heartbeat_at, input.ttl_ms);
  return Object.freeze({
    ...lease,
    heartbeat_at: times.at,
    expires_at: times.expires_at
  });
}

export function isRuntimeOwnerLeaseExpired(
  lease: RuntimeOwnerLease,
  at: Date | string | number
): boolean {
  return isLeaseExpired(lease.expires_at, at);
}

export function canUseRuntimeOwnerLease(
  lease: RuntimeOwnerLease,
  runtimeInstanceId: string,
  fencingToken: number,
  at: Date | string | number
): boolean {
  return (
    lease.runtime_instance_id === runtimeInstanceId.trim() &&
    lease.fencing_token === fencingToken &&
    !isRuntimeOwnerLeaseExpired(lease, at)
  );
}

export function assertRuntimeOwnerLeaseAuthority(
  lease: RuntimeOwnerLease,
  runtimeInstanceId: string,
  fencingToken: number,
  at: Date | string | number
): void {
  assertLeaseAuthority(
    lease.runtime_instance_id,
    lease.fencing_token,
    lease.expires_at,
    runtimeInstanceId,
    fencingToken,
    at
  );
}

export function createWriteLease(input: CreateWriteLeaseInput): WriteLease {
  const owner = requireNonEmpty(input.owner, "lease owner");
  assertPositiveSafeInteger(input.fencing_token, "fencing_token");
  const times = createLeaseTimes(input.acquired_at, input.ttl_ms);
  return Object.freeze({
    target_path: normalizeIdempotencyTargetPath(input.target_path),
    owner,
    acquired_at: times.at,
    heartbeat_at: times.at,
    expires_at: times.expires_at,
    fencing_token: input.fencing_token
  });
}

export function acquireWriteLease(current: WriteLease | null, input: WriteLeaseAcquireInput): WriteLease {
  const targetPath = normalizeIdempotencyTargetPath(input.target_path);
  if (current !== null && current.target_path !== targetPath) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.LEASE_RESOURCE_MISMATCH,
      "Current write lease belongs to a different target path",
      { requested_target_path: targetPath, lease_target_path: current.target_path }
    );
  }
  if (current !== null && !isWriteLeaseExpired(current, input.acquired_at)) {
    throw leaseHeld(current.owner, current.expires_at, current.fencing_token);
  }
  return createWriteLease({
    ...input,
    target_path: targetPath,
    fencing_token: nextFencingToken(current?.fencing_token ?? 0)
  });
}

export function renewWriteLease(lease: WriteLease, input: WriteLeaseRenewInput): WriteLease {
  assertWriteLeaseAuthority(lease, input.owner, input.fencing_token, input.heartbeat_at);
  const times = createLeaseTimes(input.heartbeat_at, input.ttl_ms);
  return Object.freeze({
    ...lease,
    heartbeat_at: times.at,
    expires_at: times.expires_at
  });
}

export function isWriteLeaseExpired(lease: WriteLease, at: Date | string | number): boolean {
  return isLeaseExpired(lease.expires_at, at);
}

export function isWriteLeaseOwnedBy(lease: WriteLease, owner: string): boolean {
  return lease.owner === owner.trim();
}

export function canUseWriteLease(
  lease: WriteLease,
  owner: string,
  fencingToken: number,
  at: Date | string | number
): boolean {
  return isWriteLeaseOwnedBy(lease, owner) && lease.fencing_token === fencingToken && !isWriteLeaseExpired(lease, at);
}

export function assertWriteLeaseAuthority(
  lease: WriteLease,
  owner: string,
  fencingToken: number,
  at: Date | string | number
): void {
  assertLeaseAuthority(lease.owner, lease.fencing_token, lease.expires_at, owner, fencingToken, at);
}

function assertLeaseAuthority(
  leaseOwner: string,
  leaseFencingToken: number,
  expiresAt: string,
  requestedOwner: string,
  requestedFencingToken: number,
  at: Date | string | number
): void {
  const owner = requireNonEmpty(requestedOwner, "lease owner");
  assertPositiveSafeInteger(requestedFencingToken, "fencing_token");
  if (requestedFencingToken < leaseFencingToken) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.STALE_FENCING_TOKEN,
      `Fencing token ${requestedFencingToken} is stale; active token is ${leaseFencingToken}`,
      { requested_fencing_token: requestedFencingToken, active_fencing_token: leaseFencingToken }
    );
  }
  if (requestedFencingToken !== leaseFencingToken) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.FENCING_TOKEN_MISMATCH,
      `Fencing token ${requestedFencingToken} does not match active token ${leaseFencingToken}`,
      { requested_fencing_token: requestedFencingToken, active_fencing_token: leaseFencingToken }
    );
  }
  if (owner !== leaseOwner) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.LEASE_OWNER_MISMATCH,
      "Lease is owned by a different owner",
      { requested_owner: owner, lease_owner: leaseOwner }
    );
  }
  if (isLeaseExpired(expiresAt, at)) {
    throw new IdempotencyInvariantError(
      IDEMPOTENCY_ERROR_CODES.LEASE_EXPIRED,
      "Lease has expired",
      { expires_at: expiresAt }
    );
  }
}

function isLeaseExpired(expiresAt: string, at: Date | string | number): boolean {
  return toTimestamp(at, "lease comparison time") >= toTimestamp(expiresAt, "expires_at");
}

function leaseHeld(owner: string, expiresAt: string, fencingToken: number): IdempotencyInvariantError {
  return new IdempotencyInvariantError(
    IDEMPOTENCY_ERROR_CODES.LEASE_HELD,
    `Lease is held by "${owner}" until ${expiresAt}`,
    { owner, expires_at: expiresAt, fencing_token: fencingToken },
    true
  );
}

function createLeaseTimes(at: Date | string | number, ttlMs: number): Readonly<{ at: string; expires_at: string }> {
  assertPositiveSafeInteger(ttlMs, "ttl_ms");
  const timestamp = toTimestamp(at, "lease timestamp");
  const expiresAt = timestamp + ttlMs;
  if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime())) {
    throw invalidInput("Lease expires_at is outside the supported timestamp range", { expires_at: expiresAt });
  }
  return Object.freeze({
    at: new Date(timestamp).toISOString(),
    expires_at: new Date(expiresAt).toISOString()
  });
}

function hashCanonical(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw invalidInput(`${field} must not be empty`, { field });
  }
  return trimmed;
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative safe integer`, { field, value });
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`${field} must be a positive safe integer`, { field, value });
  }
}

function toTimestamp(value: Date | string | number, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
    throw invalidInput(`Invalid ${field} timestamp`, { field });
  }
  return timestamp;
}

function invalidInput(message: string, detail: Record<string, unknown>): IdempotencyInvariantError {
  return new IdempotencyInvariantError(IDEMPOTENCY_ERROR_CODES.INVALID_INPUT, message, detail);
}
