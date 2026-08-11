import { randomUUID } from "node:crypto";

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createProjectId(): string {
  return randomUUID();
}

export function parseProjectId(value: unknown): string | null {
  const projectId = typeof value === "string" ? value.trim() : "";
  return PROJECT_ID_PATTERN.test(projectId) ? projectId.toLowerCase() : null;
}
