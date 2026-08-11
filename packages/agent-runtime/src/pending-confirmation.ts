import type { SkillRunResponse } from "@xiaoshuo/shared";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Skill responses historically exposed confirmation state in several nested
 * shapes. Keep one authoritative derivation so wrappers cannot accidentally
 * turn a real pending action into a completed response.
 */
export function skillRunResponseRequiresConfirmation(result?: SkillRunResponse | null): boolean {
  if (!result) {
    return false;
  }

  const response = result as SkillRunResponse & { requires_confirmation?: unknown };
  if (response.requires_confirmation === true) {
    return true;
  }

  const data = record(result.data);
  if (!data) {
    return false;
  }
  if (data.requires_confirmation === true || data.pending_save === true) {
    return true;
  }

  const libraryDraft = record(data.library_draft);
  if (libraryDraft && libraryDraft.requires_confirmation !== false) {
    return true;
  }

  const savePlan = record(data.save_plan);
  return savePlan?.requires_confirmation === true;
}
