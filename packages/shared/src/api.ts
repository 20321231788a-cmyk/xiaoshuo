import { z } from "zod";
import {
  type AgentConfirmation,
  type AgentRunEventReplayResponse,
  type AgentRunListResponse,
  type AgentRunState,
  agentConfirmationSchema,
  agentPlanResponseSchema,
  agentRunEventReplayResponseSchema,
  agentRunListResponseSchema,
  agentRunStateSchema,
  agentRunTraceSchema,
  generatedCacheDetailSchema
} from "./schemas/agent.js";
import {
  appConfigSchema,
  licenseAccountKeyResponseSchema,
  licenseStatusSchema,
  websiteAiDashboardSchema,
  websiteAiRechargeOrderResponseSchema,
  websiteAiRedeemResponseSchema
} from "./schemas/config.js";
import { conversationDetailSchema, conversationSummarySchema } from "./schemas/conversation.js";
import { documentContentSchema, documentInfoSchema, libraryCardSchema, revisionLogEntrySchema, treeNodeSchema } from "./schemas/document.js";
import { healthSchema } from "./schemas/health.js";
import { jobInfoSchema } from "./schemas/job.js";
import {
  currentProjectSchema,
  projectChromeSnapshotSchema,
  projectManifestStatusSchema,
  timelineDeleteResultSchema,
  timelineEntrySchema,
  timelineRollbackResultSchema,
  vectorTestResponseSchema,
  vectorSearchResponseSchema,
  vectorIndexStatusSchema
} from "./schemas/project.js";
import { skillDefinitionSchema } from "./schemas/skill.js";
import { ledgerItemSchema } from "./schemas/workbench.js";

const agentRunListContractSchema: z.ZodType<AgentRunListResponse, z.ZodTypeDef, unknown> = agentRunListResponseSchema;
const agentRunStateContractSchema: z.ZodType<AgentRunState, z.ZodTypeDef, unknown> = agentRunStateSchema;
const agentRunEventReplayContractSchema: z.ZodType<AgentRunEventReplayResponse, z.ZodTypeDef, unknown> =
  agentRunEventReplayResponseSchema;
const agentConfirmationContractSchema: z.ZodType<AgentConfirmation, z.ZodTypeDef, unknown> = agentConfirmationSchema;

export const apiContracts = {
  health: { method: "GET", path: "/api/health", response: healthSchema },
  licenseStatus: { method: "GET", path: "/api/license/status", response: licenseStatusSchema },
  config: { method: "GET", path: "/api/config", response: appConfigSchema },
  setConfig: { method: "PUT", path: "/api/config", response: appConfigSchema },
  setLicenseAccountKey: { method: "POST", path: "/api/license/account-key", response: licenseAccountKeyResponseSchema },
  websiteAiLogin: { method: "POST", path: "/api/website-ai/login", response: websiteAiDashboardSchema },
  websiteAiDashboard: { method: "GET", path: "/api/website-ai/dashboard", response: websiteAiDashboardSchema },
  websiteAiApply: { method: "POST", path: "/api/website-ai/apply", response: websiteAiDashboardSchema },
  websiteAiRedeem: { method: "POST", path: "/api/website-ai/redeem", response: websiteAiRedeemResponseSchema },
  websiteAiRechargeCreate: { method: "POST", path: "/api/website-ai/recharge-orders", response: websiteAiRechargeOrderResponseSchema },
  websiteAiRechargeOrder: { method: "GET", path: "/api/website-ai/recharge-orders/{order_id}", response: websiteAiRechargeOrderResponseSchema },
  currentProject: { method: "GET", path: "/api/projects/current", response: currentProjectSchema },
  documents: { method: "GET", path: "/api/documents", response: z.array(documentInfoSchema) },
  projectTree: { method: "GET", path: "/api/project/tree", response: z.array(treeNodeSchema) },
  projectTreeSubtree: { method: "GET", path: "/api/project/tree/subtree", response: treeNodeSchema },
  projectChrome: { method: "GET", path: "/api/project/chrome", response: projectChromeSnapshotSchema },
  projectManifestStatus: { method: "GET", path: "/api/project/manifest/status", response: projectManifestStatusSchema },
  vectorStatus: { method: "GET", path: "/api/vector/status", response: vectorIndexStatusSchema },
  vectorTest: { method: "POST", path: "/api/vector/test", response: vectorTestResponseSchema },
  vectorSearch: { method: "POST", path: "/api/vector/search", response: vectorSearchResponseSchema },
  libraries: { method: "GET", path: "/api/libraries", response: z.array(libraryCardSchema) },
  document: { method: "GET", path: "/api/documents/{rel_path}", response: documentContentSchema },
  conversations: { method: "GET", path: "/api/conversations", response: z.array(conversationSummarySchema) },
  conversation: { method: "GET", path: "/api/conversations/{conversation_id}", response: conversationDetailSchema },
  skills: { method: "GET", path: "/api/skills", response: z.array(skillDefinitionSchema) },
  agentPlan: { method: "POST", path: "/api/agent/plan", response: agentPlanResponseSchema },
  agentRuns: { method: "GET", path: "/api/agent/runs", response: agentRunListContractSchema },
  agentRun: { method: "GET", path: "/api/agent/runs/{run_id}", response: agentRunStateContractSchema },
  agentRunEvents: { method: "GET", path: "/api/agent/runs/{run_id}/events", response: agentRunEventReplayContractSchema },
  pauseAgentRun: { method: "POST", path: "/api/agent/runs/{run_id}/pause", response: agentRunStateContractSchema },
  resumeAgentRun: { method: "POST", path: "/api/agent/runs/{run_id}/resume", response: agentRunStateContractSchema },
  cancelAgentRun: { method: "POST", path: "/api/agent/runs/{run_id}/cancel", response: agentRunStateContractSchema },
  retryAgentRunStep: { method: "POST", path: "/api/agent/runs/{run_id}/steps/{step_id}/retry", response: agentRunStateContractSchema },
  approveAgentConfirmation: {
    method: "POST",
    path: "/api/agent/confirmations/{confirmation_id}/approve",
    response: agentConfirmationContractSchema
  },
  rejectAgentConfirmation: {
    method: "POST",
    path: "/api/agent/confirmations/{confirmation_id}/reject",
    response: agentConfirmationContractSchema
  },
  agentTraces: { method: "GET", path: "/api/agent/traces", response: z.array(agentRunTraceSchema) },
  agentTrace: { method: "GET", path: "/api/agent/traces/{run_id}", response: agentRunTraceSchema },
  generatedCache: { method: "GET", path: "/api/agent/generated/cache/{cache_id}", response: generatedCacheDetailSchema },
  jobs: { method: "GET", path: "/api/jobs", response: z.array(jobInfoSchema) },
  job: { method: "GET", path: "/api/jobs/{job_id}", response: jobInfoSchema },
  ledger: { method: "GET", path: "/api/ledger", response: z.array(ledgerItemSchema) },
  timeline: { method: "GET", path: "/api/timeline", response: z.array(timelineEntrySchema) },
  timelineEntry: { method: "GET", path: "/api/timeline/{entry_id}", response: timelineEntrySchema },
  deleteTimelineEntry: { method: "DELETE", path: "/api/timeline/{entry_id}", response: timelineDeleteResultSchema },
  rollbackTimelineEntry: { method: "POST", path: "/api/timeline/{entry_id}/rollback", response: timelineRollbackResultSchema },
  revisionLog: { method: "GET", path: "/api/revision-log", response: z.array(revisionLogEntrySchema) }
} as const;

export type ApiContractName = keyof typeof apiContracts;
export type ApiContractMap = typeof apiContracts;
export type ApiResponseFor<TName extends ApiContractName> = z.infer<ApiContractMap[TName]["response"]>;
