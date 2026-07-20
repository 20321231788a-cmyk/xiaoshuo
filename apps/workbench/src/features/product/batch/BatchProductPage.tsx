import {
  Check,
  History,
  Play,
  ShieldCheck,
  SquarePen
} from "lucide-react";
import type { TreeNode } from "@xiaoshuo/shared";
import { lazy, Suspense, useMemo, useState } from "react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";

const CardDrawFeaturePage = lazy(() =>
  import("../../card-draw/CardDrawFeaturePage.js").then((module) => ({ default: module.CardDrawFeaturePage }))
);

export function BatchProductPage({ controller }: { controller: WorkbenchController }) {
  const [mode, setMode] = useState<"draft" | "draw">("draft");
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(3);
  const [words, setWords] = useState(3000);
  const [instruction, setInstruction] = useState("");
  const [checkConsistency, setCheckConsistency] = useState(true);
  const [pauseEach, setPauseEach] = useState(true);
  const [attempts, setAttempts] = useState(2);
  const [budgetLimit, setBudgetLimit] = useState(3);
  const [showHistory, setShowHistory] = useState(false);

  function startBatch() {
    void controller.runWorkflowSkill("batch_generate", {
      chapter: Math.max(1, start),
      end_chapter: Math.max(start, end),
      target_words: Math.max(300, words),
      instruction,
      write_result: false,
      auto_revision: checkConsistency,
      score_threshold: controller.configDraft?.consistency_revision_score || 80,
      max_attempts: attempts,
      pause_each: pauseEach,
      max_cost_usd: Math.max(0, budgetLimit)
    } as any);
  }

  const chaptersCount = Math.max(1, end - start + 1);
  const totalWords = chaptersCount * words;
  const chapterRows = useMemo(
    () => buildBatchChapterRows(controller.snapshot?.projectChrome.tree || [], start, end),
    [controller.snapshot?.projectChrome.tree, start, end]
  );

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>批量章节生成</h1>
          <p>先确认章纲和预算，再逐章生成草稿；任何内容都不会自动覆盖正文。</p>
        </div>
        <div className="content-actions">
          <div className="segment">
            <button className={mode === "draft" ? "active" : ""} type="button" onClick={() => setMode("draft")}>生成草稿</button>
            <button className={mode === "draw" ? "active" : ""} type="button" onClick={() => setMode("draw")}>抽卡</button>
          </div>
          <button className={`button secondary${showHistory ? " active" : ""}`} type="button" aria-pressed={showHistory} onClick={() => setShowHistory((value) => !value)}>
            <History size={15} />历史批次
          </button>
        </div>
      </div>

      {showHistory && (
        <section className="batch-history">
          <h2>最近生成任务</h2>
          {(controller.snapshot?.jobs || []).slice(0, 8).map((job) => <button key={job.id} type="button" onClick={() => void controller.selectJob(job.id)}><span>{String(job.skill_id || "生成任务")}</span><small>{job.status}</small></button>)}
          {!controller.snapshot?.jobs.length && <p>还没有批量生成记录。</p>}
        </section>
      )}

      {mode === "draw" ? (
        <div className="batch-draw"><Suspense fallback={<div className="aw-feature-loading">正在加载抽卡...</div>}><CardDrawFeaturePage controller={controller} /></Suspense></div>
      ) : (
      <div className="batch-layout" style={{ flex: 1, minHeight: 0 }}>
        {/* 左栏：生成计划步骤 */}
        <main className="batch-setup" style={{ overflowY: "auto", flex: 1 }}>
          <section className="batch-section">
            <div className="section-title">
              <h3>1. 选择章节</h3>
              <span style={{ fontSize: "12px", color: "var(--accent)" }}>已选 {chaptersCount} 章</span>
            </div>

            <div className="chapter-plan-table" style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "10px" }}>
              <div className="table-head" style={{ display: "grid", gridTemplateColumns: "30px 1fr 120px 100px 40px", padding: "6px 8px", background: "var(--stone)", borderRadius: "4px", fontSize: "12px", fontWeight: "bold" }}>
                <span />
                <span>章节</span>
                <span>章纲状态</span>
                <span>预计字数</span>
                <span />
              </div>

              {chapterRows.map((r) => (
                <article
                  key={r.ch}
                  className="selected"
                  style={{ display: "grid", gridTemplateColumns: "30px 1fr 120px 100px 40px", padding: "8px", alignItems: "center", borderBottom: "1px solid var(--line)", fontSize: "12px" }}
                >
                  <input type="checkbox" checked={r.ch >= start && r.ch <= end} onChange={(event) => {
                    if (event.target.checked) { setStart(Math.min(start, r.ch)); setEnd(Math.max(end, r.ch)); }
                    else if (r.ch === start && start < end) setStart(start + 1);
                    else if (r.ch === end && end > start) setEnd(end - 1);
                  }} />
                  <span>
                    <strong>第 {r.ch} 章</strong> <small style={{ color: "var(--muted)" }}>{r.title}</small>
                  </span>
                  <span>
                    <i className="plan-status p1" style={{ fontStyle: "normal", color: r.status === "章纲可用" ? "var(--success)" : "var(--warning)" }}>
                      {r.status}
                    </i>
                  </span>
                  <span>{words.toLocaleString()}</span>
                  <button className="icon-button subtle" type="button" title={`只生成第 ${r.ch} 章`} onClick={() => { setStart(r.ch); setEnd(r.ch); }}>
                    <SquarePen size={14} />
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="batch-section" style={{ marginTop: "20px" }}>
            <div className="section-title">
              <h3>2. 生成配置</h3>
            </div>
            <div className="field-row" style={{ display: "flex", gap: "15px", marginTop: "10px" }}>
              <label style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <span style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>起始章节</span>
                <input type="number" min={1} value={start} onChange={(event) => setStart(Math.max(1, Math.min(Number(event.target.value) || 1, end)))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <span style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>结束章节</span>
                <input type="number" min={start} value={end} onChange={(event) => setEnd(Math.max(start, Number(event.target.value) || start))} />
              </label>
            </div>
            <div className="field-row" style={{ display: "flex", gap: "15px", marginTop: "10px" }}>
              <label style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <span style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>每章目标字数</span>
                <input
                  type="number"
                  value={words}
                  onChange={(e) => setWords(Number(e.target.value))}
                  style={{ padding: "6px", border: "1px solid var(--line)", borderRadius: "4px", fontSize: "12px" }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <span style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>最多尝试</span>
                <select value={attempts} onChange={(event) => setAttempts(Number(event.target.value))} style={{ padding: "6px", border: "1px solid var(--line)", borderRadius: "4px", fontSize: "12px" }}>
                  <option value={2}>2 次</option>
                  <option value={3}>3 次</option>
                </select>
              </label>
            </div>

            <div style={{ marginTop: "12px" }}>
              <span style={{ fontSize: "12px", color: "var(--muted)", display: "block", marginBottom: "4px" }}>生成要求</span>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                style={{ width: "100%", padding: "8px", border: "1px solid var(--line)", borderRadius: "4px", fontSize: "12px", resize: "none" }}
                rows={3}
              />
            </div>
          </section>

          <section className="batch-section compact" style={{ marginTop: "15px", display: "flex", flexDirection: "column", gap: "6px" }}>
            <label className="check-line" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
              <input type="checkbox" checked={checkConsistency} onChange={(e) => setCheckConsistency(e.target.checked)} />
              <span>生成前自动运行全书一致性检查</span>
            </label>
            <label className="check-line" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
              <input type="checkbox" checked={pauseEach} onChange={(e) => setPauseEach(e.target.checked)} />
              <span>每章生成完成后暂停，等待我单独确认</span>
            </label>
          </section>
        </main>

        {/* 右栏：生成预算与概览面板 */}
        <aside className="budget-panel" style={{ width: "250px", borderLeft: "1px solid var(--line)", paddingLeft: "15px" }}>
          <h3>生成概览</h3>
          <dl style={{ margin: "10px 0", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
              <dt style={{ color: "var(--muted)" }}>章节范围</dt>
              <dd>第 {start} - {end} 章 ({chaptersCount} 章)</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
              <dt style={{ color: "var(--muted)" }}>预计字数</dt>
              <dd>{totalWords.toLocaleString()} 字</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
              <dt style={{ color: "var(--muted)" }}>读取上下文</dt>
              <dd>大纲、设定与前文</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
              <dt style={{ color: "var(--muted)" }}>章纲检查</dt>
              <dd>{chapterRows.filter((row) => row.status === "章纲可用").length} / {chaptersCount} 章可用</dd>
            </div>
          </dl>

          <div className="budget-box" style={{ background: "var(--stone-deep)", padding: "12px", borderRadius: "6px", margin: "15px 0" }}>
            <label htmlFor="batch-budget" style={{ fontSize: "12px", color: "var(--muted)", display: "block" }}>预算上限（美元）</label>
            <input id="batch-budget" type="number" min={0} step={0.1} value={budgetLimit} onChange={(event) => setBudgetLimit(Math.max(0, Number(event.target.value) || 0))} style={{ width: "100%", margin: "6px 0" }} />
            <p style={{ fontSize: "12px", color: "var(--muted)", margin: 0 }}>
              实际消耗由后台任务按所选模型实时统计；达到上限后自动暂停。
            </p>
          </div>

          <div className="write-scope" style={{ display: "flex", alignItems: "start", gap: "6px", margin: "15px 0" }}>
            <ShieldCheck size={16} style={{ color: "var(--success)", marginTop: "2px" }} />
            <div style={{ fontSize: "12px" }}>
              <strong style={{ display: "block" }}>草稿安全保护</strong>
              <span style={{ color: "var(--muted)" }}>生成到临时草稿箱内，不会覆盖或损坏已有正文。</span>
            </div>
          </div>

          <button className="button primary" style={{ width: "100%", minHeight: "36px" }} type="button" onClick={startBatch} disabled={controller.operationsBusy || !controller.snapshot?.currentProject.path}>
            <Play size={14} /> 开始生成 {chaptersCount} 章
          </button>

          <p style={{ fontSize: "12px", color: "var(--muted)", textAlign: "center", marginTop: "8px" }}>
            开始后您随时可以到后台任务中暂停或取消。
          </p>
        </aside>
      </div>
      )}
    </div>
  );
}

type BatchChapterRow = {
  ch: number;
  title: string;
  status: "章纲可用" | "未找到章纲";
};

export function buildBatchChapterRows(nodes: TreeNode[], start: number, end: number): BatchChapterRow[] {
  const files = flattenFiles(nodes);
  const safeStart = Math.max(1, Math.floor(start));
  const safeEnd = Math.max(safeStart, Math.floor(end));
  return Array.from({ length: Math.min(300, safeEnd - safeStart + 1) }, (_, index) => {
    const ch = safeStart + index;
    const matching = files.filter((file) => chapterNumber(file.name) === ch);
    const body = matching.find((file) => /正文|章节/.test(file.path));
    const outline = matching.find((file) => /大纲|章纲|细纲/.test(file.path));
    const source = body || outline;
    return {
      ch,
      title: source
        ? source.name.replace(/\.(txt|md)$/i, "").replace(/^第?\s*\d+\s*[章节、._-]?\s*/u, "").trim() || "未命名章节"
        : "项目中尚无对应文档",
      status: outline ? "章纲可用" : "未找到章纲"
    };
  });
}

function flattenFiles(nodes: TreeNode[], result: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    if (node.kind === "file") result.push(node);
    if (node.children?.length) flattenFiles(node.children, result);
  }
  return result;
}

function chapterNumber(name: string): number | null {
  const match = /(?:第\s*)?(\d+)\s*章/u.exec(name);
  if (match) return Number(match[1]);
  const prefix = /^(\d+)[、._\s-]/u.exec(name);
  return prefix ? Number(prefix[1]) : null;
}
