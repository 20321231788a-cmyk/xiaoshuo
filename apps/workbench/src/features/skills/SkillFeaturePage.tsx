import type { SkillDefinition } from "@xiaoshuo/shared";
import { useEffect, useRef, useState } from "react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";

function listDraft(items: string[] | undefined): string {
  return (items || []).join(", ");
}

function parseListDraft(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SkillFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [pathInput, setPathInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [draftNameInput, setDraftNameInput] = useState("");
  const [draftInstructionInput, setDraftInstructionInput] = useState("");
  const [cloneNameInput, setCloneNameInput] = useState("");
  const [editDescriptionInput, setEditDescriptionInput] = useState("");
  const [editPromptInput, setEditPromptInput] = useState("");
  const [editContextInput, setEditContextInput] = useState("");
  const [editTargetsInput, setEditTargetsInput] = useState("");
  const [editReasonInput, setEditReasonInput] = useState("");
  const [skillPage, setSkillPage] = useState(0);
  const [skillDescriptionDrafts, setSkillDescriptionDrafts] = useState<Record<string, string>>({});
  const [pendingSkillAction, setPendingSkillAction] = useState<{ skillId: string; action: "run" | "delete-disable" | "restore" } | null>(null);
  const [skillRefreshError, setSkillRefreshError] = useState("");
  const attemptedEmptySkillRefreshRef = useRef(false);
  const skillFileInputRef = useRef<HTMLInputElement | null>(null);
  const skills = controller.snapshot?.skills || [];
  const skillsPerPage = 12;
  const pageCount = Math.max(1, Math.ceil(skills.length / skillsPerPage));
  const currentPage = Math.min(skillPage, pageCount - 1);
  const pageSkills = skills.slice(currentPage * skillsPerPage, currentPage * skillsPerPage + skillsPerPage);
  const pendingDraft = controller.pendingSkillDraft;
  const pendingDraftPrompt = pendingDraft?.skill.prompt.trim() || "";
  const selectedSkill = controller.selectedSkillDetail;
  const pendingPatch = selectedSkill && controller.pendingSkillPatchPreview?.skillId === selectedSkill.id
    ? controller.pendingSkillPatchPreview
    : null;
  const editChanged = selectedSkill ? (
    editDescriptionInput !== selectedSkill.description ||
    editPromptInput !== (selectedSkill.prompt || "") ||
    editContextInput !== listDraft(selectedSkill.context_requirements) ||
    editTargetsInput !== listDraft(selectedSkill.linked_targets) ||
    editReasonInput.trim().length > 0
  ) : false;

  async function refreshSkills() {
    setSkillRefreshError("");
    try {
      await controller.refreshSkillCatalog();
    } catch (error) {
      setSkillRefreshError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    if (skillPage > pageCount - 1) {
      setSkillPage(pageCount - 1);
    }
  }, [pageCount, skillPage]);

  useEffect(() => {
    if (!controller.snapshot || skills.length || attemptedEmptySkillRefreshRef.current) {
      return;
    }
    attemptedEmptySkillRefreshRef.current = true;
    void refreshSkills();
  }, [controller.snapshot, skills.length]);

  useEffect(() => {
    if (!pendingSkillAction || controller.operationsBusy) {
      return;
    }
    if (controller.selectedSkillId !== pendingSkillAction.skillId || controller.selectedSkillDetail?.id !== pendingSkillAction.skillId) {
      return;
    }
    const action = pendingSkillAction.action;
    setPendingSkillAction(null);
    if (action === "run") {
      void controller.invokeSelectedSkill();
      return;
    }
    if (action === "restore") {
      void controller.restoreSelectedBuiltinSkill();
      return;
    }
    void controller.deleteOrDisableSelectedSkill();
  }, [controller, pendingSkillAction]);

  useEffect(() => {
    if (!selectedSkill) {
      setCloneNameInput("");
      setEditDescriptionInput("");
      setEditPromptInput("");
      setEditContextInput("");
      setEditTargetsInput("");
      setEditReasonInput("");
      return;
    }
    setCloneNameInput(`${selectedSkill.name}（自定义）`);
    setEditDescriptionInput(selectedSkill.description || "");
    setEditPromptInput(selectedSkill.prompt || "");
    setEditContextInput(listDraft(selectedSkill.context_requirements));
    setEditTargetsInput(listDraft(selectedSkill.linked_targets));
    setEditReasonInput("");
  }, [
    selectedSkill?.id,
    selectedSkill?.description,
    selectedSkill?.prompt,
    selectedSkill?.context_requirements,
    selectedSkill?.linked_targets,
    selectedSkill?.version,
    selectedSkill?.manifest?.version
  ]);

  function queueSkillAction(skillId: string, action: "run" | "delete-disable" | "restore") {
    setPendingSkillAction({ skillId, action });
    void controller.selectSkill(skillId, { activateTab: false });
  }

  function submitPathImport() {
    const path = pathInput.trim();
    if (path) {
      void controller.importSkillFromPath(path);
      return;
    }
    skillFileInputRef.current?.click();
  }

  function submitSkillDraft(kind: "instruction" | "current_document") {
    void controller.draftSkillPreview({
      kind,
      instruction: draftInstructionInput,
      targetName: draftNameInput
    });
  }

  function previewSkillPatch() {
    if (!selectedSkill) {
      return;
    }
    void controller.previewSelectedSkillPatch({
      description: editDescriptionInput,
      prompt: editPromptInput,
      context_requirements: parseListDraft(editContextInput),
      linked_targets: parseListDraft(editTargetsInput),
      change_reason: editReasonInput.trim() || "workbench edit"
    });
  }

  async function saveSkillDescription(skill: SkillDefinition) {
    if (skill.builtin) {
      return;
    }
    const draft = skillDescriptionDrafts[skill.id] ?? skill.description;
    if (draft.trim() === String(skill.description || "").trim()) {
      return;
    }
    const updated = await controller.updateSkillDescription(skill.id, draft);
    if (updated) {
      setSkillDescriptionDrafts((current) => {
        const next = { ...current };
        delete next[skill.id];
        return next;
      });
    }
  }

  return (
    <section className="xw-feature-page">
      <div className="xw-skill-import-row">
        <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="本地技能路径" />
        <button className="xw-secondary-button compact" onClick={submitPathImport} disabled={controller.operationsBusy}>导入</button>
        <input
          ref={skillFileInputRef}
          type="file"
          className="xw-hidden-file"
          accept=".md,.markdown,.txt,.zip"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0] || null;
            event.currentTarget.value = "";
            if (file) {
              void controller.uploadSkillFile(file);
            }
          }}
        />
        <input value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="GitHub 或网页 URL" />
        <button className="xw-secondary-button compact" onClick={() => void controller.importSkillFromUrl(urlInput)} disabled={controller.operationsBusy || !urlInput.trim()}>URL 草稿</button>
        <button className="xw-secondary-button compact" onClick={controller.openSkillFolder} disabled={controller.operationsBusy}>技能目录</button>
        <button className="xw-secondary-button compact" onClick={() => void refreshSkills()} disabled={controller.operationsBusy}>刷新技能</button>
      </div>
      <div className="xw-skill-draft-panel">
        <div className="xw-skill-draft-form">
          <input value={draftNameInput} onChange={(event) => setDraftNameInput(event.target.value)} placeholder="技能名（可选）" />
          <textarea
            value={draftInstructionInput}
            onChange={(event) => setDraftInstructionInput(event.target.value)}
            placeholder="把这套提示词做成一个技能"
          />
          <div className="xw-skill-draft-actions">
            <button
              className="xw-primary-button compact"
              onClick={() => submitSkillDraft("instruction")}
              disabled={controller.operationsBusy || (!draftInstructionInput.trim() && !draftNameInput.trim())}
            >
              生成草稿
            </button>
            <button
              className="xw-secondary-button compact"
              onClick={() => submitSkillDraft("current_document")}
              disabled={controller.operationsBusy}
            >
              当前文档草稿
            </button>
          </div>
        </div>
        {pendingDraft && (
          <article className="xw-skill-draft-preview">
            <div className="xw-skill-draft-heading">
              <strong>{pendingDraft.skill.name}</strong>
              <small>{pendingDraft.skill.id} · {pendingDraft.skill.handler_type} · {pendingDraft.source_name || pendingDraft.source_url || "draft"}</small>
            </div>
            <p>{pendingDraft.skill.description}</p>
            {pendingDraft.warnings.length > 0 && <em>{pendingDraft.warnings.join("；")}</em>}
            {pendingDraftPrompt && <pre>{pendingDraftPrompt.slice(0, 900)}{pendingDraftPrompt.length > 900 ? "\n..." : ""}</pre>}
            <div className="xw-skill-draft-actions">
              <button className="xw-primary-button compact" onClick={() => void controller.importPendingSkillDraft()} disabled={controller.operationsBusy}>导入草稿</button>
              <button className="xw-secondary-button compact" onClick={controller.discardPendingSkillDraft} disabled={controller.operationsBusy}>丢弃</button>
            </div>
          </article>
        )}
      </div>
      {selectedSkill && (
        <section className="xw-skill-edit-panel">
          <div className="xw-skill-edit-head">
            <div>
              <strong>{selectedSkill.name}</strong>
              <span>{selectedSkill.builtin ? "默认技能需复制后编辑" : `自定义技能 · v${selectedSkill.version || selectedSkill.manifest?.version || "1.0.0"}`}</span>
            </div>
            <button
              className="xw-secondary-button compact"
              onClick={() => void controller.loadSkillVersions(selectedSkill.id)}
              disabled={controller.operationsBusy || Boolean(selectedSkill.builtin)}
            >
              版本历史
            </button>
          </div>
          {selectedSkill.builtin ? (
            <div className="xw-skill-clone-row">
              <input value={cloneNameInput} onChange={(event) => setCloneNameInput(event.target.value)} placeholder="复制后的技能名" />
              <button
                className="xw-primary-button compact"
                onClick={() => void controller.cloneSelectedSkill({ targetName: cloneNameInput })}
                disabled={controller.operationsBusy}
              >
                复制为自定义技能
              </button>
            </div>
          ) : (
            <div className="xw-skill-edit-grid">
              <label>
                <span>简介</span>
                <input value={editDescriptionInput} onChange={(event) => setEditDescriptionInput(event.target.value)} />
              </label>
              <label>
                <span>上下文要求</span>
                <input value={editContextInput} onChange={(event) => setEditContextInput(event.target.value)} placeholder="project_state, conversation" />
              </label>
              <label>
                <span>关联目标</span>
                <input value={editTargetsInput} onChange={(event) => setEditTargetsInput(event.target.value)} placeholder="可空，逗号分隔" />
              </label>
              <label>
                <span>修改原因</span>
                <input value={editReasonInput} onChange={(event) => setEditReasonInput(event.target.value)} placeholder="例如：强化输出格式" />
              </label>
              <label className="xw-skill-prompt-editor">
                <span>Prompt</span>
                <textarea value={editPromptInput} onChange={(event) => setEditPromptInput(event.target.value)} />
              </label>
              <div className="xw-skill-edit-actions">
                <button className="xw-primary-button compact" onClick={previewSkillPatch} disabled={controller.operationsBusy || !editChanged}>
                  预览修改
                </button>
                <button className="xw-secondary-button compact" onClick={controller.discardPendingSkillPatch} disabled={controller.operationsBusy || !pendingPatch}>
                  丢弃预览
                </button>
              </div>
            </div>
          )}
          {pendingPatch && (
            <div className="xw-skill-diff-preview">
              <strong>{pendingPatch.response.diff ? "修改差异" : "没有差异"}</strong>
              {pendingPatch.response.diff ? <pre>{pendingPatch.response.diff}</pre> : <p>当前草稿与已保存技能一致。</p>}
              {pendingPatch.response.warnings.length > 0 && <em>{pendingPatch.response.warnings.join("；")}</em>}
              <div className="xw-skill-edit-actions">
                <button className="xw-primary-button compact" onClick={() => void controller.commitPendingSkillPatch()} disabled={controller.operationsBusy || !pendingPatch.response.diff}>
                  确认保存
                </button>
                <button className="xw-secondary-button compact" onClick={controller.discardPendingSkillPatch} disabled={controller.operationsBusy}>
                  取消
                </button>
              </div>
            </div>
          )}
          {controller.selectedSkillVersions.length > 0 && (
            <div className="xw-skill-version-list">
              {controller.selectedSkillVersions.slice(0, 8).map((version) => (
                <article key={version.version_id}>
                  <div>
                    <strong>{version.snapshot.name}</strong>
                    <span>{version.created_at} · {version.change_reason || "patch"}</span>
                  </div>
                  <button
                    className="xw-secondary-button compact"
                    onClick={() => void controller.rollbackSelectedSkill(version.version_id)}
                    disabled={controller.operationsBusy || Boolean(selectedSkill.builtin)}
                  >
                    回滚
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="xw-skill-grid">
        {pageSkills.map((skill) => {
          const selected = skill.id === controller.selectedSkillId;
          const restoreBuiltin = Boolean(skill.builtin && skill.disabled);
          const secondLabel = restoreBuiltin ? "恢复" : skill.builtin ? "禁用" : "删除技能";
          const descriptionDraft = skillDescriptionDrafts[skill.id] ?? skill.description;
          return (
            <article
              key={skill.id}
              className={`xw-skill-card ${selected ? "selected" : ""} ${skill.disabled ? "muted" : ""}`}
              onClick={() => controller.selectSkill(skill.id)}
            >
              <div className="xw-skill-main">
                <strong>{skill.disabled ? "已禁用 / " : ""}{skill.name}</strong>
                {skill.builtin ? (
                  <span>{skill.description}</span>
                ) : (
                  <input
                    className="xw-skill-description-input"
                    value={descriptionDraft}
                    onChange={(event) => setSkillDescriptionDrafts((current) => ({ ...current, [skill.id]: event.target.value }))}
                    onBlur={() => void saveSkillDescription(skill)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="输入技能简介，AI 调用时会参考"
                    disabled={controller.operationsBusy}
                  />
                )}
                <small>{skill.builtin ? "默认技能" : "导入技能"} · v{skill.version || skill.manifest?.version || "1.0.0"} · {skill.input_mode} · {skill.handler_type} · {skill.id}</small>
                {skill.disabled && <em>AI 自动判断时会跳过它，尝试调用相近可用技能。</em>}
              </div>
              <div className="xw-skill-actions">
                <button
                  className="xw-primary-button compact"
                  onClick={(event) => {
                    event.stopPropagation();
                    queueSkillAction(skill.id, "run");
                  }}
                  disabled={controller.operationsBusy || Boolean(skill.disabled)}
                >
                  运行
                </button>
                <button
                  className={restoreBuiltin ? "xw-secondary-button compact" : "xw-danger-button compact"}
                  onClick={(event) => {
                    event.stopPropagation();
                    queueSkillAction(skill.id, restoreBuiltin ? "restore" : "delete-disable");
                  }}
                  disabled={controller.operationsBusy}
                >
                  {secondLabel}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!pageSkills.length && (
        <div className="xw-empty-action">
          <p className="xw-feature-empty">{skillRefreshError ? `技能目录读取失败：${skillRefreshError}` : "暂无技能，正在尝试重新读取技能目录。"}</p>
          <button className="xw-secondary-button compact" onClick={() => void refreshSkills()} disabled={controller.operationsBusy}>重新读取技能</button>
        </div>
      )}
      {pageCount > 1 && (
        <div className="xw-skill-pager">
          <button className="xw-secondary-button compact" onClick={() => setSkillPage((page) => Math.max(0, page - 1))} disabled={currentPage <= 0}>
            上一页
          </button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button className="xw-secondary-button compact" onClick={() => setSkillPage((page) => Math.min(pageCount - 1, page + 1))} disabled={currentPage >= pageCount - 1}>
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
