import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DocumentService } from "@xiaoshuo/document-service";
import { MANIFEST_REL_PATH, parseProjectId, readExistingProjectId } from "@xiaoshuo/project-manifest";
import type { DocumentContent } from "@xiaoshuo/shared";
import path from "node:path";
import type {
  ExecutionCommitJournalEntry,
  ExecutionStorePort,
  ExecutionWriteLease
} from "./execution-store-port.js";

export type CommitJournalWriteInput = {
  runId: string;
  stepId: string;
  attemptId: string;
  action: string;
  targetPath: string;
  content: string;
  idempotencyKey: string;
  source?: string;
  summary?: string;
  documentVersion?: number;
};

export type CommitJournalWriteResult = {
  journal: ExecutionCommitJournalEntry;
  document: DocumentContent;
  replayed: boolean;
};

export type CommitJournalRecoveryResult = {
  journalId: string;
  outcome: "finalized_new" | "finalized_old" | "recovery_required" | "lease_held";
};

export type CommitJournalServiceOptions = {
  store: ExecutionStorePort;
  projectRoot: string;
  documents?: DocumentService;
  now?: () => Date;
  idFactory?: () => string;
  leaseDurationMs?: number;
  /** Test seam for deterministic crash-boundary verification. */
  afterStage?: (stage: "temp_written" | "file_replaced", journal: ExecutionCommitJournalEntry) => void | Promise<void>;
};

export class CommitJournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The only v2 single-document write path. It records durable intent before
 * touching disk and keeps the document service responsible for path checks,
 * conflict detection, and timeline entries.
 */
export class CommitJournalService {
  private readonly store: ExecutionStorePort;
  private readonly documents: DocumentService;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly leaseDurationMs: number;
  private readonly afterStage?: CommitJournalServiceOptions["afterStage"];

  constructor(options: CommitJournalServiceOptions) {
    this.store = options.store;
    this.documents = options.documents || new DocumentService({ projectRoot: options.projectRoot });
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || (() => randomUUID().replace(/-/g, ""));
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.afterStage = options.afterStage;
  }

  async write(input: CommitJournalWriteInput): Promise<CommitJournalWriteResult> {
    const projectIdentity = await this.assertRunProjectIdentity(input.runId);
    const relativePath = this.documents.normalizeRelativePath(input.targetPath);
    const targetPath = await this.documents.resolveSafePath(relativePath, { allowMissing: true });
    const current = await this.documents.readRawText(relativePath).catch(() => "");
    const requestedHash = contentHash(input.content);
    const appliedReplay = await this.findAppliedReplay(input, relativePath, targetPath, requestedHash);
    if (appliedReplay) {
      return appliedReplay;
    }
    const now = this.now();
    const owner = `${input.runId}:${input.stepId}:${input.attemptId}`;
    const lease = this.acquireLease(targetPath, owner, input, now);
    if (!lease) {
      throw new CommitJournalError("WRITE_LEASE_HELD", `目标文件正在由其他执行器提交: ${relativePath}`);
    }

    const journalId = this.idFactory();
    const journal = this.store.createCommitJournal({
      journal_id: journalId,
      run_id: input.runId,
      step_id: input.stepId,
      attempt_id: input.attemptId,
      action: input.action,
      target_path: targetPath,
      base_hash: contentHash(current),
      new_hash: requestedHash,
      temp_path: sidecarPath(targetPath, journalId, "tmp"),
      backup_path: sidecarPath(targetPath, journalId, "bak"),
      document_version: input.documentVersion ?? 0,
      timeline_ref: journalId,
      idempotency_key: input.idempotencyKey,
      fencing_token: lease.fencing_token,
      stage: "prepared",
      version: 1,
      manifest: {
        relative_path: relativePath,
        project_id: projectIdentity.projectId,
        canonical_root: projectIdentity.canonicalRoot
      },
      error_code: "",
      error: "",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      finalized_at: ""
    });

    if (journal.journal_id !== journalId) {
      this.releaseLease(lease);
      if (journal.stage !== "finalized") {
        await this.recoverJournal(journal);
      }
      const recovered = this.requireJournal(journal.journal_id);
      if (
        recovered.run_id !== input.runId ||
        recovered.step_id !== input.stepId ||
        recovered.target_path !== targetPath ||
        recovered.new_hash !== requestedHash
      ) {
        throw new CommitJournalError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `提交幂等键已绑定到不同执行、内容或目标: ${relativePath}`
        );
      }
      const actualHash = contentHash(await this.documents.readRawText(relativePath).catch(() => ""));
      if (actualHash !== requestedHash || recovered.manifest.recovery === "file_matches_base_hash") {
        const retryKey = retryIdempotencyKey(input.idempotencyKey, input.attemptId);
        if (retryKey === input.idempotencyKey) {
          throw new CommitJournalError("COMMIT_NOT_APPLIED", `此前提交未落盘，当前 attempt 也未能恢复: ${relativePath}`);
        }
        return this.write({ ...input, idempotencyKey: retryKey });
      }
      const document = await this.documents.readDocument(relativePath);
      return { journal: recovered, document, replayed: true };
    }

    let currentJournal = journal;
    try {
      const document = await this.documents.saveDocument(relativePath, input.content, {
        source: input.source || "agent",
        summary: input.summary || `Agent 提交 ${relativePath}`,
        atomicWrite: {
          tempPath: journal.temp_path,
          backupPath: journal.backup_path,
          onStage: async (stage) => {
            if (stage === "before_replace") {
              this.assertLeaseStillOwned(lease);
              await this.assertRunProjectIdentity(input.runId, projectIdentity);
              return;
            }
            if (stage === "temp_written" && contentHash(await readFile(currentJournal.temp_path, "utf8")) !== currentJournal.new_hash) {
              throw new CommitJournalError("TEMP_HASH_MISMATCH", `临时文件内容校验失败: ${relativePath}`);
            }
            currentJournal = this.advance(currentJournal, stage === "temp_written" ? "temp_written" : "file_replaced");
            await this.afterStage?.(stage, currentJournal);
          }
        }
      });
      if (contentHash(await this.documents.readRawText(relativePath)) !== currentJournal.new_hash) {
        throw new CommitJournalError("WRITE_HASH_MISMATCH", `文件提交后的内容校验失败: ${relativePath}`);
      }
      currentJournal = this.advance(currentJournal, "db_committed");
      currentJournal = this.advance(currentJournal, "finalized");
      this.releaseLease(lease);
      return { journal: currentJournal, document, replayed: false };
    } catch (error) {
      this.markRecoveryRequired(currentJournal, error);
      this.releaseLease(lease);
      throw error;
    }
  }

  async recoverPending(runId?: string): Promise<CommitJournalRecoveryResult[]> {
    const results: CommitJournalRecoveryResult[] = [];
    for (const journal of this.store.listPendingCommitJournal(runId)) {
      results.push(await this.recoverJournal(journal));
    }
    return results;
  }

  private async findAppliedReplay(
    input: CommitJournalWriteInput,
    relativePath: string,
    targetPath: string,
    requestedHash: string
  ): Promise<CommitJournalWriteResult | null> {
    const related = this.store.listCommitJournal(input.runId).filter((journal) =>
      journal.target_path === targetPath &&
      (
        journal.idempotency_key === input.idempotencyKey ||
        journal.idempotency_key.startsWith(`${input.idempotencyKey}:attempt:`)
      )
    );
    if (!related.length) {
      return null;
    }
    for (const journal of related) {
      if (journal.stage !== "finalized") {
        await this.recoverJournal(journal);
      }
    }
    const actualHash = contentHash(await this.documents.readRawText(relativePath).catch(() => ""));
    if (actualHash !== requestedHash) {
      return null;
    }
    const applied = related
      .map((journal) => this.requireJournal(journal.journal_id))
      .find((journal) =>
        journal.stage === "finalized" &&
        journal.new_hash === requestedHash &&
        journal.manifest.recovery !== "file_matches_base_hash"
      );
    if (!applied) {
      return null;
    }
    return {
      journal: applied,
      document: await this.documents.readDocument(relativePath),
      replayed: true
    };
  }

  private async recoverJournal(journal: ExecutionCommitJournalEntry): Promise<CommitJournalRecoveryResult> {
    const relativePath = String(journal.manifest.relative_path || "");
    if (!relativePath) {
      this.markRecoveryRequired(journal, new CommitJournalError("RECOVERY_REQUIRED", "提交日志缺少受控相对路径"));
      return { journalId: journal.journal_id, outcome: "recovery_required" };
    }
    try {
      await this.assertRunProjectIdentity(journal.run_id, {
        projectId: String(journal.manifest.project_id || ""),
        canonicalRoot: String(journal.manifest.canonical_root || "")
      });
    } catch (error) {
      this.markRecoveryRequired(journal, error);
      return { journalId: journal.journal_id, outcome: "recovery_required" };
    }
    const targetPath = await this.documents.resolveSafePath(relativePath, { allowMissing: true });
    const now = this.now();
    const lease = this.store.acquireWriteLease({
      target_path: targetPath,
      owner: `recovery:${journal.journal_id}`,
      run_id: journal.run_id,
      step_id: journal.step_id,
      attempt_id: journal.attempt_id,
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.leaseDurationMs).toISOString()
    });
    if (!lease.applied || !lease.value) {
      return { journalId: journal.journal_id, outcome: "lease_held" };
    }
    try {
      const actualHash = contentHash(await this.documents.readRawText(relativePath).catch(() => ""));
      if (actualHash === journal.new_hash) {
        let current = this.requireJournal(journal.journal_id);
        if (current.stage !== "db_committed") {
          current = this.advance(current, "db_committed", { recovery: "file_matches_new_hash" });
        }
        this.advance(current, "finalized", { recovery: "file_matches_new_hash" });
        return { journalId: journal.journal_id, outcome: "finalized_new" };
      }
      if (actualHash === journal.base_hash) {
        const current = this.requireJournal(journal.journal_id);
        this.advance(current, "finalized", { recovery: "file_matches_base_hash" });
        return { journalId: journal.journal_id, outcome: "finalized_old" };
      }
      this.markRecoveryRequired(
        journal,
        new CommitJournalError("RECOVERY_REQUIRED", "磁盘内容与提交日志的旧版、新版哈希均不一致")
      );
      return { journalId: journal.journal_id, outcome: "recovery_required" };
    } finally {
      this.releaseLease(lease.value);
    }
  }

  private acquireLease(
    targetPath: string,
    owner: string,
    input: CommitJournalWriteInput,
    now: Date
  ): ExecutionWriteLease | null {
    const result = this.store.acquireWriteLease({
      target_path: targetPath,
      owner,
      run_id: input.runId,
      step_id: input.stepId,
      attempt_id: input.attemptId,
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.leaseDurationMs).toISOString()
    });
    return result.applied ? result.value : null;
  }

  private assertLeaseStillOwned(lease: ExecutionWriteLease): void {
    const current = this.store.getWriteLease(lease.target_path);
    const now = this.now().getTime();
    if (
      !current ||
      current.owner !== lease.owner ||
      current.fencing_token !== lease.fencing_token ||
      current.released_at ||
      Date.parse(current.expires_at) <= now
    ) {
      throw new CommitJournalError("WRITE_FENCED", "文件写入租约已失效，拒绝替换目标文件");
    }
  }

  private advance(
    journal: ExecutionCommitJournalEntry,
    stage: ExecutionCommitJournalEntry["stage"],
    manifest?: Record<string, unknown>
  ): ExecutionCommitJournalEntry {
    const result = this.store.updateCommitJournal({
      journal_id: journal.journal_id,
      expected_version: journal.version,
      expected_stage: journal.stage,
      stage,
      manifest: manifest ? { ...journal.manifest, ...manifest } : journal.manifest,
      updated_at: this.now().toISOString(),
      finalized_at: stage === "finalized" ? this.now().toISOString() : undefined
    });
    if (!result.applied || !result.value) {
      throw new CommitJournalError("COMMIT_JOURNAL_CAS_MISS", "提交日志状态被并发修改");
    }
    return result.value;
  }

  private markRecoveryRequired(journal: ExecutionCommitJournalEntry, error: unknown): void {
    const current = this.store.getCommitJournal(journal.journal_id);
    if (!current || current.stage === "finalized" || current.stage === "recovery_required") {
      return;
    }
    this.store.updateCommitJournal({
      journal_id: current.journal_id,
      expected_version: current.version,
      expected_stage: current.stage,
      stage: "recovery_required",
      error_code: error instanceof CommitJournalError ? error.code : "COMMIT_WRITE_FAILED",
      error: error instanceof Error ? error.message : String(error),
      updated_at: this.now().toISOString()
    });
  }

  private releaseLease(lease: ExecutionWriteLease): void {
    this.store.releaseWriteLease({
      target_path: lease.target_path,
      owner: lease.owner,
      fencing_token: lease.fencing_token,
      expected_version: lease.version,
      released_at: this.now().toISOString()
    });
  }

  private requireJournal(journalId: string): ExecutionCommitJournalEntry {
    const journal = this.store.getCommitJournal(journalId);
    if (!journal) {
      throw new CommitJournalError("COMMIT_JOURNAL_MISSING", `提交日志不存在: ${journalId}`);
    }
    return journal;
  }

  private async assertRunProjectIdentity(
    runId: string,
    expected?: { projectId: string; canonicalRoot: string }
  ): Promise<{ projectId: string; canonicalRoot: string }> {
    const run = this.store.getRun(runId);
    const projectId = parseProjectId(run?.project_id);
    if (!run || !projectId || path.resolve(run.project_path) !== path.resolve(this.documents.projectRoot)) {
      throw new CommitJournalError(
        "PROJECT_IDENTITY_MISMATCH",
        "durable run 未绑定当前项目的稳定 UUID 和路径"
      );
    }

    const manifestPath = path.join(this.documents.projectRoot, MANIFEST_REL_PATH);
    await this.documents.revalidateAbsoluteProjectPath(manifestPath, false);
    const currentProjectId = await readExistingProjectId(this.documents.projectRoot);
    const canonicalRoot = await this.documents.canonicalProjectRoot();
    if (
      currentProjectId !== projectId
      || (expected && (expected.projectId !== projectId || expected.canonicalRoot !== canonicalRoot))
    ) {
      throw new CommitJournalError(
        "PROJECT_IDENTITY_MISMATCH",
        "项目 UUID 或 canonical root 在写入授权后发生变化"
      );
    }
    return { projectId, canonicalRoot };
  }
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function retryIdempotencyKey(idempotencyKey: string, attemptId: string): string {
  const suffix = `:attempt:${attemptId}`;
  return idempotencyKey.endsWith(suffix) ? idempotencyKey : `${idempotencyKey}${suffix}`;
}

function sidecarPath(targetPath: string, journalId: string, extension: "tmp" | "bak"): string {
  const parsed = path.parse(targetPath);
  return path.join(parsed.dir, `.${parsed.name}.agent-${journalId}.${extension}`);
}
