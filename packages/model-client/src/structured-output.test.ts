import { describe, it, expect } from "vitest";
import { z } from "zod";
import { StructuredOutputManager, StructuredOutputParseError } from "./structured-output.js";

describe("StructuredOutputManager", () => {
  const testSchema = z.object({
    name: z.string(),
    count: z.number()
  });

  it("should parse valid clean JSON", () => {
    const raw = '{"name": "test", "count": 42}';
    const parsed = StructuredOutputManager.parseWithSchema(raw, testSchema);
    expect(parsed).toEqual({ name: "test", count: 42 });
  });

  it("should strip markdown code block wraps", () => {
    const raw = '```json\n{"name": "markdown", "count": 10}\n```';
    const parsed = StructuredOutputManager.parseWithSchema(raw, testSchema);
    expect(parsed).toEqual({ name: "markdown", count: 10 });
  });

  it("should fix trailing commas inside JSON objects", () => {
    const raw = '{"name": "comma", "count": 5, }';
    const parsed = StructuredOutputManager.parseWithSchema(raw, testSchema);
    expect(parsed).toEqual({ name: "comma", count: 5 });
  });

  it("should throw StructuredOutputParseError on zod validation fail", () => {
    const raw = '{"name": "wrong_type", "count": "not_a_number"}';
    expect(() => {
      StructuredOutputManager.parseWithSchema(raw, testSchema);
    }).toThrow(StructuredOutputParseError);
  });

  it("should throw StructuredOutputParseError on malformed JSON", () => {
    const raw = '{"name": "incomplete", ';
    expect(() => {
      StructuredOutputManager.parseWithSchema(raw, testSchema);
    }).toThrow(StructuredOutputParseError);
  });
});
