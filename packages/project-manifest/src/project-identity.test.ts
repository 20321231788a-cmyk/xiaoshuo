import { describe, expect, it } from "vitest";
import { createProjectId, parseProjectId } from "./project-identity.js";

describe("project identity", () => {
  it("creates and normalizes UUID project identifiers", () => {
    const projectId = createProjectId();

    expect(parseProjectId(projectId)).toBe(projectId);
    expect(parseProjectId(projectId.toUpperCase())).toBe(projectId);
  });

  it("rejects malformed project identifiers", () => {
    expect(parseProjectId("")).toBeNull();
    expect(parseProjectId("project-demo")).toBeNull();
    expect(parseProjectId({ project_id: "not-a-uuid" })).toBeNull();
  });
});
