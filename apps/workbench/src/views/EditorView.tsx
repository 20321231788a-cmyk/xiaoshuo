import { AlertTriangle, FilePenLine, History, LibraryBig, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import type { TimelineEntry, TreeNode } from "@xiaoshuo/shared";
import { useMemo, useRef, useState } from "react";
import type { OpenDocumentTab } from "../hooks/useWorkbenchController.js";
import { Panel } from "../components/Panel.js";
import type { DashboardSnapshot } from "../lib/dashboard.js";
import { filterProjectTree } from "../lib/projectTree.js";

export function EditorView({
  snapshot,
  openDocuments,
  activeDocumentPath,
  busy,
  message,
  pendingCloseRequest,
  pendingReloadRequest,
  pendingSaveConflictRequest,
  onOpenDocument,
  onReloadDocument,
  onActivateDocument,
  onCloseDocument,
  onCancelCloseDocument,
  onConfirmCloseDocument,
  onCancelReloadDocument,
  onConfirmReloadDocument,
  onCancelSaveConflict,
  onConfirmSaveOverwrite,
  onRollbackTimelineEntry,
  onChangeDocument,
  onSaveDocument
}: {
  snapshot: DashboardSnapshot;
  openDocuments: OpenDocumentTab[];
  activeDocumentPath: string;
  busy: boolean;
  message: string;
  pendingCloseRequest: { path: string; title: string } | null;
  pendingReloadRequest: { path: string; title: string } | null;
  pendingSaveConflictRequest: { path: string; title: string; currentUpdatedAt: string } | null;
  onOpenDocument: (path: string) => void;
  onReloadDocument: () => void;
  onActivateDocument: (path: string) => void;
  onCloseDocument: (path: string) => void;
  onCancelCloseDocument: () => void;
  onConfirmCloseDocument: () => void;
  onCancelReloadDocument: () => void;
  onConfirmReloadDocument: () => void;
  onCancelSaveConflict: () => void;
  onConfirmSaveOverwrite: () => void;
  onRollbackTimelineEntry: (entryId: string, confirmDelete?: boolean) => void;
  onChangeDocument: (content: string) => void;
  onSaveDocument: () => void;
}) {
  const activeDocument = openDocuments.find((item) => item.path === activeDocumentPath) || null;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [treeQuery, setTreeQuery] = useState("");
  const [rollbackConfirmId, setRollbackConfirmId] = useState("");
  const filteredTree = useMemo(() => filterProjectTree(snapshot.projectChrome.tree, treeQuery), [snapshot.projectChrome.tree, treeQuery]);
  const recentTimeline = snapshot.timeline.slice(0, 6);

  function handleRollback(entry: TimelineEntry) {
    if (rollbackConfirmId !== entry.id) {
      setRollbackConfirmId(entry.id);
      return;
    }
    setRollbackConfirmId("");
    onRollbackTimelineEntry(entry.id, true);
  }

  function insertWritingMark(mark: WritingMark) {
    if (!activeDocument) {
      return;
    }
    const editor = editorRef.current;
    const start = editor?.selectionStart ?? activeDocument.content.length;
    const end = editor?.selectionEnd ?? start;
    const selected = activeDocument.content.slice(start, end);
    const insertion =
      mark.close && selected
        ? `${mark.value}${selected}${mark.close}`
        : mark.close
          ? `${mark.value}${mark.close}`
          : mark.value;
    const next = `${activeDocument.content.slice(0, start)}${insertion}${activeDocument.content.slice(end)}`;
    onChangeDocument(next);
    requestAnimationFrame(() => {
      const nextCursor = mark.close && selected ? start + insertion.length : start + mark.value.length;
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  return (
    <div className="double-grid editor-layout">
      <Panel eyebrow="素材" title="项目文件与资料卡" aside={<LibraryBig size={17} />}>
        <div className="editor-source-stack">
          <div>
            <p className="section-label">项目树</p>
            <label className="field compact-field">
              <span>搜索文件</span>
              <input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="输入章节、设定或文件名" />
            </label>
            <div className="tree-shell">
              {filteredTree.length ? (
                filteredTree.map((node) => <EditorTreeBranch key={node.path} node={node} depth={0} onOpenDocument={onOpenDocument} />)
              ) : (
                <p className="empty-copy">
                  {snapshot.projectChrome.tree.length ? "没有匹配的文件，换个关键词试试。" : "打开项目后，这里会显示项目文件。"}
                </p>
              )}
            </div>
          </div>
          <div>
            <p className="section-label">资料卡</p>
            <div className="list-stack">
              {snapshot.projectChrome.libraries.slice(0, 8).map((card) => (
                <button key={card.key} className="row-card action-card" onClick={() => onOpenDocument(card.path)}>
                  <div>
                    <strong>{card.title}</strong>
                    <p>{card.path}</p>
                  </div>
                  <span>{card.chars} 字</span>
                </button>
              ))}
              {!snapshot.projectChrome.libraries.length && <p className="empty-copy">目前没有可直接打开的资料卡。</p>}
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        eyebrow="正文"
        title="文档编辑器"
        aside={
          <div className="action-pair">
            <button className="ghost-button" onClick={onReloadDocument} disabled={!activeDocument || busy}>
              <RefreshCw size={15} />
              <span>读取最新版</span>
            </button>
            <button className="refresh-button" onClick={onSaveDocument} disabled={!activeDocument || busy}>
              <Save size={15} />
              <span>{busy ? "保存中" : "保存文档"}</span>
            </button>
          </div>
        }
      >
        <div className="status-banner compact-banner">
          <strong>{message || "在这里写正文、改设定或整理大纲。保存前会保留本地草稿，避免误覆盖。"}</strong>
          {activeDocument && <p>{activeDocument.path}</p>}
        </div>

        {pendingCloseRequest && (
          <div className="close-guard">
            <div>
              <strong>{pendingCloseRequest.title} 还有未保存修改</strong>
              <p>继续关闭会直接丢掉本地草稿；如果还要保留，先点“返回编辑”或者先保存。</p>
            </div>
            <div className="action-pair">
              <button className="ghost-button" onClick={onCancelCloseDocument}>
                <span>返回编辑</span>
              </button>
              <button className="refresh-button" onClick={onConfirmCloseDocument}>
                <span>仍然关闭</span>
              </button>
            </div>
          </div>
        )}

        {pendingReloadRequest && (
          <div className="close-guard">
            <div>
              <strong>{pendingReloadRequest.title} 还有未保存修改</strong>
              <p>读取最新版会用磁盘内容覆盖当前本地草稿；如果还要保留，先点“继续编辑”或者先保存。</p>
            </div>
            <div className="action-pair">
              <button className="ghost-button" onClick={onCancelReloadDocument}>
                <span>继续编辑</span>
              </button>
              <button className="refresh-button" onClick={onConfirmReloadDocument}>
                <span>丢弃草稿并读取</span>
              </button>
            </div>
          </div>
        )}

        {pendingSaveConflictRequest && (
          <div className="close-guard">
            <div>
              <strong>{pendingSaveConflictRequest.title} 磁盘已有新版</strong>
              <p>
                普通保存已暂停，避免覆盖后台或其他窗口写入的内容。
                {pendingSaveConflictRequest.currentUpdatedAt ? ` 磁盘最新版时间：${pendingSaveConflictRequest.currentUpdatedAt}` : ""}
              </p>
            </div>
            <div className="action-pair">
              <button className="ghost-button" onClick={onCancelSaveConflict}>
                <span>继续编辑草稿</span>
              </button>
              <button className="ghost-button" onClick={onReloadDocument}>
                <RefreshCw size={15} />
                <span>读取最新版</span>
              </button>
              <button className="refresh-button" onClick={onConfirmSaveOverwrite}>
                <Save size={15} />
                <span>确认覆盖</span>
              </button>
            </div>
          </div>
        )}

        <div className="editor-tabs">
          {openDocuments.map((document) => (
            <div
              key={document.path}
              className={`editor-tab ${document.path === activeDocumentPath ? "active" : ""}`}
            >
              <button type="button" className="tab-activate" onClick={() => onActivateDocument(document.path)}>
                <span>{document.title}</span>
                {document.dirty && <em>●</em>}
                {document.stale && <span className="tab-warning" title="磁盘里有更新，当前标签仍保留本地草稿">!</span>}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 ${document.title}`}
                onClick={() => onCloseDocument(document.path)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          {!openDocuments.length && (
            <div className="editor-empty-state">
              <p className="empty-copy">从左侧项目树或资料卡里打开一个文件，编辑标签会出现在这里。</p>
              <div className="empty-editor-actions">
                <button className="ghost-button" onClick={() => onOpenDocument("02_正文/正文.txt")}>打开正文</button>
                <button className="ghost-button" onClick={() => onOpenDocument("01_大纲/大纲.txt")}>打开大纲</button>
                <button className="ghost-button" onClick={() => onOpenDocument("00_设定集/设定集/人物设定.txt")}>人物设定</button>
              </div>
            </div>
          )}
        </div>

        {activeDocument && (
          <div className="editor-panel">
            <div className="editor-meta">
              <span>{activeDocument.updatedAt}</span>
              <span>{activeDocument.chars} 字</span>
              <span>{activeDocument.dirty ? "未保存" : activeDocument.stale ? "有后台更新" : "已同步"}</span>
            </div>
            {activeDocument.stale && (
              <div className="stale-warning">
                <AlertTriangle size={15} />
                <span>磁盘里的 {activeDocument.path} 已更新，当前标签继续保留本地草稿。确认不需要本地修改后，可点“读取最新版”。</span>
              </div>
            )}
            <div className="writing-mark-toolbar" aria-label="常用写作标点">
              {writingMarks.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="mark-button"
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => insertWritingMark(item)}
                >
                  {item.preview}
                </button>
              ))}
            </div>
            <textarea
              ref={editorRef}
              className="editor-surface"
              aria-label={activeDocument.title ? `${activeDocument.title} 正文编辑器` : "正文编辑器"}
              value={activeDocument.content}
              onChange={(event) => onChangeDocument(event.target.value)}
              spellCheck={false}
            />
          </div>
        )}

        <section className="timeline-panel">
          <div className="timeline-panel-head">
            <div>
              <p className="section-label">改稿记录</p>
              <strong>保存与回滚记录</strong>
            </div>
            <History size={17} />
          </div>
          <div className="timeline-list">
            {recentTimeline.map((entry) => (
              <article key={entry.id} className={`timeline-card ${rollbackConfirmId === entry.id ? "confirming" : ""}`}>
                <div className="timeline-card-head">
                  <div>
                    <strong>{entry.summary || entry.id}</strong>
                    <p>{entry.time} · {entry.source}</p>
                  </div>
                  <button className={rollbackConfirmId === entry.id ? "refresh-button" : "ghost-button"} onClick={() => handleRollback(entry)} disabled={busy}>
                    <RotateCcw size={15} />
                    <span>{rollbackConfirmId === entry.id ? "确认回滚" : "恢复到此前"}</span>
                  </button>
                </div>
                {rollbackConfirmId === entry.id && (
                  <p className="timeline-warning">再次点击会把下面文件恢复到这次操作之前的状态；新建文件可能会被删除。</p>
                )}
                <div className="timeline-file-list">
                  {entry.files.slice(0, 4).map((file) => (
                    <div key={`${entry.id}-${file.path}`} className="timeline-file-row">
                      <button className="timeline-path" onClick={() => onOpenDocument(file.path)}>
                        {file.path}
                      </button>
                      <span>{file.action}</span>
                      <p>{file.after_exists ? file.after_excerpt || "已写入但没有可预览文本" : "本次操作后文件不存在"}</p>
                    </div>
                  ))}
                  {entry.files.length > 4 && <p className="empty-copy">另有 {entry.files.length - 4} 个文件受影响。</p>}
                </div>
              </article>
            ))}
            {!recentTimeline.length && <p className="empty-copy">保存、AI 写入或文件操作完成后，这里会出现可恢复记录。</p>}
          </div>
        </section>
      </Panel>
    </div>
  );
}

type WritingMark = {
  label: string;
  value: string;
  preview: string;
  close?: string;
};

const writingMarks: WritingMark[] = [
  { label: "逗号", value: "，", preview: "，" },
  { label: "句号", value: "。", preview: "。" },
  { label: "分号", value: "；", preview: "；" },
  { label: "冒号", value: "：", preview: "：" },
  { label: "问号", value: "？", preview: "？" },
  { label: "感叹号", value: "！", preview: "！" },
  { label: "顿号", value: "、", preview: "、" },
  { label: "省略号", value: "……", preview: "……" },
  { label: "破折号", value: "——", preview: "——" },
  { label: "中文双引号", value: "“", close: "”", preview: "“”" },
  { label: "中文单引号", value: "‘", close: "’", preview: "‘’" },
  { label: "书名号", value: "《", close: "》", preview: "《》" },
  { label: "圆括号", value: "（", close: "）", preview: "（）" },
  { label: "方括号", value: "【", close: "】", preview: "【】" },
  { label: "直角引号", value: "「", close: "」", preview: "「」" },
  { label: "双直角引号", value: "『", close: "』", preview: "『』" }
];

function EditorTreeBranch({
  node,
  depth,
  onOpenDocument
}: {
  node: TreeNode;
  depth: number;
  onOpenDocument: (path: string) => void;
}) {
  const isFile = node.kind === "file";

  return (
    <div className="tree-branch" style={{ paddingLeft: `${depth * 14}px` }}>
      <button className={`tree-row ${isFile ? "clickable" : ""}`} onClick={() => isFile && onOpenDocument(node.path)}>
        <span>{isFile ? "FILE" : "DIR"}</span>
        <strong>{node.name}</strong>
      </button>
      {node.children.map((child) => (
        <EditorTreeBranch key={child.path} node={child} depth={depth + 1} onOpenDocument={onOpenDocument} />
      ))}
    </div>
  );
}
