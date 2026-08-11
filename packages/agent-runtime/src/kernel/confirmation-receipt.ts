import type { AgentConfirmationTargetBinding } from "@xiaoshuo/shared";
import { createHash } from "node:crypto";

export const CONFIRMATION_RECEIPT_CODES = {
  required: "CONFIRMATION_REQUIRED",
  legacyUnscoped: "CONFIRMATION_LEGACY_UNSCOPED",
  notApproved: "CONFIRMATION_NOT_APPROVED",
  scopeMismatch: "CONFIRMATION_SCOPE_MISMATCH",
  actionMismatch: "CONFIRMATION_ACTION_MISMATCH",
  projectMismatch: "CONFIRMATION_PROJECT_MISMATCH",
  targetMismatch: "CONFIRMATION_TARGET_MISMATCH",
  hashMismatch: "CONFIRMATION_HASH_MISMATCH",
  versionMismatch: "CONFIRMATION_VERSION_MISMATCH",
  expired: "CONFIRMATION_EXPIRED",
  alreadyConsumed: "CONFIRMATION_ALREADY_CONSUMED"
} as const;

export type ConfirmationReceiptCode =
  (typeof CONFIRMATION_RECEIPT_CODES)[keyof typeof CONFIRMATION_RECEIPT_CODES];

export class ConfirmationReceiptError extends Error {
  constructor(
    readonly code: ConfirmationReceiptCode,
    message: string
  ) {
    super(message);
    this.name = "ConfirmationReceiptError";
  }
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function sha256StableJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function sameTargetBindings(
  left: readonly AgentConfirmationTargetBinding[],
  right: readonly AgentConfirmationTargetBinding[]
): boolean {
  return stableJson(sortTargetBindings(left)) === stableJson(sortTargetBindings(right));
}

function sortTargetBindings(
  bindings: readonly AgentConfirmationTargetBinding[]
): AgentConfirmationTargetBinding[] {
  return [...bindings].sort((left, right) => {
    const canonical = left.canonical_path.localeCompare(right.canonical_path);
    return canonical || left.path.localeCompare(right.path);
  });
}
