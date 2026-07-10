import { createApiClient } from "@xiaoshuo/api-client";
import type { AgentConfirmation, AgentRunEvent, AgentRunState, AgentRunTrace } from "@xiaoshuo/shared";
import { Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkbenchRuntime } from "../lib/runtime.js";
import {
  appendAgentRunEvent,
  markAgentRunEventGap,
  mergeAgentRunEvents,
  replayAgentRunEvents,
  type AgentRunEventReplay
} from "./agentRunEvents.js";

type ReplayState = AgentRunEventReplay & { events: AgentRunEvent[] };

export function AgentTraceView({ runtime }: { runtime: WorkbenchRuntime }) {
  const client = useMemo(() => createApiClient({ baseUrl: runtime.apiBase, fetchFn: runtime.fetchFn }), [runtime.apiBase, runtime.fetchFn]);
  const [runs, setRuns] = useState<AgentRunState[]>([]);
  const [traces, setTraces] = useState<AgentRunTrace[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runDetail, setRunDetail] = useState<AgentRunState | null>(null);
  const [detail, setDetail] = useState<AgentRunTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [acting, setActing] = useState("");
  const [events, setEvents] = useState<AgentRunEvent[]>([]);
  const [confirmations, setConfirmations] = useState<AgentConfirmation[]>([]);
  const [eventGapDetected, setEventGapDetected] = useState(false);
  const replayStateRef = useRef(new Map<string, ReplayState>());
  const loadSequenceRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);

  function stopEventStream() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }

  function startEventStream(runId: string, after: number, loadSequence: number) {
    stopEventStream();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    void client.streamAgentRunEvents(runId, {
      onEvent: (event) => {
        if (controller.signal.aborted || loadSequence !== loadSequenceRef.current) {
          return;
        }
        const current = replayStateRef.current.get(runId) || { events: [], nextSequence: after, gapDetected: false };
        const next = appendAgentRunEvent(current, event);
        const nextState: ReplayState = { ...next };
        replayStateRef.current.set(runId, nextState);
        setEvents(nextState.events);
      },
      onGap: async () => {
        if (controller.signal.aborted || loadSequence !== loadSequenceRef.current) {
          return;
        }
        const current = replayStateRef.current.get(runId) || { events: [], nextSequence: after, gapDetected: false };
        const nextState: ReplayState = { ...markAgentRunEventGap(current) };
        replayStateRef.current.set(runId, nextState);
        setEventGapDetected(true);
        try {
          const correctedRun = await client.getAgentRun(runId);
          if (!controller.signal.aborted && loadSequence === loadSequenceRef.current) {
            setRunDetail(correctedRun);
            setMessage("检测到事件保留缺口，已重新读取运行状态");
          }
        } catch (error) {
          if (!controller.signal.aborted && loadSequence === loadSequenceRef.current) {
            setMessage(error instanceof Error ? error.message : String(error));
          }
        }
      },
      onEnd: () => {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
      }
    }, after, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted && loadSequence === loadSequenceRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    });
  }

  async function loadRun(runId: string, fallbackRun?: AgentRunState, fallbackTrace?: AgentRunTrace) {
    stopEventStream();
    const loadSequence = ++loadSequenceRef.current;
    if (!runId) {
      setRunDetail(null);
      setDetail(null);
      setEvents([]);
      setConfirmations([]);
      setEventGapDetected(false);
      return;
    }
    const replayState = replayStateRef.current.get(runId) || { events: [], nextSequence: 0, gapDetected: false };
    setMessage("");
    setSelectedRunId(runId);
    setRunDetail(fallbackRun || null);
    setDetail(fallbackTrace || null);
    setEvents(replayState.events);
    setConfirmations([]);
    setEventGapDetected(replayState.gapDetected);
    setDetailLoading(true);
    try {
      const [nextRun, nextTrace, nextConfirmations, replay] = await Promise.allSettled([
        client.getAgentRun(runId),
        client.getAgentTrace(runId),
        client.getAgentRunConfirmations(runId),
        replayAgentRunEvents((after) => client.getAgentRunEvents(runId, after), replayState.nextSequence)
      ]);
      if (loadSequence !== loadSequenceRef.current) {
        return;
      }
      if (nextRun.status === "fulfilled") {
        setRunDetail(nextRun.value);
      }
      if (nextTrace.status === "fulfilled") {
        setDetail(nextTrace.value);
      }
      if (nextConfirmations.status === "fulfilled") {
        setConfirmations(nextConfirmations.value);
      }
      if (replay.status === "fulfilled") {
        const nextReplayState: ReplayState = {
          events: mergeAgentRunEvents(replayState.events, replay.value.events),
          nextSequence: replay.value.nextSequence,
          gapDetected: replayState.gapDetected || replay.value.gapDetected
        };
        replayStateRef.current.set(runId, nextReplayState);
        setEvents(nextReplayState.events);
        setEventGapDetected(nextReplayState.gapDetected);

        if (replay.value.gapDetected) {
          const correctedRun = await client.getAgentRun(runId);
          if (loadSequence !== loadSequenceRef.current) {
            return;
          }
          setRunDetail(correctedRun);
          setMessage("检测到事件保留缺口，已重新读取运行状态");
        }
        if (loadSequence === loadSequenceRef.current) {
          startEventStream(runId, nextReplayState.nextSequence, loadSequence);
        }
      }
      if (nextRun.status === "rejected" && nextTrace.status === "rejected") {
        throw nextRun.reason;
      }
      if (replay.status === "rejected" && nextRun.status === "fulfilled") {
        setMessage(replay.reason instanceof Error ? replay.reason.message : String(replay.reason));
      }
    } catch (error) {
      if (loadSequence !== loadSequenceRef.current) {
        return;
      }
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (loadSequence === loadSequenceRef.current) {
        setDetailLoading(false);
      }
    }
  }

  async function refreshTraces() {
    setLoading(true);
    setMessage("");
    try {
      const [runResponse, nextTraces] = await Promise.all([client.listAgentRuns({ limit: 50 }), client.getAgentTraces(50)]);
      const nextRuns = runResponse.runs;
      setRuns(nextRuns);
      setTraces(nextTraces);
      const nextRun = nextRuns.find((run) => run.run_id === selectedRunId) || nextRuns[0] || null;
      const nextTrace = nextTraces.find((trace) => trace.run_id === (nextRun?.run_id || selectedRunId)) || (!nextRun ? nextTraces[0] : null);
      if (nextRun || nextTrace) {
        await loadRun(nextRun?.run_id || nextTrace!.run_id, nextRun || undefined, nextTrace || undefined);
      } else {
        setSelectedRunId("");
        setRunDetail(null);
        setDetail(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setRuns([]);
      setTraces([]);
      setRunDetail(null);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshTraces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => () => {
    stopEventStream();
  }, []);

  const selectedTrace = detail || traces.find((trace) => trace.run_id === selectedRunId) || traces[0] || null;
  const selectedRun = runDetail || runs.find((run) => run.run_id === selectedRunId) || null;
  const legacyTraces = traces.filter((trace) => !runs.some((run) => run.run_id === trace.run_id));

  async function runAction(action: "pause" | "resume" | "cancel" | "retry", stepId = "") {
    if (!selectedRun) return;
    setActing(action);
    setMessage("");
    try {
      const payload = { operation_id: createOperationId(), expected_version: selectedRun.version };
      const next = action === "pause"
        ? await client.pauseAgentRun(selectedRun.run_id, payload)
        : action === "resume"
          ? await client.resumeAgentRun(selectedRun.run_id, payload)
          : action === "cancel"
            ? await client.cancelAgentRun(selectedRun.run_id, payload)
            : await client.retryAgentRunStep(selectedRun.run_id, stepId || selectedRun.current_step_id, payload);
      setRunDetail(next);
      setRuns((current) => current.map((run) => (run.run_id === next.run_id ? next : run)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  async function resolveConfirmation(confirmation: AgentConfirmation, action: "approve" | "reject") {
    if (!selectedRun) return;
    setActing(`${action}:${confirmation.confirmation_id}`);
    setMessage("");
    try {
      const payload = { operation_id: createOperationId(), expected_version: confirmation.version };
      const resolved = action === "approve"
        ? await client.approveAgentConfirmation(confirmation.confirmation_id, payload)
        : await client.rejectAgentConfirmation(confirmation.confirmation_id, payload);
      setConfirmations((current) => current.map((item) => item.confirmation_id === resolved.confirmation_id ? resolved : item));
      const next = await client.getAgentRun(selectedRun.run_id);
      setRunDetail(next);
      setRuns((current) => current.map((run) => run.run_id === next.run_id ? next : run));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  return (
    <section className="xw-feature-page xw-trace-page">
      <div className="xw-feature-toolbar">
        <strong>Agent 运行</strong>
        <span>{loading ? "读取中" : `${runs.length} 个任务`}</span>
        {detailLoading && <span>详情读取中</span>}
        {message && <span className="xw-trace-warning">{message}</span>}
        <button className="xw-secondary-button compact" onClick={() => void refreshTraces()} disabled={loading}>
          <RefreshCw size={14} />
          <span>刷新</span>
        </button>
      </div>

      <div className="xw-trace-layout">
        <div className="xw-trace-list" aria-label="Agent trace runs">
          {runs.map((run) => (
            <button
              key={run.run_id}
              className={`xw-feature-card action xw-trace-run ${run.run_id === selectedRunId ? "selected" : ""} ${run.status === "failed" ? "error" : ""}`}
              type="button"
              onClick={() => void loadRun(run.run_id, run, traces.find((trace) => trace.run_id === run.run_id))}
            >
              <div className="xw-feature-card-head">
                <strong>{formatRunTitle(run)}</strong>
                <small>{formatDate(run.updated_at)}</small>
              </div>
              <span>{run.goal.instruction || run.run_id}</span>
              <div className="xw-trace-badges">
                <small>{formatRunStatus(run.status)}</small>
                <small>{run.steps.filter((step) => step.status === "done").length}/{run.steps.length} 步</small>
                {run.status === "failed" && <small className="danger">需要处理</small>}
              </div>
            </button>
          ))}
          {legacyTraces.map((trace) => (
            <button
              key={`legacy-${trace.run_id}`}
              className={`xw-feature-card action xw-trace-run ${trace.run_id === selectedRunId ? "selected" : ""}`}
              type="button"
              onClick={() => void loadRun(trace.run_id, undefined, trace)}
            >
              <div className="xw-feature-card-head"><strong>{formatTraceTitle(trace)}</strong><small>{formatDate(trace.ended_at || trace.started_at)}</small></div>
              <span>{trace.input_excerpt || trace.run_id}</span>
              <div className="xw-trace-badges"><small>历史 Trace</small></div>
            </button>
          ))}
          {!runs.length && !legacyTraces.length && <p className="xw-feature-empty">{loading ? "正在读取运行记录" : "暂无运行记录"}</p>}
        </div>

        <TraceDetail trace={selectedTrace} run={selectedRun} events={events} confirmations={confirmations} eventGapDetected={eventGapDetected} acting={acting} onAction={runAction} onResolveConfirmation={resolveConfirmation} />
      </div>
    </section>
  );
}

function TraceDetail({
  trace,
  run,
  events,
  confirmations,
  eventGapDetected,
  acting,
  onAction,
  onResolveConfirmation
}: {
  trace: AgentRunTrace | null;
  run: AgentRunState | null;
  events: AgentRunEvent[];
  confirmations: AgentConfirmation[];
  eventGapDetected: boolean;
  acting: string;
  onAction: (action: "pause" | "resume" | "cancel" | "retry", stepId?: string) => Promise<void>;
  onResolveConfirmation: (confirmation: AgentConfirmation, action: "approve" | "reject") => Promise<void>;
}) {
  if (!trace && !run) {
    return <p className="xw-feature-empty">未选择运行记录</p>;
  }

  return (
    <article className="xw-trace-detail" aria-label="Agent trace detail">
      <div className="xw-trace-detail-head">
        <div>
          <strong>{run ? formatRunTitle(run) : formatTraceTitle(trace!)}</strong>
          <span>{run?.run_id || trace?.run_id}</span>
        </div>
        <small>{formatDate(run?.updated_at || trace?.ended_at || trace?.started_at || "")}</small>
      </div>

      {run && <RunControls run={run} acting={acting} onAction={onAction} />}

      {run && (
        <>
          <div className="xw-trace-summary-grid">
            <TraceMetric label="状态" value={formatRunStatus(run.status)} />
            <TraceMetric label="计划" value={`v${run.plan_version}`} />
            <TraceMetric label="步骤" value={`${run.steps.filter((step) => step.status === "done").length}/${run.steps.length}`} />
            <TraceMetric label="尝试" value={String(run.steps.reduce((total, step) => total + step.attempts, 0))} />
          </div>
          <TraceSection title="执行步骤">
            <div className="xw-trace-stack">
              {run.steps.map((step) => (
                <div key={step.step_id} className={`xw-trace-row ${step.status === "failed" ? "error" : ""}`}>
                  <strong>{step.instruction || step.skill_id || step.action_id}</strong>
                  <small>{formatStepStatus(step.status)} · {step.attempts}/{step.max_attempts} 次</small>
                  {step.error && <span>{step.error}</span>}
                  {step.status === "failed" && step.retryable && (
                    <button
                      className="xw-secondary-button compact"
                      disabled={Boolean(acting) || !canRetryStep(run, step)}
                      onClick={() => void onAction("retry", step.step_id)}
                    >
                      <RotateCcw size={14} /><span>重试此步</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </TraceSection>
          {confirmations.length > 0 && <TraceSection title="执行确认">
            <div className="xw-trace-stack">
              {confirmations.map((confirmation) => (
                <div key={confirmation.confirmation_id} className={`xw-trace-row ${confirmation.status === "rejected" || confirmation.status === "expired" ? "error" : ""}`}>
                  <strong>{confirmation.summary || confirmation.action}</strong>
                  <small>{formatConfirmationStatus(confirmation.status)}{confirmation.target_paths.length ? ` · ${confirmation.target_paths.join("、")}` : ""}</small>
                  {confirmation.status === "pending" && <span className="xw-trace-row-actions">
                    <button className="xw-secondary-button compact" disabled={Boolean(acting)} onClick={() => void onResolveConfirmation(confirmation, "approve")}>批准</button>
                    <button className="xw-secondary-button compact" disabled={Boolean(acting)} onClick={() => void onResolveConfirmation(confirmation, "reject")}>拒绝</button>
                  </span>}
                  {confirmation.status === "approved" && <span>已批准。请使用“继续”显式恢复任务。</span>}
                </div>
              ))}
            </div>
          </TraceSection>}
          <TraceSection title="运行事件">
            {eventGapDetected && <p className="xw-trace-warning">部分历史事件已不再保留，状态以当前运行详情为准。</p>}
            <div className="xw-trace-stack">
              {events.map((event) => (
                <div key={event.event_id} className="xw-trace-row">
                  <strong>{event.event_type}</strong>
                  <small>#{event.sequence} · {formatDate(event.created_at)}</small>
                  <span>{event.step_id ? `步骤 ${event.step_id}` : "运行事件"}</span>
                </div>
              ))}
              {!events.length && <p>-</p>}
            </div>
          </TraceSection>
          {run.error && <TraceSection title="运行错误"><p className="xw-trace-error">{run.error}</p></TraceSection>}
        </>
      )}

      {trace && <div className="xw-trace-summary-grid">
        <TraceMetric label="阶段" value={trace.stage} />
        <TraceMetric label="意图" value={trace.intent || "-"} />
        <TraceMetric label="技能" value={trace.selected_skill_id || trace.skill_id || "-"} />
        <TraceMetric label="耗时" value={`${trace.duration_ms || 0} ms`} />
      </div>}

      {trace && <><TraceSection title="输入摘要">
        <p>{trace.input_excerpt || "-"}</p>
      </TraceSection>

      <TraceSection title="选择理由">
        <p>{trace.selected_reason || "-"}</p>
      </TraceSection>

      {trace.route_candidates.length > 0 && (
        <TraceSection title="候选技能">
          <div className="xw-trace-stack">
            {trace.route_candidates.map((candidate, index) => (
              <div key={`${candidate.skill_id}-${index}`} className="xw-trace-row">
                <strong>{candidate.skill_id || "未命名"}</strong>
                <small>{candidate.score.toFixed(2)}</small>
                <span>{[...candidate.reasons, ...candidate.signals].filter(Boolean).join(" · ") || "-"}</span>
              </div>
            ))}
          </div>
        </TraceSection>
      )}

      <TraceSection title="上下文块">
        <div className="xw-trace-stack">
          {trace.context_blocks.map((block, index) => (
            <TraceContextBlockRow key={`${block.name}-${index}`} block={block} />
          ))}
          {!trace.context_blocks.length && <p>-</p>}
        </div>
      </TraceSection>

      <TraceSection title="模型调用">
        <div className="xw-trace-stack">
          {trace.model_calls.map((call, index) => (
            <div key={`${call.model}-${index}`} className="xw-trace-row">
              <strong>{call.model || "unknown"}</strong>
              <small>{call.line} · {call.streaming ? "stream" : "single"} · {call.duration_ms} ms</small>
              <span>输入 {call.input_chars} 字 · 输出 {call.output_chars} 字{call.fallback_used ? " · fallback" : ""}{call.error ? ` · ${call.error}` : ""}</span>
            </div>
          ))}
          {!trace.model_calls.length && <p>-</p>}
        </div>
      </TraceSection>

      <TraceSection title="联网来源">
        <div className="xw-trace-link-list">
          {trace.web_search_sources.map((source, index) => (
            <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">
              {source.title || source.url}
            </a>
          ))}
          {!trace.web_search_sources.length && <p>-</p>}
        </div>
      </TraceSection>

      <TraceSection title="保存决策">
        <p>{trace.save_decision ? `${trace.save_decision.action || "-"}${trace.save_decision.mode ? ` · ${trace.save_decision.mode}` : ""}${trace.save_decision.auto_committed ? " · 已写入" : ""}` : "-"}</p>
        {trace.save_decision?.reason && <p>{trace.save_decision.reason}</p>}
        <TracePathList paths={trace.save_decision?.target_paths || trace.saved_paths} />
      </TraceSection>

      {trace.error && (
        <TraceSection title="错误">
          <p className="xw-trace-error">{trace.error}</p>
        </TraceSection>
      )}</>}
    </article>
  );
}

function RunControls({
  run,
  acting,
  onAction
}: {
  run: AgentRunState;
  acting: string;
  onAction: (action: "pause" | "resume" | "cancel") => Promise<void>;
}) {
  const busy = Boolean(acting);
  const canPause = ["queued", "planning", "running", "waiting_user_input", "waiting_confirmation"].includes(run.status);
  const canResume = run.status === "paused" || run.status === "failed";
  const canCancel = !["cancelling", "cancelled", "completed"].includes(run.status);

  return (
    <div className="xw-feature-actions" aria-label="运行操作">
      <button
        className="xw-secondary-button compact"
        type="button"
        aria-label="暂停运行"
        title="暂停运行"
        disabled={busy || !canPause}
        onClick={() => void onAction("pause")}
      >
        <Pause size={14} />
      </button>
      <button
        className="xw-secondary-button compact"
        type="button"
        aria-label="恢复运行"
        title="恢复运行"
        disabled={busy || !canResume}
        onClick={() => void onAction("resume")}
      >
        <Play size={14} />
      </button>
      <button
        className="xw-danger-button compact"
        type="button"
        aria-label="取消运行"
        title="取消运行"
        disabled={busy || !canCancel}
        onClick={() => void onAction("cancel")}
      >
        <Square size={14} />
      </button>
    </div>
  );
}

function TraceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="xw-trace-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TraceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="xw-trace-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function TraceContextBlockRow({ block }: { block: AgentRunTrace["context_blocks"][number] }) {
  const reference = getReferenceMetadata(block);
  const metaParts = [
    reference?.kind ? `类型 ${reference.kind}` : "",
    reference?.confidence !== undefined ? `置信度 ${formatConfidence(reference.confidence)}` : "",
    reference?.matchedText ? `匹配 ${reference.matchedText}` : ""
  ].filter(Boolean);

  return (
    <div className={`xw-trace-row ${block.included ? "" : "muted"}`}>
      <strong>{reference?.label || block.name}</strong>
      <small>{block.source} · {block.chars} 字 · {block.included ? "已纳入" : "未纳入"}</small>
      <span>{block.reason || "-"}</span>
      {reference?.path && (
        <div className="xw-trace-paths">
          <code>{reference.path}</code>
          {metaParts.length > 0 && <small>{metaParts.join(" · ")}</small>}
        </div>
      )}
    </div>
  );
}

function TracePathList({ paths }: { paths: string[] }) {
  if (!paths.length) {
    return null;
  }
  return (
    <div className="xw-trace-paths">
      {paths.map((item) => (
        <code key={item}>{item}</code>
      ))}
    </div>
  );
}

function getReferenceMetadata(block: AgentRunTrace["context_blocks"][number]): {
  path: string;
  label: string;
  kind: string;
  confidence?: number;
  matchedText: string;
} | null {
  const record = block as Record<string, unknown>;
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const role = stringValue(metadata.role) || stringValue(record.role);
  const path = stringValue(metadata.path) || stringValue(record.path);
  if (!path || (role && role !== "reference_file")) {
    return null;
  }
  return {
    path,
    label: stringValue(metadata.label) || stringValue(record.label),
    kind: stringValue(metadata.kind) || stringValue(record.kind),
    confidence: numberValue(metadata.confidence ?? record.confidence),
    matchedText: stringValue(metadata.matched_text) || stringValue(record.matched_text)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatConfidence(value: number): string {
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(normalized)}%`;
}

function formatTraceTitle(trace: AgentRunTrace): string {
  return trace.selected_skill_id || trace.skill_id || trace.intent || trace.stage || "agent run";
}

function formatRunTitle(run: AgentRunState): string {
  const currentStep = run.steps.find((step) => step.step_id === run.current_step_id);
  return currentStep?.instruction || currentStep?.skill_id || run.goal.instruction || run.run_id;
}

function formatRunStatus(status: AgentRunState["status"]): string {
  return {
    queued: "排队中",
    planning: "规划中",
    running: "执行中",
    waiting_user_input: "等待输入",
    waiting_confirmation: "等待确认",
    paused: "已暂停",
    cancelling: "取消中",
    failed: "失败",
    cancelled: "已取消",
    completed: "已完成"
  }[status];
}

function formatStepStatus(status: AgentRunState["steps"][number]["status"]): string {
  return {
    pending: "待执行",
    running: "执行中",
    waiting_confirmation: "等待确认",
    done: "已完成",
    failed: "失败",
    skipped: "已跳过",
    cancelled: "已取消"
  }[status];
}

function formatConfirmationStatus(status: AgentConfirmation["status"]): string {
  return {
    pending: "待确认",
    approved: "已批准",
    rejected: "已拒绝",
    expired: "已过期",
    superseded: "已替代"
  }[status];
}

function canRetryStep(run: AgentRunState, step: AgentRunState["steps"][number]): boolean {
  return run.status === "failed" && step.status === "failed" && step.retryable && step.attempts < step.max_attempts;
}

function createOperationId(): string {
  return crypto.randomUUID();
}

function formatDate(value: string): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}
