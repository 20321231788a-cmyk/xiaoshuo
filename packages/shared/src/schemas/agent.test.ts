import { describe, expect, it } from "vitest";
import {
  agentRunRequestSchema,
  projectFileReferenceCandidateSchema,
  projectFileReadRequestSchema,
  projectFileResolveRequestSchema
} from "./agent.js";

describe("agent schemas", () => {
  it("applies project file resolve defaults", () => {
    const parsed = projectFileResolveRequestSchema.parse({});

    expect(parsed).toMatchObject({
      text: "",
      current_path: "",
      selection: "",
      attachment_ids: [],
      explicit_paths: [],
      max_candidates: 8
    });
  });

  it("rejects project file confidence outside 0..1", () => {
    expect(() =>
      projectFileReferenceCandidateSchema.parse({
        kind: "alias",
        confidence: 1.01
      })
    ).toThrow();
  });

  it("enforces max candidate bounds", () => {
    expect(() => projectFileResolveRequestSchema.parse({ max_candidates: 21 })).toThrow();
    expect(projectFileResolveRequestSchema.parse({ max_candidates: 20 }).max_candidates).toBe(20);
  });

  it("keeps old agent run payloads compatible", () => {
    const parsed = agentRunRequestSchema.parse({
      content: "参考章纲继续写"
    });

    expect(parsed.reference_paths).toEqual([]);
    expect(parsed.confirmed_reference_paths).toEqual([]);
    expect(parsed.disable_auto_references).toBe(false);
  });

  it("applies project file read caps", () => {
    const parsed = projectFileReadRequestSchema.parse({});

    expect(parsed.max_chars_per_file).toBe(12000);
    expect(parsed.max_total_chars).toBe(36000);
    expect(() => projectFileReadRequestSchema.parse({ max_chars_per_file: 499 })).toThrow();
    expect(() => projectFileReadRequestSchema.parse({ max_total_chars: 120001 })).toThrow();
  });
});
