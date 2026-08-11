import { z } from "zod";

export class StructuredOutputParseError extends Error {
  readonly code = "STRUCTURED_OUTPUT_PARSE_FAILED";
  constructor(message: string, readonly rawContent?: string, readonly zodErrors?: z.ZodError) {
    super(message);
    this.name = "StructuredOutputParseError";
  }
}

export class StructuredOutputManager {
  static cleanAndParseJSON(text: string): any {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, "");
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3).trim();
    }

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");

    let jsonCandidate = cleaned;
    if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      jsonCandidate = cleaned.slice(firstBrace, lastBrace + 1);
    } else if (firstBracket !== -1 && lastBracket !== -1) {
      jsonCandidate = cleaned.slice(firstBracket, lastBracket + 1);
    }

    jsonCandidate = jsonCandidate
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/,\s*,/g, ",");

    return JSON.parse(jsonCandidate);
  }

  static parseWithSchema<T>(text: string, schema: z.ZodType<T>): T {
    try {
      const rawObj = this.cleanAndParseJSON(text);
      return schema.parse(rawObj);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new StructuredOutputParseError(`JSON schema validation failed: ${error.message}`, text, error);
      }
      throw new StructuredOutputParseError(`JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`, text);
    }
  }

  static buildStrictPrompt(schema: z.ZodType<any>, originalInstruction: string): string {
    const schemaDesc = JSON.stringify(this.zodToSchemaDesc(schema), null, 2);
    return `${originalInstruction}

请严格按以下 JSON Schema 格式输出结果。只能输出 JSON，不要带有任何 Markdown 标记或多余文字。
格式要求：
${schemaDesc}`;
  }

  private static zodToSchemaDesc(schema: z.ZodType<any>): any {
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape;
      const properties: Record<string, any> = {};
      for (const key of Object.keys(shape)) {
        properties[key] = this.zodToSchemaDesc(shape[key]);
      }
      return { type: "object", properties };
    }
    if (schema instanceof z.ZodArray) {
      return { type: "array", items: this.zodToSchemaDesc(schema.element) };
    }
    if (schema instanceof z.ZodEnum) {
      return { type: "string", enum: schema.options };
    }
    if (schema instanceof z.ZodString) {
      return { type: "string" };
    }
    if (schema instanceof z.ZodNumber) {
      return { type: "number" };
    }
    if (schema instanceof z.ZodBoolean) {
      return { type: "boolean" };
    }
    return { type: "any" };
  }
}
