import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectLibraryDomain, ProjectLibraryRecord } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";

type ProjectLibraryDraft = {
  draft_id: string;
  domain: ProjectLibraryDomain;
  records: ProjectLibraryRecord[];
  source: string;
  created_at: string;
};

type LibraryDraftReviewProps = {
  controller: WorkbenchController;
  domains: ProjectLibraryDomain[];
  onChanged?: () => void | Promise<void>;
  refreshKey?: string | number;
  compact?: boolean;
};

const domainLabels: Record<ProjectLibraryDomain, string> = {
  lore: "设定资料",
  style: "写作风格",
  genre: "题材规则"
};

function describeRecord(record: ProjectLibraryRecord): string {
  const candidate = record as ProjectLibraryRecord & {
    description?: string;
    instruction?: string;
    content?: string;
    notes?: string;
  };
  return record.summary || candidate.description || candidate.instruction || candidate.content || candidate.notes || "暂无补充说明";
}

async function draftRequest<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(new URL(pathname, controller.runtime.apiBase).toString(), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(String(payload.detail || response.statusText || "待确认草稿请求失败"));
  }
  return payload as T;
}

export function LibraryDraftReview({ controller, domains, onChanged, refreshKey = "", compact = false }: LibraryDraftReviewProps) {
  const [drafts, setDrafts] = useState<ProjectLibraryDraft[]>([]);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState("");
  const onChangedRef = useRef(onChanged);
  const projectPath = controller.snapshot?.currentProject.path || "";
  const domainKey = [...domains].sort().join(",");

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const load = useCallback(async () => {
    if (!projectPath) {
      setDrafts([]);
      setMessage("");
      setLoadError("");
      return;
    }
    try {
      const payload = await draftRequest<{ drafts: ProjectLibraryDraft[] }>(controller, "/api/project-library-drafts");
      const allowed = new Set(domainKey.split(",").filter(Boolean));
      setDrafts((payload.drafts || []).filter((draft) => allowed.has(draft.domain)));
      setLoadError("");
    } catch (error) {
      setDrafts([]);
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [controller.runtime.apiBase, controller.runtime.fetchFn, domainKey, projectPath]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function commit(draft: ProjectLibraryDraft) {
    setBusyId(draft.draft_id);
    setMessage("");
    setLoadError("");
    try {
      await draftRequest(controller, `/api/project-library-drafts/${encodeURIComponent(draft.draft_id)}/commit`, { method: "POST" });
      await load();
      await controller.refreshProjectWorkspace();
      await onChangedRef.current?.();
      setMessage(`${domainLabels[draft.domain]}已确认写入，项目上下文已刷新。`);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId("");
    }
  }

  async function discard(draft: ProjectLibraryDraft) {
    setBusyId(draft.draft_id);
    setMessage("");
    setLoadError("");
    try {
      await draftRequest(controller, `/api/project-library-drafts/${encodeURIComponent(draft.draft_id)}`, { method: "DELETE" });
      await load();
      setMessage("待确认草稿已丢弃，项目文件未发生变化。");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId("");
    }
  }

  if (!drafts.length && !message && !loadError) return null;

  if (loadError && !drafts.length) {
    return (
      <section className={`library-draft-review error${compact ? " compact" : ""}`} aria-label="待确认写入不可用">
        <header className="library-draft-header">
          <span><AlertTriangle size={15} /><strong>待确认写入不可用</strong></span>
          <small>本次未修改项目资料</small>
        </header>
        <p className="library-draft-message error" role="alert">{loadError}</p>
        <div className="library-draft-actions">
          <button className="button secondary compact" type="button" onClick={() => void load()}>
            <RefreshCw size={14} />重新检查
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`library-draft-review${compact ? " compact" : ""}`} aria-label="待确认 AI 草稿">
      <header className="library-draft-header">
        <span><Clock3 size={15} /><strong>待确认写入</strong></span>
        <small>确认前不会修改项目资料</small>
      </header>
      {drafts.map((draft) => (
        <article className="library-draft-card" key={draft.draft_id}>
          <div className="library-draft-summary">
            <div>
              <strong>{domainLabels[draft.domain]}</strong>
              <span>{draft.records.length} 条内容 · 来源：{draft.source || "AI 助手"}</span>
            </div>
            <span className="library-draft-state">尚未写入项目</span>
          </div>
          <div className="library-draft-records">
            {draft.records.map((record) => (
              <div className="library-draft-record" key={record.id}>
                <strong>{record.name || "未命名内容"}</strong>
                <p>{describeRecord(record)}</p>
              </div>
            ))}
          </div>
          <div className="library-draft-actions">
            <button className="button secondary compact danger" type="button" disabled={Boolean(busyId)} onClick={() => void discard(draft)}>
              <Trash2 size={14} />丢弃
            </button>
            <button className="button primary compact" type="button" disabled={Boolean(busyId)} onClick={() => void commit(draft)}>
              <CheckCircle2 size={14} />{busyId === draft.draft_id ? "正在写入..." : "确认写入"}
            </button>
          </div>
        </article>
      ))}
      {message && <p className="library-draft-message" role="status">{message}</p>}
    </section>
  );
}
