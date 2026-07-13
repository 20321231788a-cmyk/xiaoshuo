import { type ActionDescriptor } from "@xiaoshuo/shared";

export const ACTION_DESCRIPTORS: Record<string, ActionDescriptor> = {
  read_project_files: {
    action: "read_project_files",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read"],
    has_side_effects: false,
    retryable: true,
    timeout_ms: 10000,
    confirmation_policy: "never"
  },
  resolve_project_references: {
    action: "resolve_project_references",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read"],
    has_side_effects: false,
    retryable: true,
    timeout_ms: 10000,
    confirmation_policy: "never"
  },
  run_skill: {
    action: "run_skill",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read", "model.invoke"],
    has_side_effects: false,
    retryable: true,
    timeout_ms: 30000,
    confirmation_policy: "never"
  },
  run_workflow: {
    action: "run_workflow",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read", "project.write", "model.invoke"],
    has_side_effects: true,
    retryable: false,
    timeout_ms: 60000,
    confirmation_policy: "always"
  },
  search_project_memory: {
    action: "search_project_memory",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read"],
    has_side_effects: false,
    retryable: true,
    timeout_ms: 10000,
    confirmation_policy: "never"
  },
  search_web_material: {
    action: "search_web_material",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read"],
    has_side_effects: false,
    retryable: true,
    timeout_ms: 15000,
    confirmation_policy: "never"
  },
  check_graph_consistency: {
    action: "check_graph_consistency",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read"],
    has_side_effects: false,
    retryable: true,
    timeout_ms: 10000,
    confirmation_policy: "never"
  },
  evaluate_artifact: {
    action: "evaluate_artifact",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.read"],
    has_side_effects: false,
    retryable: true,
    timeout_ms: 10000,
    confirmation_policy: "never"
  },
  propose_save: {
    action: "propose_save",
    input_schema: {},
    output_schema: {},
    required_permissions: ["project.write"],
    has_side_effects: true,
    retryable: true,
    timeout_ms: 10000,
    confirmation_policy: "always"
  }
};
