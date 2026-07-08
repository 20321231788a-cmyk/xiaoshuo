import {
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Cloud,
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { DisassemblyBookSummary, WorkbenchController } from "../../hooks/useWorkbenchController.js";
import { ProjectTreeNode } from "./ProjectTreeNode.js";

export type DisassemblyUiState = {
  selectedBookId: string;
  fusionBookIds: string[];
  onSelectBook: (bookId: string) => void;
  onToggleFusionBook: (bookId: string) => void;
};

function disassemblyBookPrimaryPath(book: DisassemblyBookSummary | null): string {
  if (!book) {
    return "";
  }
  return book.paths.source || book.paths.detail_outline || book.paths.reverse_outline || book.paths.lore || "";
}

function disassemblyBookReadyForFusion(book: DisassemblyBookSummary | null): boolean {
  if (!book || book.legacy) {
    return false;
  }
  return Boolean(book.paths.lore || book.paths.reverse_outline || book.paths.detail_outline);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function formatDateShort(value: string): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function NovelFolderNode({
  title,
  books,
  controller,
  disassemblyUi,
  onOpenDocument,
  selectedBookId
}: {
  title: string;
  books: DisassemblyBookSummary[];
  controller: WorkbenchController;
  disassemblyUi: DisassemblyUiState;
  onOpenDocument: (path: string) => void | Promise<void>;
  selectedBookId: string | null;
}) {
  const rawSources = books.filter((book) => !disassemblyBookReadyForFusion(book));
  const readyForFusions = books.filter(disassemblyBookReadyForFusion);

  const hasSelected = books.some((book) => book.id === selectedBookId);
  const [expanded, setExpanded] = useState<boolean>(hasSelected || true);
  const [rawExpanded, setRawExpanded] = useState<boolean>(true);
  const [fusionExpanded, setFusionExpanded] = useState<boolean>(true);

  function runTreeDistillation(book: DisassemblyBookSummary) {
    if (controller.styleDistillationProfile && !window.confirm("当前项目已有蒸馏文风档案，确认替换为当前原文吗？")) {
      return;
    }
    void controller.runNuwaStyleDistillation({
      replace: Boolean(controller.styleDistillationProfile),
      sourceBookId: book.id,
      sourcePath: disassemblyBookPrimaryPath(book),
      bookTitle: book.title,
      text: ""
    });
  }

  return (
    <div className="xw-tree-node" style={{ marginBottom: "6px" }}>
      <button
        className="xw-tree-row dir"
        onClick={() => setExpanded(!expanded)}
        type="button"
        style={{ cursor: "pointer" }}
      >
        <Folder size={15} />
        <span style={{ fontWeight: "bold" }}>{title}</span>
        <em>{expanded ? "-" : "+"}</em>
      </button>

      {expanded && (
        <div className="xw-tree-children" style={{ gap: "4px" }}>
          {/* 原书 (原书文件夹) */}
          {rawSources.length > 0 && (
            <div className="xw-tree-node">
              <button
                className="xw-tree-row dir"
                onClick={() => setRawExpanded(!rawExpanded)}
                type="button"
                style={{
                  minHeight: "30px",
                  height: "30px",
                  fontSize: "12px",
                  background: "transparent",
                  border: "none",
                  padding: "0 4px",
                  gap: "6px",
                  cursor: "pointer"
                }}
              >
                <Folder size={13} style={{ color: "var(--xw-muted)" }} />
                <span style={{ color: "var(--xw-text)", fontSize: "12px" }}>原书</span>
                <em>{rawExpanded ? "-" : "+"}</em>
              </button>
              {rawExpanded && (
                <div className="xw-tree-children" style={{ gap: "4px", paddingLeft: "12px" }}>
                  {rawSources.map((book) => {
                    const active = book.id === selectedBookId;
                    return (
                      <div
                        key={book.id}
                        className={`xw-disassembly-tree-item ${active ? "active" : ""}`}
                        style={{
                          padding: "6px 8px",
                          borderRadius: "8px",
                          marginBottom: "2px"
                        }}
                      >
                        <button
                          className="xw-disassembly-tree-main"
                          onClick={() => disassemblyUi.onSelectBook(book.id)}
                          type="button"
                          style={{ width: "100%", padding: 0 }}
                        >
                          <div style={{ display: "grid", textAlign: "left" }}>
                            <strong style={{ fontSize: "12px" }}>{book.source_summary || "原文"}</strong>
                            <small style={{ fontSize: "10px", color: active ? "var(--xw-primary)" : "var(--xw-muted)", marginTop: "2px" }}>
                              {active ? "当前源书" : `${book.chars} 字`}
                            </small>
                          </div>
                        </button>
                        <div className="xw-disassembly-tree-actions">
                          <button
                            className="xw-secondary-button compact"
                            onClick={() => runTreeDistillation(book)}
                            type="button"
                            disabled={controller.operationsBusy}
                            style={{ padding: "2px 6px", fontSize: "11px", minWidth: "42px", height: "22px" }}
                          >
                            蒸馏
                          </button>
                          {disassemblyBookPrimaryPath(book) && (
                            <button
                              className="xw-secondary-button compact icon-only"
                              onClick={() => void onOpenDocument(disassemblyBookPrimaryPath(book))}
                              type="button"
                              title="打开源文件"
                              style={{ width: "22px", minWidth: "22px", height: "22px" }}
                            >
                              <FileText size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 拆书产物 (拆书产物文件夹) */}
          {readyForFusions.length > 0 && (
            <div className="xw-tree-node">
              <button
                className="xw-tree-row dir"
                onClick={() => setFusionExpanded(!fusionExpanded)}
                type="button"
                style={{
                  minHeight: "30px",
                  height: "30px",
                  fontSize: "12px",
                  background: "transparent",
                  border: "none",
                  padding: "0 4px",
                  gap: "6px",
                  cursor: "pointer"
                }}
              >
                <Folder size={13} style={{ color: "var(--xw-muted)" }} />
                <span style={{ color: "var(--xw-text)", fontSize: "12px" }}>拆书产物</span>
                <em>{fusionExpanded ? "-" : "+"}</em>
              </button>
              {fusionExpanded && (
                <div className="xw-tree-children" style={{ gap: "4px", paddingLeft: "12px" }}>
                  {readyForFusions.map((book) => {
                    const active = book.id === selectedBookId;
                    const fused = disassemblyUi.fusionBookIds.includes(book.id);
                    return (
                      <div
                        key={book.id}
                        className={`xw-disassembly-tree-item ${active ? "active" : ""}`}
                        style={{
                          padding: "6px 8px",
                          borderRadius: "8px",
                          marginBottom: "2px"
                        }}
                      >
                        <button
                          className="xw-disassembly-tree-main"
                          onClick={() => disassemblyUi.onSelectBook(book.id)}
                          type="button"
                          style={{ width: "100%", padding: 0 }}
                        >
                          <div style={{ display: "grid", textAlign: "left" }}>
                            <strong style={{ fontSize: "12px" }}>{book.source_summary || "已拆书"}</strong>
                            <small style={{ fontSize: "10px", color: active ? "var(--xw-primary)" : "var(--xw-muted)", marginTop: "2px" }}>
                              {active ? "当前源书" : "已拆书"}
                            </small>
                          </div>
                        </button>
                        <div className="xw-disassembly-tree-actions">
                          <button
                            className={`xw-secondary-button compact ${fused ? "active" : ""}`}
                            onClick={() => disassemblyUi.onToggleFusionBook(book.id)}
                            type="button"
                            style={{ padding: "2px 6px", fontSize: "11px", minWidth: "42px", height: "22px" }}
                          >
                            {fused ? "已融" : "融梗"}
                          </button>
                          {disassemblyBookPrimaryPath(book) && (
                            <button
                              className="xw-secondary-button compact icon-only"
                              onClick={() => void onOpenDocument(disassemblyBookPrimaryPath(book))}
                              type="button"
                              title="打开源文件"
                              style={{ width: "22px", minWidth: "22px", height: "22px" }}
                            >
                              <FileText size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DisassemblyLibraryTree({
  controller,
  disassemblyUi,
  onOpenDocument
}: {
  controller: WorkbenchController;
  disassemblyUi: DisassemblyUiState;
  onOpenDocument: (path: string) => void | Promise<void>;
}) {
  const books = controller.disassemblyBooks.filter((book) => !book.legacy);
  const legacyBooks = controller.disassemblyBooks.filter((book) => book.legacy);
  const selectedBook = books.find((book) => book.id === disassemblyUi.selectedBookId) || null;

  // 按 title 属性进行分组
  const groupedBooks: Record<string, DisassemblyBookSummary[]> = {};
  for (const book of books) {
    if (!groupedBooks[book.title]) {
      groupedBooks[book.title] = [];
    }
    groupedBooks[book.title]!.push(book);
  }

  return (
    <>
      {books.length ? (
        Object.entries(groupedBooks).map(([title, groupBooks]) => (
          <NovelFolderNode
            key={title}
            title={title}
            books={groupBooks}
            controller={controller}
            disassemblyUi={disassemblyUi}
            onOpenDocument={onOpenDocument}
            selectedBookId={selectedBook?.id || null}
          />
        ))
      ) : (
        <p className="xw-empty">先联网爬取、上传拆书或执行一键拆书，这里会自动出现拆书库。</p>
      )}

      {!!legacyBooks.length && (
        <details className="xw-disassembly-tree-legacy" style={{ marginTop: "12px" }}>
          <summary style={{ fontSize: "12px", cursor: "pointer", color: "var(--xw-muted)" }}>历史拆书产物</summary>
          <div className="xw-disassembly-tree-scroll legacy" style={{ display: "grid", gap: "6px", marginTop: "6px" }}>
            {legacyBooks.map((book) => (
              <article key={book.id} className="xw-disassembly-tree-item legacy" style={{ padding: "6px 8px" }}>
                <div className="xw-disassembly-tree-main static" style={{ display: "grid", textAlign: "left" }}>
                  <div>
                    <strong style={{ fontSize: "12px" }}>{book.title}</strong>
                    <span style={{ fontSize: "10px", color: "var(--xw-muted)" }}>{book.source_summary || "历史拆书产物"}</span>
                  </div>
                </div>
                <div className="xw-disassembly-tree-actions" style={{ display: "flex", gap: "4px", marginTop: "4px" }}>
                  {book.paths.source && (
                    <button className="xw-secondary-button compact" onClick={() => void onOpenDocument(book.paths.source!)} type="button">
                      原文
                    </button>
                  )}
                  {book.paths.detail_outline && (
                    <button className="xw-secondary-button compact" onClick={() => void onOpenDocument(book.paths.detail_outline!)} type="button">
                      细纲
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

export type ProjectSidebarProps = {
  controller: WorkbenchController;
  disassemblyUi: DisassemblyUiState;
  leftSidebarTab: "project" | "disassembly";
  onSidebarTabChange: (tab: "project" | "disassembly") => void;
  onOpenDocument: (path: string) => void | Promise<void>;
  onOpenTimeline: () => void;
};

export function ProjectSidebar({
  controller,
  disassemblyUi,
  leftSidebarTab,
  onSidebarTabChange,
  onOpenDocument,
  onOpenTimeline
}: ProjectSidebarProps) {
  const snapshot = controller.snapshot;
  const project = snapshot?.currentProject;
  const projectName = project?.name || "未打开项目";
  const projectPath = project?.path || "先打开一个小说目录";
  const [renamingProject, setRenamingProject] = useState(false);
  const [cloudPanelOpen, setCloudPanelOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRenameRef = useRef(false);
  const cloudSlots = [1, 2, 3].map((slotId) => ({
    slotId,
    slot: controller.cloudProjectSlots.find((item) => item.slot_id === slotId) || null
  }));

  useEffect(() => {
    if (!renamingProject) {
      controller.setProjectNameInput(project?.name || "");
    }
  }, [project?.name, renamingProject]);

  useEffect(() => {
    if (renamingProject) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingProject]);

  function beginRenameProject(event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!project?.path || controller.projectBusy) {
      return;
    }
    controller.setProjectNameInput(project.name);
    setRenamingProject(true);
  }

  function cancelRenameProject() {
    cancelRenameRef.current = true;
    controller.setProjectNameInput(project?.name || "");
    setRenamingProject(false);
  }

  function commitRenameProject() {
    if (!renamingProject) {
      return;
    }
    setRenamingProject(false);
    void controller.renameCurrentProject();
  }

  function handleRenameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRenameProject();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRenameProject();
    }
  }

  return (
    <aside className="xw-left surface">
      <div className="xw-brand">
        <Sparkles size={24} />
        <strong>ArcWriter</strong>
      </div>

      <section className="xw-project-card">
        <div className="xw-card-head">
          <span>项目</span>
          <small>双击名称可重命名</small>
        </div>
        <div className="xw-project-picker">
          <button className="xw-project-open-icon" onClick={() => controller.pickAndOpenProject("open")} disabled={controller.projectBusy} aria-label="打开项目">
            <FolderOpen size={20} />
          </button>
          <div>
            {renamingProject ? (
              <input
                ref={renameInputRef}
                className="xw-project-name-input"
                value={controller.projectNameInput}
                onChange={(event) => controller.setProjectNameInput(event.target.value)}
                onBlur={() => {
                  if (cancelRenameRef.current) {
                    cancelRenameRef.current = false;
                    return;
                  }
                  commitRenameProject();
                }}
                onKeyDown={handleRenameKeyDown}
                disabled={controller.projectBusy}
                aria-label="项目显示名"
              />
            ) : (
              <button className="xw-project-name-button" onDoubleClick={beginRenameProject} disabled={controller.projectBusy}>
                <strong>{projectName}</strong>
              </button>
            )}
            <button className="xw-project-path-button" title={projectPath} onClick={() => controller.pickAndOpenProject("open")} disabled={controller.projectBusy}>
              {projectPath}
            </button>
          </div>
        </div>
        <div className="xw-project-actions">
          <button className="xw-primary-button" onClick={() => controller.pickAndOpenProject("create")} disabled={controller.projectBusy}>
            <FolderPlus size={15} />
            <span>新建项目</span>
          </button>
          <button className="xw-secondary-button" onClick={() => controller.pickAndOpenProject("open")} disabled={controller.projectBusy}>
            <FolderOpen size={15} />
            <span>打开项目</span>
          </button>
          <div className={`xw-cloud-project-strip ${cloudPanelOpen ? "open" : ""}`}>
            <button
              className="xw-cloud-project-strip-head"
              onClick={() => {
                setCloudPanelOpen((value) => !value);
                if (!cloudPanelOpen) {
                  void controller.refreshCloudProjects({ silent: true });
                }
              }}
              type="button"
            >
              <Cloud size={15} />
              <strong>上传/同步项目</strong>
              <small>{controller.cloudProjectSlots.length}/3</small>
              {cloudPanelOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {cloudPanelOpen && (
              <div className="xw-cloud-project-panel">
                <div className="xw-cloud-project-group">
                  <span>本地项目</span>
                  <div className="xw-cloud-project-local">
                    <button className="xw-secondary-button compact" onClick={() => void controller.exportCurrentProject()} disabled={controller.projectBusy || !project?.path}>
                      <Download size={14} />
                      <span>导出项目 ZIP</span>
                    </button>
                    <button className="xw-secondary-button compact" onClick={() => void controller.importProjectArchive()} disabled={controller.projectBusy}>
                      <ArchiveRestore size={14} />
                      <span>导入项目 ZIP</span>
                    </button>
                  </div>
                </div>
                <div className="xw-cloud-project-group">
                  <div className="xw-cloud-project-group-head">
                    <span>云项目</span>
                    <button className="xw-icon-button" onClick={() => void controller.refreshCloudProjects()} disabled={controller.cloudProjectBusy} aria-label="刷新云项目">
                      <RefreshCw size={13} className={controller.cloudProjectBusy ? "spin" : ""} />
                    </button>
                  </div>
                  <div className="xw-cloud-slot-list">
                    {cloudSlots.map(({ slotId, slot }) => (
                      <article key={slotId} className={`xw-cloud-slot ${slot ? "filled" : "empty"}`}>
                        <div className="xw-cloud-slot-main">
                          <strong>槽位 {slotId}</strong>
                          <span>{slot ? slot.project_name || slot.file_name : "空槽"}</span>
                          {slot && <small>{formatBytes(slot.size)} · {formatDateShort(slot.updated_at)}</small>}
                        </div>
                        <div className="xw-cloud-slot-actions">
                          <button
                            className="xw-secondary-button compact"
                            onClick={() => void controller.uploadCurrentProjectToCloud(slotId)}
                            disabled={controller.cloudProjectBusy || controller.projectBusy || !project?.path}
                          >
                            <Upload size={13} />
                            <span>{slot ? "覆盖上传" : "上传当前项目"}</span>
                          </button>
                          {slot && (
                            <>
                              <button
                                className="xw-secondary-button compact"
                                onClick={() => void controller.syncCloudProjectToCurrent(slot)}
                                disabled={controller.cloudProjectBusy || controller.projectBusy || !project?.path}
                              >
                                <ArchiveRestore size={13} />
                                <span>同步</span>
                              </button>
                              <button className="xw-danger-button compact" onClick={() => void controller.deleteCloudProject(slot)} disabled={controller.cloudProjectBusy}>
                                <Trash2 size={13} />
                                <span>删除</span>
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
                {controller.cloudProjectMessage && <p className="xw-cloud-project-message">{controller.cloudProjectMessage}</p>}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="xw-tree-card">
        <div className="xw-card-head" style={{ justifyContent: "flex-start", gap: "10px" }}>
          <button
            className={`xw-sidebar-tab-btn ${leftSidebarTab === "project" ? "active" : ""}`}
            onClick={() => onSidebarTabChange("project")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontSize: "12px",
              fontWeight: leftSidebarTab === "project" ? "bold" : "normal",
              color: leftSidebarTab === "project" ? "var(--xw-text, #111)" : "var(--xw-muted, #777)",
              cursor: "pointer"
            }}
          >
            项目树
          </button>
          <span style={{ color: "var(--xw-line, #ccc)" }}>|</span>
          <button
            className={`xw-sidebar-tab-btn ${leftSidebarTab === "disassembly" ? "active" : ""}`}
            onClick={() => onSidebarTabChange("disassembly")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontSize: "12px",
              fontWeight: leftSidebarTab === "disassembly" ? "bold" : "normal",
              color: leftSidebarTab === "disassembly" ? "var(--xw-text, #111)" : "var(--xw-muted, #777)",
              cursor: "pointer"
            }}
          >
            拆书库
          </button>
          {leftSidebarTab === "disassembly" && (
            <button
              className="xw-tree-refresh"
              onClick={() => void controller.refreshDisassemblyLibrary()}
              disabled={controller.disassemblyLibraryBusy}
              style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", display: "inline-flex", alignItems: "center" }}
              title="刷新书库"
            >
              <RefreshCw size={12} className={controller.disassemblyLibraryBusy ? "spin" : ""} />
            </button>
          )}
        </div>
        <div className="xw-tree-scroll">
          {leftSidebarTab === "project" ? (
            snapshot?.projectChrome.tree.length ? (
              snapshot.projectChrome.tree.map((node) => (
                <ProjectTreeNode
                  key={node.path}
                  node={node}
                  activePath={controller.activeDocumentPath}
                  busy={controller.projectBusy || controller.documentBusy}
                  onOpenDocument={onOpenDocument}
                  onCreateFile={controller.createProjectTreeFile}
                  onDeleteFile={controller.deleteProjectTreeFile}
                />
              ))
            ) : (
              <p className="xw-empty">打开项目后显示全部文本文件。</p>
            )
          ) : (
            <DisassemblyLibraryTree
              controller={controller}
              disassemblyUi={disassemblyUi}
              onOpenDocument={onOpenDocument}
            />
          )}
        </div>
      </section>

      <button className="xw-timeline-button" onClick={onOpenTimeline}>
        <History size={16} />
        <strong>时间线</strong>
        <span>{snapshot?.timeline.length || 0}</span>
      </button>
    </aside>
  );
}
