import { describe, expect, it } from "vitest";
import { EXECUTION_STATE_ERROR_CODES } from "./execution-state-machine.js";
import {
  IDEMPOTENCY_ERROR_CODES,
  acquireRuntimeOwnerLease,
  acquireWriteLease,
  assertNextStepAttempt,
  assertStepAttemptSequence,
  assertRuntimeOwnerLeaseAuthority,
  assertWriteLeaseAuthority,
  canUseRuntimeOwnerLease,
  canUseWriteLease,
  createControlOperationFingerprint,
  createIdempotencyKey,
  createWriteLease,
  isRuntimeOwnerLeaseExpired,
  isWriteLeaseExpired,
  isWriteLeaseOwnedBy,
  nextStepAttempt,
  normalizeIdempotencyAction,
  normalizeIdempotencyTargetPath,
  renewRuntimeOwnerLease,
  renewWriteLease,
  resolveControlOperation,
  resolveIdempotentResult,
  type ControlOperationRequest
} from "./idempotency.js";

const BASE_INPUT = {
  run_id: "run-1",
  step_id: "step-2",
  attempt: 1,
  action: "write_file",
  target_path: "C:/Projects/Novel/chapters/one.md",
  base_document_version: 7
};

const PAUSE_OPERATION: ControlOperationRequest = {
  operation_id: "op-1",
  operation: "pause",
  resource_type: "run",
  resource_id: "run-1",
  expected_version: 4
};

describe("idempotency", () => {
  it("normalizes Windows paths and actions", () => {
    expect(normalizeIdempotencyTargetPath(" C:\\Projects\\Novel\\drafts\\..\\Chapter.MD ")).toBe(
      "c:/projects/novel/chapter.md"
    );
    expect(normalizeIdempotencyTargetPath("C:\\Projects\\Novel\\")).toBe("c:/projects/novel");
    expect(normalizeIdempotencyAction("  WRITE-File  ")).toBe("write_file");
  });

  it("returns the same key for the same normalized input", () => {
    const first = createIdempotencyKey(BASE_INPUT);
    const second = createIdempotencyKey({
      ...BASE_INPUT,
      action: " WRITE-file ",
      target_path: "c:\\projects\\novel\\chapters\\one.md"
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("binds side-effect keys to attempt and base document state", () => {
    expect(createIdempotencyKey({ ...BASE_INPUT, attempt: 2 })).not.toBe(createIdempotencyKey(BASE_INPUT));
    expect(createIdempotencyKey({ ...BASE_INPUT, base_document_version: 8 })).not.toBe(createIdempotencyKey(BASE_INPUT));
    expect(
      createIdempotencyKey({ ...BASE_INPUT, base_document_version: null, content_hash: "sha256:first" })
    ).not.toBe(
      createIdempotencyKey({ ...BASE_INPUT, base_document_version: null, content_hash: "sha256:second" })
    );
  });

  it("requires the first persisted attempt to be 1 and every retry to be contiguous", () => {
    expect(nextStepAttempt(0)).toBe(1);
    expect(nextStepAttempt(1)).toBe(2);
    expect(() => assertNextStepAttempt(1, 1)).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.ATTEMPT_NOT_MONOTONIC })
    );
    expect(() => assertNextStepAttempt(1, 3)).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.ATTEMPT_NOT_MONOTONIC })
    );
    expect(() => nextStepAttempt(2, 2)).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.ATTEMPT_LIMIT_EXCEEDED })
    );
    expect(() => createIdempotencyKey({ ...BASE_INPUT, attempt: 0 })).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.INVALID_INPUT })
    );
    expect(() => assertStepAttemptSequence([1, 2, 3])).not.toThrow();
    expect(() => assertStepAttemptSequence([1, 2, 2])).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.ATTEMPT_NOT_MONOTONIC })
    );
    expect(() => assertStepAttemptSequence([1, 3])).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.ATTEMPT_NOT_MONOTONIC })
    );
  });

  it("replays the first side-effect result and never starts an in-progress duplicate", () => {
    const key = createIdempotencyKey(BASE_INPUT);
    expect(resolveIdempotentResult(key, null)).toEqual({ kind: "execute", idempotency_key: key });
    expect(resolveIdempotentResult(key, { idempotency_key: key, state: "started" })).toEqual({
      kind: "in_progress",
      idempotency_key: key
    });
    expect(resolveIdempotentResult(key, { idempotency_key: key, state: "completed", result: { path: "one.md" } })).toEqual({
      kind: "replay",
      idempotency_key: key,
      result: { path: "one.md" }
    });
  });

  it("resolves operation replay before expected-version CAS", () => {
    const requestFingerprint = createControlOperationFingerprint(PAUSE_OPERATION);
    expect(resolveControlOperation(PAUSE_OPERATION, 4, null)).toEqual({
      kind: "execute",
      operation_id: "op-1",
      request_fingerprint: requestFingerprint,
      expected_version: 4,
      next_version: 5
    });

    expect(
      resolveControlOperation(PAUSE_OPERATION, 5, {
        operation_id: "op-1",
        request_fingerprint: requestFingerprint,
        state: "completed",
        result: { status: "paused", version: 5 }
      })
    ).toEqual({
      kind: "replay",
      operation_id: "op-1",
      request_fingerprint: requestFingerprint,
      result: { status: "paused", version: 5 }
    });
  });

  it("does not execute concurrent or conflicting reuse of an operation id", () => {
    const requestFingerprint = createControlOperationFingerprint(PAUSE_OPERATION);
    expect(
      resolveControlOperation(PAUSE_OPERATION, 4, {
        operation_id: "op-1",
        request_fingerprint: requestFingerprint,
        state: "started"
      })
    ).toMatchObject({ kind: "in_progress", operation_id: "op-1" });

    expect(() =>
      resolveControlOperation(
        { ...PAUSE_OPERATION, operation: "cancel" },
        4,
        { operation_id: "op-1", request_fingerprint: requestFingerprint, state: "started" }
      )
    ).toThrowError(expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.OPERATION_ID_CONFLICT }));
  });

  it("rejects a new operation with a stale expected version", () => {
    expect(() => resolveControlOperation(PAUSE_OPERATION, 5, null)).toThrowError(
      expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.VERSION_CONFLICT })
    );
  });

  it("acquires, renews, and fences a runtime owner lease", () => {
    const first = acquireRuntimeOwnerLease(null, {
      runtime_instance_id: "runtime-1",
      acquired_at: "2026-07-10T00:00:00.000Z",
      ttl_ms: 30_000
    });
    expect(first).toEqual({
      runtime_instance_id: "runtime-1",
      acquired_at: "2026-07-10T00:00:00.000Z",
      heartbeat_at: "2026-07-10T00:00:00.000Z",
      expires_at: "2026-07-10T00:00:30.000Z",
      fencing_token: 1
    });

    const renewed = renewRuntimeOwnerLease(first, {
      runtime_instance_id: "runtime-1",
      fencing_token: 1,
      heartbeat_at: "2026-07-10T00:00:10.000Z",
      ttl_ms: 30_000
    });
    expect(renewed).toMatchObject({
      acquired_at: first.acquired_at,
      heartbeat_at: "2026-07-10T00:00:10.000Z",
      expires_at: "2026-07-10T00:00:40.000Z",
      fencing_token: 1
    });
    expect(canUseRuntimeOwnerLease(renewed, "runtime-1", 1, "2026-07-10T00:00:39.999Z")).toBe(true);
    expect(isRuntimeOwnerLeaseExpired(renewed, "2026-07-10T00:00:40.000Z")).toBe(true);
  });

  it("permits takeover only after expiry and increments the fencing token", () => {
    const first = acquireRuntimeOwnerLease(null, {
      runtime_instance_id: "runtime-1",
      acquired_at: "2026-07-10T00:00:00.000Z",
      ttl_ms: 1_000
    });
    expect(() =>
      acquireRuntimeOwnerLease(first, {
        runtime_instance_id: "runtime-2",
        acquired_at: "2026-07-10T00:00:00.999Z",
        ttl_ms: 1_000
      })
    ).toThrowError(expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.LEASE_HELD }));

    const takeover = acquireRuntimeOwnerLease(first, {
      runtime_instance_id: "runtime-2",
      acquired_at: "2026-07-10T00:00:01.000Z",
      ttl_ms: 1_000
    });
    expect(takeover).toMatchObject({ runtime_instance_id: "runtime-2", fencing_token: 2 });
    expect(() => assertRuntimeOwnerLeaseAuthority(takeover, "runtime-1", 1, "2026-07-10T00:00:01.500Z")).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.STALE_FENCING_TOKEN })
    );
  });

  it("creates a normalized write lease and validates owner plus fencing token", () => {
    const lease = createWriteLease({
      target_path: "C:\\Projects\\Novel\\Chapter.md",
      owner: "run-1:step-2",
      acquired_at: "2026-07-10T00:00:00.000Z",
      ttl_ms: 30_000,
      fencing_token: 7
    });

    expect(lease).toEqual({
      target_path: "c:/projects/novel/chapter.md",
      owner: "run-1:step-2",
      acquired_at: "2026-07-10T00:00:00.000Z",
      heartbeat_at: "2026-07-10T00:00:00.000Z",
      expires_at: "2026-07-10T00:00:30.000Z",
      fencing_token: 7
    });
    expect(isWriteLeaseOwnedBy(lease, "run-1:step-2")).toBe(true);
    expect(canUseWriteLease(lease, "run-1:step-2", 7, "2026-07-10T00:00:29.999Z")).toBe(true);
    expect(canUseWriteLease(lease, "run-1:step-2", 6, "2026-07-10T00:00:29.999Z")).toBe(false);
  });

  it("keeps a fencing token on renewal and rejects use at the expiry boundary", () => {
    const lease = createWriteLease({
      target_path: "chapter.md",
      owner: "run-1",
      acquired_at: "2026-07-10T00:00:00.000Z",
      ttl_ms: 1_000,
      fencing_token: 1
    });
    const renewed = renewWriteLease(lease, {
      owner: "run-1",
      fencing_token: 1,
      heartbeat_at: "2026-07-10T00:00:00.500Z",
      ttl_ms: 1_000
    });

    expect(renewed).toMatchObject({ fencing_token: 1, expires_at: "2026-07-10T00:00:01.500Z" });
    expect(isWriteLeaseExpired(renewed, "2026-07-10T00:00:01.499Z")).toBe(false);
    expect(isWriteLeaseExpired(renewed, "2026-07-10T00:00:01.500Z")).toBe(true);
    expect(() => assertWriteLeaseAuthority(renewed, "run-1", 1, "2026-07-10T00:00:01.500Z")).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.LEASE_EXPIRED })
    );
  });

  it("increments a write fencing token after expiry and rejects a late old commit", () => {
    const first = acquireWriteLease(null, {
      target_path: "chapter.md",
      owner: "run-1",
      acquired_at: "2026-07-10T00:00:00.000Z",
      ttl_ms: 1_000
    });
    const takeover = acquireWriteLease(first, {
      target_path: "CHAPTER.md",
      owner: "run-2",
      acquired_at: "2026-07-10T00:00:01.000Z",
      ttl_ms: 1_000
    });

    expect(takeover).toMatchObject({ owner: "run-2", fencing_token: 2 });
    expect(() => assertWriteLeaseAuthority(takeover, "run-1", 1, "2026-07-10T00:00:01.500Z")).toThrowError(
      expect.objectContaining({ code: IDEMPOTENCY_ERROR_CODES.STALE_FENCING_TOKEN })
    );
  });
});
