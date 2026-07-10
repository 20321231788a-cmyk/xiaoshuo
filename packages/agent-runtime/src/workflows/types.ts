import type { ConfigServiceOptions } from "@xiaoshuo/config-service";
import type { ConversationService } from "@xiaoshuo/conversation-service";
import type { DocumentService } from "@xiaoshuo/document-service";
import type { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import type { AgentRunRequest, AgentRunResponse, SkillRunRequest, SkillRunResponse } from "@xiaoshuo/shared";
import type { AgentTraceRecorder } from "../agent-trace.js";
import type { GeneratedSavePlanner } from "../generated-save-planner.js";
import type { PromptSkillRunner } from "../skill-runner.js";
import type { StreamingModelClient } from "../stream.js";
import type { WebSearchClient } from "../web-search.js";
import type { WorkflowCheckpointStore } from "../kernel/workflow-checkpoint.js";
import type { CommitJournalService } from "../kernel/commit-journal-service.js";

export type WorkflowDurableExecution = {
  runId: string;
  stepId: string;
  attemptId: string;
};

export type WorkflowRunContext = {
  projectRoot: string;
  config: ConfigServiceOptions;
  modelClient: StreamingModelClient;
  webSearchClient: WebSearchClient;
  documents: DocumentService;
  conversations: ConversationService;
  cache: GeneratedCacheService;
  savePlanner: GeneratedSavePlanner;
  skillRunner: PromptSkillRunner;
  trace?: AgentTraceRecorder;
  signal?: AbortSignal;
  checkpoint?: WorkflowCheckpointStore;
  /** Present only for a durable runtime execution. */
  durableExecution?: WorkflowDurableExecution;
  /** Durable file commit path for workflow-owned document writes. */
  commitJournal?: CommitJournalService;
};

export type WorkflowHandler = {
  id: string;
  canRunSkillRequest?: boolean;
  runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse>;
  runSkill?(request: SkillRunRequest, context: WorkflowRunContext): Promise<SkillRunResponse>;
};
