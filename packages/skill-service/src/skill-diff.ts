import type { SkillDefinition } from "@xiaoshuo/shared";

const DIFF_FIELDS = [
  "id",
  "version",
  "name",
  "description",
  "context_requirements",
  "linked_targets",
  "model_policy",
  "save_policy",
  "prompt",
  "imported_from",
  "writable"
] as const;

export function createSkillDiff(before: SkillDefinition | null | undefined, after: SkillDefinition | null | undefined): string {
  const beforeLines = serializeSkillForDiff(before).split("\n");
  const afterLines = serializeSkillForDiff(after).split("\n");
  const lines = ["--- before", "+++ after"];
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < maxLength; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      continue;
    }
    if (beforeLine !== undefined) {
      lines.push(`- ${beforeLine}`);
    }
    if (afterLine !== undefined) {
      lines.push(`+ ${afterLine}`);
    }
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function serializeSkillForDiff(skill: SkillDefinition | null | undefined): string {
  if (!skill) {
    return "";
  }
  const snapshot: Record<string, unknown> = {};
  for (const field of DIFF_FIELDS) {
    const value = skill[field];
    if (value !== undefined) {
      snapshot[field] = value;
    }
  }
  return JSON.stringify(snapshot, null, 2);
}
