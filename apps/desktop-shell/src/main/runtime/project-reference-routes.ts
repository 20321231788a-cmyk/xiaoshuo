import { DocumentService } from "@xiaoshuo/document-service";
import { ProjectFileManifestService, ProjectFileResolver } from "@xiaoshuo/agent-runtime";
import {
  projectFileReadRequestSchema,
  projectFileReadResponseSchema,
  projectFileResolveRequestSchema,
  type CurrentProject
} from "@xiaoshuo/shared";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type RuntimeProjectReferenceRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleProjectReferenceRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeProjectReferenceRouteDeps
): Promise<boolean> {
  if (!isProjectReferenceRoute(pathname)) {
    return false;
  }

  const currentProject = await deps.ensureProjectSessionCurrent(context);
  if (!currentProject.path) {
    deps.writeJson(response, 400, { detail: "尚未打开项目" });
    return true;
  }

  const documents = new DocumentService({ projectRoot: currentProject.path });
  const manifest = new ProjectFileManifestService({ projectRoot: currentProject.path, documents });

  if (pathname === "/api/project/resolve-files" && request.method === "POST") {
    try {
      const payload = projectFileResolveRequestSchema.parse(await deps.readJsonBody(request));
      const resolver = new ProjectFileResolver({ projectRoot: currentProject.path, documents, manifest });
      deps.writeJson(response, 200, await resolver.resolve({
        text: payload.text,
        currentPath: payload.current_path,
        selection: payload.selection,
        attachmentIds: payload.attachment_ids,
        explicitPaths: payload.explicit_paths,
        maxCandidates: payload.max_candidates
      }));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/project/read-references" && request.method === "POST") {
    try {
      const payload = projectFileReadRequestSchema.parse(await deps.readJsonBody(request));
      let remaining = payload.max_total_chars;
      const blocks = [];
      const warnings: string[] = [];
      for (const rawPath of payload.paths) {
        if (remaining <= 0) {
          break;
        }
        try {
          const normalized = documents.normalizeRelativePath(rawPath);
          const limit = Math.min(payload.max_chars_per_file, remaining);
          const content = await documents.readRawText(normalized, limit);
          const chars = content.length;
          remaining -= chars;
          blocks.push({
            path: normalized,
            title: path.posix.parse(normalized).name,
            content,
            chars,
            truncated: chars >= limit
          });
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
      deps.writeJson(response, 200, projectFileReadResponseSchema.parse({ blocks, warnings }));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/project/rebuild-file-manifest" && request.method === "POST") {
    try {
      const rebuilt = await manifest.rebuild();
      deps.writeJson(response, 200, {
        ok: true,
        entries: rebuilt.entries.length,
        path: manifest.manifestRelativePath()
      });
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}

function isProjectReferenceRoute(pathname: string): boolean {
  return pathname === "/api/project/resolve-files" || pathname === "/api/project/read-references" || pathname === "/api/project/rebuild-file-manifest";
}
