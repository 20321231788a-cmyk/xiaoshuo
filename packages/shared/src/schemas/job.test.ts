import { describe, expect, it } from "vitest";
import { legacyJobRunMappingListResponseSchema, legacyJobRunMappingSchema } from "./job.js";

describe("legacy JobManager run mapping schema", () => {
  const mapping = {
    mapping_version: 1,
    source: "legacy_job_manager",
    legacy_job_id: "job-1",
    run_id: "legacy-job:job-1",
    job: { id: "job-1", kind: "novel_crawl", status: "running", progress: 0.5, message: "抓取中" },
    read_only: true,
    recoverable: false,
    agent_control_operations: []
  };

  it("accepts only an explicitly read-only, non-recoverable projection", () => {
    expect(legacyJobRunMappingSchema.parse(mapping)).toEqual(mapping);
    expect(legacyJobRunMappingListResponseSchema.parse({ mappings: [mapping] })).toEqual({ mappings: [mapping] });
  });

  it("rejects Agent-like ids and recoverable or controllable compatibility records", () => {
    expect(() => legacyJobRunMappingSchema.parse({ ...mapping, run_id: "run-1" })).toThrow();
    expect(() => legacyJobRunMappingSchema.parse({ ...mapping, recoverable: true })).toThrow();
    expect(() => legacyJobRunMappingSchema.parse({ ...mapping, agent_control_operations: ["resume"] })).toThrow();
  });
});
