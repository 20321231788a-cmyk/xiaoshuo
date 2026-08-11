import { createApiClient, type GovernedMemoryClaim, type GovernedMemoryConfirmation } from "@xiaoshuo/api-client";
import { Check, Download, Pencil, RefreshCw, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkbenchRuntime } from "../lib/runtime.js";

export function MemoryGovernanceView({ runtime }: { runtime: WorkbenchRuntime }) {
  const client = useMemo(() => createApiClient({ baseUrl: runtime.apiBase, fetchFn: runtime.fetchFn }), [runtime.apiBase, runtime.fetchFn]);
  const [claims, setClaims] = useState<GovernedMemoryClaim[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<GovernedMemoryConfirmation | null>(null);
  const [editingClaimId, setEditingClaimId] = useState("");
  const [replacement, setReplacement] = useState("");

  async function refresh() {
    setLoading(true);
    setMessage("");
    try {
      const response = await client.listGovernedMemoryClaims();
      setClaims(response.claims);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setClaims([]);
    } finally {
      setLoading(false);
    }
  }

  async function exportMemory() {
    setActing("export");
    setMessage("");
    try {
      const exported = await client.exportGovernedMemory();
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `governed-memory-${exported.project_id}-${exported.memory_revision}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  async function rebuildProjections() {
    setActing("rebuild");
    setMessage("");
    try {
      const result = await client.rebuildGovernedMemoryProjections();
      setMessage(`已重建 revision ${result.memory_revision} 的记忆投影。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  useEffect(() => {
    void refresh();
  }, [client]);

  async function requestConfirmation(claim: GovernedMemoryClaim) {
    setActing(claim.id);
    setMessage("");
    try {
      const result = await client.requestGovernedMemoryConfirmation(claim.id, claim.revision);
      setConfirmation(result.confirmation);
      setMessage("请确认该草稿后再写入已确认记忆。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  async function resolve(decision: "approved" | "rejected") {
    if (!confirmation) return;
    setActing(confirmation.confirmation_id);
    setMessage("");
    try {
      const result = await client.resolveGovernedMemoryConfirmation(confirmation.confirmation_id, confirmation.version, decision);
      setConfirmation(result.confirmation);
      if (decision === "rejected") {
        setMessage("已拒绝，本条草稿不会进入已确认记忆。");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  async function confirm() {
    if (!confirmation || confirmation.status !== "approved") return;
    setActing(confirmation.confirmation_id);
    setMessage("");
    try {
      await client.confirmGovernedMemoryClaim(confirmation.claim_id, confirmation.confirmation_id, confirmation.version);
      setConfirmation(null);
      setMessage("已写入已确认记忆。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  async function forget(claim: GovernedMemoryClaim) {
    if (!window.confirm(`遗忘“${claim.subject} ${claim.predicate} ${claim.object}”？此操作会保留审计记录。`)) return;
    setActing(claim.id);
    setMessage("");
    try {
      await client.forgetGovernedMemoryClaim(claim.id);
      setMessage("已遗忘该记忆。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  async function saveCorrection(claim: GovernedMemoryClaim) {
    const next = replacement.trim();
    if (!next) return;
    setActing(claim.id);
    setMessage("");
    try {
      await client.createGovernedMemoryOverride(claim.id, next);
      setEditingClaimId("");
      setReplacement("");
      setMessage("已保存用户修正；原始 claim 保留用于审计与回退。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActing("");
    }
  }

  return (
    <section className="xw-feature-page xw-memory-page">
      <div className="xw-feature-toolbar">
        <strong>项目记忆</strong>
        <span>{loading ? "读取中" : `${claims.length} 条记忆`}</span>
        {message && <span className="xw-memory-message">{message}</span>}
        <button className="xw-secondary-button compact" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} />
          <span>刷新</span>
        </button>
        <button className="xw-secondary-button compact" type="button" onClick={() => void exportMemory()} disabled={acting === "export"}>
          <Download size={14} />
          <span>导出</span>
        </button>
        <button className="xw-secondary-button compact" type="button" onClick={() => void rebuildProjections()} disabled={acting === "rebuild"}>
          <RotateCw size={14} />
          <span>重建投影</span>
        </button>
      </div>

      {confirmation && (
        <section className="xw-memory-confirmation" aria-live="polite">
          <div><strong>确认记忆草稿</strong><span>状态：{confirmation.status}</span></div>
          {confirmation.status === "requested" && (
            <div className="xw-memory-actions">
              <button className="xw-primary-button compact" type="button" onClick={() => void resolve("approved")} disabled={acting === confirmation.confirmation_id}><Check size={14} /><span>批准</span></button>
              <button className="xw-danger-button compact" type="button" onClick={() => void resolve("rejected")} disabled={acting === confirmation.confirmation_id}><X size={14} /><span>拒绝</span></button>
            </div>
          )}
          {confirmation.status === "approved" && <button className="xw-primary-button compact" type="button" onClick={() => void confirm()} disabled={acting === confirmation.confirmation_id}><Check size={14} /><span>确认写入</span></button>}
        </section>
      )}

      <div className="xw-memory-list">
        {claims.map((claim) => (
          <article className="xw-memory-card" key={claim.id}>
            <div className="xw-memory-card-head"><strong>{claim.subject} · {claim.predicate}</strong><span className={`xw-memory-status ${claim.status}`}>{claim.status}</span></div>
            <p>{claim.object}</p>
            <small>{claim.sourceRef || "无来源"}{claim.perspective ? ` · ${claim.perspective}` : ""}{claim.confidence !== undefined ? ` · 置信度 ${claim.confidence}` : ""}</small>
            {editingClaimId === claim.id ? (
              <div className="xw-memory-edit"><input value={replacement} onChange={(event) => setReplacement(event.target.value)} aria-label="修正记忆内容" /><button className="xw-primary-button compact" type="button" onClick={() => void saveCorrection(claim)} disabled={!replacement.trim() || acting === claim.id}><Check size={14} /><span>保存修正</span></button><button className="xw-secondary-button compact" type="button" onClick={() => setEditingClaimId("")}><X size={14} /></button></div>
            ) : (
              <div className="xw-memory-actions">
                {["draft", "proposed", "planned"].includes(claim.status) && <button className="xw-primary-button compact" type="button" onClick={() => void requestConfirmation(claim)} disabled={acting === claim.id}><Check size={14} /><span>请求确认</span></button>}
                <button className="xw-secondary-button compact" type="button" onClick={() => { setEditingClaimId(claim.id); setReplacement(claim.object); }}><Pencil size={14} /><span>纠正</span></button>
                {claim.status !== "superseded" && <button className="xw-danger-button compact" type="button" onClick={() => void forget(claim)} disabled={acting === claim.id}><Trash2 size={14} /><span>遗忘</span></button>}
              </div>
            )}
          </article>
        ))}
        {!claims.length && !loading && <p className="xw-feature-empty">当前项目没有可治理的记忆。</p>}
      </div>
    </section>
  );
}
