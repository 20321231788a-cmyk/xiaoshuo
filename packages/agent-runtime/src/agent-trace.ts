import {
  agentRunTraceSchema,
  type AgentContextBlockTrace,
  type AgentModelCallTrace,
  type AgentRouteCandidateTrace,
  type AgentRunTrace,
  type AgentSaveDecisionTrace,
  type AgentTraceStage,
  type WebSearchSource
} from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_EXCERPT_CHARS = 800;
const MAX_ERROR_CHARS = 4000;
const MAX_REASON_CHARS = 1000;
const TRACE_DIR = path.join("00_设定集", ".agent", "runs");

export type AgentTraceRecorder = {
  readonly runId: string;
  mark(stage: AgentTraceStage, patch?: Partial<AgentRunTrace>): void;
  addRouteCandidates(candidates: AgentRouteCandidateTrace[]): void;
  addContextBlock(block: AgentContextBlockTrace): void;
  addModelCall(call: AgentModelCallTrace): void;
  addSaveDecision(decision: AgentSaveDecisionTrace): void;
  addWebSearchSources(sources: WebSearchSource[]): void;
  fail(error: unknown): void;
  finish(patch?: Partial<AgentRunTrace>): Promise<void>;
};

export type AgentTraceRecorderOptions = {
  projectRoot: string;
  conversationId?: string;
  skillId?: string;
  content?: string;
  requestId?: string;
  now?: () => Date;
  idFactory?: () => string;
};

export function createAgentTraceRecorder(options: AgentTraceRecorderOptions): AgentTraceRecorder {
  return new JsonlAgentTraceRecorder(options);
}

export function getAgentTraceFilePath(projectRoot: string, date = new Date()): string {
  return path.join(getAgentTraceDirPath(projectRoot), `${formatTraceDate(date)}.jsonl`);
}

export function getAgentTraceDirPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), TRACE_DIR);
}

class JsonlAgentTraceRecorder implements AgentTraceRecorder {
  readonly runId: string;
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly startedMs: number;
  private finished = false;
  private trace: AgentRunTrace;

  constructor(options: AgentTraceRecorderOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.now = options.now ?? (() => new Date());
    this.startedMs = Date.now();
    this.runId = options.idFactory?.() || randomUUID().replaceAll("-", "");
    const startedAt = this.now().toISOString();
    this.trace = agentRunTraceSchema.parse({
      run_id: this.runId,
      request_id: sanitizeText(options.requestId || "", 120),
      conversation_id: sanitizeText(options.conversationId || "", 120),
      skill_id: sanitizeText(options.skillId || "", 120),
      project_path: this.projectRoot,
      started_at: startedAt,
      stage: "received",
      input_excerpt: sanitizeText(options.content || "", MAX_EXCERPT_CHARS)
    });
  }

  mark(stage: AgentTraceStage, patch: Partial<AgentRunTrace> = {}): void {
    this.trace = sanitizeTrace({
      ...this.trace,
      ...patch,
      stage
    });
  }

  addRouteCandidates(candidates: AgentRouteCandidateTrace[]): void {
    this.trace.route_candidates = candidates
      .map((candidate) => ({
        skill_id: sanitizeText(candidate.skill_id || "", 120),
        score: Number.isFinite(candidate.score) ? candidate.score : 0,
        reasons: (candidate.reasons || []).map((item) => sanitizeText(item, MAX_REASON_CHARS)).slice(0, 8),
        signals: (candidate.signals || []).map((item) => sanitizeText(item, 200)).slice(0, 16)
      }))
      .slice(0, 12);
  }

  addContextBlock(block: AgentContextBlockTrace): void {
    this.trace.context_blocks.push({
      ...block,
      name: sanitizeText(block.name, 200),
      reason: sanitizeText(block.reason || "", MAX_REASON_CHARS)
    });
  }

  addModelCall(call: AgentModelCallTrace): void {
    this.trace.model_calls.push({
      ...call,
      model: sanitizeText(call.model || "", 200),
      error: sanitizeText(call.error || "", MAX_ERROR_CHARS)
    });
  }

  addSaveDecision(decision: AgentSaveDecisionTrace): void {
    this.trace.save_decision = {
      ...decision,
      action: sanitizeText(decision.action || "", 120),
      cache_id: sanitizeText(decision.cache_id || "", 120),
      reason: sanitizeText(decision.reason || "", MAX_REASON_CHARS),
      target_paths: (decision.target_paths || []).map((item) => sanitizeText(item, 500)).slice(0, 20)
    };
  }

  addWebSearchSources(sources: WebSearchSource[]): void {
    const seen = new Set(this.trace.web_search_sources.map((source) => source.url));
    for (const source of sources || []) {
      const title = sanitizeText(source.title || "", 300);
      const url = sanitizeUrl(source.url || "");
      if (!title || !url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      this.trace.web_search_sources.push({ title, url });
      if (this.trace.web_search_sources.length >= 10) {
        break;
      }
    }
  }

  fail(error: unknown): void {
    this.mark("failed", {
      error: sanitizeText(error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error), MAX_ERROR_CHARS)
    });
  }

  async finish(patch: Partial<AgentRunTrace> = {}): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const endedAt = this.now();
    this.trace = sanitizeTrace({
      ...this.trace,
      ...patch,
      ended_at: endedAt.toISOString(),
      duration_ms: Math.max(0, Math.trunc(Date.now() - this.startedMs))
    });

    try {
      const parsed = agentRunTraceSchema.parse(this.trace);
      const target = getAgentTraceFilePath(this.projectRoot, endedAt);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, `${JSON.stringify(parsed)}\n`, "utf8");
    } catch {
      // Trace is diagnostics only; it must never break an agent run.
    }
  }
}

function sanitizeTrace(trace: Partial<AgentRunTrace> & Pick<AgentRunTrace, "run_id" | "started_at">): AgentRunTrace {
  return agentRunTraceSchema.parse({
    ...trace,
    request_id: sanitizeText(trace.request_id || "", 120),
    conversation_id: sanitizeText(trace.conversation_id || "", 120),
    skill_id: sanitizeText(trace.skill_id || "", 120),
    project_path: sanitizeText(trace.project_path || "", 1000),
    input_excerpt: sanitizeText(trace.input_excerpt || "", MAX_EXCERPT_CHARS),
    selected_skill_id: sanitizeText(trace.selected_skill_id || "", 120),
    selected_reason: sanitizeText(trace.selected_reason || "", MAX_REASON_CHARS),
    saved_paths: (trace.saved_paths || []).map((item) => sanitizeText(item, 500)).slice(0, 50),
    error: sanitizeText(trace.error || "", MAX_ERROR_CHARS)
  });
}

function sanitizeText(value: string, limit: number): string {
  const withoutSecrets = String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*['"]?[^'"\s,}]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
    .replace(/\b[a-zA-Z0-9_-]{24,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\b/g, "[redacted-token]");
  return withoutSecrets.length <= limit ? withoutSecrets : `${withoutSecrets.slice(0, limit).trimEnd()}...`;
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password|auth|credential/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return "";
  }
}

function formatTraceDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}
