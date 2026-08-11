import {
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  History,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Users
} from "lucide-react";
import { useEffect, useState } from "react";
import type { NovelReviewRole, NovelRoomResponse, NovelWorkspaceProject } from "@xiaoshuo/shared";
import type { TreeNode } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";

const roleOptions: Array<{ id: NovelReviewRole; label: string; detail: string; glyph: string }> = [
  { id: "plot_reviewer", label: "剧情审阅", detail: "检查推进、冲突与悬念", glyph: "剧" },
  { id: "character_reviewer", label: "人物审阅", detail: "检查动机、关系与口吻", glyph: "人" },
  { id: "continuity_reviewer", label: "连续性审阅", detail: "对照设定、伏笔与时间线", glyph: "续" },
  { id: "style_reviewer", label: "文风审阅", detail: "检查视角、句式与项目风格", glyph: "文" }
];

export function StudioProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: any) => void;
}) {
  const api = window.xiaoshuoDesktop?.novelAgent;
  const projectRoot = controller.snapshot?.currentProject.path || "";
  const activePath = controller.activeDocumentPath || "";
  const activeDocument = controller.openDocuments.find((d) => d.path === activePath) || null;
  const activeContent = activeDocument?.content || "";
  const sourceRevision = activeDocument?.updatedAt || "unsaved";

  const [project, setProject] = useState<NovelWorkspaceProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [instruction, setInstruction] = useState("检查当前章节的剧情推进、人物动机、连续性和文风，并给出可直接修改的建议。");
  const [roles, setRoles] = useState<NovelReviewRole[]>(["plot_reviewer", "character_reviewer", "continuity_reviewer"]);
  const [result, setResult] = useState<NovelRoomResponse | null>(null);
  const [viewMode, setViewMode] = useState<"merged" | "roles">("merged");
  const [includeAdjacent, setIncludeAdjacent] = useState(true);
  const [ignoredIssues, setIgnoredIssues] = useState<Set<string>>(() => new Set());

  // 初始化项目
  useEffect(() => {
    if (api && projectRoot) {
      api.identifyProject({ project_root: projectRoot })
        .then((identified) => setProject(identified))
        .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
    }
  }, [api, projectRoot]);

  function toggleRole(role: NovelReviewRole) {
    setRoles((current) =>
      current.includes(role)
        ? current.filter((item) => item !== role)
        : current.length < 3 ? [...current, role] : current
    );
  }

  async function runReview() {
    if (!api || !project) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await api.review({
        project_root: project.project_root,
        request: {
          domain: "novel_creation",
          project_id: project.project_id,
          run_id: `novel_room_${crypto.randomUUID()}`,
          budget_id: `novel_budget_${crypto.randomUUID()}`,
          instruction,
          draft: activeContent,
          current_path: activePath,
          source_revision: sourceRevision,
          requested_roles: roles,
          context_paths: activePath ? (includeAdjacent ? adjacentChapterPaths(controller.snapshot?.projectChrome.tree || [], activePath) : [activePath]) : []
        }
      });
      setResult(response);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!api || !projectRoot) {
    return (
      <div style={{ padding: "20px", display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
        <EmptyState title="小说编辑室不可用" description="请在桌面壳中打开小说项目后重试。" />
      </div>
    );
  }

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>小说编辑室</h1>
          <p>选择最多 3 位审阅角色并行分析，主笔会合并重复建议，方向冲突由你决定。</p>
        </div>
        <div className="content-actions">
          <button className="button secondary" type="button" onClick={() => onSelectFeature("review")}>
            <History size={15} />历史审阅
          </button>
        </div>
      </div>

      <div className="studio-layout" style={{ flex: 1, minHeight: 0 }}>
        {/* 左栏：步骤流程 */}
        <section className="studio-setup" style={{ overflowY: "auto" }}>
          <div className="setup-step">
            <span className="step-no">1</span>
            <div>
              <h3>审阅范围</h3>
              <p style={{ fontSize: "12px", color: "var(--muted)" }}>
                {activeDocument ? `当前章节：${activeDocument.title}` : "请先在编辑器打开一个章节文件"}
              </p>
            </div>
            <button className="button secondary compact" type="button" onClick={() => onSelectFeature("editor")}>更改</button>
          </div>

          <div className="setup-step vertical">
            <span className="step-no">2</span>
            <div>
              <h3>选择审阅角色 <small style={{ color: "var(--accent)" }}>已选 {roles.length} / 3</small></h3>
              <div className="reviewer-picker" style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
                {roleOptions.map((role) => {
                  const selected = roles.includes(role.id);
                  return (
                    <button
                      key={role.id}
                      className={selected ? "selected" : ""}
                      type="button"
                      onClick={() => toggleRole(role.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "8px 12px",
                        border: "1px solid var(--line)",
                        borderRadius: "6px",
                        textAlign: "left",
                        background: selected ? "var(--accent-soft)" : "transparent",
                        cursor: "pointer"
                      }}
                    >
                      <span className="reviewer-avatar" style={{ width: "24px", height: "24px", display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--stone-deep)", fontSize: "12px", fontWeight: "bold" }}>
                        {role.glyph}
                      </span>
                      <span style={{ flex: 1 }}>
                        <strong style={{ fontSize: "12px", display: "block" }}>{role.label}</strong>
                        <small style={{ fontSize: "12px", color: "var(--muted)" }}>{role.detail}</small>
                      </span>
                      <i>{selected ? <Check size={14} style={{ color: "var(--accent)" }} /> : <Plus size={14} />}</i>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="setup-step vertical">
            <span className="step-no">3</span>
            <div>
              <h3>本次目标</h3>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid var(--line)", resize: "none", fontSize: "12px" }}
                rows={3}
              />
              <label className="check-line" style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", fontSize: "12px" }}>
                <input type="checkbox" checked={includeAdjacent} onChange={(event) => setIncludeAdjacent(event.target.checked)} />
                <span>同时检查与前后两章的衔接</span>
              </label>
            </div>
          </div>

          <button
            className="button primary"
            style={{ width: "100%", minHeight: "36px", marginTop: "15px" }}
            type="button"
            onClick={runReview}
            disabled={busy || !activePath || !roles.length}
          >
            <Sparkles size={15} />{busy ? "正在审阅中..." : "开始运行审阅"}
          </button>
          {message && <p style={{ color: "var(--danger)", fontSize: "12px", marginTop: "6px" }}>{message}</p>}
        </section>

        {/* 右栏：审阅结果展示 */}
        <section className="studio-result" style={{ overflowY: "auto" }}>
          <div className="result-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: "10px", marginBottom: "15px" }}>
            <div>
              <span className="success-icon" style={{ color: "var(--success)" }}><Check size={15} /></span>
              <strong style={{ marginLeft: "4px" }}>
                {result ? "审阅已完成" : "等待审阅"}
              </strong>
            </div>
            <div className="segment">
              <button className={viewMode === "merged" ? "active" : ""} type="button" onClick={() => setViewMode("merged")}>合并建议</button>
              <button className={viewMode === "roles" ? "active" : ""} type="button" onClick={() => setViewMode("roles")}>按角色</button>
            </div>
          </div>

          {result ? (
            <>
              <div className="result-summary" style={{ background: "var(--stone-deep)", padding: "12px", borderRadius: "6px", marginBottom: "15px" }}>
                <strong>本章整体结构良好，已发现 {result.reviews.reduce((sum, r) => sum + r.issues.length, 0)} 项修改建议</strong>
                <p style={{ fontSize: "12px", color: "var(--muted)", margin: "4px 0" }}>{result.merged_summary}</p>
              </div>

              {/* 渲染具体的建议 */}
              {viewMode === "merged" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {result.reviews.flatMap((review) => review.issues.map((issue, index) => ({ issue, key: `${review.role}-${index}` }))).filter((entry) => !ignoredIssues.has(entry.key)).map(({ issue, key }) => (
                    <article className="review-issue" key={key} style={{ padding: "12px", border: "1px solid var(--line)", borderRadius: "6px" }}>
                      <span className={`severity ${issue.severity}`} style={{ fontSize: "12px", padding: "2px 6px", borderRadius: "4px", background: "var(--stone)", display: "inline-block" }}>
                        {issue.severity === "blocking" ? "阻断" : issue.severity === "warning" ? "建议" : "优化"}
                      </span>
                      <div style={{ marginTop: "6px" }}>
                        <strong style={{ fontSize: "12px" }}>{issue.summary}</strong>
                        <p style={{ fontSize: "12px", color: "var(--muted)", margin: "4px 0" }}>{issue.suggestion}</p>
                        <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                          <button className="button secondary compact" type="button" style={{ height: "24px" }} onClick={() => {
                            controller.setMessageInput(`针对审阅建议：${issue.suggestion}，请帮我提供修改提案。`);
                            onSelectFeature("conversations");
                          }}>
                            生成修改
                          </button>
                          <button className="button secondary compact" type="button" style={{ height: "24px" }} onClick={() => setIgnoredIssues((current) => new Set(current).add(key))}>忽略</button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
                  {result.reviews.map((review) => (
                    <div key={review.role} style={{ borderLeft: "2px solid var(--accent)", paddingLeft: "10px" }}>
                      <strong style={{ fontSize: "12px" }}>
                        {roleOptions.find((r) => r.id === review.role)?.label}
                      </strong>
                      <p style={{ fontSize: "12px", color: "var(--muted)", margin: "4px 0" }}>{review.summary}</p>
                      {review.issues.map((issue, idx) => (
                        <div key={idx} style={{ fontSize: "12px", background: "var(--stone)", padding: "6px", borderRadius: "4px", marginTop: "4px" }}>
                          <strong>{issue.summary}</strong>
                          <p>{issue.suggestion}</p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
              <Users size={24} style={{ display: "block", margin: "0 auto 10px" }} />
              还没有审阅结果。在左侧选择范围与审阅角色并开始审校。
            </div>
          )}

          {result && (
            <div className="result-footer" style={{ borderTop: "1px solid var(--line)", marginTop: "20px", paddingTop: "15px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "var(--muted)" }}>所有修改会生成预览，确认后才会写入正文。</span>
              <button className="button primary" type="button" onClick={() => onSelectFeature("conversations")}>
                查看修改预览
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function adjacentChapterPaths(nodes: TreeNode[], activePath: string): string[] {
  const paths: string[] = [];
  const visit = (items: TreeNode[]) => items.forEach((item) => {
    if (item.kind === "file" && /正文|章节/.test(item.path) && /\.(txt|md)$/i.test(item.path)) paths.push(item.path);
    if (item.children?.length) visit(item.children);
  });
  visit(nodes);
  const index = paths.indexOf(activePath);
  if (index < 0) return [activePath];
  return paths.slice(Math.max(0, index - 1), index + 2);
}
