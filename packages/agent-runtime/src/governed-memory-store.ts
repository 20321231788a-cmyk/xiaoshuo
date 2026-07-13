import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  validateCoordinateInterval,
  validateNarrativeCoordinate,
  isTimelineNarrativeCoordinate,
  type CanonClaim,
  type UserOverride
} from "./memory-governor.js";
import { sha256StableJson } from "./kernel/confirmation-receipt.js";

export const GOVERNED_MEMORY_STORE_RELATIVE_PATH = path.join("00_设定集", ".agent", "governed_memory.sqlite3");
export const GOVERNED_MEMORY_STORE_SCHEMA_VERSION = 1;

export const GOVERNED_MEMORY_ERROR_CODES = {
  directConfirmedWrite: "MEMORY_DIRECT_CONFIRMED_WRITE",
  claimNotFound: "MEMORY_CLAIM_NOT_FOUND",
  projectMismatch: "MEMORY_PROJECT_MISMATCH",
  sourceRevisionMismatch: "MEMORY_SOURCE_REVISION_MISMATCH",
  confirmationNotFound: "MEMORY_CONFIRMATION_NOT_FOUND",
  confirmationNotApproved: "MEMORY_CONFIRMATION_NOT_APPROVED",
  confirmationExpired: "MEMORY_CONFIRMATION_EXPIRED",
  confirmationScopeMismatch: "MEMORY_CONFIRMATION_SCOPE_MISMATCH",
  confirmationAlreadyConsumed: "MEMORY_CONFIRMATION_ALREADY_CONSUMED",
  confirmationVersionConflict: "MEMORY_CONFIRMATION_VERSION_CONFLICT",
  invalidTransition: "MEMORY_INVALID_TRANSITION"
} as const;

export type GovernedMemoryErrorCode = (typeof GOVERNED_MEMORY_ERROR_CODES)[keyof typeof GOVERNED_MEMORY_ERROR_CODES];

export class GovernedMemoryError extends Error {
  constructor(readonly code: GovernedMemoryErrorCode, message: string) {
    super(message);
    this.name = "GovernedMemoryError";
  }
}

export type GovernedMemoryConfirmationStatus = "requested" | "approved" | "rejected" | "expired" | "consumed";

export type GovernedMemoryConfirmation = {
  confirmation_id: string;
  project_id: string;
  claim_id: string;
  source_revision: number;
  content_hash: string;
  version: number;
  status: GovernedMemoryConfirmationStatus;
  requested_at: string;
  expires_at: string;
  resolved_at: string;
  resolved_by: "" | "user_ui";
  consumed_at: string;
};

export type GovernedMemoryOutboxEvent = {
  event_id: string;
  project_id: string;
  memory_revision: number;
  topic: "claim.created" | "claim.confirmed" | "claim.forgotten" | "override.created" | "override.revoked" | "source.invalidated" | "timeline.anchors_registered" | "timeline.rebased";
  payload: Record<string, unknown>;
  created_at: string;
  published_at: string;
};

export type CreateGovernedMemoryClaimInput = Omit<CanonClaim, "projectUuid" | "revision" | "status"> & {
  status?: Extract<CanonClaim["status"], "draft" | "proposed" | "planned">;
  revision?: number;
};

export type RequestGovernedMemoryConfirmationInput = {
  projectId: string;
  claimId: string;
  sourceRevision: number;
  confirmationId?: string;
  expiresAt?: string;
};

export type ResolveGovernedMemoryConfirmationInput = {
  confirmationId: string;
  expectedVersion: number;
  decision: "approved" | "rejected";
  resolvedAt?: string;
};

export type ConfirmGovernedMemoryClaimInput = {
  projectId: string;
  claimId: string;
  confirmationId: string;
  expectedConfirmationVersion: number;
  confirmedAt?: string;
};

export type CreateGovernedMemoryOverrideInput = {
  projectId: string;
  overrideId?: string;
  override: UserOverride;
  createdAt?: string;
};

export type InvalidateGovernedMemorySourceInput = {
  projectId: string;
  sourceRef: string;
  currentSourceRevision: string;
};

export type GovernedTimelineAnchor = {
  anchorId: string;
  ordinal: number;
};

export type RegisterGovernedTimelineAnchorsInput = {
  projectId: string;
  timelineId: string;
  timelineRevision: number;
  anchors: readonly GovernedTimelineAnchor[];
};

export type RebaseGovernedTimelineClaimsInput = {
  projectId: string;
  timelineId: string;
  fromRevision: number;
  toRevision: number;
};

export type GovernedConversationMemory = {
  projectId: string;
  conversationId: string;
  memoryRevision: number;
  confirmedFacts: string[];
  decisions: string[];
  rejectedOptions: string[];
  userPreferences: string[];
  openTasks: string[];
  currentGoal: string;
  sourceMessageIds: string[];
  updatedAt: string;
};

export type UpsertGovernedConversationMemoryInput = Omit<GovernedConversationMemory, "projectId" | "memoryRevision" | "updatedAt"> & {
  updatedAt?: string;
};

export type GovernedMemoryOverride = UserOverride & {
  override_id: string;
  project_id: string;
  status: "active" | "revoked";
  created_at: string;
  revoked_at: string;
};

export type GovernedMemoryExport = {
  schema_version: number;
  project_id: string;
  memory_revision: number;
  claims: CanonClaim[];
  overrides: GovernedMemoryOverride[];
  confirmations: GovernedMemoryConfirmation[];
  pending_outbox: GovernedMemoryOutboxEvent[];
};

export type GovernedMemoryProjectionStatus = {
  projection_name: "canon_markdown" | "vector_graph";
  project_id: string;
  memory_revision: number;
  status: "pending" | "ready" | "failed";
  content_hash: string;
  updated_at: string;
  error: string;
};

export type GovernedMemoryStoreOptions = {
  now?: () => Date;
};

/**
 * Project-local, durable source of truth for governed memory. It intentionally
 * lives outside the run store: memory must survive run retention and an agent
 * run may only reference its revision, never own the facts themselves.
 */
export class GovernedMemoryStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;

  constructor(projectRoot: string, options: GovernedMemoryStoreOptions = {}) {
    const root = path.resolve(projectRoot);
    this.databasePath = path.join(root, GOVERNED_MEMORY_STORE_RELATIVE_PATH);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.now = options.now ?? (() => new Date());
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  getMemoryRevision(projectId: string): number {
    return this.ensureProject(projectId).memory_revision;
  }

  createClaim(projectId: string, input: CreateGovernedMemoryClaimInput): CanonClaim {
    const status: CanonClaim["status"] = (input as { status?: CanonClaim["status"] }).status ?? "draft";
    if (status === "confirmed") {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.directConfirmedWrite, "未经用户二次确认不能直接创建 confirmed memory");
    }
    const claim: CanonClaim = {
      id: requiredText(input.id, "claim id"),
      projectUuid: requiredText(projectId, "project id"),
      subject: requiredText(input.subject, "subject"),
      predicate: requiredText(input.predicate, "predicate"),
      object: requiredText(input.object, "object"),
      interval: validateCoordinateInterval(input.interval),
      status,
      revision: nonNegativeInteger(input.revision ?? 0, "claim revision"),
      sourceRef: optionalText(input.sourceRef),
      sourceRevision: optionalText(input.sourceRevision),
      evidenceRefs: input.evidenceRefs ? input.evidenceRefs.map((ref) => requiredText(ref, "evidence ref")) : undefined,
      perspective: input.perspective,
      perspectiveEntityId: optionalText(input.perspectiveEntityId),
      confidence: input.confidence === undefined ? undefined : numberInRange(input.confidence, "confidence", 0, 1),
      storyTime: input.storyTime === undefined ? undefined : validateNarrativeCoordinate(input.storyTime)
    };
    this.transaction(() => {
      this.ensureProject(projectId);
      if (this.getClaim(projectId, claim.id)) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.invalidTransition, "memory claim 已存在，不能静默覆盖");
      }
      const now = this.timestamp();
      this.database.prepare(`INSERT INTO governed_memory_claims (
        claim_id, project_id, revision, status, claim_json, created_at, updated_at, forgotten_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '')`).run(
        claim.id, projectId, claim.revision, claim.status, JSON.stringify(claim), now, now
      );
      const revision = this.bumpProjectRevision(projectId);
      this.appendOutbox(projectId, revision, "claim.created", { claim_id: claim.id, claim_revision: claim.revision });
    });
    return cloneClaim(claim);
  }

  getClaim(projectId: string, claimId: string): CanonClaim | null {
    const row = this.database.prepare(`SELECT claim_json FROM governed_memory_claims
      WHERE project_id = ? AND claim_id = ? AND forgotten_at = ''`).get(projectId, claimId) as { claim_json?: unknown } | undefined;
    return row?.claim_json ? parseClaim(row.claim_json) : null;
  }

  listClaims(projectId: string): CanonClaim[] {
    this.ensureProject(projectId);
    return this.database.prepare(`SELECT claim_json FROM governed_memory_claims
      WHERE project_id = ? AND forgotten_at = '' ORDER BY updated_at ASC, claim_id ASC`).all(projectId)
      .map((row) => parseClaim((row as { claim_json?: unknown }).claim_json));
  }

  getConversationMemory(projectId: string, conversationId: string): GovernedConversationMemory | null {
    const row = this.database.prepare(`SELECT summary_json FROM governed_memory_conversation_summaries
      WHERE project_id = ? AND conversation_id = ?`).get(projectId, conversationId) as { summary_json?: unknown } | undefined;
    return row?.summary_json ? parseConversationMemory(row.summary_json) : null;
  }

  upsertConversationMemory(projectId: string, input: UpsertGovernedConversationMemoryInput): GovernedConversationMemory {
    const conversationId = requiredText(input.conversationId, "conversation id");
    let summary: GovernedConversationMemory | null = null;
    this.transaction(() => {
      const revision = this.ensureProject(projectId).memory_revision;
      summary = {
        projectId,
        conversationId,
        memoryRevision: revision,
        confirmedFacts: uniqueTexts(input.confirmedFacts, "confirmed fact"),
        decisions: uniqueTexts(input.decisions, "decision"),
        rejectedOptions: uniqueTexts(input.rejectedOptions, "rejected option"),
        userPreferences: uniqueTexts(input.userPreferences, "user preference"),
        openTasks: uniqueTexts(input.openTasks, "open task"),
        currentGoal: String(input.currentGoal ?? "").trim(),
        sourceMessageIds: uniqueTexts(input.sourceMessageIds, "source message id"),
        updatedAt: input.updatedAt ?? this.timestamp()
      };
      this.database.prepare(`INSERT INTO governed_memory_conversation_summaries (
        project_id, conversation_id, memory_revision, summary_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, conversation_id) DO UPDATE SET
        memory_revision = excluded.memory_revision,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at`).run(
        summary.projectId, summary.conversationId, summary.memoryRevision, JSON.stringify(summary), summary.updatedAt
      );
    });
    return summary!;
  }

  requestConfirmation(input: RequestGovernedMemoryConfirmationInput): GovernedMemoryConfirmation {
    const projectId = requiredText(input.projectId, "project id");
    const claim = this.requireClaim(projectId, input.claimId);
    if (!canConfirm(claim.status)) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.invalidTransition, "只有 draft、proposed 或 planned memory 可以请求确认");
    }
    if (input.sourceRevision !== claim.revision) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.sourceRevisionMismatch, "memory claim 已变更，请重新预览并确认");
    }
    const now = this.timestamp();
    const expiresAt = input.expiresAt ?? new Date(this.now().getTime() + 15 * 60_000).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now)) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationExpired, "memory confirmation 的过期时间无效");
    }
    const receipt: GovernedMemoryConfirmation = {
      confirmation_id: input.confirmationId ?? `memconf_${randomUUID().replace(/-/g, "")}`,
      project_id: projectId,
      claim_id: claim.id,
      source_revision: claim.revision,
      content_hash: claimContentHash(claim),
      version: 1,
      status: "requested",
      requested_at: now,
      expires_at: expiresAt,
      resolved_at: "",
      resolved_by: "",
      consumed_at: ""
    };
    this.transaction(() => {
      this.ensureProject(projectId);
      this.database.prepare(`INSERT INTO governed_memory_confirmations (
        confirmation_id, project_id, claim_id, source_revision, content_hash, version, status,
        requested_at, expires_at, resolved_at, resolved_by, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '')`).run(
        receipt.confirmation_id, receipt.project_id, receipt.claim_id, receipt.source_revision,
        receipt.content_hash, receipt.version, receipt.status, receipt.requested_at, receipt.expires_at
      );
    });
    return receipt;
  }

  resolveConfirmation(input: ResolveGovernedMemoryConfirmationInput): GovernedMemoryConfirmation {
    const receipt = this.requireConfirmation(input.confirmationId);
    if (receipt.version !== input.expectedVersion) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationVersionConflict, "memory confirmation 版本已更新");
    }
    if (receipt.status === "consumed") {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationAlreadyConsumed, "memory confirmation 已被消费");
    }
    if (receipt.status !== "requested") {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationNotApproved, "memory confirmation 不处于待确认状态");
    }
    const now = input.resolvedAt ?? this.timestamp();
    if (Date.parse(receipt.expires_at) <= Date.parse(now)) {
      this.database.prepare(`UPDATE governed_memory_confirmations SET status = 'expired', version = version + 1 WHERE confirmation_id = ? AND version = ?`).run(receipt.confirmation_id, receipt.version);
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationExpired, "memory confirmation 已过期");
    }
    const changed = this.database.prepare(`UPDATE governed_memory_confirmations
      SET status = ?, version = version + 1, resolved_at = ?, resolved_by = 'user_ui'
      WHERE confirmation_id = ? AND version = ? AND status = 'requested'`).run(input.decision, now, receipt.confirmation_id, receipt.version);
    if (Number(changed.changes) !== 1) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationVersionConflict, "memory confirmation 已被并发更新");
    }
    return this.requireConfirmation(receipt.confirmation_id);
  }

  confirmClaim(input: ConfirmGovernedMemoryClaimInput): CanonClaim {
    const projectId = requiredText(input.projectId, "project id");
    let promoted: CanonClaim | null = null;
    this.transaction(() => {
      const receipt = this.requireConfirmation(input.confirmationId);
      if (receipt.project_id !== projectId || receipt.claim_id !== input.claimId) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationScopeMismatch, "memory confirmation 不属于当前项目或 claim");
      }
      if (receipt.version !== input.expectedConfirmationVersion) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationVersionConflict, "memory confirmation 版本已更新");
      }
      if (receipt.status === "consumed") {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationAlreadyConsumed, "memory confirmation 已被消费");
      }
      if (receipt.status !== "approved") {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationNotApproved, "memory confirmation 尚未获得用户批准");
      }
      const now = input.confirmedAt ?? this.timestamp();
      if (Date.parse(receipt.expires_at) <= Date.parse(now)) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationExpired, "memory confirmation 已过期");
      }
      const claim = this.requireClaim(projectId, input.claimId);
      if (!canConfirm(claim.status) || claim.revision !== receipt.source_revision || claimContentHash(claim) !== receipt.content_hash) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationScopeMismatch, "memory claim 已变更，旧确认回执不能复用");
      }
      promoted = { ...claim, status: "confirmed", revision: claim.revision + 1 };
      const claimChanged = this.database.prepare(`UPDATE governed_memory_claims
        SET revision = ?, status = 'confirmed', claim_json = ?, updated_at = ?
        WHERE project_id = ? AND claim_id = ? AND revision = ? AND forgotten_at = ''`).run(
        promoted.revision, JSON.stringify(promoted), now, projectId, promoted.id, claim.revision
      );
      if (Number(claimChanged.changes) !== 1) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.sourceRevisionMismatch, "memory claim 已被并发更新");
      }
      const receiptChanged = this.database.prepare(`UPDATE governed_memory_confirmations
        SET status = 'consumed', version = version + 1, consumed_at = ?
        WHERE confirmation_id = ? AND version = ? AND status = 'approved'`).run(now, receipt.confirmation_id, receipt.version);
      if (Number(receiptChanged.changes) !== 1) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationVersionConflict, "memory confirmation 已被并发消费");
      }
      const memoryRevision = this.bumpProjectRevision(projectId);
      this.appendOutbox(projectId, memoryRevision, "claim.confirmed", {
        claim_id: promoted.id,
        claim_revision: promoted.revision,
        confirmation_id: receipt.confirmation_id
      });
    });
    return cloneClaim(promoted!);
  }

  forgetClaim(projectId: string, claimId: string): CanonClaim {
    let forgotten: CanonClaim | null = null;
    this.transaction(() => {
      const claim = this.requireClaim(projectId, claimId);
      forgotten = { ...claim, status: "superseded", revision: claim.revision + 1 };
      const now = this.timestamp();
      const changed = this.database.prepare(`UPDATE governed_memory_claims
        SET revision = ?, status = 'superseded', claim_json = ?, updated_at = ?, forgotten_at = ?
        WHERE project_id = ? AND claim_id = ? AND revision = ? AND forgotten_at = ''`).run(
        forgotten.revision, JSON.stringify(forgotten), now, now, projectId, claimId, claim.revision
      );
      if (Number(changed.changes) !== 1) {
        throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.sourceRevisionMismatch, "memory claim 已被并发更新");
      }
      const memoryRevision = this.bumpProjectRevision(projectId);
      this.appendOutbox(projectId, memoryRevision, "claim.forgotten", { claim_id: claimId, claim_revision: forgotten.revision });
    });
    return cloneClaim(forgotten!);
  }

  /**
   * Source replacement does not delete history. Claims derived from an older
   * version become superseded and projections receive one ordered outbox event.
   */
  invalidateSource(input: InvalidateGovernedMemorySourceInput): CanonClaim[] {
    const projectId = requiredText(input.projectId, "project id");
    const sourceRef = requiredText(input.sourceRef, "source ref");
    const currentSourceRevision = requiredText(input.currentSourceRevision, "source revision");
    const invalidated: CanonClaim[] = [];
    this.transaction(() => {
      this.ensureProject(projectId);
      const candidates = this.database.prepare(`SELECT claim_json FROM governed_memory_claims
        WHERE project_id = ? AND forgotten_at = ''`).all(projectId)
        .map((row) => parseClaim((row as { claim_json?: unknown }).claim_json));
      const now = this.timestamp();
      for (const claim of candidates) {
        if (claim.sourceRef !== sourceRef || !claim.sourceRevision || claim.sourceRevision === currentSourceRevision || claim.status === "superseded") {
          continue;
        }
        const superseded: CanonClaim = { ...claim, status: "superseded", revision: claim.revision + 1 };
        const changed = this.database.prepare(`UPDATE governed_memory_claims
          SET revision = ?, status = 'superseded', claim_json = ?, updated_at = ?
          WHERE project_id = ? AND claim_id = ? AND revision = ? AND forgotten_at = ''`).run(
          superseded.revision, JSON.stringify(superseded), now, projectId, claim.id, claim.revision
        );
        if (Number(changed.changes) === 1) {
          invalidated.push(superseded);
        }
      }
      if (invalidated.length) {
        const memoryRevision = this.bumpProjectRevision(projectId);
        this.appendOutbox(projectId, memoryRevision, "source.invalidated", {
          source_ref: sourceRef,
          current_source_revision: currentSourceRevision,
          claim_ids: invalidated.map((claim) => claim.id)
        });
      }
    });
    return invalidated.map(cloneClaim);
  }

  registerTimelineAnchors(input: RegisterGovernedTimelineAnchorsInput): number {
    const projectId = requiredText(input.projectId, "project id");
    const timelineId = requiredText(input.timelineId, "timeline id");
    const revision = nonNegativeInteger(input.timelineRevision, "timeline revision");
    const anchors = normalizeAnchors(input.anchors);
    this.transaction(() => {
      this.ensureProject(projectId);
      this.database.prepare(`DELETE FROM governed_memory_timeline_anchors
        WHERE project_id = ? AND timeline_id = ? AND timeline_revision = ?`).run(projectId, timelineId, revision);
      const insertedAt = this.timestamp();
      const insert = this.database.prepare(`INSERT INTO governed_memory_timeline_anchors (
        project_id, timeline_id, timeline_revision, anchor_id, ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const anchor of anchors) {
        insert.run(projectId, timelineId, revision, anchor.anchorId, anchor.ordinal, insertedAt);
      }
      const memoryRevision = this.bumpProjectRevision(projectId);
      this.appendOutbox(projectId, memoryRevision, "timeline.anchors_registered", {
        timeline_id: timelineId,
        timeline_revision: revision,
        anchor_count: anchors.length
      });
    });
    return this.getMemoryRevision(projectId);
  }

  rebaseTimelineClaims(input: RebaseGovernedTimelineClaimsInput): CanonClaim[] {
    const projectId = requiredText(input.projectId, "project id");
    const timelineId = requiredText(input.timelineId, "timeline id");
    const fromRevision = nonNegativeInteger(input.fromRevision, "from timeline revision");
    const toRevision = nonNegativeInteger(input.toRevision, "to timeline revision");
    if (fromRevision === toRevision) {
      return [];
    }
    const targetAnchors = new Map(
      this.database.prepare(`SELECT anchor_id, ordinal FROM governed_memory_timeline_anchors
        WHERE project_id = ? AND timeline_id = ? AND timeline_revision = ?`).all(projectId, timelineId, toRevision)
        .map((row) => {
          const raw = row as { anchor_id?: unknown; ordinal?: unknown };
          return [requiredText(raw.anchor_id, "anchor id"), nonNegativeInteger(raw.ordinal, "anchor ordinal")] as const;
        })
    );
    if (!targetAnchors.size) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.invalidTransition, "目标 timeline revision 未注册 anchor，拒绝重基准");
    }
    const candidates = this.database.prepare(`SELECT claim_json FROM governed_memory_claims
      WHERE project_id = ? AND forgotten_at = ''`).all(projectId)
      .map((row) => parseClaim((row as { claim_json?: unknown }).claim_json));
    const rebased = candidates.map((claim) => rebaseClaim(claim, timelineId, fromRevision, toRevision, targetAnchors));
    const changed = rebased.filter((entry): entry is CanonClaim => entry !== null);
    if (!changed.length) {
      return [];
    }
    this.transaction(() => {
      this.ensureProject(projectId);
      const now = this.timestamp();
      for (const claim of changed) {
        const previous = this.requireClaim(projectId, claim.id);
        const update = this.database.prepare(`UPDATE governed_memory_claims
          SET revision = ?, claim_json = ?, updated_at = ?
          WHERE project_id = ? AND claim_id = ? AND revision = ? AND forgotten_at = ''`).run(
          claim.revision, JSON.stringify(claim), now, projectId, claim.id, previous.revision
        );
        if (Number(update.changes) !== 1) {
          throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.sourceRevisionMismatch, "claim 在 timeline 重基准期间发生变化");
        }
      }
      const memoryRevision = this.bumpProjectRevision(projectId);
      this.appendOutbox(projectId, memoryRevision, "timeline.rebased", {
        timeline_id: timelineId,
        from_timeline_revision: fromRevision,
        to_timeline_revision: toRevision,
        claim_ids: changed.map((claim) => claim.id)
      });
    });
    return changed.map(cloneClaim);
  }

  createOverride(input: CreateGovernedMemoryOverrideInput): GovernedMemoryOverride {
    const projectId = requiredText(input.projectId, "project id");
    const claim = this.requireClaim(projectId, input.override.claimId);
    if (input.override.overrideStatus === "confirmed" && claim.status !== "confirmed") {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.directConfirmedWrite, "override 不能绕过二次确认把 draft memory 提升为 confirmed");
    }
    const value: GovernedMemoryOverride = {
      ...cloneJson(input.override),
      override_id: input.overrideId ?? `memovr_${randomUUID().replace(/-/g, "")}`,
      project_id: projectId,
      status: "active",
      created_at: input.createdAt ?? this.timestamp(),
      revoked_at: ""
    };
    this.transaction(() => {
      this.ensureProject(projectId);
      this.database.prepare(`INSERT INTO governed_memory_overrides (
        override_id, project_id, claim_id, status, override_json, created_at, revoked_at
      ) VALUES (?, ?, ?, 'active', ?, ?, '')`).run(
        value.override_id, projectId, value.claimId, JSON.stringify(value), value.created_at
      );
      const memoryRevision = this.bumpProjectRevision(projectId);
      this.appendOutbox(projectId, memoryRevision, "override.created", { override_id: value.override_id, claim_id: value.claimId });
    });
    return cloneJson(value);
  }

  revokeOverride(projectId: string, overrideId: string): GovernedMemoryOverride {
    const current = this.database.prepare(`SELECT override_json FROM governed_memory_overrides
      WHERE project_id = ? AND override_id = ?`).get(projectId, overrideId) as { override_json?: unknown } | undefined;
    if (!current?.override_json) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.claimNotFound, "memory override 不存在");
    }
    const override = parseOverride(current.override_json);
    if (override.status === "revoked") {
      return override;
    }
    const revoked = { ...override, status: "revoked" as const, revoked_at: this.timestamp() };
    this.transaction(() => {
      this.database.prepare(`UPDATE governed_memory_overrides SET status = 'revoked', override_json = ?, revoked_at = ?
        WHERE project_id = ? AND override_id = ? AND status = 'active'`).run(JSON.stringify(revoked), revoked.revoked_at, projectId, overrideId);
      const memoryRevision = this.bumpProjectRevision(projectId);
      this.appendOutbox(projectId, memoryRevision, "override.revoked", { override_id: overrideId, claim_id: override.claimId });
    });
    return revoked;
  }

  listOverrides(projectId: string, includeRevoked = false): GovernedMemoryOverride[] {
    this.ensureProject(projectId);
    const query = includeRevoked
      ? "SELECT override_json FROM governed_memory_overrides WHERE project_id = ? ORDER BY created_at ASC, override_id ASC"
      : "SELECT override_json FROM governed_memory_overrides WHERE project_id = ? AND status = 'active' ORDER BY created_at ASC, override_id ASC";
    return this.database.prepare(query).all(projectId).map((row) => parseOverride((row as { override_json?: unknown }).override_json));
  }

  listOutbox(projectId: string, unpublishedOnly = true): GovernedMemoryOutboxEvent[] {
    this.ensureProject(projectId);
    const query = unpublishedOnly
      ? "SELECT * FROM governed_memory_outbox WHERE project_id = ? AND published_at = '' ORDER BY memory_revision ASC, event_id ASC"
      : "SELECT * FROM governed_memory_outbox WHERE project_id = ? ORDER BY memory_revision ASC, event_id ASC";
    return this.database.prepare(query).all(projectId).map((row) => parseOutbox(row));
  }

  markOutboxPublished(projectId: string, eventIds: readonly string[], publishedAt = this.timestamp()): number {
    if (!eventIds.length) {
      return 0;
    }
    this.ensureProject(projectId);
    let count = 0;
    for (const eventId of eventIds) {
      const changed = this.database.prepare(`UPDATE governed_memory_outbox SET published_at = ?
        WHERE project_id = ? AND event_id = ? AND published_at = ''`).run(publishedAt, projectId, eventId);
      count += Number(changed.changes);
    }
    return count;
  }

  exportProject(projectId: string): GovernedMemoryExport {
    return {
      schema_version: GOVERNED_MEMORY_STORE_SCHEMA_VERSION,
      project_id: projectId,
      memory_revision: this.getMemoryRevision(projectId),
      claims: this.listClaims(projectId),
      overrides: this.listOverrides(projectId, true),
      confirmations: this.database.prepare("SELECT * FROM governed_memory_confirmations WHERE project_id = ? ORDER BY requested_at ASC, confirmation_id ASC")
        .all(projectId).map(parseConfirmation),
      pending_outbox: this.listOutbox(projectId, true)
    };
  }

  listProjectionStatuses(projectId: string): GovernedMemoryProjectionStatus[] {
    this.ensureProject(projectId);
    return this.database.prepare(`SELECT * FROM governed_memory_projection_status
      WHERE project_id = ? ORDER BY projection_name ASC`).all(projectId).map(parseProjectionStatus);
  }

  markProjectionReady(
    projectId: string,
    projectionName: GovernedMemoryProjectionStatus["projection_name"],
    memoryRevision: number,
    contentHash: string
  ): GovernedMemoryProjectionStatus {
    const current = this.getMemoryRevision(projectId);
    if (memoryRevision !== current) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.sourceRevisionMismatch, "记忆投影已过期，拒绝标记为当前版本");
    }
    const updatedAt = this.timestamp();
    this.database.prepare(`INSERT INTO governed_memory_projection_status (
      project_id, projection_name, memory_revision, status, content_hash, updated_at, error
    ) VALUES (?, ?, ?, 'ready', ?, ?, '')
    ON CONFLICT(project_id, projection_name) DO UPDATE SET
      memory_revision = excluded.memory_revision, status = excluded.status,
      content_hash = excluded.content_hash, updated_at = excluded.updated_at, error = ''`).run(
      projectId, projectionName, memoryRevision, requiredText(contentHash, "projection content hash"), updatedAt
    );
    return this.listProjectionStatuses(projectId).find((item) => item.projection_name === projectionName)!;
  }

  markProjectionFailed(projectId: string, projectionName: GovernedMemoryProjectionStatus["projection_name"], error: string): void {
    const revision = this.getMemoryRevision(projectId);
    this.database.prepare(`INSERT INTO governed_memory_projection_status (
      project_id, projection_name, memory_revision, status, content_hash, updated_at, error
    ) VALUES (?, ?, ?, 'failed', '', ?, ?)
    ON CONFLICT(project_id, projection_name) DO UPDATE SET
      memory_revision = excluded.memory_revision, status = excluded.status,
      content_hash = '', updated_at = excluded.updated_at, error = excluded.error`).run(
      projectId, projectionName, revision, this.timestamp(), String(error || "projection failed")
    );
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS governed_memory_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS governed_memory_projects (
        project_id TEXT PRIMARY KEY,
        memory_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS governed_memory_claims (
        claim_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        claim_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        forgotten_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES governed_memory_projects(project_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_governed_memory_claims_project ON governed_memory_claims (project_id, forgotten_at, updated_at, claim_id);
      CREATE TABLE IF NOT EXISTS governed_memory_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT NOT NULL DEFAULT '',
        resolved_by TEXT NOT NULL DEFAULT '',
        consumed_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES governed_memory_projects(project_id) ON DELETE CASCADE,
        FOREIGN KEY (claim_id) REFERENCES governed_memory_claims(claim_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_governed_memory_confirmations_claim ON governed_memory_confirmations (project_id, claim_id, status, expires_at);
      CREATE TABLE IF NOT EXISTS governed_memory_overrides (
        override_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        status TEXT NOT NULL,
        override_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES governed_memory_projects(project_id) ON DELETE CASCADE,
        FOREIGN KEY (claim_id) REFERENCES governed_memory_claims(claim_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_governed_memory_overrides_claim ON governed_memory_overrides (project_id, claim_id, status, created_at);
      CREATE TABLE IF NOT EXISTS governed_memory_outbox (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        memory_revision INTEGER NOT NULL,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES governed_memory_projects(project_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_governed_memory_outbox_pending ON governed_memory_outbox (project_id, published_at, created_at, event_id);
      CREATE TABLE IF NOT EXISTS governed_memory_timeline_anchors (
        project_id TEXT NOT NULL,
        timeline_id TEXT NOT NULL,
        timeline_revision INTEGER NOT NULL,
        anchor_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, timeline_id, timeline_revision, anchor_id),
        FOREIGN KEY (project_id) REFERENCES governed_memory_projects(project_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_governed_memory_timeline_anchors_lookup
        ON governed_memory_timeline_anchors (project_id, timeline_id, timeline_revision, ordinal);
      CREATE TABLE IF NOT EXISTS governed_memory_conversation_summaries (
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        memory_revision INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, conversation_id),
        FOREIGN KEY (project_id) REFERENCES governed_memory_projects(project_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_governed_memory_conversation_summaries_revision
        ON governed_memory_conversation_summaries (project_id, memory_revision, updated_at);
      CREATE TABLE IF NOT EXISTS governed_memory_projection_status (
        project_id TEXT NOT NULL,
        projection_name TEXT NOT NULL,
        memory_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (project_id, projection_name),
        FOREIGN KEY (project_id) REFERENCES governed_memory_projects(project_id) ON DELETE CASCADE
      );
    `);
    this.database.prepare("INSERT OR IGNORE INTO governed_memory_schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(GOVERNED_MEMORY_STORE_SCHEMA_VERSION, this.timestamp());
  }

  private ensureProject(projectId: string): { memory_revision: number } {
    const id = requiredText(projectId, "project id");
    const existing = this.database.prepare("SELECT memory_revision FROM governed_memory_projects WHERE project_id = ?").get(id) as { memory_revision?: unknown } | undefined;
    if (existing) {
      return { memory_revision: nonNegativeInteger(existing.memory_revision, "memory revision") };
    }
    const now = this.timestamp();
    this.database.prepare("INSERT OR IGNORE INTO governed_memory_projects (project_id, memory_revision, created_at, updated_at) VALUES (?, 0, ?, ?)")
      .run(id, now, now);
    return { memory_revision: 0 };
  }

  private requireClaim(projectId: string, claimId: string): CanonClaim {
    const claim = this.getClaim(projectId, claimId);
    if (!claim) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.claimNotFound, "当前项目不存在该 memory claim");
    }
    return claim;
  }

  private requireConfirmation(confirmationId: string): GovernedMemoryConfirmation {
    const row = this.database.prepare("SELECT * FROM governed_memory_confirmations WHERE confirmation_id = ?").get(confirmationId);
    if (!row) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.confirmationNotFound, "memory confirmation 不存在");
    }
    return parseConfirmation(row);
  }

  private bumpProjectRevision(projectId: string): number {
    const changed = this.database.prepare(`UPDATE governed_memory_projects
      SET memory_revision = memory_revision + 1, updated_at = ? WHERE project_id = ?`).run(this.timestamp(), projectId);
    if (Number(changed.changes) !== 1) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.projectMismatch, "memory project 不存在");
    }
    const revision = this.ensureProject(projectId).memory_revision;
    this.markProjectionPending(projectId, revision);
    return revision;
  }

  private markProjectionPending(projectId: string, revision: number): void {
    const updatedAt = this.timestamp();
    const statement = this.database.prepare(`INSERT INTO governed_memory_projection_status (
      project_id, projection_name, memory_revision, status, content_hash, updated_at, error
    ) VALUES (?, ?, ?, 'pending', '', ?, '')
    ON CONFLICT(project_id, projection_name) DO UPDATE SET
      memory_revision = excluded.memory_revision, status = 'pending',
      content_hash = '', updated_at = excluded.updated_at, error = ''`);
    statement.run(projectId, "canon_markdown", revision, updatedAt);
    statement.run(projectId, "vector_graph", revision, updatedAt);
  }

  private appendOutbox(projectId: string, revision: number, topic: GovernedMemoryOutboxEvent["topic"], payload: Record<string, unknown>): void {
    this.database.prepare(`INSERT INTO governed_memory_outbox (
      event_id, project_id, memory_revision, topic, payload_json, created_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, '')`).run(
      `memout_${randomUUID().replace(/-/g, "")}`, projectId, revision, topic, JSON.stringify(payload), this.timestamp()
    );
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function canConfirm(status: CanonClaim["status"]): boolean {
  return status === "draft" || status === "proposed" || status === "planned";
}

function claimContentHash(claim: CanonClaim): string {
  return sha256StableJson({
    id: claim.id,
    projectUuid: claim.projectUuid,
    subject: claim.subject,
    predicate: claim.predicate,
    object: claim.object,
    interval: claim.interval,
    status: claim.status,
    revision: claim.revision
  });
}

function parseClaim(value: unknown): CanonClaim {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("governed memory claim payload is invalid");
  }
  const raw = parsed as Partial<CanonClaim>;
  const status = raw.status;
  if (!status || !["draft", "proposed", "confirmed", "planned", "rejected", "superseded"].includes(status)) {
    throw new Error("governed memory claim status is invalid");
  }
  return {
    id: requiredText(raw.id, "claim id"),
    projectUuid: requiredText(raw.projectUuid, "project id"),
    subject: requiredText(raw.subject, "subject"),
    predicate: requiredText(raw.predicate, "predicate"),
    object: requiredText(raw.object, "object"),
    interval: validateCoordinateInterval(raw.interval),
    status,
    revision: nonNegativeInteger(raw.revision, "claim revision"),
    sourceRef: optionalText(raw.sourceRef),
    sourceRevision: optionalText(raw.sourceRevision),
    evidenceRefs: Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.map((ref) => requiredText(ref, "evidence ref")) : undefined,
    perspective: raw.perspective === "objective" || raw.perspective === "narrator" || raw.perspective === "character" || raw.perspective === "rumor"
      ? raw.perspective
      : undefined,
    perspectiveEntityId: optionalText(raw.perspectiveEntityId),
    confidence: raw.confidence === undefined ? undefined : numberInRange(raw.confidence, "confidence", 0, 1),
    storyTime: raw.storyTime === undefined ? undefined : validateNarrativeCoordinate(raw.storyTime)
  };
}

function parseConfirmation(value: unknown): GovernedMemoryConfirmation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("governed memory confirmation payload is invalid");
  }
  const raw = value as Record<string, unknown>;
  const status = requiredText(raw.status, "confirmation status") as GovernedMemoryConfirmationStatus;
  if (!["requested", "approved", "rejected", "expired", "consumed"].includes(status)) {
    throw new Error("governed memory confirmation status is invalid");
  }
  return {
    confirmation_id: requiredText(raw.confirmation_id, "confirmation id"),
    project_id: requiredText(raw.project_id, "project id"),
    claim_id: requiredText(raw.claim_id, "claim id"),
    source_revision: nonNegativeInteger(raw.source_revision, "source revision"),
    content_hash: requiredText(raw.content_hash, "content hash"),
    version: positiveInteger(raw.version, "confirmation version"),
    status,
    requested_at: requiredText(raw.requested_at, "requested at"),
    expires_at: requiredText(raw.expires_at, "expires at"),
    resolved_at: stringValue(raw.resolved_at),
    resolved_by: raw.resolved_by === "user_ui" ? "user_ui" : "",
    consumed_at: stringValue(raw.consumed_at)
  };
}

function parseOverride(value: unknown): GovernedMemoryOverride {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("governed memory override payload is invalid");
  }
  const raw = parsed as Record<string, unknown>;
  return {
    claimId: requiredText(raw.claimId, "claim id"),
    overrideObject: raw.overrideObject === undefined ? undefined : String(raw.overrideObject),
    overrideStatus: raw.overrideStatus as UserOverride["overrideStatus"],
    overrideInterval: raw.overrideInterval && typeof raw.overrideInterval === "object" && !Array.isArray(raw.overrideInterval)
      ? validateCoordinateInterval(raw.overrideInterval)
      : undefined,
    override_id: requiredText(raw.override_id, "override id"),
    project_id: requiredText(raw.project_id, "project id"),
    status: raw.status === "revoked" ? "revoked" : "active",
    created_at: requiredText(raw.created_at, "created at"),
    revoked_at: stringValue(raw.revoked_at)
  };
}

function parseProjectionStatus(value: unknown): GovernedMemoryProjectionStatus {
  if (!value || typeof value !== "object") {
    throw new Error("governed memory projection status is invalid");
  }
  const raw = value as Record<string, unknown>;
  const projectionName = requiredText(raw.projection_name, "projection name");
  if (projectionName !== "canon_markdown" && projectionName !== "vector_graph") {
    throw new Error("governed memory projection name is invalid");
  }
  const status = requiredText(raw.status, "projection status");
  if (status !== "pending" && status !== "ready" && status !== "failed") {
    throw new Error("governed memory projection state is invalid");
  }
  return {
    projection_name: projectionName,
    project_id: requiredText(raw.project_id, "project id"),
    memory_revision: nonNegativeInteger(raw.memory_revision, "memory revision"),
    status,
    content_hash: stringValue(raw.content_hash),
    updated_at: requiredText(raw.updated_at, "projection updated at"),
    error: stringValue(raw.error)
  };
}

function parseOutbox(value: unknown): GovernedMemoryOutboxEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("governed memory outbox payload is invalid");
  }
  const raw = value as Record<string, unknown>;
  const topic = requiredText(raw.topic, "outbox topic") as GovernedMemoryOutboxEvent["topic"];
  if (!["claim.created", "claim.confirmed", "claim.forgotten", "override.created", "override.revoked", "source.invalidated", "timeline.anchors_registered", "timeline.rebased"].includes(topic)) {
    throw new Error("governed memory outbox topic is invalid");
  }
  const payload = typeof raw.payload_json === "string" ? JSON.parse(raw.payload_json) : raw.payload_json;
  return {
    event_id: requiredText(raw.event_id, "event id"),
    project_id: requiredText(raw.project_id, "project id"),
    memory_revision: nonNegativeInteger(raw.memory_revision, "memory revision"),
    topic,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {},
    created_at: requiredText(raw.created_at, "created at"),
    published_at: stringValue(raw.published_at)
  };
}

function parseConversationMemory(value: unknown): GovernedConversationMemory {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("governed conversation memory payload is invalid");
  }
  const raw = parsed as Record<string, unknown>;
  return {
    projectId: requiredText(raw.projectId, "project id"),
    conversationId: requiredText(raw.conversationId, "conversation id"),
    memoryRevision: nonNegativeInteger(raw.memoryRevision, "memory revision"),
    confirmedFacts: uniqueTexts(raw.confirmedFacts, "confirmed fact"),
    decisions: uniqueTexts(raw.decisions, "decision"),
    rejectedOptions: uniqueTexts(raw.rejectedOptions, "rejected option"),
    userPreferences: uniqueTexts(raw.userPreferences, "user preference"),
    openTasks: uniqueTexts(raw.openTasks, "open task"),
    currentGoal: stringValue(raw.currentGoal).trim(),
    sourceMessageIds: uniqueTexts(raw.sourceMessageIds, "source message id"),
    updatedAt: requiredText(raw.updatedAt, "updated at")
  };
}

function cloneClaim(claim: CanonClaim): CanonClaim {
  return cloneJson(claim);
}

function normalizeAnchors(value: readonly GovernedTimelineAnchor[]): GovernedTimelineAnchor[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.invalidTransition, "timeline anchor 列表不能为空");
  }
  const seen = new Set<string>();
  return value.map((anchor) => {
    const anchorId = requiredText(anchor.anchorId, "anchor id");
    if (seen.has(anchorId)) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.invalidTransition, "timeline anchor 不能重复");
    }
    seen.add(anchorId);
    return { anchorId, ordinal: nonNegativeInteger(anchor.ordinal, "anchor ordinal") };
  });
}

function rebaseClaim(
  claim: CanonClaim,
  timelineId: string,
  fromRevision: number,
  toRevision: number,
  targetAnchors: ReadonlyMap<string, number>
): CanonClaim | null {
  let changed = false;
  const rebase = (coordinate: CanonClaim["storyTime"]): CanonClaim["storyTime"] => {
    if (!coordinate || !isTimelineNarrativeCoordinate(coordinate) || coordinate.timelineId !== timelineId || coordinate.timelineRevision !== fromRevision) {
      return coordinate ? cloneJson(coordinate) : undefined;
    }
    const ordinal = targetAnchors.get(coordinate.anchorId);
    if (ordinal === undefined) {
      throw new GovernedMemoryError(GOVERNED_MEMORY_ERROR_CODES.invalidTransition, `目标 timeline revision 缺少 anchor ${coordinate.anchorId}`);
    }
    changed = true;
    return { ...coordinate, timelineRevision: toRevision, ordinal };
  };
  const interval = {
    from: rebase(claim.interval.from),
    to: rebase(claim.interval.to)
  };
  const storyTime = rebase(claim.storyTime);
  if (!changed) {
    return null;
  }
  return {
    ...cloneClaim(claim),
    interval,
    storyTime,
    revision: claim.revision + 1
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredText(value: unknown, label: string): string {
  const text = stringValue(value).trim();
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function optionalText(value: unknown): string | undefined {
  const text = stringValue(value).trim();
  return text || undefined;
}

function numberInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function uniqueTexts(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} list must be an array`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = requiredText(entry, label);
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function positiveInteger(value: unknown, label: string): number {
  const number = nonNegativeInteger(value, label);
  if (number < 1) {
    throw new Error(`${label} must be positive`);
  }
  return number;
}
