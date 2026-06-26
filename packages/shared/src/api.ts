import { z } from "zod";
import { agentPlanResponseSchema, generatedCacheDetailSchema } from "./schemas/agent.js";
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
