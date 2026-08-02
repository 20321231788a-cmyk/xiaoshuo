import {
  Archive,
  CheckCircle2,
  FileText,
  Filter,
  History,
  Import,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Tags,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectLibraryBundle, ProjectLibraryDomain, ProjectLibraryRecord } from "@xiaoshuo/shared";
import { projectLibraryBundleSchema } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { LibraryDraftReview } from "../shared/LibraryDraftReview.js";
import { EmptyState } from "../shared/SharedStates.js";

type LoadState = "loading" | "ready" | "error";

async function libraryRequest<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(new URL(pathname, controller.runtime.apiBase).toString(), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(String(payload.detail || response.statusText || "风格题材请求失败"));
  }
  return payload as T;
}

function manualBase(name: string, order: number) {
  const now = new Date().toISOString();
  return {
    id: globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now()}`,
    name,
    summary: "",
    tags: [],
    order,
    status: "active" as const,
    origin: "manual" as const,
    created_at: now,
    updated_at: now,
    needs_review: false,
    notes: ""
  };
}

export function StyleProductPage({ controller }: { controller: WorkbenchController }) {
  const [style, setStyle] = useState<ProjectLibraryBundle | null>(null);
  const [genre, setGenre] = useState<ProjectLibraryBundle | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"style" | "genre" | "examples" | "banned">("style");

  const [selectedExampleId, setSelectedExampleId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!controller.snapshot?.currentProject.path) {
      setLoadState("ready");
      return;
    }
    setLoadState("loading");
    try {
      const [nextStyle, nextGenre] = await Promise.all([
        libraryRequest(controller, "/api/project-libraries/style").then((payload) => projectLibraryBundleSchema.parse(payload)),
        libraryRequest(controller, "/api/project-libraries/genre").then((payload) => projectLibraryBundleSchema.parse(payload))
      ]);
      setStyle(nextStyle);
      setGenre(nextGenre);
      setSelectedExampleId(nextStyle.records.find((r) => r.status === "active" && r.kind === "style_example")?.id || "");
      setLoadState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setLoadState("error");
    }
  }, [controller, controller.snapshot?.currentProject.path]);

  useEffect(() => {
    void load();
  }, [load]);

  const styleRecords = (style?.records || []).filter((r) => r.status === "active");
  const genreRecords = (genre?.records || []).filter((r) => r.status === "active");

  const examples = styleRecords.filter((record) => record.kind === "style_example");
  const selectedExample = examples.find((record) => record.id === selectedExampleId) || examples[0] || null;

  const rules = view === "genre"
    ? genreRecords.filter((record) => record.kind === "genre_rule")
    : styleRecords.filter((record) => record.kind === "style_rule");

  const profile = view === "genre"
    ? genreRecords.find((record) => record.kind === "genre_profile") || null
    : styleRecords.find((record) => record.kind === "style_profile") || null;

  const preferences = styleRecords.filter((record) => record.kind === "language_preference");
  const banned = genreRecords.filter((record) => record.kind === "banned_expression");

  async function saveDomain(domain: ProjectLibraryDomain, source: ProjectLibraryBundle | null) {
    if (!source) return;
    try {
      const next = projectLibraryBundleSchema.parse(
        await libraryRequest(controller, `/api/project-libraries/${domain}`, {
          method: "PUT",
          body: JSON.stringify({ base_revision: source.revision, records: source.records })
        })
      );
      if (domain === "style") setStyle(next);
      else setGenre(next);
      setMessage("规则已保存，并已更新写作上下文。");
      void controller.refreshProjectWorkspace();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function addItem() {
    const domain = view === "genre" || view === "banned" ? "genre" : "style";
    const source = domain === "style" ? style : genre;
    if (!source) return;

    let record: any;
    if (view === "examples") {
      record = { ...manualBase("新范文片段", source.records.length), kind: "style_example" as const, before: "", after: "", explanation: "", source_ref: "" };
    } else if (domain === "style") {
      record = { ...manualBase("新叙事规则", source.records.length), kind: "style_rule" as const, category: "custom" as const, instruction: "", severity: "preference" as const, enabled: true };
    } else {
      record = {
        ...manualBase(view === "banned" ? "禁用表达" : "新题材规则", source.records.length),
        kind: view === "banned" ? ("banned_expression" as const) : ("genre_rule" as const),
        ...(view === "banned" ? { replacement: "", reason: "" } : { category: "custom" as const, instruction: "", severity: "hard" as const, enabled: true })
      };
    }

    const next = { ...source, records: [...source.records, record] };
    if (domain === "style") {
      setStyle(next);
      if (record.kind === "style_example") setSelectedExampleId(record.id);
    } else {
      setGenre(next);
    }
  }

  function updateDomainRecord(domain: ProjectLibraryDomain, id: string, values: Record<string, unknown>) {
    const setter = domain === "style" ? setStyle : setGenre;
    setter((current) =>
      current
        ? {
            ...current,
            records: current.records.map((record) =>
              record.id === id ? ({ ...record, ...values } as ProjectLibraryRecord) : record
            )
          }
        : current
    );
  }

  function updateProfile(domain: "style" | "genre", values: Record<string, unknown>) {
    const source = domain === "style" ? style : genre;
    const setter = domain === "style" ? setStyle : setGenre;
    if (!source) return;
    const kind = domain === "style" ? "style_profile" : "genre_profile";
    const existing = source.records.find((record) => record.kind === kind);
    if (existing) {
      setter({
        ...source,
        records: source.records.map((record) =>
          record.id === existing.id ? ({ ...record, ...values } as ProjectLibraryRecord) : record
        )
      });
      return;
    }
    const profileRecord =
      domain === "style"
        ? ({
            ...manualBase("未命名写作风格", source.records.length),
            kind: "style_profile" as const,
            narrative_pov: "",
            description: "",
            active: true,
            ...values
          } as ProjectLibraryRecord)
        : ({
            ...manualBase("未命名题材", source.records.length),
            kind: "genre_profile" as const,
            description: "",
            active: true,
            ...values
          } as ProjectLibraryRecord);
    setter({ ...source, records: [...source.records, profileRecord] });
  }

  async function importRules(file: File | undefined) {
    if (!file) return;
    try {
      const imported = projectLibraryBundleSchema.parse(JSON.parse(await file.text()));
      const targetDomain = view === "genre" || view === "banned" ? "genre" : "style";
      const source = targetDomain === "style" ? style : genre;
      if (!source) return;
      const existingIds = new Set(source.records.map((record) => record.id));
      const records = imported.records.map((record, index) => existingIds.has(record.id) ? { ...record, id: `${record.id}_${Date.now()}_${index}` } : record);
      const next = { ...source, records: [...source.records, ...records] };
      if (targetDomain === "style") setStyle(next); else setGenre(next);
      setMessage(`已导入 ${records.length} 条规则，请检查后保存。`);
    } catch (error) {
      setMessage(error instanceof Error ? `导入失败：${error.message}` : "导入失败：文件格式不正确。");
    }
  }

  if (loadState === "loading") {
    return <div style={{ padding: "20px", fontSize: "12px", color: "var(--muted)" }}>正在加载规则库...</div>;
  }

  if (!controller.snapshot?.currentProject.path) {
    return (
      <div style={{ padding: "20px", display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
        <EmptyState title="写作规则不可用" description="请打开小说项目，然后再管理写作题材边界与叙事风格规则。" />
      </div>
    );
  }

  return (
    <div className="page-scroll" style={{ display: "flex", flexDirection: "column", height: "100%", padding: "20px" }}>
      <div className="content-head">
        <div>
          <h1>风格与题材</h1>
          <p>项目级写作规则与参考素材会在生成和审阅时自动生效。</p>
        </div>
        <div className="content-actions">
          <button className="button secondary" type="button" onClick={() => importInputRef.current?.click()}>
            <Import size={15} />导入规则
          </button>
          <input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importRules(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          <button className="button primary" type="button" onClick={addItem}>
            <Plus size={15} />添加规则
          </button>
        </div>
      </div>

      <LibraryDraftReview controller={controller} domains={["style", "genre"]} onChanged={load} />

      <div className="style-layout" style={{ flex: 1, minHeight: 0 }}>
        {/* 左栏：分类导航 */}
        <aside className="style-nav" style={{ width: "190px" }}>
          <button className={view === "style" ? "active" : ""} type="button" onClick={() => setView("style")}>
            <Pencil size={15} />写作风格
          </button>
          <button className={view === "genre" ? "active" : ""} type="button" onClick={() => setView("genre")}>
            <Tags size={15} />题材规则
          </button>
          <button className={view === "examples" ? "active" : ""} type="button" onClick={() => setView("examples")}>
            <FileText size={15} />范文片段
          </button>
          <button className={view === "banned" ? "active" : ""} type="button" onClick={() => setView("banned")}>
            <ShieldCheck size={15} />禁用表达
          </button>
        </aside>

        {/* 中栏：风格概要与规则列表 */}
        <main className="style-main" style={{ flex: 1, overflowY: "auto" }}>
          <section className="style-profile" style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "15px" }}>
            <div>
              <span className="eyebrow">当前风格</span>
              {profile ? (
                <>
                  <h2>{profile.name}</h2>
                  <p>{profile.summary || (profile as any).description || "尚未填写风格说明"}</p>
                </>
              ) : (
                <h2>尚未配置当前项目风格档案</h2>
              )}
            </div>
            <button className="icon-button" type="button" onClick={() => updateProfile(view === "style" ? "style" : "genre", { name: "冷峻克制的悬疑风格", description: "近距离第三人称限知，动作承载情绪。" })}>
              <Pencil size={15} />
            </button>
          </section>

          {/* 规则和偏好列表 */}
          <div className="rule-section">
            <div className="section-title">
              <h3>大纲叙事规则</h3>
              {message && <small style={{ color: "var(--success)" }}>{message}</small>}
            </div>
            {rules.map((rule) => (
              <article className="rule-row" key={rule.id} style={{ display: "flex", gap: "10px", alignItems: "center", padding: "10px", borderBottom: "1px solid var(--line)" }}>
                <input
                  value={rule.name}
                  onChange={(e) => updateDomainRecord(view === "style" ? "style" : "genre", rule.id, { name: e.target.value })}
                  style={{ width: "120px", padding: "4px", fontSize: "12px", border: "1px solid var(--line)", borderRadius: "4px" }}
                />
                <textarea
                  value={rule.summary || (rule as any).instruction || ""}
                  onChange={(e) => updateDomainRecord(view === "style" ? "style" : "genre", rule.id, { instruction: e.target.value, summary: e.target.value })}
                  placeholder="可执行的叙事指南..."
                  style={{ flex: 1, padding: "4px", fontSize: "12px", border: "1px solid var(--line)", borderRadius: "4px", resize: "none" }}
                  rows={2}
                />
                <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
                  <input
                    type="checkbox"
                    checked={(rule as any).enabled !== false}
                    onChange={(e) => updateDomainRecord(view === "style" ? "style" : "genre", rule.id, { enabled: e.target.checked })}
                  />
                  <span>启</span>
                </label>
              </article>
            ))}

            <div style={{ marginTop: "15px" }}>
              <button className="button primary compact" type="button" onClick={() => void saveDomain(view === "style" ? "style" : "genre", view === "style" ? style : genre)}>
                保存大纲规则
              </button>
            </div>
          </div>

          {/* 语言偏好 chips */}
          {view === "style" && (
            <div className="rule-section" style={{ marginTop: "20px" }}>
              <div className="section-title">
                <h3>写作语言偏好</h3>
              </div>
              <div className="preference-row" style={{ display: "flex", gap: "8px", flexWrap: "wrap", padding: "8px 0" }}>
                <span style={{ fontSize: "12px", color: "var(--success)" }}>推荐词</span>
                {preferences.filter((p: any) => p.preference === "prefer").map((p) => (
                  <button key={p.id} type="button" onClick={() => updateDomainRecord("style", p.id, { status: "archived" })} style={{ padding: "2px 6px", fontSize: "12px", borderRadius: "4px", background: "var(--success-soft)", color: "var(--success)", border: 0 }}>
                    {p.name} <X size={10} style={{ marginLeft: "2px" }} />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    if (!style) return;
                    setStyle({
                      ...style,
                      records: [...style.records, { ...manualBase("短段落", style.records.length), kind: "language_preference", preference: "prefer", status: "active" } as any]
                    });
                  }}
                  style={{ padding: "2px 6px", fontSize: "12px", borderRadius: "4px", background: "transparent", border: "1px dashed var(--line)", cursor: "pointer" }}
                >
                  + 偏好
                </button>
              </div>

              <div className="preference-row danger" style={{ display: "flex", gap: "8px", flexWrap: "wrap", padding: "8px 0" }}>
                <span style={{ fontSize: "12px", color: "var(--danger)" }}>避免词</span>
                {preferences.filter((p: any) => p.preference === "avoid").map((p) => (
                  <button key={p.id} type="button" onClick={() => updateDomainRecord("style", p.id, { status: "archived" })} style={{ padding: "2px 6px", fontSize: "12px", borderRadius: "4px", background: "var(--danger-soft)", color: "var(--danger)", border: 0 }}>
                    {p.name} <X size={10} style={{ marginLeft: "2px" }} />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    if (!style) return;
                    setStyle({
                      ...style,
                      records: [...style.records, { ...manualBase("内心深处", style.records.length), kind: "language_preference", preference: "avoid", status: "active" } as any]
                    });
                  }}
                  style={{ padding: "2px 6px", fontSize: "12px", borderRadius: "4px", background: "transparent", border: "1px dashed var(--line)", cursor: "pointer" }}
                >
                  + 避免
                </button>
              </div>
            </div>
          )}

          {view === "banned" && (
            <div className="rule-section" style={{ marginTop: "20px" }}>
              <div className="section-title">
                <h3>禁用表达列表</h3>
              </div>
              {banned.map((item) => (
                <div key={item.id} style={{ display: "flex", gap: "10px", padding: "6px 0" }}>
                  <input
                    value={item.name}
                    onChange={(e) => updateDomainRecord("genre", item.id, { name: e.target.value })}
                    style={{ flex: 1, padding: "4px", fontSize: "12px", border: "1px solid var(--line)", borderRadius: "4px" }}
                  />
                  <input
                    value={(item as any).replacement || ""}
                    onChange={(e) => updateDomainRecord("genre", item.id, { replacement: e.target.value })}
                    placeholder="替代建议"
                    style={{ flex: 1, padding: "4px", fontSize: "12px", border: "1px solid var(--line)", borderRadius: "4px" }}
                  />
                  <button type="button" onClick={() => updateDomainRecord("genre", item.id, { status: "archived" })} style={{ color: "var(--danger)", border: 0, background: "transparent" }}>
                    X
                  </button>
                </div>
              ))}
            </div>
          )}
        </main>

        {/* 右栏：效果对照预览 */}
        <aside className="style-preview" style={{ width: "260px", overflowY: "auto" }}>
          <div className="detail-head">
            <span>规则效果预览</span>
            <button className="icon-button subtle" type="button" title="查看当前版本" aria-pressed={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
              <History size={14} />
            </button>
          </div>
          {historyOpen && (
            <div className="library-version-summary">
              <strong>当前规则版本</strong>
              <span>写作风格修订 {style?.revision ?? 0}</span>
              <span>题材规则修订 {genre?.revision ?? 0}</span>
              <small>每次保存都会校验基础修订号，冲突时不会覆盖磁盘新版。</small>
            </div>
          )}
          {selectedExample ? (
            <div style={{ padding: "10px" }}>
              <p className="preview-label">应用前</p>
              <blockquote style={{ fontSize: "12px", color: "var(--muted)", margin: "4px 0", padding: "8px", background: "var(--stone-deep)", borderRadius: "4px" }}>
                {selectedExample.before || "顾淮感到一阵难以言喻的不安，握紧了手中的船票。"}
              </blockquote>
              <p className="preview-label accent" style={{ marginTop: "12px", color: "var(--accent)" }}>应用后</p>
              <blockquote style={{ fontSize: "12px", fontWeight: "bold", margin: "4px 0", padding: "8px", background: "var(--accent-soft)", color: "var(--accent)", borderRadius: "4px" }}>
                {selectedExample.after || "船票的齿边陷进掌心。顾淮没有松手。"}
              </blockquote>
              <div className="preview-result" style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "6px", color: "var(--success)" }}>
                <CheckCircle2 size={15} />
                <span style={{ fontSize: "12px" }}>
                  {selectedExample.explanation || "更符合项目风格，情绪由具体动作承载。"}
                </span>
              </div>
            </div>
          ) : (
            <div style={{ padding: "20px", color: "var(--muted)", textAlign: "center" }}>
              无范文对照数据。在左侧选择范文片段即可开启对比预览。
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
