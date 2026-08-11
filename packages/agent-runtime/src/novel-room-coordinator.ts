import { loadModelConfig, type ConfigServiceOptions, type ModelConfig } from "@xiaoshuo/config-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { ModelGateway, StructuredOutputManager, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import {
  novelRoleReviewSchema,
  novelRoomRequestSchema,
  novelRoomResponseSchema,
  type NovelReviewRole,
  type NovelRoleReview,
  type NovelRoomRequest,
  type NovelRoomResponse
} from "@xiaoshuo/shared";
import { createHash } from "node:crypto";
import { NegativeCapabilityPolicy } from "./negative-capability-policy.js";

const MAX_CONTEXT_CHARS = 24_000;
const MAX_CONTEXT_FILE_CHARS = 6_000;

export type NovelRoleReviewInput = NovelRoomRequest & {
  role: NovelReviewRole;
  context: string;
};

export interface NovelRoleReviewer {
  review(input: NovelRoleReviewInput, signal?: AbortSignal): Promise<NovelRoleReview>;
}

export type NovelRoomCoordinatorOptions = {
  projectRoot: string;
  reviewer?: NovelRoleReviewer;
  capabilityPolicy?: NegativeCapabilityPolicy;
  config?: ConfigServiceOptions;
  gateway?: ModelGateway;
};

export class NovelRoomCoordinator {
  private readonly documents: DocumentService;
  private readonly reviewer: NovelRoleReviewer;
  private readonly policy: NegativeCapabilityPolicy;

  constructor(options: NovelRoomCoordinatorOptions) {
    this.documents = new DocumentService({ projectRoot: options.projectRoot });
    this.reviewer = options.reviewer ?? new ModelNovelRoleReviewer({
      config: options.config,
      gateway: options.gateway
    });
    this.policy = options.capabilityPolicy ?? new NegativeCapabilityPolicy();
  }

  async review(requestValue: NovelRoomRequest, signal?: AbortSignal): Promise<NovelRoomResponse> {
    const request = novelRoomRequestSchema.parse(requestValue);
    const roles = uniqueRoles(request.requested_roles).slice(0, 3);
    if (!roles.length) {
      return novelRoomResponseSchema.parse({
        domain: "novel_creation",
        project_id: request.project_id,
        run_id: request.run_id,
        source_revision: request.source_revision,
        reviews: [],
        conflicts: [],
        merged_summary: "本次任务未选择小说审校角色。",
        save_proposal_allowed: true,
        degraded: false
      });
    }

    this.policy.assertAgentAction("run_novel_review", {
      projectId: request.project_id,
      runId: request.run_id,
      budgetId: request.budget_id
    });
    const context = await this.loadContext(request);
    const settled = await Promise.allSettled(roles.map((role) => this.reviewer.review({
      ...request,
      role,
      context
    }, signal)));
    const reviews = settled.map((result, index) => this.normalizeReview(result, roles[index]!, request));
    const conflicts = buildConflicts(reviews);
    const blockingIssues = reviews.flatMap((review) => review.issues).filter((issue) => issue.severity === "blocking");
    const completed = reviews.filter((review) => review.status === "completed");

    return novelRoomResponseSchema.parse({
      domain: "novel_creation",
      project_id: request.project_id,
      run_id: request.run_id,
      source_revision: request.source_revision,
      reviews,
      conflicts,
      merged_summary: buildMainWriterSummary(reviews, conflicts),
      save_proposal_allowed: completed.length > 0 && blockingIssues.length === 0 && conflicts.length === 0,
      degraded: reviews.some((review) => review.status === "failed")
    });
  }

  private async loadContext(request: NovelRoomRequest): Promise<string> {
    const paths = [...new Set([request.current_path, ...request.context_paths].filter(Boolean))].slice(0, 24);
    const blocks: string[] = [];
    let used = 0;
    for (const relativePath of paths) {
      if (used >= MAX_CONTEXT_CHARS) {
        break;
      }
      try {
        const content = await this.documents.readRawText(relativePath, Math.min(MAX_CONTEXT_FILE_CHARS, MAX_CONTEXT_CHARS - used));
        blocks.push(`【${this.documents.normalizeRelativePath(relativePath)}】\n${content}`);
        used += content.length;
      } catch {
        // A missing or unsafe optional context file is omitted; the reviewer
        // never receives an expanded path or filesystem error detail.
      }
    }
    return blocks.join("\n\n");
  }

  private normalizeReview(
    settled: PromiseSettledResult<NovelRoleReview>,
    role: NovelReviewRole,
    request: NovelRoomRequest
  ): NovelRoleReview {
    if (settled.status === "rejected") {
      return novelRoleReviewSchema.parse({
        role,
        status: "failed",
        summary: "该审校角色本次未完成，主笔可继续使用其他审校结果。",
        issues: [],
        error_code: "NOVEL_ROLE_REVIEW_FAILED",
        duration_ms: 0
      });
    }
    const parsed = novelRoleReviewSchema.safeParse(settled.value);
    if (!parsed.success || parsed.data.role !== role) {
      return novelRoleReviewSchema.parse({
        role,
        status: "failed",
        summary: "审校结果角色或结构不匹配，已拒绝该结果。",
        issues: [],
        error_code: "NOVEL_ROLE_REVIEW_INVALID",
        duration_ms: 0
      });
    }
    const allowedPaths = new Set([request.current_path, ...request.context_paths].filter(Boolean).map((item) => {
      try {
        return this.documents.normalizeRelativePath(item);
      } catch {
        return "";
      }
    }));
    return novelRoleReviewSchema.parse({
      ...parsed.data,
      issues: parsed.data.issues.map((issue) => ({
        ...issue,
        evidence: issue.evidence.filter((evidence) => {
          try {
            return allowedPaths.has(this.documents.normalizeRelativePath(evidence.source_path))
              && evidence.source_revision === request.source_revision;
          } catch {
            return false;
          }
        })
      }))
    });
  }
}

type ModelNovelRoleReviewerOptions = {
  config?: ConfigServiceOptions;
  gateway?: ModelGateway;
};

export class ModelNovelRoleReviewer implements NovelRoleReviewer {
  private readonly configOptions: ConfigServiceOptions;
  private readonly gateway: ModelGateway;
  private configPromise: Promise<ModelConfig> | null = null;

  constructor(options: ModelNovelRoleReviewerOptions = {}) {
    this.configOptions = options.config ?? {};
    this.gateway = options.gateway ?? new ModelGateway();
  }

  async review(input: NovelRoleReviewInput, signal?: AbortSignal): Promise<NovelRoleReview> {
    const startedAt = Date.now();
    const config = await this.modelConfig();
    if (!config.configured) {
      throw Object.assign(new Error("未配置主线路模型"), { code: "MODEL_NOT_CONFIGURED" });
    }
    const messages = buildRoleMessages(input);
    const options = {
      purpose: "verification",
      dataClassification: "project",
      signal,
      runId: input.run_id,
      maxOutputTokens: 2_000,
      captureUsage: true
    } as const;
    const strictMessages = [...messages];
    const last = strictMessages[strictMessages.length - 1];
    if (last) {
      strictMessages[strictMessages.length - 1] = {
        role: last.role,
        content: StructuredOutputManager.buildStrictPrompt(novelRoleReviewSchema, last.content)
      };
    }
    const raw = await this.gateway.requestCompletion(config, strictMessages, 0.1, options);
    const response = StructuredOutputManager.parseWithSchema(raw, novelRoleReviewSchema);
    return novelRoleReviewSchema.parse({
      ...response,
      role: input.role,
      duration_ms: Date.now() - startedAt
    });
  }

  private modelConfig(): Promise<ModelConfig> {
    this.configPromise ??= loadModelConfig(this.configOptions, "primary");
    return this.configPromise;
  }
}

function buildRoleMessages(input: NovelRoleReviewInput): ChatCompletionMessage[] {
  return [
    {
      role: "system",
      content: [
        `你是 ArcWriter 小说编辑室中的${roleLabel(input.role)}。`,
        "只审阅当前小说项目，不执行文件写入、工具安装、Shell、跨项目操作或记忆确认。",
        "只报告可由正文、大纲、设定或已确认记忆支持的问题；没有证据时只能给 info 建议，不能判定 blocking。",
        "涉及剧情走向、人物动机或文风取舍的冲突必须标记 requires_user_decision=true。",
        `所有 evidence.source_revision 必须填写 ${input.source_revision}。`
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `用户目标：${input.instruction}`,
        input.current_path ? `当前文档：${input.current_path}` : "",
        input.draft ? `待审草稿：\n${input.draft.slice(0, 18_000)}` : "",
        input.context ? `项目上下文：\n${input.context}` : "项目上下文：无"
      ].filter(Boolean).join("\n\n")
    }
  ];
}

function uniqueRoles(roles: readonly NovelReviewRole[]): NovelReviewRole[] {
  return [...new Set(roles)];
}

function buildConflicts(reviews: readonly NovelRoleReview[]): Array<{
  conflict_id: string;
  issue_ids: string[];
  summary: string;
  requires_user_decision: true;
}> {
  const decisionIssues = reviews.flatMap((review) => review.issues.map((issue) => ({ role: review.role, issue })))
    .filter(({ issue }) => issue.requires_user_decision);
  const conflicts: Array<{ conflict_id: string; issue_ids: string[]; summary: string; requires_user_decision: true }> = [];
  for (let index = 0; index < decisionIssues.length; index += 1) {
    const current = decisionIssues[index]!;
    const related = decisionIssues.slice(index + 1).find((candidate) =>
      candidate.role !== current.role && candidate.issue.category === current.issue.category
    );
    if (!related) {
      continue;
    }
    const issueIds = [current.issue.issue_id, related.issue.issue_id].sort();
    conflicts.push({
      conflict_id: `conflict_${createHash("sha256").update(issueIds.join(":"), "utf8").digest("hex").slice(0, 16)}`,
      issue_ids: issueIds,
      summary: `${roleLabel(current.role)}与${roleLabel(related.role)}对同类问题给出了需要用户取舍的意见。`,
      requires_user_decision: true
    });
  }
  return [...new Map(conflicts.map((conflict) => [conflict.conflict_id, conflict])).values()];
}

function buildMainWriterSummary(
  reviews: readonly NovelRoleReview[],
  conflicts: readonly { summary: string }[]
): string {
  const lines = ["主笔合并结论："];
  for (const review of reviews) {
    lines.push(`- ${roleLabel(review.role)}：${review.summary || statusLabel(review.status)}`);
    for (const issue of review.issues) {
      const evidence = issue.evidence.length
        ? `（证据：${issue.evidence.map((item) => item.source_path).join("、")}）`
        : "";
      const suggestion = issue.suggestion ? `；建议：${issue.suggestion}` : "";
      lines.push(`  - [${issue.severity}] ${issue.summary}${evidence}${suggestion}`);
    }
  }
  for (const conflict of conflicts) {
    lines.push(`- 待用户决定：${conflict.summary}`);
  }
  return lines.join("\n");
}

function roleLabel(role: NovelReviewRole): string {
  return ({
    plot_reviewer: "剧情审校",
    character_reviewer: "人物审校",
    continuity_reviewer: "连续性审校",
    style_reviewer: "文风审校"
  } as const)[role];
}

function statusLabel(status: NovelRoleReview["status"]): string {
  return status === "failed" ? "失败" : status === "skipped" ? "跳过" : "完成";
}
