import { type AgentPlanResponse, type FileOperation } from "@xiaoshuo/shared";
import { createHash } from "node:crypto";

export class PlanValidator {
  private allowedActions = new Set([
    "read_project_files",
    "resolve_project_references",
    "run_skill",
    "run_workflow",
    "search_project_memory",
    "search_web_material",
    "check_graph_consistency",
    "evaluate_artifact",
    "propose_save",
    // Also allow original operations for backward compatibility
    "create_file",
    "append_text",
    "replace_text",
    "move_file",
    "archive_file"
  ]);

  validatePlan(
    plan: AgentPlanResponse,
    options: {
      budgetLimit?: number;
      stepLimit?: number;
      allowedSkills?: string[];
      untrustedContext?: boolean;
    } = {}
  ): { ok: boolean; warnings: string[] } {
    const warnings: string[] = [];

    // 1. Check budget limits
    if (options.stepLimit && plan.operations.length > options.stepLimit) {
      warnings.push(`阻止：计划步骤数 (${plan.operations.length}) 超过预算上限 (${options.stepLimit})`);
    }

    // 2. Validate action existence in Registry
    for (const op of plan.operations) {
      if (!this.allowedActions.has(op.action)) {
        warnings.push(`阻止：未注册的 Action: ${op.action}`);
      }

      // 3. Untrusted context permission checks
      if (options.untrustedContext) {
        if (op.action === "archive_file" || op.action === "move_file") {
          warnings.push(`阻止：不受信任的上下文禁止执行高敏感操作: ${op.action}`);
        }
      }
    }

    // 4. Circular dependency or conflicting parallel writes
    const targetPaths = plan.operations.map((op) => op.path).filter(Boolean);
    const uniqueTargets = new Set(targetPaths);
    if (targetPaths.length !== uniqueTargets.size) {
      warnings.push("阻止：计划中包含互相冲突的并行文件写入目标。");
    }

    return {
      ok: !warnings.some((w) => w.startsWith("阻止：")),
      warnings
    };
  }

  static computeFingerprint(plan: AgentPlanResponse): string {
    const data = JSON.stringify({
      summary: plan.summary || "",
      operations: plan.operations.map((op) => ({
        action: op.action,
        path: op.path || "",
        text: op.text || "",
        target_path: op.target_path || ""
      }))
    });
    return createHash("sha256").update(data).digest("hex");
  }
}
