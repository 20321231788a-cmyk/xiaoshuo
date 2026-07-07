import { createApiClient } from "@xiaoshuo/api-client";
import type { AgentRunTrace } from "@xiaoshuo/shared";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkbenchRuntime } from "../lib/runtime.js";

export function AgentTraceView({ runtime }: { runtime: WorkbenchRuntime }) {
  const client = useMemo(() => createApiClient({ baseUrl: runtime.apiBase }), [runtime.apiBase]);
  const [traces, setTraces] = useState<AgentRunTrace[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState<AgentRunTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadTrace(runId: string, fallback?: AgentRunTrace) {
    if (!runId) {
      setDetail(null);
      return;
    }
    setSelectedRunId(runId);
    setDetail(fallback || null);
    setDetailLoading(true);
    try {
      setDetail(await client.getAgentTrace(runId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (fallback) {
        setDetail(fallback);
      }
    } finally {
      setDetailLoading(false);
    }
  }

  async function refreshTraces() {
    setLoading(true);
    setMessage("");
    try {
      const nextTraces = await client.getAgentTraces(50);
      setTraces(nextTraces);
      const nextSelected = nextTraces.find((trace) => trace.run_id === selectedRunId) || nextTraces[0] || null;
      if (nextSelected) {
        await loadTrace(nextSelected.run_id, nextSelected);
      } else {
        setSelectedRunId("");
        setDetail(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setTraces([]);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshTraces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const selectedTrace = detail || traces.find((trace) => trace.run_id === selectedRunId) || traces[0] || null;

  return (
    <section className="xw-feature-page xw-trace-page">
      <div className="xw-feature-toolbar">
        <strong>Agent 运行</strong>
        <span>{loading ? "读取中" : `${traces.length} 条`}</span>
        {detailLoading && <span>详情读取中</span>}
        {message && <span className="xw-trace-warning">{message}</span>}
        <button className="xw-secondary-button compact" onClick={() => void refreshTraces()} disabled={loading}>
          <RefreshCw size={14} />
          <span>刷新</span>
        </button>
      </div>

      <div className="xw-trace-layout">
        <div className="xw-trace-list" aria-label="Agent trace runs">
          {traces.map((trace) => (
            <button
              key={trace.run_id}
              className={`xw-feature-card action xw-trace-run ${trace.run_id === selectedRunId ? "selected" : ""} ${trace.error ? "error" : ""}`}
              type="button"
              onClick={() => void loadTrace(trace.run_id, trace)}
            >
              <div className="xw-feature-card-head">
                <strong>{formatTraceTitle(trace)}</strong>
                <small>{formatDate(trace.ended_at || trace.started_at)}</small>
              </div>
              <span>{trace.input_excerpt || trace.selected_reason || trace.run_id}</span>
              <div className="xw-trace-badges">
                <small>{trace.intent || trace.stage}</small>
                <small>{trace.selected_skill_id || trace.skill_id || "无技能"}</small>
                {trace.error && <small className="danger">失败</small>}
              </div>
            </button>
          ))}
          {!traces.length && <p className="xw-feature-empty">{loading ? "正在读取运行记录" : "暂无运行记录"}</p>}
        </div>

        <TraceDetail trace={selectedTrace} />
      </div>
    </section>
  );
}

function TraceDetail({ trace }: { trace: AgentRunTrace | null }) {
  if (!trace) {
    return <p className="xw-feature-empty">未选择运行记录</p>;
  }

  return (
    <article className="xw-trace-detail" aria-label="Agent trace detail">
      <div className="xw-trace-detail-head">
        <div>
          <strong>{formatTraceTitle(trace)}</strong>
          <span>{trace.run_id}</span>
        </div>
        <small>{formatDate(trace.ended_at || trace.started_at)}</small>
      </div>

      <div className="xw-trace-summary-grid">
        <TraceMetric label="阶段" value={trace.stage} />
        <TraceMetric label="意图" value={trace.intent || "-"} />
        <TraceMetric label="技能" value={trace.selected_skill_id || trace.skill_id || "-"} />
        <TraceMetric label="耗时" value={`${trace.duration_ms || 0} ms`} />
      </div>

      <TraceSection title="输入摘要">
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
      )}
    </article>
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
