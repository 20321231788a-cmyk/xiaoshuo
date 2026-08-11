import { createHash } from "node:crypto";
import type { ExecutionStorePort } from "./execution-store-port.js";

export type WorkflowUnitCheckpoint = {
  workflow_id: string;
  unit_id: string;
  payload: Record<string, unknown>;
};

export type WorkflowCheckpointStore = {
  listCompletedUnits(workflowId: string): WorkflowUnitCheckpoint[];
  completeUnit(checkpoint: WorkflowUnitCheckpoint): WorkflowUnitCheckpoint;
};

export type DurableWorkflowCheckpointOptions = {
  runId: string;
  stepId: string;
  attemptId: string;
};

/**
 * Stores unit completion markers in the run event log. A deterministic event
 * id makes a resumed attempt observe the original completion instead of
 * creating another checkpoint for the same unit.
 */
export class DurableWorkflowCheckpointStore implements WorkflowCheckpointStore {
  private readonly store: ExecutionStorePort;
  private readonly options: DurableWorkflowCheckpointOptions;

  constructor(store: ExecutionStorePort, options: DurableWorkflowCheckpointOptions) {
    this.store = store;
    this.options = options;
  }

  listCompletedUnits(workflowId: string): WorkflowUnitCheckpoint[] {
    const completed: WorkflowUnitCheckpoint[] = [];
    let after = 0;
    while (true) {
      const events = this.store.listEvents(this.options.runId, { after, limit: 1_000 });
      if (events.length === 0) {
        return completed;
      }
      for (const event of events) {
        if (event.event_type !== "workflow.unit.completed" || event.step_id !== this.options.stepId) {
          continue;
        }
        const checkpoint = parseCheckpoint(event.payload);
        if (checkpoint?.workflow_id === workflowId) {
          completed.push(checkpoint);
        }
      }
      const nextAfter = events.at(-1)?.sequence ?? after;
      if (events.length < 1_000 || nextAfter <= after) {
        return completed;
      }
      after = nextAfter;
    }
  }

  completeUnit(checkpoint: WorkflowUnitCheckpoint): WorkflowUnitCheckpoint {
    const normalized = normalizeCheckpoint(checkpoint);
    const event = this.store.appendEventInTransaction(this.options.runId, {
      event_id: checkpointEventId(this.options.runId, this.options.stepId, normalized.workflow_id, normalized.unit_id),
      event_type: "workflow.unit.completed",
      step_id: this.options.stepId,
      payload: {
        ...normalized,
        attempt_id: this.options.attemptId
      }
    });
    return parseCheckpoint(event.payload) ?? normalized;
  }
}

function checkpointEventId(runId: string, stepId: string, workflowId: string, unitId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ runId, stepId, workflowId, unitId }), "utf8")
    .digest("hex");
  return `workflow_checkpoint_${digest}`;
}

function normalizeCheckpoint(checkpoint: WorkflowUnitCheckpoint): WorkflowUnitCheckpoint {
  const workflowId = String(checkpoint.workflow_id || "").trim();
  const unitId = String(checkpoint.unit_id || "").trim();
  if (!workflowId || !unitId) {
    throw new Error("Workflow checkpoints require workflow_id and unit_id");
  }
  return {
    workflow_id: workflowId,
    unit_id: unitId,
    payload: checkpoint.payload && typeof checkpoint.payload === "object" && !Array.isArray(checkpoint.payload)
      ? { ...checkpoint.payload }
      : {}
  };
}

function parseCheckpoint(value: unknown): WorkflowUnitCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const workflowId = String(source.workflow_id || "").trim();
  const unitId = String(source.unit_id || "").trim();
  if (!workflowId || !unitId) {
    return null;
  }
  const payload = source.payload;
  return {
    workflow_id: workflowId,
    unit_id: unitId,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>) } : {}
  };
}
