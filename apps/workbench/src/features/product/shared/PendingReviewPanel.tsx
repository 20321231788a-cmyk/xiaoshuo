import { AlertTriangle, CheckCircle2, ChevronDown, Clipboard, Copy, Eye, FileOutput, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RichText } from "../../../components/RichText.js";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { PendingGeneratedSave, PendingLibraryDraftGroup, PendingReviewItem } from "../../../lib/workflow.js";

type GeneratedPreviewTarget = {
  target_path: string;
  mode: "replace" | "append";
  before_content: string;
  after_content: string;
  before_hash: string;
  before_chars: number;
  after_chars: number;
  change: "create" | "append" | "replace";
};

type GeneratedPreview = { cache_id: string; targets: GeneratedPreviewTarget[] };

type LibraryPreview = PendingLibraryDraftGroup & {
  preview: Array<{
    domain: "lore" | "style" | "genre";
    base_revision: number;
    current_revision: number;
    target_paths: string[];
    added: Array<{ id: string; name: string; summary?: string }>;
    changed: Array<{ id: string; name: string; summary?: string }>;
    removed: Array<{ id: string; name: string; summary?: string }>;
  }>;
};

type PendingReviewPanelProps = {
  review: PendingReviewItem;
  controller: WorkbenchController;
  compact?: boolean;
  onOpenTarget?: (path: string) => void;
  onOpenEditor?: () => void;
  onOpenLibrary?: (domain: "lore" | "style" | "genre") => void;
  onRequestRevision?: (review: PendingReviewItem) => void;
};

const domainLabel = { lore: "设定资料", style: "写作风格", genre: "题材规则" } as const;

export function PendingReviewPanel({ review, controller, compact = false, onOpenTarget, onOpenEditor, onOpenLibrary, onRequestRevision }: PendingReviewPanelProps) {
  return review.kind === "generated_file"
    ? <GeneratedFileReview pending={review.pending} controller={controller} compact={compact} onOpenTarget={onOpenTarget} onOpenEditor={onOpenEditor} />
    : <LibraryGroupReview pending={review.pending} controller={controller} compact={compact} onOpenLibrary={onOpenLibrary} onRequestRevision={() => onRequestRevision?.(review)} />;
}

function GeneratedFileReview({ pending, controller, compact, onOpenTarget, onOpenEditor }: {
  pending: PendingGeneratedSave;
  controller: WorkbenchController;
  compact: boolean;
  onOpenTarget?: (path: string) => void;
  onOpenEditor?: () => void;
}) {
  const [tab, setTab] = useState<"summary" | "content" | "targets">("summary");
  const [preview, setPreview] = useState<GeneratedPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [discardArmed, setDiscardArmed] = useState(false);
  const [mode, setMode] = useState<"replace" | "append">(pending.defaultMode);

  const loadPreview = async () => {
    if (!pending.cacheId) return;
    setLoading(true);
    setLoadError("");
    try {
      const result = await (controller.runtime.fetchFn || fetch)(new URL(`/api/agent/generated/cache/${encodeURIComponent(pending.cacheId)}/preview`, controller.runtime.apiBase).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, target_paths: pending.targetPaths, save_plan: pending.savePlan })
      });
      const raw = await result.text();
      const payload = raw ? JSON.parse(raw) : {};
      if (!result.ok) throw new Error(String(payload.detail || result.statusText || "无法读取生成预览"));
      setPreview(payload as GeneratedPreview);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadPreview(); }, [pending.cacheId, mode]);

  const hashes = useMemo(() => Object.fromEntries((preview?.targets || []).map((target) => [target.target_path, target.before_hash])), [preview]);
  const targets = preview?.targets || [];
  const primaryLabel = generatedCommitLabel(pending, mode, targets.length);

  return (
    <section className={`pending-review-panel${compact ? " compact" : ""}`} aria-label="生成结果待确认">
      <header className="pending-review-heading">
        <span><Eye size={15} /><strong>生成结果待确认</strong></span>
        <small>尚未写入项目</small>
      </header>
      <div className="pending-review-meta">
        <strong>{describeTarget(pending)}</strong>
        <span>{mode === "replace" ? "覆盖写入" : "追加写入"} · 已生成约 {pending.cacheChars || pending.content.length} 字</span>
      </div>
      {mode === "replace" && targets.some((target) => target.change === "replace") && <p className="pending-review-warning"><AlertTriangle size={14} />确认后会替换所列目标的原内容，请先核对差异。</p>}
      <div className="pending-review-tabs" role="tablist" aria-label="生成结果预览">
        <button type="button" role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")}>变更摘要</button>
        <button type="button" role="tab" aria-selected={tab === "content"} onClick={() => setTab("content")}>内容预览</button>
        <button type="button" role="tab" aria-selected={tab === "targets"} onClick={() => setTab("targets")}>目标文件</button>
      </div>
      {loading && <p className="pending-review-loading"><RefreshCw size={14} />正在核对目标文件…</p>}
      {loadError && <p className="pending-review-error" role="alert">{loadError}<button type="button" onClick={() => void loadPreview()}>重新检查</button></p>}
      {!loading && !loadError && tab === "summary" && <div className="pending-review-summary">
        {targets.map((target) => <div className="pending-target-summary" key={target.target_path}>
          <span className={`pending-change ${target.change}`}>{changeLabel(target.change)}</span>
          <strong>{target.target_path}</strong>
          <small>{target.before_chars} → {target.after_chars} 字</small>
        </div>)}
      </div>}
      {!loading && !loadError && tab === "content" && <div className="pending-review-content">
        {targets.map((target) => <details key={target.target_path} open={targets.length === 1}>
          <summary>{target.target_path}</summary>
          <TextDiff before={target.before_content} after={target.after_content} change={target.change} />
          <details className="pending-full-content"><summary>查看完整生成内容</summary><RichText text={target.after_content} /></details>
        </details>)}
      </div>}
      {!loading && !loadError && tab === "targets" && <div className="pending-review-targets">
        {targets.map((target) => <button type="button" key={target.target_path} onClick={() => onOpenTarget?.(target.target_path)}><FolderOpen size={14} />{target.target_path}</button>)}
      </div>}
      {pending.error && <p className="pending-review-error" role="alert">{pending.error}</p>}
      <div className="pending-review-actions">
        <button className="button secondary compact" type="button" onClick={() => { onOpenEditor?.(); void controller.savePendingGeneratedAsDraft(pending.cacheId); }}><FileOutput size={14} />另存草稿并编辑</button>
        <button className="button secondary compact" type="button" onClick={() => void controller.copyPendingGeneratedContent(pending.cacheId)}><Copy size={14} />复制</button>
        <button className="button secondary compact danger" type="button" onClick={() => discardArmed ? void controller.discardPendingGenerated(pending.cacheId) : setDiscardArmed(true)}><Trash2 size={14} />{discardArmed ? "再次点击确认丢弃" : "丢弃"}</button>
        <span className="pending-mode-menu"><button className="button primary compact" type="button" disabled={loading || Boolean(loadError) || controller.conversationBusy || controller.operationsBusy} onClick={() => void controller.savePendingGenerated(mode, pending.cacheId, hashes)}><CheckCircle2 size={14} />{primaryLabel}</button><button className="button primary compact mode-toggle" type="button" aria-label="切换写入方式" onClick={() => setMode((value) => value === "replace" ? "append" : "replace")}><ChevronDown size={14} /></button></span>
      </div>
    </section>
  );
}

function LibraryGroupReview({ pending, controller, compact, onOpenLibrary, onRequestRevision }: {
  pending: PendingLibraryDraftGroup;
  controller: WorkbenchController;
  compact: boolean;
  onOpenLibrary?: (domain: "lore" | "style" | "genre") => void;
  onRequestRevision: () => void;
}) {
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [discardArmed, setDiscardArmed] = useState(false);
  const load = async () => {
    setLoading(true); setError("");
    try {
      const result = await (controller.runtime.fetchFn || fetch)(new URL(`/api/project-library-draft-groups/${encodeURIComponent(pending.groupId)}/preview`, controller.runtime.apiBase).toString());
      const raw = await result.text(); const payload = raw ? JSON.parse(raw) : {};
      if (!result.ok) throw new Error(String(payload.detail || result.statusText || "无法读取资料草稿预览"));
      setPreview(payload as LibraryPreview);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [pending.groupId]);
  const plural = pending.domains.length > 1;
  return <section className={`pending-review-panel library${compact ? " compact" : ""}`} aria-label="资料库草稿待确认">
    <header className="pending-review-heading"><span><Clipboard size={15} /><strong>{plural ? "风格与题材待确认" : "资料草稿待确认"}</strong></span><small>尚未写入项目</small></header>
    <div className="pending-review-meta"><strong>{pending.mode === "replace" ? "整体替换资料库" : "合并到现有资料库"}</strong><span>{pending.domains.map((domain) => domainLabel[domain]).join("、")}</span></div>
    {pending.mode === "replace" && <p className="pending-review-warning"><AlertTriangle size={14} />确认后会整体替换这两套资料库中的旧条目。</p>}
    {loading && <p className="pending-review-loading"><RefreshCw size={14} />正在整理资料库差异…</p>}
    {error && <p className="pending-review-error" role="alert">{error}<button type="button" onClick={() => void load()}>重新检查</button></p>}
    {!loading && preview && <div className="pending-library-summary">{preview.preview.map((section) => <details key={section.domain} open>
      <summary>{domainLabel[section.domain]}，新增 {section.added.length}，修改 {section.changed.length}{pending.mode === "replace" ? `，移除 ${section.removed.length}` : ""}</summary>
      <div className="pending-library-records">{[...section.added.map((item) => ["新增", item] as const), ...section.changed.map((item) => ["修改", item] as const), ...section.removed.map((item) => ["移除", item] as const)].slice(0, 30).map(([kind, item]) => <p key={`${kind}:${item.id}`}><span>{kind}</span><strong>{item.name}</strong>{item.summary && <small>{item.summary}</small>}</p>)}</div>
      <button className="pending-open-library" type="button" onClick={() => onOpenLibrary?.(section.domain)}><FolderOpen size={14} />查看当前{domainLabel[section.domain]}</button>
    </details>)}</div>}
    {pending.error && <p className="pending-review-error" role="alert">{pending.error}</p>}
    <div className="pending-review-actions">
      <button className="button secondary compact" type="button" onClick={onRequestRevision}>返回对话要求修改</button>
      <button className="button secondary compact danger" type="button" onClick={() => discardArmed ? void controller.discardPendingLibraryDraftGroup(pending.groupId) : setDiscardArmed(true)}><Trash2 size={14} />{discardArmed ? "再次点击确认丢弃" : "整体丢弃"}</button>
      <button className="button primary compact" type="button" disabled={loading || Boolean(error) || controller.operationsBusy} onClick={() => void controller.commitPendingLibraryDraftGroup(pending.groupId)}><CheckCircle2 size={14} />确认{pending.mode === "replace" ? "替换" : "合并"}{plural ? "风格与题材库" : "资料库"}</button>
    </div>
  </section>;
}

function TextDiff({ before, after, change }: { before: string; after: string; change: GeneratedPreviewTarget["change"] }) {
  if (change === "create") return <pre className="pending-diff added">{shortText(after)}</pre>;
  if (change === "append") return <><pre className="pending-diff context">{shortText(before, 700)}</pre><pre className="pending-diff added">{shortText(after.slice(before.length), 1800)}</pre></>;
  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before.slice(prefix), after.slice(prefix));
  const removed = before.slice(prefix, Math.max(prefix, before.length - suffix));
  const added = after.slice(prefix, Math.max(prefix, after.length - suffix));
  return <div className="pending-diff"><pre className="context">{shortText(before.slice(0, prefix), 500)}</pre>{removed && <pre className="removed">{shortText(removed, 1800)}</pre>}{added && <pre className="added">{shortText(added, 1800)}</pre>}<pre className="context">{shortText(after.slice(after.length - suffix), 500)}</pre></div>;
}

function commonPrefix(left: string, right: string) { let index = 0; while (index < left.length && index < right.length && left[index] === right[index]) index += 1; return index; }
function commonSuffix(left: string, right: string) { let index = 0; while (index < left.length && index < right.length && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1; return index; }
function shortText(value: string, length = 2200) { return value.length > length ? `${value.slice(0, length)}\n…（预览已截断，可展开查看完整内容）` : value || "（空）"; }
function changeLabel(change: GeneratedPreviewTarget["change"]) { return change === "create" ? "新建" : change === "append" ? "追加" : "替换"; }
function describeTarget(pending: PendingGeneratedSave) { return pending.targetPaths.length > 1 ? `${pending.targetPaths[0]} 等 ${pending.targetPaths.length} 个文件` : pending.targetPath || "未指定目标文件"; }
function generatedCommitLabel(pending: PendingGeneratedSave, mode: "replace" | "append", count: number) { const target = pending.targetPath.includes("大纲") ? "主线大纲" : pending.chapter ? `第 ${pending.chapter} 章` : count > 1 ? `${count} 个文件` : "目标文件"; return mode === "append" ? `确认追加到${target}` : `确认覆盖${target}`; }
