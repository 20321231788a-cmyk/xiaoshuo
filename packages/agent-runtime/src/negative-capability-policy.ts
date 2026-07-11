import {
  capabilityRequestSchema,
  type CapabilityRequest,
  type InvocationActor
} from "@xiaoshuo/shared";

export const NEGATIVE_CAPABILITY_CODES = {
  singleAgent: "NEGATIVE_CAPABILITY_SINGLE_AGENT",
  dependencyInstall: "NEGATIVE_CAPABILITY_DEPENDENCY_INSTALL",
  shellExecution: "NEGATIVE_CAPABILITY_SHELL_EXECUTION",
  runtimeMutation: "NEGATIVE_CAPABILITY_RUNTIME_MUTATION",
  unbudgetedAutonomy: "NEGATIVE_CAPABILITY_UNBUDGETED_AUTONOMY",
  crossProjectWrite: "NEGATIVE_CAPABILITY_CROSS_PROJECT_WRITE",
  confirmedMemory: "NEGATIVE_CAPABILITY_CONFIRMED_MEMORY",
  budgetRequired: "BUDGET_REQUIRED",
  unknown: "NEGATIVE_CAPABILITY_UNKNOWN"
} as const;

export type NegativeCapabilityCode = (typeof NEGATIVE_CAPABILITY_CODES)[keyof typeof NEGATIVE_CAPABILITY_CODES];

export class NegativeCapabilityPolicyError extends Error {
  constructor(
    readonly code: NegativeCapabilityCode,
    message: string
  ) {
    super(message);
    this.name = "NegativeCapabilityPolicyError";
  }
}

const AGENT_ACTION_ALLOWLIST = new Set([
  "read_project_files",
  "resolve_project_references",
  "run_skill",
  "run_workflow",
  "search_project_memory",
  "search_web_material",
  "check_graph_consistency",
  "evaluate_artifact",
  "propose_save"
]);

const FORBIDDEN_AGENT_CAPABILITIES: ReadonlyArray<readonly [string, NegativeCapabilityCode]> = [
  ["agent.spawn", NEGATIVE_CAPABILITY_CODES.singleAgent],
  ["agent.delegate", NEGATIVE_CAPABILITY_CODES.singleAgent],
  ["dependency.install", NEGATIVE_CAPABILITY_CODES.dependencyInstall],
  ["shell.", NEGATIVE_CAPABILITY_CODES.shellExecution],
  ["terminal.", NEGATIVE_CAPABILITY_CODES.shellExecution],
  ["runtime.modify", NEGATIVE_CAPABILITY_CODES.runtimeMutation],
  ["runtime.publish", NEGATIVE_CAPABILITY_CODES.runtimeMutation],
  ["background.autonomous", NEGATIVE_CAPABILITY_CODES.unbudgetedAutonomy],
  ["project.write.cross", NEGATIVE_CAPABILITY_CODES.crossProjectWrite],
  ["memory.confirm", NEGATIVE_CAPABILITY_CODES.confirmedMemory]
];

/**
 * Code-level deny-by-default boundary for the seven exclusions in Manual §19.
 * Product flags never participate in this decision, so a prompt, Skill or
 * environment value cannot turn one of these capabilities back on.
 */
export class NegativeCapabilityPolicy {
  assertAllowed(input: CapabilityRequest): void {
    const request = capabilityRequestSchema.parse(input);
    const forbidden = FORBIDDEN_AGENT_CAPABILITIES.find(([prefix]) => request.capability === prefix || request.capability.startsWith(prefix));
    if (forbidden && request.actor === "agent") {
      throw this.denied(forbidden[1], request.actor, request.capability);
    }

    if (request.actor === "agent") {
      if (!request.run_id || !request.budget_id) {
        throw this.denied(NEGATIVE_CAPABILITY_CODES.budgetRequired, request.actor, request.capability);
      }
      if (request.target_project_id && request.target_project_id !== request.project_id) {
        throw this.denied(NEGATIVE_CAPABILITY_CODES.crossProjectWrite, request.actor, request.capability);
      }
      const action = request.capability.startsWith("agent.action.") ? request.capability.slice("agent.action.".length) : "";
      if (!action || !AGENT_ACTION_ALLOWLIST.has(action)) {
        throw this.denied(NEGATIVE_CAPABILITY_CODES.unknown, request.actor, request.capability);
      }
      return;
    }

    if (request.actor === "user_ui" && request.capability === "user_terminal") {
      if (!request.confirmation_id) {
        throw this.denied(NEGATIVE_CAPABILITY_CODES.shellExecution, request.actor, request.capability);
      }
      return;
    }
    if (request.actor === "updater" && request.capability === "signed_update") {
      return;
    }
    throw this.denied(NEGATIVE_CAPABILITY_CODES.unknown, request.actor, request.capability);
  }

  assertAgentAction(action: string, scope: {
    projectId: string;
    runId?: string;
    budgetId?: string;
    confirmationId?: string;
    targetProjectId?: string;
  }): void {
    this.assertAllowed({
      actor: "agent",
      capability: `agent.action.${action}`,
      project_id: scope.projectId,
      run_id: scope.runId || null,
      budget_id: scope.budgetId || null,
      confirmation_id: scope.confirmationId || null,
      target_project_id: scope.targetProjectId || null
    });
  }

  private denied(code: NegativeCapabilityCode, actor: InvocationActor, capability: string): NegativeCapabilityPolicyError {
    return new NegativeCapabilityPolicyError(code, `拒绝 ${actor} 调用受限能力：${capability}`);
  }
}
