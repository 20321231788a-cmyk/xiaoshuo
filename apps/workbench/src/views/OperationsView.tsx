import { Bot, Clock3, Copy, Download, FilePlus2, FileText, FolderOpen, Link, MessageSquarePlus, RotateCcw, Sparkles, Square, Trash2, Upload, Workflow } from "lucide-react";
import type { ConversationDetail, JobInfo, SkillDefinition, SkillRunResponse, StyleDistillationProfile } from "@xiaoshuo/shared";
import { useState } from "react";
import { Panel } from "../components/Panel.js";
import { RichText } from "../components/RichText.js";
import type { DashboardSnapshot } from "../lib/dashboard.js";
import { previewText } from "../lib/richText.js";
import {
  describeGeneratedSaveAction,
  describeGeneratedSaveReason,
  describeGeneratedWriteIntent,
  describeJobKind,
  describePendingGeneratedTarget,
  extractJobResultFiles,
  pendingGeneratedTargetPaths,
  sanitizeWebSearchSources,
  skillRequiresActiveDocument,
  summarizeJobResult
} from "../lib/workflow.js";
import type { JobResultFile, PendingGeneratedSave } from "../lib/workflow.js";

export function OperationsView({
  snapshot,
  selectedSkillId,
  selectedSkillDetail,
  selectedJobId,
  selectedJobDetail,
  busy,
  message,
  activeConversation,
  activeDocumentPath,
  latestSkillResult,
  pendingGeneratedSave,
  styleDistillationProfile,
  onSelectSkill,
  onSelectJob,
  onOpenJobResultFile,
  onContinueJobResultInConversation,
  onRunJob,
  onCancelSelectedJob,
  onInvokeSelectedSkill,
  onImportSkillFromPath,
  onUploadSkillFile,
  onImportSkillFromUrl,
  onOpenSkillFolder,
  onDeleteOrDisableSelectedSkill,
  onRestoreSelectedBuiltinSkill,
  onRunNuwaStyleDistillation,
  onToggleNuwaStyleDistillation,
  onDeleteNuwaStyleDistillation,
  onSavePendingGenerated,
  onSavePendingGeneratedAsDraft,
  onCopyPendingGeneratedContent,
  onDiscardPendingGenerated
}: {
  snapshot: DashboardSnapshot;
  selectedSkillId: string;
  selectedSkillDetail: SkillDefinition | null;
  selectedJobId: string;
  selectedJobDetail: JobInfo | null;
  busy: boolean;
  message: string;
  activeConversation: ConversationDetail | null;
  activeDocumentPath: string;
  latestSkillResult: SkillRunResponse | null;
  pendingGeneratedSave: PendingGeneratedSave | null;
  styleDistillationProfile: StyleDistillationProfile | null;
  onSelectSkill: (skillId: string) => void;
  onSelectJob: (jobId: string) => void;
  onOpenJobResultFile: (path: string) => void;
  onContinueJobResultInConversation: (path: string) => void;
  onRunJob: (kind: string, payload: Record<string, unknown>) => void;
  onCancelSelectedJob: () => void;
  onInvokeSelectedSkill: () => void;
  onImportSkillFromPath: (path: string) => void;
  onUploadSkillFile: (file: File) => void;
  onImportSkillFromUrl: (url: string) => void;
  onOpenSkillFolder: () => void;
  onDeleteOrDisableSelectedSkill: () => void;
  onRestoreSelectedBuiltinSkill: () => void;
  onRunNuwaStyleDistillation: (options?: { replace?: boolean }) => void;
  onToggleNuwaStyleDistillation: (enabled?: boolean) => void;
  onDeleteNuwaStyleDistillation: () => void;
  onSavePendingGenerated: (mode: "replace" | "append") => void;
  onSavePendingGeneratedAsDraft: () => void;
  onCopyPendingGeneratedContent: () => void;
  onDiscardPendingGenerated: () => void;
}) {
  const pendingSkillSave = pendingGeneratedSave?.source === "skill" ? pendingGeneratedSave : null;
  const skillPreview = pendingSkillSave?.content || latestSkillResult?.result || latestSkillResult?.content || "";
  const pendingTargetPaths = pendingGeneratedSave ? pendingGeneratedTargetPaths(pendingGeneratedSave) : [];
  const selectedSkillNeedsDocument = skillRequiresActiveDocument(selectedSkillDetail);
  const canInvokeSelectedSkill = Boolean(selectedSkillDetail) && (!selectedSkillNeedsDocument || Boolean(activeDocumentPath));
  const selectedJobHasResult = Boolean(selectedJobDetail && "result" in selectedJobDetail && selectedJobDetail.result !== undefined);
  const selectedJobResultFiles = selectedJobHasResult ? extractJobResultFiles(selectedJobDetail?.result) : [];
  const selectedJobResultSummary = selectedJobHasResult ? summarizeJobResult(selectedJobDetail?.result, selectedJobResultFiles) : null;
  const skillWebSearchSources = sanitizeWebSearchSources(latestSkillResult?.data?.web_search_sources);
  const [copiedPath, setCopiedPath] = useState("");
  const [confirmDiscardGenerated, setConfirmDiscardGenerated] = useState(false);
  const [confirmReplaceDistillation, setConfirmReplaceDistillation] = useState(false);
  const [confirmDeleteDistillation, setConfirmDeleteDistillation] = useState(false);
  const [confirmSkillDelete, setConfirmSkillDelete] = useState(false);
  const [skillPathInput, setSkillPathInput] = useState("");
  const [skillUrlInput, setSkillUrlInput] = useState("");
  const isDisassembleSurface = selectedSkillId === "disassemble_book" || selectedSkillId === "continue_disassemble" || selectedSkillId === "nuwa_style_distill";

  async function copyJobResultPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
    } catch {
      setCopiedPath("");
    }
  }

  function exportSkillFile(skill: SkillDefinition) {
    const text = formatSkillMarkdown(skill);
    downloadTextFile(`${safeFilename(skill.id || skill.name || "skill")}.SKILL.md`, text, "text/markdown;charset=utf-8");
  }

  function exportAllSkills() {
    const payload = {
      exported_at: new Date().toISOString(),
      skills: snapshot.skills
    };
    downloadTextFile("arcwriter-skills.json", `${JSON.stringify(payload, null, 2)}\n`, "application/json;charset=utf-8");
  }

  return (
    <div className="double-grid">
      <Panel eyebrow="Skills" title="技能目录" aside={<Bot size={17} />}>
        <div className="skill-transfer-panel">
          <div className="skill-transfer-row">
            <input
              value={skillPathInput}
              onChange={(event) => setSkillPathInput(event.target.value)}
              placeholder="本地技能目录或 SKILL.md 路径"
              disabled={busy}
            />
            <button className="ghost-button" onClick={() => onImportSkillFromPath(skillPathInput)} disabled={busy || !skillPathInput.trim()}>
              <FolderOpen size={15} />
              <span>导入本地</span>
            </button>
          </div>
          <div className="skill-transfer-row">
            <input
              value={skillUrlInput}
              onChange={(event) => setSkillUrlInput(event.target.value)}
              placeholder="https://.../SKILL.md 或技能说明页面"
              disabled={busy}
            />
            <button className="ghost-button" onClick={() => onImportSkillFromUrl(skillUrlInput)} disabled={busy || !skillUrlInput.trim()}>
              <Link size={15} />
              <span>链接导入</span>
            </button>
          </div>
          <div className="action-pair skill-transfer-actions">
            <label className="ghost-button skill-upload-button">
              <Upload size={15} />
              <span>上传 Skill</span>
              <input
                type="file"
                accept=".md,.markdown,.txt,.zip"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) {
                    onUploadSkillFile(file);
                  }
                  event.currentTarget.value = "";
                }}
                disabled={busy}
              />
            </label>
            <button className="ghost-button" onClick={onOpenSkillFolder} disabled={busy}>
              <FolderOpen size={15} />
              <span>打开目录</span>
            </button>
            <button className="ghost-button" onClick={() => selectedSkillDetail && exportSkillFile(selectedSkillDetail)} disabled={!selectedSkillDetail}>
              <Download size={15} />
              <span>导出当前</span>
            </button>
            <button className="ghost-button" onClick={exportAllSkills} disabled={!snapshot.skills.length}>
              <Download size={15} />
              <span>导出全部</span>
            </button>
          </div>
        </div>
        <div className="list-stack">
          {snapshot.skills.map((skill) => (
            <button
              key={skill.id}
              className={`conversation-card ${skill.id === selectedSkillId ? "active" : ""} ${skill.disabled ? "disabled-skill" : ""}`}
              onClick={() => onSelectSkill(skill.id)}
            >
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
              <span>
                {skill.disabled ? "已禁用 / " : ""}
                {skill.builtin ? "默认" : "导入"} / {skill.handler_type} / {skill.input_mode}
              </span>
            </button>
          ))}
        </div>
        {selectedSkillDetail && (
          <div className="detail-stack">
            <div className="status-banner">
              <strong>{selectedSkillDetail.name}</strong>
              <p>{selectedSkillDetail.description}</p>
            </div>
            <div className="skill-context">
              <span>当前文档</span>
              <strong>{activeDocumentPath || "未打开文档"}</strong>
              <span>当前会话</span>
              <strong>{activeConversation?.title || activeConversation?.id || "未选中会话"}</strong>
            </div>
            <div className="action-pair">
              <button className="refresh-button" onClick={onInvokeSelectedSkill} disabled={busy || !canInvokeSelectedSkill || Boolean(selectedSkillDetail.disabled)}>
                <Sparkles size={15} />
                <span>执行当前技能</span>
              </button>
              {selectedSkillDetail.disabled && selectedSkillDetail.builtin ? (
                <button className="ghost-button" onClick={onRestoreSelectedBuiltinSkill} disabled={busy}>
                  <RotateCcw size={15} />
                  <span>恢复默认</span>
                </button>
              ) : (
                <button
                  className={confirmSkillDelete ? "danger-button" : "ghost-button"}
                  onClick={() => {
                    if (!confirmSkillDelete) {
                      setConfirmSkillDelete(true);
                      return;
                    }
                    setConfirmSkillDelete(false);
                    onDeleteOrDisableSelectedSkill();
                  }}
                  disabled={busy}
                >
                  <Trash2 size={15} />
                  <span>{confirmSkillDelete ? (selectedSkillDetail.builtin ? "确认禁用" : "确认删除") : (selectedSkillDetail.builtin ? "禁用默认" : "删除技能")}</span>
                </button>
              )}
              {isDisassembleSurface && (
                <button
                  className={confirmReplaceDistillation ? "refresh-button" : "ghost-button"}
                  onClick={() => {
                    if (styleDistillationProfile && !confirmReplaceDistillation) {
                      setConfirmReplaceDistillation(true);
                      setConfirmDeleteDistillation(false);
                      return;
                    }
                    onRunNuwaStyleDistillation({ replace: Boolean(styleDistillationProfile) });
                    setConfirmReplaceDistillation(false);
                  }}
                  disabled={busy}
                  title={styleDistillationProfile ? "当前项目已有蒸馏书籍，再次点击确认替换" : "蒸馏当前拆书原文或拆书产物"}
                >
                  <Sparkles size={15} />
                  <span>{confirmReplaceDistillation ? "确认替换蒸馏" : "蒸馏"}</span>
                </button>
              )}
            </div>
            {selectedSkillDetail.disabled && <p className="preview-warning">该默认技能已禁用。AI 自动判断时会跳过它，尝试调用相近的可用技能。</p>}
            {confirmSkillDelete && (
              <p className="preview-warning">
                {selectedSkillDetail.builtin ? "默认技能不会被删除，只会在当前项目中禁用；之后可点击恢复默认。" : "导入技能会从当前项目技能目录中删除。"}
              </p>
            )}
            {isDisassembleSurface && (
              <div className="nuwa-distill-row">
                {styleDistillationProfile ? (
                  <>
                    <button
                      className={`nuwa-distill-chip ${styleDistillationProfile.enabled ? "active" : ""}`}
                      onClick={() => {
                        setConfirmReplaceDistillation(false);
                        setConfirmDeleteDistillation(false);
                        onToggleNuwaStyleDistillation(!styleDistillationProfile.enabled);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setConfirmDeleteDistillation(true);
                        setConfirmReplaceDistillation(false);
                      }}
                      title="左键切换使用状态，右键删除"
                      disabled={busy}
                    >
                      <span>{styleDistillationProfile.enabled ? "使用中" : "未使用"}</span>
                      <strong>已蒸馏：{styleDistillationProfile.book_title}</strong>
                    </button>
                    {confirmDeleteDistillation && (
                      <button
                        className="danger-button"
                        onClick={() => {
                          setConfirmDeleteDistillation(false);
                          onDeleteNuwaStyleDistillation();
                        }}
                        disabled={busy}
                      >
                        确认删除蒸馏书籍
                      </button>
                    )}
                  </>
                ) : (
                  <p className="empty-copy">当前项目还没有蒸馏书籍。蒸馏后可在这里选择是否用于生成。</p>
                )}
              </div>
            )}
            {confirmReplaceDistillation && <p className="preview-warning">一个项目只能蒸馏一本书。再次点击“确认替换蒸馏”会覆盖当前档案。</p>}
            {confirmDeleteDistillation && <p className="preview-warning">右键删除只影响蒸馏档案，不会删除普通风格库或拆书产物。</p>}
            {selectedSkillNeedsDocument && !activeDocumentPath && (
              <p className="preview-warning">这个技能需要当前文档内容。请先到编辑页打开正文、章纲或设定文件，再执行技能。</p>
            )}
            <pre className="prompt-preview">{selectedSkillDetail.prompt || "这个技能没有公开 prompt 文本。"}</pre>
            {pendingGeneratedSave && pendingGeneratedSave.source === "skill" && (
              <div className="pending-save-panel">
                <div>
                  <strong>{describePendingGeneratedTarget(pendingGeneratedSave)}</strong>
                  <p>
                    技能结果已经生成完毕，默认方式是{pendingGeneratedSave.defaultMode === "append" ? "追加" : "覆盖"}，
                    下一步可以决定如何写入目标文件。
                  </p>
                  <p>{describeGeneratedWriteIntent(pendingGeneratedSave)}</p>
                  {describeGeneratedSaveReason(pendingGeneratedSave) && <p>{describeGeneratedSaveReason(pendingGeneratedSave)}</p>}
                  {pendingTargetPaths.length > 1 && (
                    <ul className="pending-target-list">
                      {pendingTargetPaths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  )}
                  {pendingGeneratedSave.content.trim() ? (
                    <details className="generated-preview" open>
                      <summary>预览待写入内容</summary>
                      <RichText text={previewText(pendingGeneratedSave.content)} />
                    </details>
                  ) : (
                    <p className="preview-warning">预览未加载，当前界面无法确认完整内容；建议重新生成或确认缓存后再保存。</p>
                  )}
                </div>
                <div className="action-pair">
                  <button className="ghost-button" onClick={() => onSavePendingGenerated("append")} disabled={busy}>
                    <span>{describeGeneratedSaveAction("append", pendingGeneratedSave.defaultMode, pendingTargetPaths.length, pendingGeneratedSave.skillId)}</span>
                  </button>
                  <button className="refresh-button" onClick={() => onSavePendingGenerated("replace")} disabled={busy}>
                    <span>{describeGeneratedSaveAction("replace", pendingGeneratedSave.defaultMode, pendingTargetPaths.length, pendingGeneratedSave.skillId)}</span>
                  </button>
                  <button className="ghost-button" onClick={onSavePendingGeneratedAsDraft} disabled={busy}>
                    <FilePlus2 size={15} />
                    <span>另存草稿</span>
                  </button>
                  <button className="ghost-button" onClick={onCopyPendingGeneratedContent} disabled={busy}>
                    <Copy size={15} />
                    <span>复制全文</span>
                  </button>
                  <button
                    className={confirmDiscardGenerated ? "refresh-button" : "ghost-button"}
                    onClick={() => {
                      if (!confirmDiscardGenerated) {
                        setConfirmDiscardGenerated(true);
                        return;
                      }
                      setConfirmDiscardGenerated(false);
                      onDiscardPendingGenerated();
                    }}
                    disabled={busy}
                  >
                    <span>{confirmDiscardGenerated ? "确认丢弃" : "丢弃生成结果"}</span>
                  </button>
                </div>
                {confirmDiscardGenerated && <p className="preview-warning">再次点击会删除这次生成结果；可以先复制全文或另存草稿。</p>}
              </div>
            )}
            {latestSkillResult && (
              <div className="detail-stack">
                <p className="section-label">{pendingSkillSave ? "将要写入的技能结果" : "最近一次技能结果"}</p>
                <div className="job-stats">
                  <article>
                    <span>状态</span>
                    <strong>{latestSkillResult.status}</strong>
                  </article>
                  <article>
                    <span>写入路径</span>
                    <strong>{latestSkillResult.saved_path || "未直接写入"}</strong>
                  </article>
                  <article>
                    <span>缓存体量</span>
                    <strong>{pendingGeneratedSave?.cacheChars || skillPreview.length || 0} 字</strong>
                  </article>
                </div>
                {skillWebSearchSources.length > 0 && (
                  <div className="web-source-list">
                    <span>联网来源</span>
                    {skillWebSearchSources.map((source) => (
                      <a key={source.url} href={source.url} target="_blank" rel="noreferrer" title={source.title}>
                        {source.title}
                      </a>
                    ))}
                  </div>
                )}
                {skillPreview ? (
                  <RichText text={previewText(skillPreview, 2400)} className="result-preview rich-result-preview" />
                ) : (
                  <pre className="prompt-preview result-preview">{formatSkillResultData(latestSkillResult.data)}</pre>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel eyebrow="Jobs" title="任务与维护操作" aside={<Workflow size={17} />}>
        <div className="action-pair">
          <button className="ghost-button" onClick={() => onRunJob("scan_project", {})} disabled={busy}>
            <RotateCcw size={15} />
            <span>扫描项目文件</span>
          </button>
          <button className="ghost-button" onClick={() => onRunJob("build_continuity_context", {})} disabled={busy}>
            <Clock3 size={15} />
            <span>构建连续上下文</span>
          </button>
        </div>

        <div className="status-banner compact-banner">
          <strong>{message || "这里会逐步承接旧界面里的技能触发和任务调度逻辑。"}</strong>
        </div>

        <div className="jobs-shell">
          <div className="conversation-list">
            {snapshot.jobs.map((job) => (
              <button
                key={job.id}
                className={`conversation-card ${job.id === selectedJobId ? "active" : ""}`}
                onClick={() => onSelectJob(job.id)}
              >
                <strong>{describeJobKind(job.kind)}</strong>
                <p>{job.status === "failed" && job.error ? job.error : job.message || "无额外说明"}</p>
                <span>{job.status} / {Math.round(job.progress * 100)}%</span>
              </button>
            ))}
            {!snapshot.jobs.length && <p className="empty-copy">当前没有任务。上面这些维护按钮已经可以直接创建新任务。</p>}
          </div>

          <div className="detail-stack">
            {selectedJobDetail ? (
              <>
                <div className="status-banner">
                  <strong>{describeJobKind(selectedJobDetail.kind)}</strong>
                  <p>{selectedJobDetail.status === "failed" && selectedJobDetail.error ? selectedJobDetail.error : selectedJobDetail.message}</p>
                </div>
                <div className="job-stats">
                  <article>
                    <span>状态</span>
                    <strong>{selectedJobDetail.status}</strong>
                  </article>
                  <article>
                    <span>进度</span>
                    <strong>{Math.round(selectedJobDetail.progress * 100)}%</strong>
                  </article>
                </div>
                {selectedJobResultSummary && (
                  <div className="job-result-summary">
                    <article>
                      <span>{selectedJobResultSummary.typeLabel}</span>
                      <strong>{selectedJobResultSummary.primary}</strong>
                      <p>{selectedJobResultSummary.detail}</p>
                    </article>
                  </div>
                )}
                {selectedJobResultFiles.length > 0 && (
                  <div className="job-result-file-list">
                    <p className="section-label">结果文件</p>
                    {selectedJobResultFiles.map((file) => (
                      <JobResultFileCard
                        key={`${file.source}-${file.path}`}
                        file={file}
                        copied={copiedPath === file.path}
                        busy={busy}
                        onOpen={onOpenJobResultFile}
                        onContinue={onContinueJobResultInConversation}
                        onCopy={copyJobResultPath}
                      />
                    ))}
                  </div>
                )}
                {selectedJobHasResult && (
                  <details className="generated-preview">
                    <summary>{selectedJobResultFiles.length ? "查看原始任务结果" : "原始任务结果"}</summary>
                    <pre className="prompt-preview result-preview">{formatRawJobResult(selectedJobDetail.result)}</pre>
                  </details>
                )}
                {(selectedJobDetail.status === "queued" || selectedJobDetail.status === "running") && (
                  <button className="refresh-button" onClick={onCancelSelectedJob} disabled={busy}>
                    <Square size={14} />
                    <span>取消任务</span>
                  </button>
                )}
              </>
            ) : (
              <p className="empty-copy">点一条任务后，这里会显示任务详情和取消操作。</p>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function JobResultFileCard({
  file,
  copied,
  busy,
  onOpen,
  onContinue,
  onCopy
}: {
  file: JobResultFile;
  copied: boolean;
  busy: boolean;
  onOpen: (path: string) => void;
  onContinue: (path: string) => void;
  onCopy: (path: string) => void;
}) {
  return (
    <article className="job-result-file-card">
      <div className="job-result-file-head">
        <div>
          <strong>{file.path}</strong>
          <p>{describeJobResultFileSource(file.source)}</p>
        </div>
        <span className={`status-chip ${file.source === "archived" ? "idle" : "ready"}`}>{describeJobResultFileSource(file.source)}</span>
      </div>
      <div className="action-pair">
        <button className="refresh-button" onClick={() => onOpen(file.path)} disabled={busy}>
          <FileText size={15} />
          <span>打开文件</span>
        </button>
        <button className="ghost-button" onClick={() => onContinue(file.path)} disabled={busy}>
          <MessageSquarePlus size={15} />
          <span>继续处理</span>
        </button>
        <button className="ghost-button" onClick={() => onCopy(file.path)} disabled={busy}>
          <Copy size={15} />
          <span>{copied ? "已复制" : "复制路径"}</span>
        </button>
      </div>
    </article>
  );
}

function describeJobResultFileSource(source: JobResultFile["source"]): string {
  const labels: Record<JobResultFile["source"], string> = {
    saved: "已写入",
    archived: "已归档",
    target: "目标文件",
    output: "输出文件",
    file: "相关文件"
  };
  return labels[source];
}

export function formatRawJobResult(value: unknown): string {
  const limit = 30000;
  const formatted = JSON.stringify(value, null, 2);
  const text = formatted === undefined ? String(value) : formatted;
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n... 已截断 ${text.length - limit} 字符。完整内容请优先通过上方结果文件查看。`;
}

export function formatSkillResultData(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "这次技能运行没有返回额外文本。";
  }
  const sanitized = { ...(value as Record<string, unknown>) };
  delete sanitized.web_search_sources;
  if (!Object.keys(sanitized).length) {
    return "这次技能运行没有返回额外文本。";
  }
  return JSON.stringify(sanitized, null, 2) || "这次技能运行没有返回额外文本。";
}

function formatSkillMarkdown(skill: SkillDefinition): string {
  const metadata = [
    "---",
    `name: ${yamlString(skill.name || skill.id || "skill")}`,
    `description: ${yamlString(skill.description || "导出的 ArcWriter 技能")}`,
    `id: ${yamlString(skill.id || "")}`,
    `input_mode: ${yamlString(skill.input_mode || "text")}`,
    `handler_type: ${yamlString(skill.handler_type || "prompt")}`,
    `writable: ${skill.writable ? "true" : "false"}`,
    `context_requirements: [${(skill.context_requirements || []).map(yamlString).join(", ")}]`,
    `linked_targets: [${(skill.linked_targets || []).map(yamlString).join(", ")}]`,
    `imported_from: ${yamlString(skill.imported_from || "arcwriter-export")}`,
    "---"
  ].join("\n");
  return `${metadata}\n\n${String(skill.prompt || "").trim()}\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(String(value || ""));
}

function safeFilename(value: string): string {
  return String(value || "skill")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "skill";
}

function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
