import { ExecutionStore } from "./kernel/execution-store.js";

export interface ArtifactFeedback {
  feedback_id: string;
  run_id: string;
  artifact_id: string;
  action: "accept" | "discard";
  task_type: string;
  diff_digest?: string;
  evidence_refs?: string[];
  rubric_versions?: Record<string, string>;
  created_at?: string;
}

export interface PreferenceCandidate {
  candidate_id: string;
  project_id?: string;
  scope: string;
  target: string;
  key: string;
  proposed_value: string;
  evidence_feedback_ids?: string[];
  counterexample_feedback_ids?: string[];
  status: "pending" | "accepted" | "rejected";
  version?: number;
  resolved_by?: string | null;
  resolved_at?: string | null;
  created_at?: string;
}

export interface PreferenceVersion {
  preference_version: string;
  parent_version: string | null;
  scope: string;
  applied_candidate_ids?: string[];
  rubric_versions?: Record<string, string>;
  router_version?: string;
  eval_manifest_ref?: string;
  status: "active" | "rolled_back";
  created_at?: string;
}

export class FeedbackLearner {
  constructor(private readonly store: ExecutionStore) {}

  /**
   * 将用户接受/放弃的反馈存储到 agent_artifact_feedback 数据库中
   */
  async addFeedback(feedback: ArtifactFeedback): Promise<void> {
    const db = (this.store as any).getDatabase ? (this.store as any).getDatabase() : (this.store as any).database;
    const createdAt = feedback.created_at || new Date().toISOString();
    const evidenceRefsJson = JSON.stringify(feedback.evidence_refs || []);
    const rubricVersionsJson = JSON.stringify(feedback.rubric_versions || {});

    const stmt = db.prepare(`
      INSERT INTO agent_artifact_feedback (
        feedback_id, run_id, artifact_id, action, task_type, diff_digest, evidence_refs, rubric_versions, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      feedback.feedback_id,
      feedback.run_id,
      feedback.artifact_id,
      feedback.action,
      feedback.task_type,
      feedback.diff_digest || "",
      evidenceRefsJson,
      rubricVersionsJson,
      createdAt
    );

    // 每次添加反馈，检查是否能为该 task_type 聚合 discard 信号
    await this.aggregateFeedbackSignals(feedback.task_type);
  }

  /**
   * 聚合信号：对于同一个 task_type 且 action = 'discard' 的 feedback，
   * 如果累积达到 3 次且未被包含在现有的 preference_candidates 中，
   * 则自动生成一个 PreferenceCandidate 提案 (status = 'pending')
   */
  private async aggregateFeedbackSignals(taskType: string): Promise<void> {
    const db = (this.store as any).getDatabase ? (this.store as any).getDatabase() : (this.store as any).database;

    // 查询同 task_type 且 action = 'discard' 的所有反馈
    const feedbacks = db.prepare(`
      SELECT feedback_id FROM agent_artifact_feedback
      WHERE task_type = ? AND action = 'discard'
    `).all(taskType) as { feedback_id: string }[];

    // 查询所有已被聚合成 candidate 的 feedback 证据
    const candidates = db.prepare(`
      SELECT evidence_feedback_ids FROM preference_candidates
    `).all() as { evidence_feedback_ids: string }[];

    const usedFeedbackIds = new Set<string>();
    for (const c of candidates) {
      try {
        const ids = JSON.parse(c.evidence_feedback_ids) as string[];
        for (const id of ids) {
          usedFeedbackIds.add(id);
        }
      } catch {}
    }

    const unusedFeedbacks = feedbacks.filter(f => !usedFeedbackIds.has(f.feedback_id));

    if (unusedFeedbacks.length >= 3) {
      const candidateId = `candidate_${Math.random().toString(36).slice(2, 10)}`;
      const evidenceIds = unusedFeedbacks.map(f => f.feedback_id);
      const proposedValue = `avoid_${taskType}_failures`;

      const insertCandidate = db.prepare(`
        INSERT INTO preference_candidates (
          candidate_id, project_id, scope, target, key, proposed_value, evidence_feedback_ids, counterexample_feedback_ids, status, version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertCandidate.run(
        candidateId,
        "", // project_id
        "project", // scope
        taskType, // target
        `${taskType}_style_preference`, // key
        proposedValue,
        JSON.stringify(evidenceIds),
        JSON.stringify([]), // counterexample_feedback_ids
        "pending", // status
        1, // version
        new Date().toISOString()
      );
    }
  }

  /**
   * 实现一个回滚路径，回滚 PreferenceVersion 并将 status 设为 rolled_back
   * 如果该 version 有 parent_version，可以将 parent 设为 active，并返回 parent_version ID
   */
  async rollbackVersion(versionId: string): Promise<string | null> {
    const db = (this.store as any).getDatabase ? (this.store as any).getDatabase() : (this.store as any).database;

    const row = db.prepare(`
      SELECT parent_version FROM preference_versions WHERE preference_version = ?
    `).get(versionId) as { parent_version: string | null } | undefined;

    if (!row) {
      throw new Error(`找不到要回滚的 PreferenceVersion: ${versionId}`);
    }

    // 将本版本设为 rolled_back
    db.prepare(`
      UPDATE preference_versions SET status = 'rolled_back' WHERE preference_version = ?
    `).run(versionId);

    const parentVersion = row.parent_version;
    if (parentVersion) {
      // 激活父版本
      db.prepare(`
        UPDATE preference_versions SET status = 'active' WHERE preference_version = ?
      `).run(parentVersion);
    }

    return parentVersion;
  }

  /**
   * 写入一个 PreferenceVersion
   */
  async createPreferenceVersion(version: PreferenceVersion): Promise<void> {
    const db = (this.store as any).getDatabase ? (this.store as any).getDatabase() : (this.store as any).database;
    const createdAt = version.created_at || new Date().toISOString();

    db.prepare(`
      INSERT INTO preference_versions (
        preference_version, parent_version, scope, applied_candidate_ids, rubric_versions, router_version, eval_manifest_ref, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.preference_version,
      version.parent_version,
      version.scope,
      JSON.stringify(version.applied_candidate_ids || []),
      JSON.stringify(version.rubric_versions || {}),
      version.router_version || "",
      version.eval_manifest_ref || "",
      version.status,
      createdAt
    );
  }

  /**
   * 获取 PreferenceVersion
   */
  async getPreferenceVersion(versionId: string): Promise<PreferenceVersion | null> {
    const db = (this.store as any).getDatabase ? (this.store as any).getDatabase() : (this.store as any).database;
    const row = db.prepare(`
      SELECT * FROM preference_versions WHERE preference_version = ?
    `).get(versionId) as any;

    if (!row) return null;

    return {
      preference_version: row.preference_version,
      parent_version: row.parent_version,
      scope: row.scope,
      applied_candidate_ids: JSON.parse(row.applied_candidate_ids || "[]"),
      rubric_versions: JSON.parse(row.rubric_versions || "{}"),
      router_version: row.router_version,
      eval_manifest_ref: row.eval_manifest_ref,
      status: row.status as any,
      created_at: row.created_at
    };
  }

  /**
   * 获取所有 PreferenceCandidate 列表
   */
  async getPreferenceCandidates(): Promise<PreferenceCandidate[]> {
    const db = (this.store as any).getDatabase ? (this.store as any).getDatabase() : (this.store as any).database;
    const rows = db.prepare(`
      SELECT * FROM preference_candidates
    `).all() as any[];

    return rows.map(row => ({
      candidate_id: row.candidate_id,
      project_id: row.project_id,
      scope: row.scope,
      target: row.target,
      key: row.key,
      proposed_value: row.proposed_value,
      evidence_feedback_ids: JSON.parse(row.evidence_feedback_ids || "[]"),
      counterexample_feedback_ids: JSON.parse(row.counterexample_feedback_ids || "[]"),
      status: row.status as any,
      version: row.version,
      resolved_by: row.resolved_by,
      resolved_at: row.resolved_at,
      created_at: row.created_at
    }));
  }
}
