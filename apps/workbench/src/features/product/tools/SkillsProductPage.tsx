import {
  ArrowLeftRight,
  BookCheck,
  ChevronRight,
  FileText,
  Import,
  Info,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SquarePen
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SkillDefinition } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { ProductRoute } from "../../../navigation.js";
import { RichText } from "../../../components/RichText.js";
import { describePendingGeneratedTarget } from "../../../lib/workflow.js";
import { automaticFeatures, saveAutomaticFeature, type AutomaticConfigKey } from "./automaticFeatures.js";

type ToolCategory = "all" | "writing" | "transfer" | "local";
function listDraft(items: string[] | undefined): string {
  return (items || []).join(", ");
}

function parseListDraft(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SkillsProductPage({ controller, route, onNavigate }: { controller: WorkbenchController; route: ProductRoute; onNavigate: (route: ProductRoute) => void }) {
  const [viewSkillId, setViewSkillId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [category, setCategory] = useState<ToolCategory>("all");
  const [automaticBusy, setAutomaticBusy] = useState<AutomaticConfigKey | "">("");

  // 编辑字段状态
  const [editDescription, setEditDescription] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editTargets, setEditTargets] = useState("");
  const [editReason, setEditReason] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [importPath, setImportPath] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const importFileRef = useRef<HTMLInputElement | null>(null);

  const skills = controller.snapshot?.skills || [];
  const visibleSkills = skills.filter((skill) => category === "all" || skillCategory(skill) === category);

  useEffect(() => {
    if (route.feature !== "skills") return;
    setViewSkillId(route.skillId || null);
    setIsEditing(route.mode === "edit");
  }, [route]);

  // 加载技能详情
  useEffect(() => {
    if (viewSkillId && route.feature === "skills" && route.mode !== "import") {
      void controller.selectSkill(viewSkillId, { activateTab: false });
    }
  }, [route, viewSkillId]);

  useEffect(() => {
    if (route.feature === "skills" && route.mode === "versions" && viewSkillId) {
      void controller.loadSkillVersions(viewSkillId);
    }
  }, [route, viewSkillId]);

  // 同步编辑状态
  const activeDetail = controller.selectedSkillDetail;
  useEffect(() => {
    if (activeDetail && activeDetail.id === viewSkillId) {
      setEditDescription(activeDetail.description || "");
      setEditPrompt(activeDetail.prompt || "");
      setEditContext(listDraft(activeDetail.context_requirements));
      setEditTargets(listDraft(activeDetail.linked_targets));
      setCloneName(`${activeDetail.name} (自定义)`);
      setEditReason("");
    }
  }, [activeDetail, viewSkillId]);

  // 三级页面保存修改
  const pendingPatch = activeDetail && controller.pendingSkillPatchPreview?.skillId === activeDetail.id
    ? controller.pendingSkillPatchPreview
    : null;

  function previewPatch() {
    if (!activeDetail) return;
    void controller.previewSelectedSkillPatch({
      description: editDescription,
      prompt: editPrompt,
      context_requirements: parseListDraft(editContext),
      linked_targets: parseListDraft(editTargets),
      change_reason: editReason.trim() || "三级页面修改"
    });
  }

  async function toggleAutomaticFeature(key: AutomaticConfigKey) {
    if (!controller.configDraft || automaticBusy) return;
    const previous = Boolean(controller.configDraft[key]);
    const next = !previous;
    const feature = automaticFeatures.find((item) => item.key === key);
    if (!feature) return;
    setAutomaticBusy(key);
    try {
      await saveAutomaticFeature({
        feature,
        enabled: next,
        skills,
        setSkillEnabled: controller.setSkillEnabled,
        patchAndSaveConfig: controller.patchAndSaveConfig
      });
    } finally {
      setAutomaticBusy("");
    }
  }

  function submitPathImport() {
    const path = importPath.trim();
    if (path) {
      void controller.importSkillFromPath(path);
      return;
    }
    importFileRef.current?.click();
  }

  if (route.feature === "skills" && route.mode === "import") {
    const pendingDraft = controller.pendingSkillDraft;
    return (
      <div className="page-scroll skill-tertiary-page">
        <header className="content-head">
          <div>
            <button className="button secondary compact" type="button" onClick={() => onNavigate({ feature: "skills" })}>← 返回创作工具</button>
            <h1>导入技能</h1>
            <p>先解析为草稿并检查权限，确认后才会加入创作工具。</p>
          </div>
        </header>
        <section className="skill-import-panel" aria-label="技能导入">
          <label><span>本地技能路径</span><input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="选择 .md、.txt 或 .zip 技能文件" /></label>
          <button className="button primary" type="button" onClick={submitPathImport} disabled={controller.operationsBusy}>选择并预览</button>
          <input
            ref={importFileRef}
            type="file"
            hidden
            accept=".md,.markdown,.txt,.zip"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] || null;
              event.currentTarget.value = "";
              if (file) void controller.uploadSkillFile(file);
            }}
          />
          <label><span>GitHub 或网页地址</span><input value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://..." /></label>
          <button className="button secondary" type="button" onClick={() => void controller.importSkillFromUrl(importUrl)} disabled={controller.operationsBusy || !importUrl.trim()}>读取 URL 草稿</button>
        </section>
        {pendingDraft ? (
          <section className="skill-import-preview" aria-label="技能导入预览">
            <div><strong>{pendingDraft.skill.name}</strong><span>{pendingDraft.skill.handler_type} · {pendingDraft.source_name || pendingDraft.source_url || "导入草稿"}</span></div>
            <p>{pendingDraft.skill.description}</p>
            {pendingDraft.warnings.length > 0 && <p className="skill-warning">{pendingDraft.warnings.join("；")}</p>}
            {pendingDraft.skill.prompt && <pre>{pendingDraft.skill.prompt.slice(0, 1200)}</pre>}
            <div className="content-actions">
              <button className="button primary" type="button" onClick={() => void controller.importPendingSkillDraft()} disabled={controller.operationsBusy}>确认导入</button>
              <button className="button secondary" type="button" onClick={controller.discardPendingSkillDraft} disabled={controller.operationsBusy}>丢弃草稿</button>
            </div>
          </section>
        ) : (
          <p className="tool-list-empty">选择本地文件或输入 URL 后，这里会显示导入预览。</p>
        )}
      </div>
    );
  }

  if (viewSkillId && activeDetail && route.feature === "skills" && route.mode === "versions") {
    return (
      <div className="page-scroll skill-tertiary-page">
        <header className="content-head">
          <div>
            <button className="button secondary compact" type="button" onClick={() => onNavigate({ feature: "skills", skillId: activeDetail.id, mode: "view" })}>← 返回技能详情</button>
            <h1>版本历史：{activeDetail.name}</h1>
            <p>每次确认保存都会创建版本；回滚前仍会保留当前内容。</p>
          </div>
          <button className="button secondary" type="button" onClick={() => void controller.loadSkillVersions(activeDetail.id)} disabled={controller.operationsBusy}>刷新历史</button>
        </header>
        <section className="skill-version-history" aria-label="技能版本历史">
          {activeDetail.builtin ? (
            <p className="tool-list-empty">系统内置技能由应用版本管理；复制为自定义技能后可查看和回滚修改历史。</p>
          ) : controller.selectedSkillVersions.length ? controller.selectedSkillVersions.map((version) => (
            <article key={version.version_id}>
              <div><strong>{version.snapshot.name}</strong><span>{version.created_at} · {version.change_reason || "内容更新"}</span></div>
              <button className="button secondary compact" type="button" onClick={() => void controller.rollbackSelectedSkill(version.version_id)} disabled={controller.operationsBusy}>回滚到此版本</button>
            </article>
          )) : (
            <p className="tool-list-empty">暂无历史版本。</p>
          )}
        </section>
      </div>
    );
  }

  // 渲染三级查看页
  if (viewSkillId && activeDetail) {
    const isBuiltin = activeDetail.builtin;
    return (
      <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="content-head">
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button className="button secondary compact" type="button" onClick={() => onNavigate({ feature: "skills" })}>
              ← 返回创作工具
            </button>
            <h1 style={{ fontSize: "16px", margin: 0 }}>技能详情：{activeDetail.name}</h1>
          </div>
          <div className="content-actions">
            {!isEditing && (
              <button className="button secondary" type="button" onClick={() => onNavigate({ feature: "skills", skillId: activeDetail.id, mode: "edit" })}>
                <SquarePen size={15} /> 编辑技能
              </button>
            )}
            <button className="button secondary" type="button" onClick={() => onNavigate({ feature: "skills", skillId: activeDetail.id, mode: "versions" })}>
              版本历史
            </button>
            <button className="button primary" type="button" onClick={() => void controller.invokeSelectedSkill()} disabled={activeDetail.disabled}>
              运行技能
            </button>
          </div>
        </div>

        {controller.operationsMessage && <p className="automatic-tools-message" role="status">{controller.operationsMessage}</p>}

        {controller.pendingGeneratedSave?.source === "skill" && (
          <section className="skill-write-confirm" aria-label="AI 写入确认">
            <div>
              <strong>生成结果预览</strong>
              <span>{describePendingGeneratedTarget(controller.pendingGeneratedSave)}</span>
            </div>
            <div className="skill-write-preview"><RichText text={controller.pendingGeneratedSave.content} /></div>
            <div className="content-actions">
              <button className="button primary" type="button" onClick={() => void controller.savePendingGenerated("replace")} disabled={controller.operationsBusy}>覆盖写入</button>
              <button className="button secondary" type="button" onClick={() => void controller.savePendingGenerated("append")} disabled={controller.operationsBusy}>追加写入</button>
              <button className="button secondary" type="button" onClick={() => void controller.savePendingGeneratedAsDraft()} disabled={controller.operationsBusy}>另存草稿</button>
              <button className="button secondary" type="button" onClick={() => void controller.discardPendingGenerated()} disabled={controller.operationsBusy}>丢弃</button>
            </div>
          </section>
        )}

        <div className="sources-layout" style={{ flex: 1, minHeight: 0, marginTop: "15px" }}>
          {/* 左栏：用途与权限 */}
          <section className="entity-detail" style={{ overflowY: "auto", flex: 1.2 }}>
            <h3>技能用途与适用场景</h3>
            <p style={{ fontSize: "12px", lineHeight: "1.6", color: "var(--text)" }}>
              {activeDetail.description}
            </p>

            <dl className="project-facts" style={{ gridTemplateColumns: "1fr", borderLeft: 0, marginTop: "15px" }}>
              <div style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <dt style={{ fontSize: "12px", color: "var(--muted)" }}>输入上下文范围</dt>
                <dd style={{ fontSize: "12px", fontWeight: "normal" }}>{listDraft(activeDetail.context_requirements) || "无需特定上下文"}</dd>
              </div>
              <div style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <dt style={{ fontSize: "12px", color: "var(--muted)" }}>关联目标输出</dt>
                <dd style={{ fontSize: "12px", fontWeight: "normal" }}>{listDraft(activeDetail.linked_targets) || "默认会话输出"}</dd>
              </div>
              <div style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <dt style={{ fontSize: "12px", color: "var(--muted)" }}>文件访问权限</dt>
                <dd style={{ fontSize: "12px", fontWeight: "normal" }}>限制于当前小说项目内</dd>
              </div>
            </dl>

            {isEditing && (
              <div className="xw-library-form" style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <label style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>Prompt 设置</span>
                  <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} style={{ padding: "6px", border: "1px solid var(--line)", borderRadius: "4px" }} rows={6} />
                </label>
                <label style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>修改说明原因</span>
                  <input value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="例如：强化输出格式规范" style={{ padding: "6px", border: "1px solid var(--line)", borderRadius: "4px" }} />
                </label>

                <div style={{ display: "flex", gap: "10px" }}>
                  <button className="button primary compact" type="button" onClick={previewPatch}>
                    预览修改
                  </button>
                  <button className="button secondary compact" type="button" onClick={() => onNavigate({ feature: "skills", skillId: activeDetail.id, mode: "view" })}>
                    取消编辑
                  </button>
                </div>
              </div>
            )}

            {pendingPatch && (
              <div className="xw-skill-diff-preview" style={{ marginTop: "15px", padding: "12px", background: "var(--stone)", borderRadius: "6px" }}>
                <strong>修改差异预览</strong>
                <pre style={{ fontSize: "12px", padding: "8px", background: "var(--stone-deep)", overflowX: "auto" }}>
                  {pendingPatch.response.diff || "没有差异检测"}
                </pre>
                <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                  <button className="button primary compact" type="button" onClick={() => void controller.commitPendingSkillPatch().then(() => onNavigate({ feature: "skills", skillId: activeDetail.id, mode: "view" }))}>
                    确认保存
                  </button>
                  <button className="button secondary compact" type="button" onClick={controller.discardPendingSkillPatch}>
                    丢弃草稿
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* 右栏：版本与属性 */}
          <aside className="detail-panel" style={{ width: "260px", overflowY: "auto", borderLeft: "1px solid var(--line)", paddingLeft: "15px" }}>
            <h3>技术元信息</h3>
            <dl style={{ fontSize: "12px", margin: "10px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <dt style={{ color: "var(--muted)" }}>当前版本</dt>
                <dd>v{activeDetail.version || "1.0.0"}</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <dt style={{ color: "var(--muted)" }}>技能来源</dt>
                <dd>{activeDetail.builtin ? "系统内置" : "用户自定义"}</dd>
              </div>
            </dl>

            <div style={{ borderTop: "1px solid var(--line)", paddingTop: "15px" }}>
              <h4>控制动作</h4>
              <button
                className="button secondary"
                style={{ width: "100%", minHeight: "30px", marginBottom: "8px" }}
                type="button"
                onClick={() => void controller.deleteOrDisableSelectedSkill()}
              >
                {activeDetail.disabled ? "启用技能" : "禁用技能"}
              </button>
              {isBuiltin && (
                <div style={{ marginTop: "10px" }}>
                  <input
                    value={cloneName}
                    onChange={(e) => setCloneName(e.target.value)}
                    style={{ width: "100%", padding: "4px", fontSize: "12px", border: "1px solid var(--line)", borderRadius: "4px" }}
                  />
                  <button
                    className="button primary"
                    style={{ width: "100%", minHeight: "30px", marginTop: "4px" }}
                    type="button"
                    onClick={() => void controller.cloneSelectedSkill({ targetName: cloneName })}
                  >
                    复制为自定义技能
                  </button>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    );
  }

  // 渲染主列表页面
  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>创作工具</h1>
          <p>只展示作者会直接使用的能力；工具访问权限在启用前清楚说明。</p>
        </div>
        <div className="content-actions">
          <button className="button primary" type="button" onClick={() => onNavigate({ feature: "skills", mode: "import" })}>
            <Import size={15} /> 导入技能
          </button>
          <button className="button secondary" type="button" onClick={() => void controller.refreshSkillCatalog()}>
            <RefreshCw size={15} /> 刷新
          </button>
        </div>
      </div>

      <div className="tool-tabs" role="tablist" aria-label="创作工具分类">
        {([
          ["all", "全部工具"],
          ["writing", "写作与审阅"],
          ["transfer", "导入与导出"],
          ["local", "本地处理"]
        ] as Array<[ToolCategory, string]>).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={category === id} className={category === id ? "active" : ""} onClick={() => setCategory(id)}>{label}</button>
        ))}
      </div>

      {category === "writing" && controller.configDraft && (
        <section className="automatic-tools" aria-label="自动写作与审阅功能">
          <div className="automatic-tools-heading">
            <div><h2>自动写作与审阅</h2><p>这些开关与设置同步，修改后立即保存。</p></div>
            <button className="button secondary compact" type="button" onClick={() => void controller.runWorkflowSkill("consistency_check")} disabled={controller.operationsBusy || !controller.activeDocumentPath}>
              <BookCheck size={14} />立即检查当前章节
            </button>
          </div>
          <div className="automatic-tool-list">
            {automaticFeatures.map((item) => {
              const enabled = Boolean(controller.configDraft?.[item.key]);
              const skillDisabled = Boolean(skills.find((skill) => skill.id === item.skillId)?.disabled);
              return (
                <article key={item.key}>
                  <div><strong>{item.label}</strong><p>{item.description}</p>{skillDisabled && <small>关联技能当前已禁用，开启时会同步恢复。</small>}</div>
                  <button
                    className={`toggle${enabled ? " on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${enabled ? "关闭" : "开启"}${item.label}`}
                    disabled={Boolean(automaticBusy) || controller.configBusy}
                    onClick={() => void toggleAutomaticFeature(item.key)}
                  ><i /></button>
                </article>
              );
            })}
          </div>
          {(controller.configMessage || controller.operationsMessage) && <p className="automatic-tools-message" role="status">{controller.configMessage || controller.operationsMessage}</p>}
        </section>
      )}

      <section className="tool-list" style={{ flex: 1, overflowY: "auto" }}>
        {visibleSkills.map((skill) => (
          <button
            key={skill.id}
            type="button"
            className="tool-row"
            onClick={() => onNavigate({ feature: "skills", skillId: skill.id, mode: "view" })}
          >
            <span className="tool-icon" style={{ width: "30px", height: "30px", background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center", borderRadius: "6px" }}>
              <BookCheck size={18} />
            </span>
            <div style={{ flex: 1 }}>
              <strong style={{ fontSize: "12px" }}>{skill.name}</strong>
              <p style={{ fontSize: "12px", color: "var(--muted)", margin: "4px 0" }}>{skill.description}</p>
              <small style={{ fontSize: "12px", color: "var(--faint)" }}>
                系统内置 · 仅访问当前小说项目
              </small>
            </div>
            <span className="tool-state" style={{ fontSize: "12px", color: skill.disabled ? "var(--muted)" : "var(--success)" }}>
              {skill.disabled ? "未启用" : "已启用"}
            </span>
            <ChevronRight size={15} style={{ color: "var(--line-strong)" }} />
          </button>
        ))}
        {!visibleSkills.length && <p className="tool-list-empty">当前分类没有可用工具。</p>}
      </section>

      <div className="safe-tools-note" style={{ display: "flex", gap: "10px", background: "var(--success-soft)", color: "var(--success)", padding: "12px", borderRadius: "6px", marginTop: "15px", alignItems: "center" }}>
        <ShieldCheck size={20} />
        <div style={{ flex: 1, fontSize: "12px" }}>
          <strong>工具不会获得终端或系统命令权限</strong>
          <p style={{ margin: "2px 0 0", color: "var(--muted)", fontSize: "12px" }}>
            所有文件操作都限制在你选择的小说项目和明确选中的外部文件中。
          </p>
        </div>
      </div>
    </div>
  );
}

function skillCategory(skill: SkillDefinition): Exclude<ToolCategory, "all"> {
  const id = skill.id.toLowerCase();
  const text = `${skill.name} ${skill.description}`.toLowerCase();
  if (/import|export|convert|migrate|epub|txt|导入|导出|转换|迁移/.test(`${id} ${text}`)) return "transfer";
  if (/offline|local|token|segment|index|本地|分词|索引/.test(`${id} ${text}`)) return "local";
  return "writing";
}
