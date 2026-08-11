import fs from "node:fs";
import path from "node:path";
import type { AgentConfirmationTargetBinding } from "@xiaoshuo/shared";
import { ACTION_DESCRIPTORS } from "./action-registry.js";
import { NegativeCapabilityPolicy, NegativeCapabilityPolicyError, NEGATIVE_CAPABILITY_CODES } from "./negative-capability-policy.js";
import {
  CONFIRMATION_RECEIPT_CODES,
  ConfirmationReceiptError,
  sha256StableJson
} from "./kernel/confirmation-receipt.js";
import type { ConsumeConfirmationReceiptInput, ExecutionCasResult, StoredAgentConfirmation } from "./kernel/execution-store-port.js";

export type TrustedActionConfirmationReceipt = {
  confirmationId: string;
  version: number;
  scopeFingerprint: string;
  actionInputHash: string;
  targetBindings: AgentConfirmationTargetBinding[];
};

export type TrustedActionExecutionScope = {
  projectId: string;
  runId: string;
  budgetId: string;
  stepId?: string;
  attemptId?: string;
  planVersion?: number;
  confirmationId?: string;
  confirmationReceipt?: TrustedActionConfirmationReceipt;
  consumeConfirmationReceipt?: (
    input: ConsumeConfirmationReceiptInput
  ) => ExecutionCasResult<StoredAgentConfirmation> | Promise<ExecutionCasResult<StoredAgentConfirmation>>;
  targetProjectId?: string;
};

export class ActionExecutor {
  private runtimeContext: any;
  private readonly negativeCapabilityPolicy: NegativeCapabilityPolicy;
  private readonly executionScope: TrustedActionExecutionScope;

  constructor(
    runtimeContext: any,
    executionScope: TrustedActionExecutionScope,
    negativeCapabilityPolicy = new NegativeCapabilityPolicy()
  ) {
    this.runtimeContext = runtimeContext;
    this.executionScope = Object.freeze({ ...executionScope });
    this.negativeCapabilityPolicy = negativeCapabilityPolicy;
  }

  async execute(action: string, args: Record<string, any>): Promise<any> {
    const descriptor = ACTION_DESCRIPTORS[action];
    if (!descriptor) {
      throw new Error(`[ActionExecutor] 阻止：未授权或不支持的 Action: ${action}`);
    }

    this.negativeCapabilityPolicy.assertAgentAction(action, {
      projectId: this.executionScope.projectId,
      runId: this.executionScope.runId,
      budgetId: this.executionScope.budgetId,
      confirmationId: this.executionScope.confirmationId,
      targetProjectId: this.executionScope.targetProjectId
    });

    // Enforce permission boundary checks
    const allowedPermissions = new Set(descriptor.required_permissions);
    if (allowedPermissions.has("project.write") && args.bypassService) {
      throw new Error(`[ActionExecutor] 阻止：禁止绕过受控服务直写盘: ${action}`);
    }
    if (action === "propose_save" && args.bypassDocumentService) {
      throw new Error("[ActionExecutor] 阻止：禁止绕过 DocumentService 直写文件");
    }

    if (descriptor.confirmation_policy === "always") {
      await this.consumeRequiredConfirmation(action, args);
    }

    switch (action) {
      case "read_project_files":
        return await this.runtimeContext.projectManifest.getProjectId();
      case "resolve_project_references":
        return args.paths || [];
      case "run_skill":
        return await this.runtimeContext.runSkillInternal(args.skill_id, args.request);
      case "search_web_material":
        return { sources: [] };
      case "propose_save": {
        const projectRoot = this.runtimeContext.projectRoot;
        if (projectRoot && args.path) {
          const canonicalProjectRoot = fs.realpathSync(projectRoot);
          const absolutePath = path.resolve(canonicalProjectRoot, args.path);
          let canonicalPath = absolutePath;
          try {
            canonicalPath = fs.realpathSync(absolutePath);
          } catch {
            try {
              const parentReal = fs.realpathSync(path.dirname(absolutePath));
              canonicalPath = path.join(parentReal, path.basename(absolutePath));
            } catch {
              canonicalPath = absolutePath;
            }
          }
          const relative = path.relative(canonicalProjectRoot, canonicalPath);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new NegativeCapabilityPolicyError(
              NEGATIVE_CAPABILITY_CODES.crossProjectWrite,
              `拒绝跨项目写入：目标路径 ${args.path} 不在项目根目录内`
            );
          }
        }
        return { ok: true, path: args.path };
      }
      default:
        return { ok: true, message: `Action ${action} executed.` };
    }
  }

  private async consumeRequiredConfirmation(action: string, args: Record<string, any>): Promise<void> {
    const receipt = this.executionScope.confirmationReceipt;
    const consume = this.executionScope.consumeConfirmationReceipt;
    const stepId = this.executionScope.stepId;
    const attemptId = this.executionScope.attemptId;
    const planVersion = this.executionScope.planVersion;
    if (!receipt || !consume || !stepId || !attemptId || !planVersion) {
      throw new ConfirmationReceiptError(
        CONFIRMATION_RECEIPT_CODES.required,
        `Action ${action} requires a trusted confirmation receipt`
      );
    }
    const actionInputHash = sha256StableJson(args);
    if (receipt.actionInputHash !== actionInputHash) {
      throw new ConfirmationReceiptError(
        CONFIRMATION_RECEIPT_CODES.hashMismatch,
        `Action ${action} arguments do not match the confirmed input`
      );
    }
    const consumed = await consume({
      confirmation_id: receipt.confirmationId,
      expected_version: receipt.version,
      run_id: this.executionScope.runId,
      step_id: stepId,
      attempt_id: attemptId,
      action,
      project_id: this.executionScope.projectId,
      plan_version: planVersion,
      action_input_hash: actionInputHash,
      scope_fingerprint: receipt.scopeFingerprint,
      target_bindings: receipt.targetBindings
    });
    if (!consumed.applied) {
      throw new ConfirmationReceiptError(
        CONFIRMATION_RECEIPT_CODES.versionMismatch,
        `Confirmation ${receipt.confirmationId} changed before action execution`
      );
    }
  }
}
