import {
  Archive,
  ChevronRight,
  FileText,
  Filter,
  History,
  Library,
  MapPin,
  Network,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Tags,
  Users,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectLibraryBundle, ProjectLibraryDomain, ProjectLibraryRecord } from "@xiaoshuo/shared";
import { projectLibraryBundleSchema } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";

type LoadState = "loading" | "ready" | "error";
type LoreEntityRecord = Extract<ProjectLibraryRecord, { kind: "character" | "location" | "faction" | "item" | "world_rule" }>;
type CharacterRecord = LoreEntityRecord & { kind: "character" };
type ProjectLibraryDraft = {
  draft_id: string;
  domain: ProjectLibraryDomain;
  records: ProjectLibraryRecord[];
  source: string;
  created_at: string;
};

function isLoreEntity(record: ProjectLibraryRecord): record is LoreEntityRecord {
  return record.kind === "character" || record.kind === "location" || record.kind === "faction" || record.kind === "item" || record.kind === "world_rule";
}

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

function apiUrl(controller: WorkbenchController, pathname: string): string {
  return new URL(pathname, controller.runtime.apiBase).toString();
}

async function libraryRequest<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(apiUrl(controller, pathname), {
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

function activeRecords(bundle: ProjectLibraryBundle | null): ProjectLibraryRecord[] {
  return (bundle?.records || []).filter((record) => record.status === "active");
}

function EmptyLibraryState({ message, onMigrate }: { message: string; onMigrate?: () => void }) {
  return (
    <div className="xw-library-empty">
      <Library size={28} />
      <strong>资料库尚未准备好</strong>
      <p>{message}</p>
      {onMigrate && <button type="button" className="xw-primary-button" onClick={onMigrate}>导入旧项目资料</button>}
    </div>
  );
}

function LibraryStatus({ bundle, message, onReconcile }: { bundle: ProjectLibraryBundle | null; message: string; onReconcile: (action: "rebuild_projection" | "reimport_projection") => void }) {
  if (!bundle || bundle.status === "ready") return message ? <p className="xw-library-message" role="status">{message}</p> : null;
  if (bundle.status === "migration_required") {
    return <p className="xw-library-warning" role="status">发现旧版 TXT 内容。确认导入后，页面才会使用结构化资料。</p>;
  }
  return (
    <div className="xw-library-warning" role="alert">
      <span>兼容文本已在外部修改，当前编辑已暂停。</span>
      <button type="button" onClick={() => onReconcile("rebuild_projection")}>以资料库重建文本</button>
      <button type="button" onClick={() => onReconcile("reimport_projection")}>重新导入文本</button>
    </div>
  );
}

function LibraryDraftReview({ controller, domains, onChanged }: { controller: WorkbenchController; domains: ProjectLibraryDomain[]; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<ProjectLibraryDraft[]>([]);
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState("");
  const load = useCallback(async () => {
    if (!controller.snapshot?.currentProject.path) { setDrafts([]); return; }
    try {
      const payload = await libraryRequest<{ drafts: ProjectLibraryDraft[] }>(controller, "/api/project-library-drafts");
      setDrafts((payload.drafts || []).filter((draft) => domains.includes(draft.domain)));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [controller, controller.snapshot?.currentProject.path, domains.join(",")]);
  useEffect(() => { void load(); }, [load]);

  async function commit(draft: ProjectLibraryDraft) {
    setBusyId(draft.draft_id);
    try {
      await libraryRequest(controller, `/api/project-library-drafts/${encodeURIComponent(draft.draft_id)}/commit`, { method: "POST" });
      setMessage("草稿已确认并写入资料库。");
      await load();
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(""); }
  }

  async function discard(draft: ProjectLibraryDraft) {
    setBusyId(draft.draft_id);
    try {
      await libraryRequest(controller, `/api/project-library-drafts/${encodeURIComponent(draft.draft_id)}`, { method: "DELETE" });
      setMessage("草稿已丢弃。");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(""); }
  }

  if (!drafts.length && !message) return null;
  return <section className="xw-library-drafts" aria-label="待确认 AI 草稿">
    <div><strong>待确认 AI 草稿</strong>{message && <span role="status">{message}</span>}</div>
    {drafts.map((draft) => <article key={draft.draft_id}>
      <span><b>{draft.domain === "lore" ? "设定资料" : draft.domain === "style" ? "写作风格" : "题材规则"}</b><small>{draft.records.length} 条待确认内容</small></span>
      <p>{draft.records.slice(0, 3).map((record) => record.name).join("、")}{draft.records.length > 3 ? " 等" : ""}</p>
      <div><button type="button" className="xw-secondary-button" disabled={Boolean(busyId)} onClick={() => void discard(draft)}>丢弃</button><button type="button" className="xw-primary-button" disabled={Boolean(busyId)} onClick={() => void commit(draft)}>{busyId === draft.draft_id ? "处理中" : "确认写入"}</button></div>
    </article>)}
  </section>;
}

export function SourcesFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [bundle, setBundle] = useState<ProjectLibraryBundle | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<(typeof entityTabs)[number][0]>("character");
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [newEntityId, setNewEntityId] = useState("");

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
      setSelectedId((current) => current || activeRecords(next).find((record) => record.kind === tab)?.id || "");
      setLoadState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setLoadState("error");
    }
  }, [controller, controller.snapshot?.currentProject.path, tab]);

  useEffect(() => { void load(); }, [load]);

  const records = useMemo(() => activeRecords(bundle), [bundle]);
  const tabRecords = useMemo(() => records.filter(isLoreEntity).filter((record) => record.kind === tab && `${record.name}\n${record.summary}\n${record.tags.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [records, tab, query]);
  const selected = records.find((record): record is LoreEntityRecord => isLoreEntity(record) && record.id === selectedId) || null;
  const characters = records.filter((record): record is CharacterRecord => isLoreEntity(record) && record.kind === "character");
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
      setNewEntityId("");
      setMessage("设定资料已保存，并同步更新 AI 可检索文本。");
      void controller.refreshProjectWorkspace();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function migrate() {
    try {
      await libraryRequest(controller, "/api/project-libraries/migrate", { method: "POST", body: JSON.stringify({ domains: ["lore"], confirm: true }) });
      await load();
      setMessage("旧版设定已导入，请核对标记为“需复核”的资料。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  async function reconcile(action: "rebuild_projection" | "reimport_projection") {
    try {
      await libraryRequest(controller, "/api/project-libraries/lore/reconcile", { method: "POST", body: JSON.stringify({ action, confirm: true }) });
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
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
    setNewEntityId(entity.id);
    setEditing(true);
  }

  function addRelation() {
    if (!bundle || selected?.kind !== "character") return;
    const target = characters.find((record) => record.id !== selected.id);
    if (!target) {
      setMessage("请先创建另一位人物，再建立关系。");
      return;
    }
    const relation = { ...manualBase(`${selected.name} 与 ${target.name}`, bundle.records.length), kind: "relation" as const, from_id: selected.id, to_id: target.id, relation_type: "关联", direction: "undirected" as const } as ProjectLibraryRecord;
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
    if (selectedArc) replaceRecord(next); else setBundle({ ...bundle, records: [...bundle.records, next] });
    setEditing(true);
  }

  if (loadState === "loading") return <section className="xw-library-page"><div className="xw-library-skeleton" /></section>;
  if (!controller.snapshot?.currentProject.path) return <section className="xw-library-page"><EmptyLibraryState message="先打开或创建小说项目，再管理人物与世界规则。" /></section>;
  if (loadState === "error") return <section className="xw-library-page"><EmptyLibraryState message={message || "设定资料无法读取。"} /></section>;
  if (bundle?.status === "migration_required") return <section className="xw-library-page"><EmptyLibraryState message={`已识别 ${bundle.migration_preview?.records.length || 0} 条旧版资料。导入不会丢弃原始文本。`} onMigrate={migrate} /></section>;

  return (
    <section className="xw-library-page">
      <header className="xw-library-head">
        <div><p>项目资料</p><h1>设定资料</h1><span>人物、地点、势力、物品和世界规则统一保存，写作与 AI 都从这里取用。</span></div>
        <div className="xw-library-actions"><button type="button" className="xw-secondary-button" onClick={() => setEditing((value) => !value)}><Pencil size={15} />{editing ? "查看" : "编辑"}</button><button type="button" className="xw-primary-button" onClick={createEntity}><Plus size={15} />新建设定</button></div>
      </header>
      <LibraryStatus bundle={bundle} message={message} onReconcile={reconcile} />
      <LibraryDraftReview controller={controller} domains={["lore"]} onChanged={() => void load()} />
      <div className="xw-library-tabs" role="tablist" aria-label="设定分类">
        {entityTabs.map(([kind, label, Icon]) => <button key={kind} type="button" role="tab" aria-selected={tab === kind} className={tab === kind ? "active" : ""} onClick={() => { setTab(kind); setSelectedId(records.find((record) => record.kind === kind)?.id || ""); }}><Icon size={15} />{label}<em>{records.filter((record) => record.kind === kind).length}</em></button>)}
      </div>
      <div className="xw-library-layout sources">
        <aside className="xw-library-list">
          <div className="xw-library-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设定" aria-label="搜索设定" /><Filter size={15} /></div>
          <div className="xw-library-list-scroll">
            {tabRecords.map((record) => <button key={record.id} type="button" className={record.id === selectedId ? "active" : ""} onClick={() => { setSelectedId(record.id); setEditing(false); }}><span className="xw-library-avatar">{record.name.slice(0, 1)}</span><span><strong>{record.name}</strong><small>{record.role || record.identity || "未填写分类"}</small><p>{record.summary || "尚未填写资料摘要"}</p></span><ChevronRight size={15} /></button>)}
            {!tabRecords.length && <p className="xw-library-list-empty">当前分类还没有资料</p>}
          </div>
        </aside>
        <main className="xw-library-detail">
          {selected ? <>
            <div className="xw-library-detail-head"><span className="xw-library-avatar large">{selected.name.slice(0, 1)}</span><div><small>{entityTabs.find(([kind]) => kind === selected.kind)?.[1] || "设定"}</small>{editing ? <input value={selected.name} onFocus={(event) => { if (newEntityId === selected.id) event.currentTarget.select(); }} onChange={(event) => updateSelected({ name: event.target.value })} aria-label="设定名称" /> : <h2>{selected.name}</h2>}<p>{selected.identity || selected.role || "尚未填写身份"}</p></div><div>{editing && <button type="button" className="xw-primary-button" onClick={save}><Save size={15} />保存</button>}<button type="button" className="xw-secondary-button" onClick={() => { updateSelected({ status: "archived" }); setSelectedId(""); setEditing(true); }}><Archive size={14} />归档</button></div></div>
            <div className="xw-library-detail-grid">
              <section><h3>{selected.kind === "character" ? "人物核心" : "资料内容"}</h3>{editing ? <EntityEditor record={selected} onChange={updateSelected} /> : <EntityReadOnly record={selected} />}</section>
              {selected.kind === "character" && <section><div className="xw-library-section-head"><h3>关系</h3>{editing && <button type="button" onClick={addRelation}><Plus size={14} />添加</button>}</div><div className="xw-library-relations">{selectedRelations.map((relation) => relation.kind === "relation" && <RelationEditor key={relation.id} relation={relation} people={characters} editing={editing} onChange={replaceRecord} />)}{!selectedRelations.length && <p>尚未建立人物关系</p>}</div></section>}
              {selected.kind === "character" && <section className="wide"><h3>人物弧光</h3><div className="xw-library-arc">{arcPhases.map(([phase, label]) => { const point = selectedArc?.kind === "character_arc" ? selectedArc.points.find((item) => item.phase === phase)?.text || "" : ""; return <div key={phase} className={phase === "current" ? "current" : ""}><span>{label}</span>{editing ? <input value={point} onChange={(event) => updateArc(phase, event.target.value)} placeholder="填写阶段变化" /> : <strong>{point || "尚未填写"}</strong>}</div>; })}</div></section>}
            </div>
          </> : <EmptyLibraryState message="选择左侧的一项设定，或新建资料开始填写。" />}
        </main>
      </div>
    </section>
  );
}

function EntityReadOnly({ record }: { record: Extract<ProjectLibraryRecord, { kind: "character" | "location" | "faction" | "item" | "world_rule" }> }) {
  const fields: Array<[string, string]> = [["简介", record.summary], ["身份", record.identity], ["目标", record.goal], ["恐惧", record.fear], ["外在特征", record.appearance], ["说话方式", record.speech_style], ["约束", record.constraints.join("；")], ["备注", record.notes]];
  return <dl className="xw-library-facts">{fields.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}{!fields.some(([, value]) => value) && <p>点击“编辑”补充这项资料。</p>}</dl>;
}

function EntityEditor({ record, onChange }: { record: Extract<ProjectLibraryRecord, { kind: "character" | "location" | "faction" | "item" | "world_rule" }>; onChange: (values: Record<string, unknown>) => void }) {
  return <div className="xw-library-form"><label>分类<input value={record.role} onChange={(event) => onChange({ role: event.target.value })} /></label><label>身份<input value={record.identity} onChange={(event) => onChange({ identity: event.target.value })} /></label><label>简介<textarea value={record.summary} onChange={(event) => onChange({ summary: event.target.value })} /></label><label>目标<textarea value={record.goal} onChange={(event) => onChange({ goal: event.target.value })} /></label><label>恐惧<textarea value={record.fear} onChange={(event) => onChange({ fear: event.target.value })} /></label><label>外在特征<textarea value={record.appearance} onChange={(event) => onChange({ appearance: event.target.value })} /></label><label>说话方式<textarea value={record.speech_style} onChange={(event) => onChange({ speech_style: event.target.value })} /></label><label>约束<input value={record.constraints.join("；")} onChange={(event) => onChange({ constraints: event.target.value.split(/[；;]+/).map((value) => value.trim()).filter(Boolean) })} /></label></div>;
}

function RelationEditor({ relation, people, editing, onChange }: { relation: Extract<ProjectLibraryRecord, { kind: "relation" }>; people: ProjectLibraryRecord[]; editing: boolean; onChange: (record: ProjectLibraryRecord) => void }) {
  const personName = (id: string) => people.find((person) => person.id === id)?.name || "未知人物";
  if (!editing) return <article><strong>{personName(relation.from_id)} <ChevronRight size={13} /> {personName(relation.to_id)}</strong><span>{relation.relation_type}{relation.summary ? `，${relation.summary}` : ""}</span></article>;
  return <article className="editing"><select value={relation.to_id} onChange={(event) => onChange({ ...relation, to_id: event.target.value })}>{people.filter((person) => person.id !== relation.from_id).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select><input value={relation.relation_type} onChange={(event) => onChange({ ...relation, relation_type: event.target.value })} placeholder="关系类型" /><input value={relation.summary} onChange={(event) => onChange({ ...relation, summary: event.target.value })} placeholder="关系说明" /></article>;
}

export function StyleGenreFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [style, setStyle] = useState<ProjectLibraryBundle | null>(null);
  const [genre, setGenre] = useState<ProjectLibraryBundle | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"style" | "genre" | "examples" | "banned">("style");
  const [selectedExampleId, setSelectedExampleId] = useState("");

  const load = useCallback(async () => {
    if (!controller.snapshot?.currentProject.path) { setState("ready"); return; }
    setState("loading");
    try {
      const [nextStyle, nextGenre] = await Promise.all([
        libraryRequest(controller, "/api/project-libraries/style").then((payload) => projectLibraryBundleSchema.parse(payload)),
        libraryRequest(controller, "/api/project-libraries/genre").then((payload) => projectLibraryBundleSchema.parse(payload))
      ]);
      setStyle(nextStyle); setGenre(nextGenre);
      setSelectedExampleId((current) => current || activeRecords(nextStyle).find((record) => record.kind === "style_example")?.id || "");
      setState("ready");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setState("error"); }
  }, [controller, controller.snapshot?.currentProject.path]);
  useEffect(() => { void load(); }, [load]);

  const styleRecords = activeRecords(style);
  const genreRecords = activeRecords(genre);
  const examples = styleRecords.filter((record) => record.kind === "style_example");
  const styleMaterials = styleRecords.filter((record) => record.kind === "style_material");
  const genreMaterials = genreRecords.filter((record) => record.kind === "genre_material");
  const conflictTemplates = genreRecords.filter((record) => record.kind === "conflict_template");
  const selectedExample = examples.find((record) => record.id === selectedExampleId && record.kind === "style_example") || null;
  const rules = view === "genre" ? genreRecords.filter((record) => record.kind === "genre_rule") : styleRecords.filter((record) => record.kind === "style_rule");
  const profile = view === "genre"
    ? genreRecords.find((record) => record.kind === "genre_profile") || null
    : styleRecords.find((record) => record.kind === "style_profile") || null;
  const preferences = styleRecords.filter((record) => record.kind === "language_preference");
  const banned = genreRecords.filter((record) => record.kind === "banned_expression");

  async function saveDomain(domain: ProjectLibraryDomain, source: ProjectLibraryBundle | null) {
    if (!source || source.status !== "ready") return;
    try {
      const next = projectLibraryBundleSchema.parse(await libraryRequest(controller, `/api/project-libraries/${domain}`, { method: "PUT", body: JSON.stringify({ base_revision: source.revision, records: source.records }) }));
      if (domain === "style") setStyle(next); else setGenre(next);
      setMessage("规则已保存，并同步更新写作上下文。");
      void controller.refreshProjectWorkspace();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  function addItem() {
    const domain = view === "genre" || view === "banned" ? "genre" : "style";
    const source = domain === "style" ? style : genre;
    if (!source) return;
    const record = view === "examples"
      ? { ...manualBase("新范文片段", source.records.length), kind: "style_example" as const, before: "", after: "", explanation: "", source_ref: "" }
      : domain === "style"
        ? { ...manualBase("新叙事规则", source.records.length), kind: "style_rule" as const, category: "custom" as const, instruction: "", severity: "preference" as const, enabled: true }
        : { ...manualBase(view === "banned" ? "禁用表达" : "新题材规则", source.records.length), kind: view === "banned" ? "banned_expression" as const : "genre_rule" as const, ...(view === "banned" ? { replacement: "", reason: "" } : { category: "custom" as const, instruction: "", severity: "hard" as const, enabled: true }) };
    const next = { ...source, records: [...source.records, record as ProjectLibraryRecord] };
    if (domain === "style") setStyle(next); else setGenre(next);
    if (record.kind === "style_example") setSelectedExampleId(record.id);
  }

  function updateDomainRecord(domain: ProjectLibraryDomain, id: string, values: Record<string, unknown>) {
    const setter = domain === "style" ? setStyle : setGenre;
    setter((current) => current ? { ...current, records: current.records.map((record) => record.id === id ? { ...record, ...values } as ProjectLibraryRecord : record) } : current);
  }

  function updateProfile(domain: "style" | "genre", values: Record<string, unknown>) {
    const source = domain === "style" ? style : genre;
    const setter = domain === "style" ? setStyle : setGenre;
    if (!source) return;
    const kind = domain === "style" ? "style_profile" : "genre_profile";
    const existing = source.records.find((record) => record.kind === kind);
    if (existing) {
      setter({ ...source, records: source.records.map((record) => record.id === existing.id ? { ...record, ...values } as ProjectLibraryRecord : record) });
      return;
    }
    const profile = domain === "style"
      ? { ...manualBase("未命名写作风格", source.records.length), kind: "style_profile" as const, narrative_pov: "", description: "", active: true, ...values }
      : { ...manualBase("未命名题材", source.records.length), kind: "genre_profile" as const, description: "", active: true, ...values };
    setter({ ...source, records: [...source.records, profile as ProjectLibraryRecord] });
  }

  async function migrate() {
    const domains = [style, genre].filter((bundle) => bundle?.status === "migration_required").map((bundle) => bundle!.domain);
    if (!domains.length) return;
    try { await libraryRequest(controller, "/api/project-libraries/migrate", { method: "POST", body: JSON.stringify({ domains, confirm: true }) }); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  if (state === "loading") return <section className="xw-library-page"><div className="xw-library-skeleton" /></section>;
  if (!controller.snapshot?.currentProject.path) return <section className="xw-library-page"><EmptyLibraryState message="先打开项目，再建立项目级写作规则。" /></section>;
  if (state === "error") return <section className="xw-library-page"><EmptyLibraryState message={message || "风格与题材资料无法读取。"} /></section>;
  if (style?.status === "migration_required" || genre?.status === "migration_required") return <section className="xw-library-page"><EmptyLibraryState message="检测到旧版风格或题材 TXT。导入后将生成可编辑的规则、标签与范文。" onMigrate={migrate} /></section>;

  const addLabel = view === "examples" ? "添加范文" : view === "banned" ? "添加禁用表达" : "添加规则";

  return <section className="xw-library-page">
    <header className="xw-library-head"><div><p>项目写作规则</p><h1>风格与题材</h1><span>确认后的规则会在生成和审阅时自动生效。</span></div><div className="xw-library-actions"><button type="button" className="xw-secondary-button" onClick={() => void load()}><RefreshCw size={15} />刷新</button><button type="button" className="xw-primary-button" onClick={addItem}><Plus size={15} />{addLabel}</button></div></header>
    <LibraryStatus bundle={style?.status === "projection_drift" ? style : genre} message={message} onReconcile={(action) => void libraryRequest(controller, `/api/project-libraries/${style?.status === "projection_drift" ? "style" : "genre"}/reconcile`, { method: "POST", body: JSON.stringify({ action, confirm: true }) }).then(load)} />
    <LibraryDraftReview controller={controller} domains={["style", "genre"]} onChanged={() => void load()} />
    <div className="xw-library-layout style">
      <aside className="xw-style-nav" role="tablist" aria-label="风格与题材分类"><button role="tab" aria-selected={view === "style"} className={view === "style" ? "active" : ""} onClick={() => setView("style")}><Pencil size={15} />写作风格</button><button role="tab" aria-selected={view === "genre"} className={view === "genre" ? "active" : ""} onClick={() => setView("genre")}><Tags size={15} />题材规则</button><button role="tab" aria-selected={view === "examples"} className={view === "examples" ? "active" : ""} onClick={() => setView("examples")}><FileText size={15} />范文片段</button><button role="tab" aria-selected={view === "banned"} className={view === "banned" ? "active" : ""} onClick={() => setView("banned")}><ShieldCheck size={15} />禁用表达</button></aside>
      <main className="xw-style-main">
        {(view === "style" || view === "genre") && <RuleEditor title={view === "style" ? "写作风格" : "题材规则"} profile={profile} records={rules} onChange={(id, values) => updateDomainRecord(view === "style" ? "style" : "genre", id, values)} onProfileChange={(values) => updateProfile(view === "style" ? "style" : "genre", values)} onSave={() => void saveDomain(view === "style" ? "style" : "genre", view === "style" ? style : genre)} />}
        {view === "style" && <PreferenceEditor records={preferences} onChange={(id, values) => updateDomainRecord("style", id, values)} onAdd={() => { if (!style) return; setStyle({ ...style, records: [...style.records, { ...manualBase("具体动词", style.records.length), kind: "language_preference", preference: "prefer", replacement: "" } as ProjectLibraryRecord] }); }} onSave={() => void saveDomain("style", style)} />}
        {view === "style" && <MaterialEditor title="参考素材" records={styleMaterials} onAdd={() => { if (!style) return; setStyle({ ...style, records: [...style.records, { ...manualBase("新参考素材", style.records.length), kind: "style_material", content: "" } as ProjectLibraryRecord] }); }} onChange={(id, values) => updateDomainRecord("style", id, values)} onSave={() => void saveDomain("style", style)} />}
        {view === "genre" && <MaterialEditor title="题材素材" records={genreMaterials} onAdd={() => { if (!genre) return; setGenre({ ...genre, records: [...genre.records, { ...manualBase("新题材素材", genre.records.length), kind: "genre_material", content: "" } as ProjectLibraryRecord] }); }} onChange={(id, values) => updateDomainRecord("genre", id, values)} onSave={() => void saveDomain("genre", genre)} />}
        {view === "genre" && <ConflictTemplateEditor records={conflictTemplates} onAdd={() => { if (!genre) return; setGenre({ ...genre, records: [...genre.records, { ...manualBase("新冲突模板", genre.records.length), kind: "conflict_template", setup: "", pressure: "", reversal: "", resolution: "" } as ProjectLibraryRecord] }); }} onChange={(id, values) => updateDomainRecord("genre", id, values)} onSave={() => void saveDomain("genre", genre)} />}
        {view === "examples" && <ExamplesEditor records={examples} selectedId={selectedExampleId} onSelect={setSelectedExampleId} onChange={(id, values) => updateDomainRecord("style", id, values)} onAdd={() => { if (!style) return; const next = { ...manualBase("新范文片段", style.records.length), kind: "style_example" as const, before: "", after: "", explanation: "", source_ref: "" } as ProjectLibraryRecord; setStyle({ ...style, records: [...style.records, next] }); setSelectedExampleId(next.id); }} onSave={() => void saveDomain("style", style)} />}
        {view === "banned" && <BannedEditor records={banned} onChange={(id, values) => updateDomainRecord("genre", id, values)} onSave={() => void saveDomain("genre", genre)} />}
      </main>
      <aside className="xw-style-preview"><div><strong>效果预览</strong><button type="button" className="xw-icon-button" title="已保存范文会在这里显示" aria-label="已保存范文效果预览"><History size={15} /></button></div>{selectedExample ? <><span>应用前</span><blockquote>{selectedExample.before || "尚未填写应用前文本"}</blockquote><span className="accent">应用后</span><blockquote>{selectedExample.after || "尚未填写应用后文本"}</blockquote><p className="xw-preview-note">{selectedExample.explanation || "将范文的修改说明保存后，会在这里呈现。"}</p></> : <p className="xw-preview-empty">保存一段范文后，可在这里对照应用前后的效果。</p>}</aside>
    </div>
  </section>;
}

function RuleEditor({ title, profile, records, onChange, onProfileChange, onSave }: { title: string; profile: ProjectLibraryRecord | null; records: ProjectLibraryRecord[]; onChange: (id: string, values: Record<string, unknown>) => void; onProfileChange: (values: Record<string, unknown>) => void; onSave: () => void }) {
  const profileDescription = profile?.kind === "style_profile" || profile?.kind === "genre_profile" ? profile.description || profile.summary : "";
  const editableProfile = profile?.kind === "style_profile" || profile?.kind === "genre_profile" ? profile : null;
  return <><div className="xw-library-profile"><div>{editableProfile ? <div className="xw-library-profile-fields"><label>当前{title}<input value={editableProfile.name} onChange={(event) => onProfileChange({ name: event.target.value })} /></label><label>说明<textarea value={profileDescription} onChange={(event) => onProfileChange({ description: event.target.value, summary: event.target.value })} /></label></div> : <><small>当前{title}</small><h2>尚未设置{title}</h2><p>先创建项目级{title}档案，再将规则、素材和范文作为同一套写作上下文保存。</p><button type="button" className="xw-secondary-button" onClick={() => onProfileChange({})}><Plus size={14} />设置{title}</button></>}</div><button type="button" className="xw-primary-button" onClick={onSave}><Save size={15} />保存</button></div><section className="xw-rule-section"><div className="xw-library-section-head"><h3>规则</h3></div>{records.map((record) => (record.kind === "style_rule" || record.kind === "genre_rule") && <article key={record.id} className="xw-rule-row"><input value={record.name} onChange={(event) => onChange(record.id, { name: event.target.value })} /><textarea value={record.instruction} onChange={(event) => onChange(record.id, { instruction: event.target.value })} placeholder="填写可执行的写作约束" /><label><input type="checkbox" checked={record.enabled} onChange={(event) => onChange(record.id, { enabled: event.target.checked })} />启用</label></article>)}{!records.length && <p>点击“添加规则”建立第一条项目约束。</p>}</section></>;
}

function MaterialEditor({ title, records, onAdd, onChange, onSave }: { title: string; records: ProjectLibraryRecord[]; onAdd: () => void; onChange: (id: string, values: Record<string, unknown>) => void; onSave: () => void }) {
  return <section className="xw-rule-section"><div className="xw-library-section-head"><h3>{title}</h3><button type="button" onClick={onAdd}><Plus size={14} />添加</button></div>{records.map((record) => (record.kind === "style_material" || record.kind === "genre_material") && <article key={record.id} className="xw-rule-row"><input value={record.name} onChange={(event) => onChange(record.id, { name: event.target.value })} /><textarea value={record.content} onChange={(event) => onChange(record.id, { content: event.target.value })} placeholder="记录可复用的题材、世界观或表达素材" /><button type="button" aria-label={`归档 ${record.name}`} onClick={() => onChange(record.id, { status: "archived" })}><Archive size={14} /></button></article>)}{!records.length && <p>尚未添加{title}。</p>}<button type="button" className="xw-secondary-button" onClick={onSave}><Save size={14} />保存{title}</button></section>;
}

function ConflictTemplateEditor({ records, onAdd, onChange, onSave }: { records: ProjectLibraryRecord[]; onAdd: () => void; onChange: (id: string, values: Record<string, unknown>) => void; onSave: () => void }) {
  return <section className="xw-rule-section"><div className="xw-library-section-head"><h3>冲突模板</h3><button type="button" onClick={onAdd}><Plus size={14} />添加</button></div>{records.map((record) => record.kind === "conflict_template" && <article key={record.id} className="xw-conflict-template"><div><input value={record.name} onChange={(event) => onChange(record.id, { name: event.target.value })} aria-label="模板名称" /><button type="button" aria-label={`归档 ${record.name}`} onClick={() => onChange(record.id, { status: "archived" })}><Archive size={14} /></button></div><div className="xw-library-form"><label>铺垫<textarea value={record.setup} onChange={(event) => onChange(record.id, { setup: event.target.value })} /></label><label>压迫<textarea value={record.pressure} onChange={(event) => onChange(record.id, { pressure: event.target.value })} /></label><label>反转<textarea value={record.reversal} onChange={(event) => onChange(record.id, { reversal: event.target.value })} /></label><label>收束<textarea value={record.resolution} onChange={(event) => onChange(record.id, { resolution: event.target.value })} /></label></div></article>)}{!records.length && <p>尚未添加冲突模板。</p>}<button type="button" className="xw-secondary-button" onClick={onSave}><Save size={14} />保存冲突模板</button></section>;
}

function PreferenceEditor({ records, onChange, onAdd, onSave }: { records: ProjectLibraryRecord[]; onChange: (id: string, values: Record<string, unknown>) => void; onAdd: () => void; onSave: () => void }) {
  return <section className="xw-rule-section"><div className="xw-library-section-head"><h3>语言偏好</h3><button type="button" onClick={onAdd}><Plus size={14} />添加</button></div>{(["prefer", "avoid"] as const).map((preference) => <div key={preference} className={`xw-preference-row ${preference === "avoid" ? "danger" : ""}`}><span>{preference === "prefer" ? "偏好" : "避免"}</span>{records.filter((record) => record.kind === "language_preference" && record.preference === preference).map((record) => record.kind === "language_preference" && <label key={record.id}><input value={record.name} onChange={(event) => onChange(record.id, { name: event.target.value })} /><button type="button" aria-label={`删除 ${record.name}`} onClick={() => onChange(record.id, { status: "archived" })}><X size={12} /></button></label>)}</div>)}<button type="button" className="xw-secondary-button" onClick={onSave}><Save size={14} />保存偏好</button></section>;
}

function ExamplesEditor({ records, selectedId, onSelect, onChange, onAdd, onSave }: { records: ProjectLibraryRecord[]; selectedId: string; onSelect: (id: string) => void; onChange: (id: string, values: Record<string, unknown>) => void; onAdd: () => void; onSave: () => void }) {
  const selected = records.find((record) => record.id === selectedId && record.kind === "style_example");
  return <section className="xw-rule-section"><div className="xw-library-section-head"><h3>范文片段</h3><button type="button" onClick={onAdd}><Plus size={14} />添加</button></div><div className="xw-example-list">{records.map((record) => record.kind === "style_example" && <button type="button" key={record.id} className={record.id === selectedId ? "active" : ""} onClick={() => onSelect(record.id)}>{record.name}</button>)}</div>{selected?.kind === "style_example" ? <div className="xw-library-form"><label>标题<input value={selected.name} onChange={(event) => onChange(selected.id, { name: event.target.value })} /></label><label>应用前<textarea value={selected.before} onChange={(event) => onChange(selected.id, { before: event.target.value })} /></label><label>应用后<textarea value={selected.after} onChange={(event) => onChange(selected.id, { after: event.target.value })} /></label><label>效果说明<input value={selected.explanation} onChange={(event) => onChange(selected.id, { explanation: event.target.value })} /></label></div> : <p>选择或新建一段范文。</p>}<button type="button" className="xw-primary-button" onClick={onSave}><Save size={15} />保存范文</button></section>;
}

function BannedEditor({ records, onChange, onSave }: { records: ProjectLibraryRecord[]; onChange: (id: string, values: Record<string, unknown>) => void; onSave: () => void }) {
  return <section className="xw-rule-section"><div className="xw-library-section-head"><h3>禁用表达</h3><button type="button" className="xw-primary-button" onClick={onSave}><Save size={15} />保存</button></div>{records.map((record) => record.kind === "banned_expression" && <article key={record.id} className="xw-rule-row"><input value={record.name} onChange={(event) => onChange(record.id, { name: event.target.value })} /><input value={record.replacement} onChange={(event) => onChange(record.id, { replacement: event.target.value })} placeholder="替代表达（可选）" /><button type="button" aria-label={`归档 ${record.name}`} onClick={() => onChange(record.id, { status: "archived" })}><Archive size={14} /></button></article>)}{!records.length && <p>点击“添加规则”后选择“禁用表达”，即可建立题材边界。</p>}</section>;
}
