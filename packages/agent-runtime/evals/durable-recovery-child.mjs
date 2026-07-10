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

process.send?.({ run_id: execution.run_id });
setInterval(() => undefined, 1_000);
