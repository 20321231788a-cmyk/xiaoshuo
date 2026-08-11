import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { VectorIndex } from "@xiaoshuo/vector-service";
import { GovernedMemoryStore, type GovernedMemoryProjectionStatus } from "./governed-memory-store.js";

export const GOVERNED_MEMORY_PROJECTION_PATH = "00_设定集/记忆投影.md";

export type GovernedMemoryProjectionRebuildResult = {
  memory_revision: number;
  projection_path: string;
  statuses: GovernedMemoryProjectionStatus[];
};

/** User-triggered materialization. The SQLite store remains authoritative. */
export class GovernedMemoryProjectionService {
  constructor(private readonly projectRoot: string, private readonly store: GovernedMemoryStore) {}

  async rebuild(projectId: string): Promise<GovernedMemoryProjectionRebuildResult> {
    const revision = this.store.getMemoryRevision(projectId);
    const content = renderProjection(this.store, projectId, revision);
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const target = path.join(this.projectRoot, GOVERNED_MEMORY_PROJECTION_PATH);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, content, "utf8");
      await fs.rename(temporary, target);
      this.store.markProjectionReady(projectId, "canon_markdown", revision, contentHash);

      const index = new VectorIndex(this.projectRoot);
      try {
        index.markChanged([GOVERNED_MEMORY_PROJECTION_PATH], "upsert");
        const result = await index.processPending();
        if (result.failed_files?.length || result.pending_files) {
          throw new Error(result.failed_files?.map((item) => item.error).join("; ") || "记忆向量投影仍有待处理文件");
        }
      } finally {
        index.close();
      }
      this.store.markProjectionReady(projectId, "vector_graph", revision, contentHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.markProjectionFailed(projectId, "vector_graph", message);
      throw error;
    }
    return { memory_revision: revision, projection_path: GOVERNED_MEMORY_PROJECTION_PATH, statuses: this.store.listProjectionStatuses(projectId) };
  }
}

function renderProjection(store: GovernedMemoryStore, projectId: string, revision: number): string {
  const overrides = new Map(store.listOverrides(projectId).map((item) => [item.claimId, item]));
  const claims = store.listClaims(projectId)
    .filter((claim) => claim.status === "confirmed")
    .map((claim) => ({ ...claim, object: overrides.get(claim.id)?.overrideObject ?? claim.object }))
    .sort((left, right) => left.subject.localeCompare(right.subject, "zh-CN") || left.predicate.localeCompare(right.predicate, "zh-CN") || left.id.localeCompare(right.id));
  const lines = ["# 已确认项目记忆", "", `memory_revision: ${revision}`, "", "## Claims", ""];
  for (const claim of claims) {
    lines.push(`- ${claim.subject} | ${claim.predicate} | ${claim.object}`);
    lines.push(`  - id: ${claim.id}${claim.sourceRef ? `, source: ${claim.sourceRef}` : ""}${claim.perspective ? `, perspective: ${claim.perspective}` : ""}`);
  }
  if (!claims.length) lines.push("- 暂无已确认记忆");
  return `${lines.join("\n").trimEnd()}\n`;
}
