import type { DocumentTimelineSession } from "@xiaoshuo/document-service";
import type { JobManager } from "@xiaoshuo/job-service";
import type { ProjectSessionService } from "@xiaoshuo/project-session";
import type http from "node:http";

export const runtimeHost = "127.0.0.1";
const configuredRuntimePort = Number.parseInt(process.env.XIAOSHUO_RUNTIME_PORT || "", 10);
export const runtimePort = Number.isInteger(configuredRuntimePort) && configuredRuntimePort > 0 ? configuredRuntimePort : 18453;
export const runtimeUrl = `http://${runtimeHost}:${runtimePort}`;

export type RuntimeServerState = {
  server?: http.Server;
  ready?: boolean;
  lastError?: string;
  jobManager?: JobManager;
  documentSessions?: Map<string, DocumentTimelineSession>;
};

export type RuntimeServerOptions = {
  projectRoot: string;
  stateFilePath: string;
  state: RuntimeServerState;
};

export type RuntimeContext = {
  projectRoot: string;
  jobManager: JobManager;
  projectSession: ProjectSessionService;
  documentSessions: Map<string, DocumentTimelineSession>;
};
