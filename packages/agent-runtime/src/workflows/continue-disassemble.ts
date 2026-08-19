import type { AgentRunRequest, AgentRunResponse } from "@xiaoshuo/shared";
import { DisassembleBookWorkflow } from "./disassemble-book.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";

/**
 * Compatibility entry for historical "继续拆书/拆细纲" commands.
 *
 * The former implementation created a new reverse-outline expansion.  That
 * made the same book enter two incompatible pipelines.  Continuing now hands
 * the original request to the prefix-chapters workflow, which restores only
 * the missing fast-batch checkpoints and never creates a new 细纲 file.
 */
export class ContinueDisassembleWorkflow implements WorkflowHandler {
  id = "continue_disassemble";
  private readonly fastWorkflow = new DisassembleBookWorkflow();

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    return this.fastWorkflow.runAgent({
      ...request,
      skill_id: "disassemble_book",
      action: ""
    } as AgentRunRequest, context);
  }
}
