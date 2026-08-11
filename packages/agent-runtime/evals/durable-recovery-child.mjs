import { RunCoordinator } from "../dist/kernel/run-coordinator.js";

const projectRoot = process.argv[2];
if (!projectRoot) {
  throw new Error("projectRoot is required");
}

const coordinator = new RunCoordinator({
  projectRoot,
  runtimeInstanceId: "runtime-crashed-child",
  leaseTtlMs: 50,
  autoHeartbeat: false
});
const execution = coordinator.beginRun({
  request_id: "forced-kill-request",
  conversation_id: "conversation-forced-kill",
  content: "resume after a forced process kill",
  current_path: "",
  selection: "",
  project_context_hint: "",
  skill_id: "",
  attachment_ids: []
});

// The coordinator currently starts a root step immediately.  Turn that root
// into the second step and persist a completed, side-effect-free prerequisite
// so recovery has to resume the active second step rather than replaying it.
const secondStep = coordinator.store.getStep(execution.run_id, execution.step_id);
const run = coordinator.getRun(execution.run_id);
if (!secondStep || !run) {
  throw new Error("Unable to initialize the two-step recovery fixture");
}

const firstStepId = "step_fixture_prepare";
const firstStep = {
  ...secondStep,
  step_id: firstStepId,
  index: 0,
  action_id: "fixture.prepare",
  instruction: "side-effect-free prerequisite",
  idempotency_key: "fixture-prepare",
  status: "pending",
  attempts: 0,
  observation_id: "",
  error_code: "",
  error: "",
  started_at: "",
  ended_at: ""
};
const preparedSecondStep = {
  ...secondStep,
  index: 1,
  action_id: "fixture.execute",
  instruction: "recover this second step"
};
const planned = coordinator.store.replaceSteps({
  run_id: execution.run_id,
  expected_run_version: run.version,
  steps: [firstStep, preparedSecondStep],
  event: { event_type: "run.fixture_checkpoint", step_id: execution.step_id }
});
if (!planned.applied) {
  throw new Error("Unable to persist the two-step recovery fixture");
}

const firstAttempt = coordinator.store.startAttempt({
  attempt_id: "attempt_fixture_prepare",
  run_id: execution.run_id,
  step_id: firstStepId,
  attempt: 1,
  input_digest: "fixture-prepare-input",
  idempotency_key: "fixture-prepare-attempt"
});
const settledFirstStep = coordinator.store.finishAttempt({
  attempt_id: firstAttempt.attempt_id,
  expected_version: firstAttempt.version,
  status: "done",
  step_status: "done"
});
if (!settledFirstStep.applied) {
  throw new Error("Unable to complete the first fixture step");
}

process.send?.({ run_id: execution.run_id, first_step_id: firstStepId, second_step_id: execution.step_id });
setInterval(() => undefined, 1_000);
