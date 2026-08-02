import {
  Archive,
  ChevronRight,
  Filter,
  History,
  Library,
  MapPin,
  Network,
  Package,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SquarePen,
  Users
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectLibraryBundle, ProjectLibraryRecord } from "@xiaoshuo/shared";
import { projectLibraryBundleSchema } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { LibraryDraftReview } from "../shared/LibraryDraftReview.js";
import { EmptyState } from "../shared/SharedStates.js";

type LoadState = "loading" | "ready" | "error";
type LoreEntityRecord = Extract<ProjectLibraryRecord, { kind: "character" | "location" | "faction" | "item" | "world_rule" }>;
type CharacterRecord = LoreEntityRecord & { kind: "character" };

const entityTabs = [
  ["character", "人物", Users],
  ["location", "地点", MapPin],
  ["faction", "势力", Network],
  ["item", "物品", Package],
  ["world_rule", "规则", ShieldCheck]
] as const;

const arcPhases = [
  ["start", "起点"],
  ["current", "当前"],
  ["turn", "转折"],
  ["end", "终点"]
] as const;

async function libraryRequest<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(new URL(pathname, controller.runtime.apiBase).toString(), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(String(payload.detail || response.statusText || "资料库请求失败"));
  }
  return payload as T;
}

function recordId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function stamp(): string {
  return new Date().toISOString();
}

function manualBase(name: string, order: number) {
  const now = stamp();
  return {
    id: recordId(),
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

export function SourcesProductPage({ controller }: { controller: WorkbenchController }) {
  const [bundle, setBundle] = useState<ProjectLibraryBundle | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<(typeof entityTabs)[number][0]>("character");
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!controller.snapshot?.currentProject.path) {
      setBundle(null);
      setLoadState("ready");
      return;
    }
    setLoadState("loading");
    try {
      const next = projectLibraryBundleSchema.parse(await libraryRequest(controller, "/api/project-libraries/lore"));
      setBundle(next);
      setSelectedId((current) => current || (next.records.filter((r) => r.status === "active" && r.kind === tab)[0]?.id || ""));
      setLoadState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setLoadState("error");
    }
  }, [controller, controller.snapshot?.currentProject.path, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const records = useMemo(() => (bundle?.records || []).filter((r) => r.status === "active"), [bundle]);
  const tabRecords = useMemo(() => {
    return records.filter((r) => r.kind === tab && r.name.toLowerCase().includes(query.toLowerCase()));
  }, [records, tab, query]);

  const selected = records.find((record): record is LoreEntityRecord => record.id === selectedId && (record.kind === "character" || record.kind === "location" || record.kind === "faction" || record.kind === "item" || record.kind === "world_rule")) || null;
  const characters = records.filter((record): record is CharacterRecord => record.kind === "character");
  const relations = records.filter((record) => record.kind === "relation");
  const selectedRelations = selected?.kind === "character" ? relations.filter((record) => record.kind === "relation" && (record.from_id === selected.id || record.to_id === selected.id)) : [];
  const selectedArc = selected?.kind === "character" ? records.find((record) => record.kind === "character_arc" && record.character_id === selected.id) : null;

  function replaceRecord(record: ProjectLibraryRecord) {
    setBundle((current) => current ? { ...current, records: current.records.map((item) => item.id === record.id ? record : item) } : current);
  }

  function updateSelected(values: Record<string, unknown>) {
    if (!selected) return;
    replaceRecord({ ...selected, ...values } as ProjectLibraryRecord);
  }

  async function save() {
    if (!bundle || bundle.status !== "ready") return;
    try {
      const next = projectLibraryBundleSchema.parse(await libraryRequest(controller, "/api/project-libraries/lore", {
        method: "PUT",
        body: JSON.stringify({ base_revision: bundle.revision, records: bundle.records })
      }));
      setBundle(next);
      setEditing(false);
      setMessage("设定资料已保存。");
      void controller.refreshProjectWorkspace();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function createEntity() {
    if (!bundle) return;
    const entity = {
      ...manualBase("未命名设定", bundle.records.length),
      kind: tab,
      role: "",
      aliases: [],
      age: "",
      identity: "",
      goal: "",
      fear: "",
      traits: [],
      appearance: "",
      speech_style: "",
      constraints: []
    } as ProjectLibraryRecord;
    setBundle({ ...bundle, records: [...bundle.records, entity] });
    setSelectedId(entity.id);
    setEditing(true);
  }

  function addRelation() {
    if (!bundle || selected?.kind !== "character") return;
    const target = characters.find((record) => record.id !== selected.id);
    if (!target) {
      setMessage("请先创建另一位人物，再建立关系。");
      return;
    }
    const relation = {
      ...manualBase(`${selected.name} 与 ${target.name}`, bundle.records.length),
      kind: "relation" as const,
      from_id: selected.id,
      to_id: target.id,
      relation_type: "关联",
      direction: "undirected" as const
    } as ProjectLibraryRecord;
    setBundle({ ...bundle, records: [...bundle.records, relation] });
    setEditing(true);
  }

  function updateArc(phase: "start" | "current" | "turn" | "end", text: string) {
    if (!bundle || selected?.kind !== "character") return;
    const arc = selectedArc?.kind === "character_arc" ? selectedArc : {
      ...manualBase(`${selected.name}的人物弧光`, bundle.records.length),
      kind: "character_arc" as const,
      character_id: selected.id,
      points: []
    };
    const next = { ...arc, points: [...arc.points.filter((point) => point.phase !== phase), { phase, text }] } as ProjectLibraryRecord;
    if (selectedArc) replaceRecord(next);
    else setBundle({ ...bundle, records: [...bundle.records, next] });
    setEditing(true);
  }

  if (loadState === "loading") {
    return <div style={{ padding: "20px", fontSize: "12px", color: "var(--muted)" }}>正在载入设定资料...</div>;
  }

  if (!controller.snapshot?.currentProject.path) {
    return (
      <div style={{ padding: "20px", display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
        <EmptyState title="设定资料库不可用" description="请先打开或创建小說项目，再管理人物与世界规则。" />
      </div>
    );
  }

  return (
    <div className="page-scroll" style={{ display: "flex", flexDirection: "column", height: "100%", padding: "20px" }}>
      <div className="content-head">
        <div>
          <h1>设定资料</h1>
          <p>人物、地点、势力、物品和世界规则统一存放，写作与 AI 都从这里取用。</p>
        </div>
        <div className="content-actions">
          <button className="button secondary" type="button" onClick={() => setEditing(!editing)}>
            <SquarePen size={15} />{editing ? "查看" : "编辑"}
          </button>
          <button className="button primary" type="button" onClick={createEntity}>
            <Plus size={15} />新建设定
          </button>
        </div>
      </div>

      <LibraryDraftReview controller={controller} domains={["lore"]} onChanged={load} />

      <div className="source-tabs" style={{ display: "flex", gap: "10px", marginBottom: "15px", borderBottom: "1px solid var(--line)", paddingBottom: "6px" }}>
        {entityTabs.map(([kind, label, Icon]) => (
          <button
            key={kind}
            type="button"
            className={tab === kind ? "active" : ""}
            onClick={() => {
              setTab(kind);
              const target = records.find((r) => r.kind === kind);
              setSelectedId(target?.id || "");
            }}
            style={{ display: "flex", alignItems: "center", gap: "6px", border: 0, background: "transparent", padding: "6px 12px", fontSize: "12px", cursor: "pointer" }}
          >
            <Icon size={15} />
            <span>{label}</span>
            <em style={{ fontStyle: "normal", color: "var(--muted)", marginLeft: "4px" }}>
              {records.filter((r) => r.kind === kind).length}
            </em>
          </button>
        ))}
      </div>

      <div className="sources-layout" style={{ flex: 1, minHeight: 0 }}>
        {/* 左栏：实体列表 */}
        <section className="entity-list" style={{ overflowY: "auto" }}>
          <div className="list-toolbar" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px" }}>
            <div className="search-box" style={{ display: "flex", alignItems: "center", gap: "6px", border: "1px solid var(--line)", padding: "4px 8px", borderRadius: "4px", flex: 1 }}>
              <Search size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称..."
                style={{ border: 0, outline: 0, background: "transparent", fontSize: "12px", width: "100%" }}
              />
            </div>
          </div>
          {tabRecords.map((record) => {
            const rec = record as any;
            return (
              <button
                key={record.id}
                type="button"
                className={`entity-row ${record.id === selectedId ? "selected" : ""}`}
                onClick={() => {
                  setSelectedId(record.id);
                  setEditing(false);
                }}
              >
                <span className="portrait">{record.name.slice(0, 1)}</span>
                <span>
                  <strong>{record.name}</strong>
                  <small>{rec.role || rec.identity || "未填写类别"}</small>
                  <p>{rec.summary || "尚未填写资料摘要"}</p>
                </span>
                <ChevronRight size={15} />
              </button>
            );
          })}
          {tabRecords.length === 0 && (
            <p style={{ padding: "20px", textAlign: "center", fontSize: "12px", color: "var(--muted)" }}>此分类暂无设定</p>
          )}
        </section>

        {/* 右栏：实体详情 */}
        <section className="entity-detail" style={{ overflowY: "auto" }}>
          {selected ? (
            <>
              <div className="entity-title" style={{ display: "flex", alignItems: "center", gap: "15px", paddingBottom: "15px", borderBottom: "1px solid var(--line)", marginBottom: "15px" }}>
                <span className="portrait large">{selected.name.slice(0, 1)}</span>
                <div style={{ flex: 1 }}>
                  <span className="eyebrow">{entityTabs.find(([k]) => k === selected.kind)?.[1] || "设定"}</span>
                  {editing ? (
                    <input
                      value={selected.name}
                      onChange={(e) => updateSelected({ name: e.target.value })}
                      style={{ fontSize: "16px", fontWeight: "bold", padding: "4px", border: "1px solid var(--line)", borderRadius: "4px", width: "80%" }}
                    />
                  ) : (
                    <h2>{selected.name}</h2>
                  )}
                  <p style={{ fontSize: "12px", color: "var(--muted)" }}>{selected.identity || selected.role || "尚未填写角色身份"}</p>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {editing && (
                    <button className="button primary" type="button" onClick={save}>
                      <Save size={14} />保存
                    </button>
                  )}
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => {
                      updateSelected({ status: "archived" });
                      setSelectedId("");
                    }}
                  >
                    <Archive size={14} />归档
                  </button>
                </div>
              </div>

              <div className="detail-grid">
                <section>
                  <h3>{selected.kind === "character" ? "人物核心" : "设定内容"}</h3>
                  {editing ? (
                    <div className="xw-library-form" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <label style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontSize: "12px", color: "var(--muted)" }}>类别说明</span>
                        <input value={selected.role || ""} onChange={(e) => updateSelected({ role: e.target.value })} style={{ padding: "4px", border: "1px solid var(--line)", borderRadius: "4px" }} />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontSize: "12px", color: "var(--muted)" }}>简介</span>
                        <textarea value={selected.summary || ""} onChange={(e) => updateSelected({ summary: e.target.value })} style={{ padding: "4px", border: "1px solid var(--line)", borderRadius: "4px", resize: "none" }} rows={3} />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontSize: "12px", color: "var(--muted)" }}>身份</span>
                        <input value={selected.identity || ""} onChange={(e) => updateSelected({ identity: e.target.value })} style={{ padding: "4px", border: "1px solid var(--line)", borderRadius: "4px" }} />
                      </label>
                      {selected.kind === "character" && (
                        <>
                          <label style={{ display: "flex", flexDirection: "column" }}>
                            <span style={{ fontSize: "12px", color: "var(--muted)" }}>行动目标</span>
                            <textarea value={(selected as any).goal || ""} onChange={(e) => updateSelected({ goal: e.target.value })} style={{ padding: "4px", border: "1px solid var(--line)", borderRadius: "4px", resize: "none" }} />
                          </label>
                          <label style={{ display: "flex", flexDirection: "column" }}>
                            <span style={{ fontSize: "12px", color: "var(--muted)" }}>内心恐惧</span>
                            <textarea value={(selected as any).fear || ""} onChange={(e) => updateSelected({ fear: e.target.value })} style={{ padding: "4px", border: "1px solid var(--line)", borderRadius: "4px", resize: "none" }} />
                          </label>
                          <label style={{ display: "flex", flexDirection: "column" }}>
                            <span style={{ fontSize: "12px", color: "var(--muted)" }}>外在特征</span>
                            <textarea value={(selected as any).appearance || ""} onChange={(e) => updateSelected({ appearance: e.target.value })} style={{ padding: "4px", border: "1px solid var(--line)", borderRadius: "4px", resize: "none" }} />
                          </label>
                        </>
                      )}
                    </div>
                  ) : (
                    <dl className="project-facts" style={{ gridTemplateColumns: "1fr", borderLeft: 0 }}>
                      <div style={{ minHeight: "auto", borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
                        <dt style={{ fontSize: "12px", color: "var(--muted)" }}>简介</dt>
                        <dd style={{ fontSize: "12px", fontWeight: "normal", margin: "4px 0" }}>{selected.summary || "未填写"}</dd>
                      </div>
                      <div style={{ minHeight: "auto", borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
                        <dt style={{ fontSize: "12px", color: "var(--muted)" }}>身份</dt>
                        <dd style={{ fontSize: "12px", fontWeight: "normal", margin: "4px 0" }}>{selected.identity || "未填写"}</dd>
                      </div>
                      {selected.kind === "character" && (
                        <>
                          <div style={{ minHeight: "auto", borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
                            <dt style={{ fontSize: "12px", color: "var(--muted)" }}>行动目标</dt>
                            <dd style={{ fontSize: "12px", fontWeight: "normal", margin: "4px 0" }}>{(selected as any).goal || "未填写"}</dd>
                          </div>
                          <div style={{ minHeight: "auto", borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
                            <dt style={{ fontSize: "12px", color: "var(--muted)" }}>恐惧</dt>
                            <dd style={{ fontSize: "12px", fontWeight: "normal", margin: "4px 0" }}>{(selected as any).fear || "未填写"}</dd>
                          </div>
                        </>
                      )}
                    </dl>
                  )}
                </section>

                {selected.kind === "character" && (
                  <section>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <h3>社会关系</h3>
                      {editing && (
                        <button className="button secondary" type="button" onClick={addRelation} style={{ minHeight: "22px", height: "22px", padding: "0 6px" }}>
                          <Plus size={12} />添加
                        </button>
                      )}
                    </div>
                    <div className="relation-map" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {selectedRelations.map((relation: any) => {
                        const targetName = characters.find(c => c.id === (relation.from_id === selected.id ? relation.to_id : relation.from_id))?.name || "未知人物";
                        return (
                          <div key={relation.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px", background: "var(--stone)", borderRadius: "4px", fontSize: "12px" }}>
                            <strong>与 {targetName} 关联</strong>
                            <span>{relation.relation_type}</span>
                          </div>
                        );
                      })}
                      {selectedRelations.length === 0 && <p style={{ fontSize: "12px", color: "var(--muted)" }}>尚未添加社会关系</p>}
                    </div>
                  </section>
                )}

                {selected.kind === "character" && (
                  <section className="wide" style={{ marginTop: "15px" }}>
                    <h3>人物弧光</h3>
                    <div className="arc-track" style={{ display: "flex", gap: "10px" }}>
                      {arcPhases.map(([phase, label]) => {
                        const pointText = selectedArc?.kind === "character_arc" ? selectedArc.points.find((p) => p.phase === phase)?.text || "" : "";
                        return (
                          <div key={phase} className={phase === "current" ? "current" : ""} style={{ flex: 1, padding: "8px", background: "var(--stone)", borderRadius: "4px" }}>
                            <span style={{ fontSize: "12px", color: "var(--accent)", fontWeight: "bold" }}>{label}</span>
                            {editing ? (
                              <input
                                value={pointText}
                                onChange={(e) => updateArc(phase, e.target.value)}
                                placeholder="阶段变化描述"
                                style={{ width: "100%", fontSize: "12px", marginTop: "4px", padding: "4px", border: "1px solid var(--line)", borderRadius: "4px" }}
                              />
                            ) : (
                              <strong style={{ display: "block", fontSize: "12px", fontWeight: "normal", marginTop: "4px" }}>{pointText || "未填写"}</strong>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            </>
          ) : (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
              <Library size={24} style={{ display: "block", margin: "0 auto 10px" }} />
              请选择左侧列表中的实体项查看详情。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
