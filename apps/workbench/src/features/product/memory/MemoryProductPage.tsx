import {
  Check,
  CircleAlert,
  History,
  Info,
  MemoryStick,
  MoreHorizontal,
  ShieldCheck
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { NovelMemoryBatchPrepareResult, NovelWorkspaceProject } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";

type ConfirmedClaim = { id: string; content: string; status: string; source_path?: string };

export function MemoryProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: any) => void;
}) {
  const api = window.xiaoshuoDesktop?.novelAgent;
  const projectRoot = controller.snapshot?.currentProject.path || "";

  const [project, setProject] = useState<NovelWorkspaceProject | null>(null);
  const [batch, setBatch] = useState<NovelMemoryBatchPrepareResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState<"pending" | "conflict" | "confirmed">("pending");
  const [expandedItemId, setExpandedItemId] = useState("");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [confirmedClaims, setConfirmedClaims] = useState<ConfirmedClaim[]>([]);

  // 初始化项目
  useEffect(() => {
    if (api && projectRoot) {
      api.identifyProject({ project_root: projectRoot })
        .then(async (identified) => {
          setProject(identified);
          const prepared = await api.prepareMemoryBatch(identified);
          setBatch(prepared);
        })
        .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
    }
  }, [api, projectRoot]);

  useEffect(() => {
    if (activeTab !== "confirmed" || !projectRoot) return;
    const fetchFn = controller.runtime.fetchFn || fetch;
    void fetchFn(new URL("/api/memory/claims", controller.runtime.apiBase)).then(async (response) => {
      if (!response.ok) throw new Error("读取已确认记忆失败");
      const payload = await response.json() as { claims?: ConfirmedClaim[] };
      setConfirmedClaims((payload.claims || []).filter((claim) => claim.status === "confirmed"));
    }).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [activeTab, controller.runtime.apiBase, controller.runtime.fetchFn, projectRoot]);

  // 刷新记忆数据
  async function refreshMemory() {
    if (!api || !project) return;
    setBusy(true);
    try {
      const prepared = await api.prepareMemoryBatch(project);
      setBatch(prepared);
      setSelected([]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // 确定批量记忆项
  async function handleConfirmSelected() {
    if (!api || !project || !batch) return;
    setBusy(true);
    const selectedItems = batch.items.filter(
      (item) => selected.includes(item.claim_id) && !item.subjective && !item.conflict_summary
    );
    const confirmationIds = Object.fromEntries(
      selectedItems.map((item) => [item.claim_id, crypto.randomUUID()])
    );

    try {
      await api.confirmMemoryBatch({
        project_root: project.project_root,
        request: {
          project_id: project.project_id,
          batch_id: `memory_${crypto.randomUUID()}`,
          items: selectedItems,
          confirmation_ids: confirmationIds,
          operation_id: crypto.randomUUID()
        }
      });
      const prepared = await api.prepareMemoryBatch(project);
      setBatch(prepared);
      setSelected([]);
      setMessage("已成功将确认内容记入项目记忆。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSingle(claimId: string) {
    if (!api || !project || !batch) return;
    const item = batch.items.find((candidate) => candidate.claim_id === claimId);
    if (!item) return;
    setBusy(true);
    try {
      await api.confirmMemoryBatch({ project_root: project.project_root, request: { project_id: project.project_id, batch_id: `memory_single_${crypto.randomUUID()}`, items: [item], confirmation_ids: { [item.claim_id]: crypto.randomUUID() }, operation_id: crypto.randomUUID() } });
      await refreshMemory();
      setMessage("已单独确认这条记忆。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function forgetClaim(claimId: string) {
    const fetchFn = controller.runtime.fetchFn || fetch;
    const response = await fetchFn(new URL(`/api/memory/claims/${encodeURIComponent(claimId)}`, controller.runtime.apiBase), { method: "DELETE" });
    if (!response.ok) { setMessage("遗忘记忆失败，请刷新后重试。"); return; }
    setConfirmedClaims((current) => current.filter((claim) => claim.id !== claimId));
    setMessage("已遗忘这条项目记忆。");
  }

  const eligibleItems = useMemo(() => {
    return (batch?.items || []).filter((item) => !item.subjective && !item.conflict_summary);
  }, [batch]);

  const selectedItems = useMemo(() => {
    return (batch?.items || []).filter((item) => selected.includes(item.claim_id) && !item.subjective && !item.conflict_summary);
  }, [batch, selected]);
  const visiblePendingItems = useMemo(() => (batch?.items || []).filter((item) => !dismissed.includes(item.claim_id)).filter((item) => activeTab === "conflict" ? item.subjective || Boolean(item.conflict_summary) : !item.subjective && !item.conflict_summary), [activeTab, batch, dismissed]);

  if (!api || !projectRoot) {
    return (
      <div style={{ padding: "20px", display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
        <EmptyState title="项目记忆审核不可用" description="请在桌面壳中打开小说项目后重试。" />
      </div>
    );
  }

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>项目记忆</h1>
          <p>确认后，AI 会在后续写作中把这些内容当作既定事实。</p>
        </div>
        <div className="content-actions">
          <button className="button secondary" type="button" onClick={() => setActiveTab("confirmed")}>
            <History size={15} /> 已确认记忆
          </button>
          <button
            className="button primary"
            type="button"
            onClick={handleConfirmSelected}
            disabled={busy || !selectedItems.length}
          >
            <Check size={15} /> 确认所选 {selectedItems.length} 条
          </button>
        </div>
      </div>

      <div className="notice-bar">
        <Info size={16} />
        <span>
          <strong>{batch?.items.length || 0} 条内容等待确认。</strong>
          主观推测和未来剧情不会被批量确认，需要逐条决定。
        </span>
      </div>

      {message && <p style={{ fontSize: "12px", color: "var(--success)", margin: "8px 0" }}>{message}</p>}

      <div className="memory-toolbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
        <label className="check-line" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
          <input
            type="checkbox"
            checked={eligibleItems.length > 0 && selected.length === eligibleItems.length}
            onChange={(e) => {
              if (e.target.checked) {
                setSelected(eligibleItems.map((item) => item.claim_id));
              } else {
                setSelected([]);
              }
            }}
            disabled={eligibleItems.length === 0}
          />
          <span>选择全部可确认内容</span>
        </label>
        <div className="filter-pills">
          <button className={activeTab === "pending" ? "active" : ""} onClick={() => setActiveTab("pending")}>
            待确认 {batch?.items.length || 0}
          </button>
          <button className={activeTab === "conflict" ? "active" : ""} onClick={() => setActiveTab("conflict")}>
            有冲突 {(batch?.items || []).filter((item) => item.subjective || item.conflict_summary).length}
          </button>
          <button className={activeTab === "confirmed" ? "active" : ""} onClick={() => setActiveTab("confirmed")}>
            已确认
          </button>
        </div>
      </div>

      {/* 记忆列表 */}
      <section className="memory-list" style={{ overflowY: "auto", flex: 1, marginTop: "10px" }}>
        {activeTab !== "confirmed" && visiblePendingItems.map((item) => {
          const requiresIndividualReview = item.subjective || Boolean(item.conflict_summary);
          const isChecked = selected.includes(item.claim_id);
          return (
            <article
              key={item.claim_id}
              className={`memory-row ${requiresIndividualReview ? "locked" : "selectable"}`}
              style={{ display: "flex", alignItems: "start", gap: "10px", padding: "12px", borderBottom: "1px solid var(--line)" }}
            >
              <label style={{ marginTop: "4px" }}>
                <input
                  type="checkbox"
                  disabled={requiresIndividualReview}
                  checked={isChecked}
                  onChange={() => {
                    setSelected((current) =>
                      current.includes(item.claim_id)
                        ? current.filter((id) => id !== item.claim_id)
                        : [...current, item.claim_id]
                    );
                  }}
                />
              </label>
              <span className={`memory-kind kind-${requiresIndividualReview ? 3 : 0}`} style={{ fontSize: "12px", padding: "2px 6px", borderRadius: "4px", background: "var(--stone)" }}>
                {item.claim_type}
              </span>
              <div style={{ flex: 1, fontSize: "12px" }}>
                <strong>{item.content}</strong>
                <small style={{ display: "block", color: "var(--muted)", fontSize: "12px", marginTop: "4px" }}>
                  来源：{item.source_path} · 可信度高
                </small>
                {item.subjective && (
                  <p style={{ display: "flex", alignItems: "center", gap: "4px", color: "var(--warning)", fontSize: "12px", margin: "4px 0 0" }}>
                    <CircleAlert size={13} />
                    <span>属于主观推测，需要您单独确认判断。</span>
                  </p>
                )}
                {item.conflict_summary && (
                  <p style={{ display: "flex", alignItems: "center", gap: "4px", color: "var(--danger)", fontSize: "12px", margin: "4px 0 0" }}>
                    <ShieldCheck size={13} />
                    <span>与当前故事设定存在冲突：{item.conflict_summary}。</span>
                  </p>
                )}
              </div>
              <button className="icon-button subtle" type="button" aria-label="记忆操作" aria-expanded={expandedItemId === item.claim_id} onClick={() => setExpandedItemId((current) => current === item.claim_id ? "" : item.claim_id)}>
                <MoreHorizontal size={15} />
              </button>
              {expandedItemId === item.claim_id && (
                <div className="memory-item-actions">
                  <button type="button" onClick={() => void confirmSingle(item.claim_id)} disabled={busy}>单独确认</button>
                  <button type="button" onClick={() => setDismissed((current) => [...current, item.claim_id])}>稍后处理</button>
                </div>
              )}
            </article>
          );
        })}
        {activeTab === "confirmed" && confirmedClaims.map((claim) => (
          <article className="memory-row confirmed" key={claim.id}><MemoryStick size={16} /><div><strong>{claim.content}</strong><small>{claim.source_path || "项目记忆"}</small></div><button className="button secondary compact" type="button" onClick={() => void forgetClaim(claim.id)}>遗忘</button></article>
        ))}
        {((activeTab === "confirmed" && confirmedClaims.length === 0) || (activeTab !== "confirmed" && visiblePendingItems.length === 0)) && (
          <div style={{ padding: "40px" }}>
            <EmptyState title="没有待确认的记忆" description="小说创作后，AI 会自动为您扫描需要进入记忆的事实信息。" />
          </div>
        )}
      </section>

      {/* 粘性底部确认栏 */}
      {selectedItems.length > 0 && (
        <div className="sticky-selection">
          <span>
            已选择 <strong>{selectedItems.length} 条</strong>，确认后将作为既定事实加入项目检索上下文，您可以随时纠正或遗忘。
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="button secondary" type="button" onClick={() => setSelected([])}>
              取消选择
            </button>
            <button className="button primary" type="button" onClick={handleConfirmSelected} disabled={busy}>
              确认并加入记忆
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
