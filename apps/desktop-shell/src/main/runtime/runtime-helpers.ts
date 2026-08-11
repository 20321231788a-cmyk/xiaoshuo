import type { DocumentTimelineSession } from "@xiaoshuo/document-service";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import type { CurrentProject } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "./types.js";

export async function ensureProjectSessionCurrent(context: RuntimeContext): Promise<CurrentProject> {
  const currentProject = await context.projectSession.getCurrentProject();
  if (currentProject.path && context.projectIdentityRegistry) {
    const projectId = await new ProjectManifestService(currentProject.path).getProjectId();
    await context.projectIdentityRegistry.confirm(currentProject.path, projectId);
  }
  return currentProject;
}

export function startDocumentSession(sessions: Map<string, DocumentTimelineSession>, projectPath: string): DocumentTimelineSession {
  const session = {
    id: cryptoRandomId(),
    startedAt: formatNow(new Date())
  };
  sessions.set(normalizeProjectPath(projectPath), session);
  return session;
}

export function ensureDocumentSession(sessions: Map<string, DocumentTimelineSession>, projectPath: string): DocumentTimelineSession {
  const key = normalizeProjectPath(projectPath);
  const existing = sessions.get(key);
  if (existing) {
    return existing;
  }
  return startDocumentSession(sessions, projectPath);
}

export function moveDocumentSession(sessions: Map<string, DocumentTimelineSession>, fromProjectPath: string, toProjectPath: string): DocumentTimelineSession {
  const fromKey = normalizeProjectPath(fromProjectPath);
  const toKey = normalizeProjectPath(toProjectPath);
  const existing = sessions.get(fromKey);
  if (existing) {
    sessions.delete(fromKey);
    sessions.set(toKey, existing);
    return existing;
  }
  return startDocumentSession(sessions, toProjectPath);
}

export async function rebuildProjectManifest(projectPath: string): Promise<void> {
  const manifest = new ProjectManifestService(projectPath);
  await manifest.rebuild();
}

function normalizeProjectPath(projectPath: string): string {
  return projectPath.trim().toLowerCase();
}

function cryptoRandomId(): string {
  return randomUUID().replace(/-/g, "");
}

function formatNow(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
