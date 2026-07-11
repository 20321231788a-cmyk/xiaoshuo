import { z } from "zod";

/** Actors are intentionally closed: unknown callers must fail closed. */
export const invocationActorSchema = z.enum(["user_ui", "agent", "system", "updater"]);

/**
 * A policy request contains the smallest stable scope needed to authorize a
 * capability. Missing scope is a denial, never an implicit current project.
 */
export const capabilityRequestSchema = z
  .object({
    actor: invocationActorSchema,
    capability: z.string().min(1),
    project_id: z.string().min(1),
    run_id: z.string().min(1).nullable(),
    budget_id: z.string().min(1).nullable(),
    confirmation_id: z.string().min(1).nullable(),
    target_project_id: z.string().min(1).nullable().optional()
  })
  .strict();

export type InvocationActor = z.infer<typeof invocationActorSchema>;
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;

export { agentRunBudgetEnvelopeSchema as budgetEnvelopeSchema } from "./agent.js";
export type { AgentRunBudgetEnvelope as BudgetEnvelope } from "./agent.js";
