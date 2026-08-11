import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  History
} from "lucide-react";
import { useState } from "react";
import type { NovelProjectTransferPlan, NovelProjectTransferSourceConfirmResult, NovelWorkspaceProject } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";

export function TransferProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: any) => void;
}) {
  const api = window.xiaoshuoDesktop?.novelAgent;
  const projectRoot = controller.snapshot?.currentProject.path || "";
  const currentProjectName = controller.snapshot?.currentProject.name || "当前项目";

  const [source, setSource] = useState<NovelWorkspaceProject | null>(null);
  const [sourcePath, setSourcePath] = useState("00_设定集/设定集/人物设定.txt");
  const [targetPath, setTargetPath] = useState("00_设定集/设定集/人物设定.txt");
  const [kind, setKind] = useState<NovelProjectTransferPlan["items"][number]["kind"]>("character_setting");
  const [strategy, setStrategy] = useState<NovelProjectTransferPlan["items"][number]["strategy"]>("create");
  const [plan, setPlan] = useState<NovelProjectTransferPlan | null>(null);
  const [sourceConfirmation, setSourceConfirmation] = useState<NovelProjectTransferSourceConfirmResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<NovelProjectTransferPlan[]>([]);

  const [checkSource, setCheckSource] = useState(false);
  const [checkTarget, setCheckTarget] = useState(false);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectSourceProject() {
    if (!api) return;
    await runAction(async () => {
      const selected = await api.pickTransferProject();
      setSource(selected);
    });
  }

  async function generatePlan() {
    if (!api || !source) return;
    await runAction(async () => {
      const nextPlan = await api.createTransferPlan({
        source_project_id: source.project_id,
        source_project_root: source.project_root,
        target_project_id: (controller.snapshot!.currentProject as any).project_id || "target",
        target_project_root: projectRoot,
        items: [{ kind, source_path: sourcePath, target_path: targetPath, strategy }]
      });
      setPlan(nextPlan);
      setSourceConfirmation(null);
    });
  }

  async function confirmSource() {
    if (!api || !plan) return;
    await runAction(async () => {
      const res = await api.confirmTransferSource({
        transfer_id: plan.transfer_id,
        plan_sha256: plan.plan_sha256
      });
      setSourceConfirmation(res);
    });
  }

  async function commitTransfer() {
    if (!api || !plan || !sourceConfirmation) return;
    await runAction(async () => {
      await api.commitTransfer({
        transfer_id: plan.transfer_id,
        plan_sha256: plan.plan_sha256,
        source_confirmation_id: sourceConfirmation.source_confirmation_id,
        operation_id: crypto.randomUUID()
      });
      setPlan(null);
      setSourceConfirmation(null);
      setMessage("素材迁移成功已写入目标项目。");
    });
  }

  async function toggleHistory() {
    if (historyOpen) { setHistoryOpen(false); return; }
    if (!api) return;
    await runAction(async () => {
      const project = await api.identifyProject({ project_root: projectRoot });
      const snapshot = await api.snapshot(project);
      setHistory(snapshot.transfer_plans);
      setHistoryOpen(true);
    });
  }

  if (!api || !projectRoot) {
    return (
      <div style={{ padding: "20px", display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
        <EmptyState title="素材迁移不可用" description="请在桌面壳中打开项目后重试。" />
      </div>
    );
  }

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>素材迁移</h1>
          <p>在两个小说项目之间复制选中的设定、风格和参考素材。</p>
        </div>
        <div className="content-actions">
          <button className="button secondary" type="button" aria-pressed={historyOpen} onClick={() => void toggleHistory()}>
            <History size={15} />迁移历史
          </button>
        </div>
      </div>
      {historyOpen && (
        <section className="transfer-history">
          {history.map((item) => <article key={item.transfer_id}><strong>{item.status === "committed" ? "迁移已完成" : "迁移计划"}</strong><span>{item.items.length} 项 · {item.status}</span></article>)}
          {!history.length && <p>当前项目还没有迁移记录。</p>}
        </section>
      )}

      {/* 顶部：项目选择与双向箭头 */}
      <div className="transfer-flow">
        <div className="project-box source">
          <span>来源项目</span>
          <button type="button" onClick={selectSourceProject}>
            <div className="cover-mini">春</div>
            <span>
              <strong>{source ? source.project_root.split(/[\\/]/).pop() : "选择项目"}</strong>
              <small>{source ? source.project_root : "点击选择来源项目文件"}</small>
            </span>
            <ChevronDown size={15} />
          </button>
        </div>

        <ArrowLeftRight size={22} style={{ color: "var(--accent)" }} />

        <div className="project-box target">
          <span>目标项目</span>
          <button type="button" disabled>
            <div className="cover-mini dark">长</div>
            <span>
              <strong>{currentProjectName}</strong>
              <small>{projectRoot}</small>
            </span>
          </button>
        </div>
      </div>

      {message && <p style={{ fontSize: "12px", color: "var(--success)", margin: "8px 0" }}>{message}</p>}

      {/* 主体三栏 */}
      <div className="transfer-layout" style={{ flex: 1, minHeight: 0, marginTop: "15px" }}>
        {/* 左栏：选择迁移内容 */}
        <section className="transfer-select" style={{ overflowY: "auto" }}>
          <div className="section-title">
            <h3>选择迁移内容</h3>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
            <label className="transfer-category" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px", border: "1px solid var(--line)", borderRadius: "6px" }}>
              <input type="checkbox" checked={kind === "character_setting"} onChange={() => setKind("character_setting")} />
              <span style={{ flex: 1, fontSize: "12px" }}>
                <strong>人物设定</strong>
                <small style={{ display: "block", color: "var(--muted)", fontSize: "12px" }}>人物关系与口吻会保留为独立副本</small>
              </span>
            </label>
            <label className="transfer-category" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px", border: "1px solid var(--line)", borderRadius: "6px" }}>
              <input type="checkbox" checked={kind === "world_setting"} onChange={() => setKind("world_setting")} />
              <span style={{ flex: 1, fontSize: "12px" }}>
                <strong>世界观规则</strong>
                <small style={{ display: "block", color: "var(--muted)", fontSize: "12px" }}>仅复制所选规则，不复制项目目录</small>
              </span>
            </label>
          </div>

          <div className="transfer-fields">
            <label><span>来源相对路径</span><input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} /></label>
            <label><span>目标相对路径</span><input value={targetPath} onChange={(event) => setTargetPath(event.target.value)} /></label>
            <label><span>同名处理</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)}><option value="create">仅新建</option><option value="append">追加</option><option value="replace">替换</option><option value="skip">跳过</option></select></label>
          </div>

          <div style={{ marginTop: "15px" }}>
            <button className="button primary compact" type="button" onClick={generatePlan} disabled={busy || !source}>
              生成迁移预览
            </button>
          </div>
        </section>

        {/* 中栏：变更差异预览 */}
        <section className="transfer-preview" style={{ overflowY: "auto", flex: 1 }}>
          <div className="section-title">
            <h3>变更预览</h3>
          </div>

          <div style={{ marginTop: "10px" }}>
            {plan ? (
              <div className="diff-head" style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--muted)", paddingBottom: "6px", borderBottom: "1px solid var(--line)" }}>
                <span>来源内容</span>
                <span>目标位置与策略</span>
              </div>
            ) : null}

            {plan ? (
              plan.items.map((item) => (
                <article className="diff-row" key={item.item_id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: "12px" }}>
                  <span><FileText size={14} style={{ color: "var(--muted)", marginRight: "4px" }} />{item.source_path}</span>
                  <span>{item.target_path} ({item.strategy})</span>
                </article>
              ))
            ) : (
              <p style={{ color: "var(--muted)", textAlign: "center", padding: "20px", fontSize: "12px" }}>请在左侧选择迁移并生成预览。</p>
            )}

            {plan?.items.map((item) => (
              <pre key={item.item_id} style={{ padding: "8px", background: "var(--stone-deep)", borderRadius: "4px", fontSize: "12px", overflowX: "auto", marginTop: "10px" }}>
                {item.diff_preview}
              </pre>
            ))}
          </div>
        </section>

        {/* 右栏：双确认面板 */}
        <aside className="transfer-confirm" style={{ width: "230px", borderLeft: "1px solid var(--line)", paddingLeft: "15px" }}>
          <h3>确认迁移</h3>
          <p style={{ fontSize: "12px", color: "var(--muted)", lineHeight: "1.5", margin: "8px 0" }}>
            素材迁移会创建可撤销的项目变更记录，不复制内部对话、额度与API密钥。
          </p>

          <dl style={{ fontSize: "12px", margin: "10px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <dt style={{ color: "var(--muted)" }}>来源项目</dt>
              <dd>{source?.project_root.split(/[\\/]/).pop() || "尚未选择"}</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <dt style={{ color: "var(--muted)" }}>目标项目</dt>
              <dd>{currentProjectName}</dd>
            </div>
          </dl>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", margin: "15px 0" }}>
            <label className="check-line" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
              <input type="checkbox" checked={checkSource} onChange={(e) => setCheckSource(e.target.checked)} />
              <span>我已核对来源项目内容</span>
            </label>
            <label className="check-line" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
              <input type="checkbox" checked={checkTarget} onChange={(e) => setCheckTarget(e.target.checked)} />
              <span>我已核对目标项目及策略</span>
            </label>
          </div>

          {!sourceConfirmation ? (
            <button
              className="button primary"
              style={{ width: "100%", minHeight: "36px" }}
              type="button"
              onClick={confirmSource}
              disabled={busy || !plan || !checkSource || !checkTarget}
            >
              <ArrowLeftRight size={14} /> 确认读取来源
            </button>
          ) : (
            <button
              className="button primary"
              style={{ width: "100%", minHeight: "36px", background: "var(--success)", borderColor: "var(--success)" }}
              type="button"
              onClick={commitTransfer}
              disabled={busy}
            >
              <Check size={14} /> 确认写入目标并提交
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
