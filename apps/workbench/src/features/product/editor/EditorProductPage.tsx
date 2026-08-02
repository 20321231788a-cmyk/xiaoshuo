import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  WandSparkles,
  X,
  Zap,
  Info,
  ShieldCheck,
  BookCheck,
  CircleAlert
} from "lucide-react";
import type { ConversationMessage, TreeNode } from "@xiaoshuo/shared";
import { createApiClient } from "@xiaoshuo/api-client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { UserFeature } from "../../../navigation.js";
import { SaveConflictState } from "../shared/SharedStates.js";
import { applyWritingMark, countCharacters, writingMarks, type WritingMark } from "./writingTools.js";
import { typedCharacterCount, useTypingMetrics } from "./useTypingMetrics.js";

export function EditorProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: UserFeature) => void;
}) {
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [treeQuery, setTreeQuery] = useState("");
  const [creatingChapter, setCreatingChapter] = useState(false);
  const [newChapterName, setNewChapterName] = useState("新章节.txt");
  const [conflictDiskContent, setConflictDiskContent] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const compositionStartLengthRef = useRef<number | null>(null);
  const sidebarConversationIdRef = useRef("");
  const sidebarAbortRef = useRef<AbortController | null>(null);
  const [sidebarMessages, setSidebarMessages] = useState<ConversationMessage[]>([]);
  const [sidebarInput, setSidebarInput] = useState("");
  const [sidebarSending, setSidebarSending] = useState(false);
  const [sidebarStatus, setSidebarStatus] = useState("");

  const snapshot = controller.snapshot;
  const activeDocument = controller.openDocuments.find((item) => item.path === controller.activeDocumentPath) || null;
  const typingMetrics = useTypingMetrics(activeDocument?.path || "");
  const isMarkdown = Boolean(activeDocument?.path.match(/\.md$/i));
  const sidebarClient = useMemo(
    () => createApiClient({ baseUrl: controller.runtime.apiBase, fetchFn: controller.runtime.fetchFn }),
    [controller.runtime.apiBase, controller.runtime.fetchFn]
  );

  useEffect(() => {
    sidebarAbortRef.current?.abort();
    sidebarConversationIdRef.current = "";
    setSidebarMessages([]);
    setSidebarInput("");
    setSidebarStatus("");
  }, [snapshot?.currentProject.path]);

  // 过滤树，只保留正文部分卷与章，去除设定、JSON、开发哈希与.agent文件
  const chaptersTree = useMemo(() => {
    const rawTree = snapshot?.projectChrome.tree || [];
    return filterOnlyChapters(rawTree, treeQuery);
  }, [snapshot?.projectChrome.tree, treeQuery]);

  if (!snapshot) return null;

  async function ensureSidebarConversation(): Promise<string> {
    if (sidebarConversationIdRef.current) return sidebarConversationIdRef.current;
    const detail = await sidebarClient.createConversation({ title: "正文侧栏对话" });
    const preferences = controller.conversationModelPreferences;
    const configured = await sidebarClient.updateConversationModelPreferences(detail.id, {
      model_override: "",
      reasoning_enabled: preferences.reasoning_enabled,
      reasoning_effort: preferences.reasoning_effort
    });
    sidebarConversationIdRef.current = configured.id;
    setSidebarMessages(configured.messages);
    return configured.id;
  }

  async function send() {
    const prompt = sidebarInput.trim();
    if (!prompt || sidebarSending) return;
    setSidebarSending(true);
    setSidebarStatus("正在生成...");
    const abortController = new AbortController();
    sidebarAbortRef.current = abortController;
    try {
      const conversationId = await ensureSidebarConversation();
      const userMessage = localSidebarMessage("user", prompt);
      const assistantMessage = localSidebarMessage("assistant", "");
      setSidebarMessages((current) => [...current, userMessage, assistantMessage]);
      setSidebarInput("");
      let answer = "";
      let reasoning = "";
      await sidebarClient.streamConversationMessage(conversationId, {
        content: prompt,
        skill_id: "",
        agent_name: "",
        write_target: "",
        insert_mode: "none",
        current_path: activeDocument?.path || "",
        runtime_context: activeDocument
          ? `当前章节：${activeDocument.path}\n\n${activeDocument.content.slice(0, 8000)}`
          : "",
        attachment_ids: []
      }, {
        onDelta: (event) => {
          if (event.channel === "reasoning") reasoning += event.text;
          else answer += event.text;
          setSidebarMessages((current) => current.map((message) => message.id === assistantMessage.id
            ? { ...message, content: answer, reasoning_content: reasoning }
            : message));
        },
        onFinal: (event) => {
          if (event.payload.conversation) setSidebarMessages(event.payload.conversation.messages);
          setSidebarStatus(event.payload.requires_confirmation ? "本轮包含待确认操作，请在完整 AI 助手中继续处理。" : "");
        },
        onError: (event) => setSidebarStatus(event.message || "生成失败，请重试。")
      }, abortController.signal);
    } catch (error) {
      if (!abortController.signal.aborted) setSidebarStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (sidebarAbortRef.current === abortController) sidebarAbortRef.current = null;
      setSidebarSending(false);
    }
  }

  // 快捷发送
  function handleShortcut(prompt: string) {
    setSidebarInput(prompt);
  }

  function expandCurrentParagraph() {
    if (!activeDocument) return;
    const cursor = editorRef.current?.selectionStart ?? activeDocument.content.length;
    const paragraph = currentParagraph(activeDocument.content, cursor);
    setSidebarInput(paragraph
      ? `请扩写下面这个当前段落，保持事实、人物口吻和叙事视角不变，增加动作、感官与情绪细节：\n\n${paragraph}`
      : "请扩写当前段落，保持事实、人物口吻和叙事视角不变，增加动作、感官与情绪细节。");
  }

  function insertWritingMark(mark: WritingMark) {
    if (!activeDocument) return;
    const start = editorRef.current?.selectionStart ?? activeDocument.content.length;
    const end = editorRef.current?.selectionEnd ?? start;
    const result = applyWritingMark(activeDocument.content, start, end, mark);
    const editor = editorRef.current;
    const selected = activeDocument.content.slice(start, end);
    const insertion = mark.close ? `${mark.value}${selected}${mark.close}` : mark.value;
    let insertedWithNativeHistory = false;
    if (editor) {
      editor.focus();
      editor.setSelectionRange(start, end);
      insertedWithNativeHistory = document.execCommand("insertText", false, insertion);
    }
    if (!insertedWithNativeHistory) controller.updateActiveDocument(result.content);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }

  function applyMarkdownWrap(open: string, close = open) {
    insertWritingMark({ label: "Markdown 格式", value: open, close, preview: open });
  }

  function applyMarkdownHeading() {
    if (!activeDocument) return;
    const cursor = editorRef.current?.selectionStart ?? activeDocument.content.length;
    const lineStart = activeDocument.content.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
    const next = `${activeDocument.content.slice(0, lineStart)}# ${activeDocument.content.slice(lineStart)}`;
    controller.updateActiveDocument(next);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(cursor + 2, cursor + 2);
    });
  }

  function handleDocumentChange(event: ChangeEvent<HTMLTextAreaElement>) {
    if (!activeDocument) return;
    const next = event.target.value;
    const nativeEvent = event.nativeEvent as InputEvent;
    const typed = typedCharacterCount({ inputType: nativeEvent.inputType, isComposing: nativeEvent.isComposing, data: nativeEvent.data }, activeDocument.content, next);
    if (typed > 0) typingMetrics.recordTypedCharacters(typed);
    controller.updateActiveDocument(next);
  }

  async function createChapter() {
    const directory = findChapterDirectory(snapshot?.projectChrome.tree || []) || "02_正文";
    const created = await controller.createProjectTreeFile(directory, newChapterName);
    if (created) {
      setCreatingChapter(false);
      setNewChapterName("新章节.txt");
    }
  }

  async function loadConflictDiff() {
    if (!activeDocument) return;
    const encodedPath = activeDocument.path.split("/").map(encodeURIComponent).join("/");
    const fetchFn = controller.runtime.fetchFn || fetch;
    try {
      const response = await fetchFn(new URL(`/api/documents/${encodedPath}`, controller.runtime.apiBase));
      if (!response.ok) throw new Error("读取磁盘版本失败");
      const payload = await response.json() as { content?: string };
      setConflictDiskContent(String(payload.content || ""));
    } catch {
      setConflictDiskContent("无法读取磁盘版本，请先重新连接后重试。");
    }
  }

  // 保存冲突时的回调
  const conflictRequest = controller.pendingSaveConflictRequest;

  return (
    <section className={`editor-layout ${assistantOpen ? "assistant-open" : ""}`} style={{ height: "100%" }}>
      {/* 左栏：章节栏 */}
      <aside className="chapter-panel">
        <div className="panel-head">
          <strong>章节</strong>
          <button className="icon-button subtle" title="新建章节" type="button" onClick={() => setCreatingChapter(true)}>
            <FilePlus2 size={15} />
          </button>
        </div>
        {creatingChapter && (
          <form className="chapter-create" onSubmit={(event) => { event.preventDefault(); void createChapter(); }}>
            <input value={newChapterName} onChange={(event) => setNewChapterName(event.target.value)} aria-label="新章节文件名" autoFocus />
            <button type="submit" disabled={!newChapterName.trim() || controller.projectBusy}>创建</button>
            <button type="button" onClick={() => setCreatingChapter(false)}>取消</button>
          </form>
        )}
        <div className="chapter-search">
          <Search size={14} />
          <input
            value={treeQuery}
            onChange={(e) => setTreeQuery(e.target.value)}
            placeholder="搜索章节..."
            style={{ border: 0, outline: 0, background: "transparent", width: "100%", fontSize: "12px" }}
          />
        </div>

        <div className="chapter-list" style={{ overflowY: "auto", flex: 1 }}>
          {chaptersTree.map((node) => (
            <ChapterNodeItem
              key={node.path}
              node={node}
              activePath={controller.activeDocumentPath}
              onOpen={(path) => void controller.openDocument(path)}
            />
          ))}
          {chaptersTree.length === 0 && (
            <p style={{ padding: "10px", fontSize: "12px", color: "var(--muted)", textAlign: "center" }}>无正文章节</p>
          )}
        </div>

        <div className="chapter-foot">
          <div><span>当前章节</span><strong>{activeDocument?.chars || 0} 字</strong></div>
          <div className="typing-speed" title={typingMetrics.ready ? `本次编辑平均 ${typingMetrics.averageCharsPerMinute} 字/分钟` : "输入至少 5 个字并持续 5 秒后开始统计"}>
            <span>打字速度</span>
            <strong>{typingMetrics.ready ? `${typingMetrics.realtimeCharsPerMinute} 字/分钟` : "-- 字/分钟"}</strong>
          </div>
        </div>
      </aside>

      {/* 中间栏：正文编辑区 */}
      <main className="manuscript-wrap">
        {/* 编辑器工具栏 */}
        <div className="editor-toolbar">
          <div className="format-tools">
            <button title="撤销" type="button" onClick={() => { editorRef.current?.focus(); document.execCommand("undo"); }} disabled={!activeDocument}>
              <RotateCcw size={15} />
            </button>
            {isMarkdown && (
              <>
                <span />
                <button type="button" style={{ fontWeight: "bold" }} onClick={() => applyMarkdownWrap("**")}>B</button>
                <button type="button" style={{ fontStyle: "italic" }} onClick={() => applyMarkdownWrap("_")}>I</button>
                <button type="button" onClick={applyMarkdownHeading}>标题</button>
              </>
            )}
          </div>
          <div className="editor-meta">
            {controller.documentBusy ? (
              <span className="saved" style={{ color: "var(--accent)" }}>正在保存...</span>
            ) : activeDocument?.dirty ? (
              <span className="saved" style={{ color: "var(--warning)" }}><CircleAlert size={13} />未保存</span>
            ) : activeDocument?.stale ? (
              <span className="saved" style={{ color: "var(--warning)" }}><CircleAlert size={13} />磁盘有更新</span>
            ) : (
              <span className="saved"><Check size={13} />已保存</span>
            )}
            <span>{activeDocument?.chars || 0} 字</span>
            <button
              className="button primary compact"
              style={{ minHeight: "24px", height: "24px" }}
              type="button"
              onClick={() => void controller.saveActiveDocument()}
              disabled={controller.documentBusy || !activeDocument}
            >
              <Save size={13} />
              保存
            </button>
          </div>
        </div>

        <div className="punctuation-toolbar" role="toolbar" aria-label="常用中文标点">
          {writingMarks.map((mark) => (
            <button key={mark.label} type="button" title={mark.label} aria-label={mark.label} onClick={() => insertWritingMark(mark)} disabled={!activeDocument}>
              {mark.preview}
            </button>
          ))}
        </div>

        {/* 冲突守卫与状态处理 */}
        {conflictRequest ? (
          <div className="save-conflict-wrap">
            <SaveConflictState
              mySizeLabel={`${activeDocument?.chars || 0} 字`}
              myTimeLabel="刚刚"
              diskSizeLabel={conflictDiskContent === null ? "磁盘版本" : `${conflictDiskContent.length} 字`}
              diskTimeLabel={conflictRequest.currentUpdatedAt || "更新时间未知"}
              onSaveCopy={() => void controller.saveActiveDocumentCopy()}
              onViewDiff={() => void loadConflictDiff()}
              onOverwrite={() => void controller.confirmSaveOverwrite()}
            />
            {conflictDiskContent !== null && (
              <section className="save-conflict-diff" aria-label="保存冲突差异">
                <div><strong>我的版本</strong><pre>{activeDocument?.content}</pre></div>
                <div><strong>磁盘版本</strong><pre>{conflictDiskContent}</pre></div>
              </section>
            )}
          </div>
        ) : activeDocument ? (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            <article className="manuscript" style={{ flex: 1 }}>
              <h1 style={{ outline: "none" }}>{activeDocument.title}</h1>
              <textarea
                ref={editorRef}
                style={{
                  width: "100%",
                  height: "80%",
                  border: 0,
                  outline: 0,
                  resize: "none",
                  background: "transparent",
                  fontFamily: '"Source Han Serif SC", "Songti SC", "STSong", serif',
                  fontSize: "17px",
                  lineHeight: "1.85",
                  color: "oklch(27% .016 70)"
                }}
                value={activeDocument.content}
                onChange={handleDocumentChange}
                onCompositionStart={() => { compositionStartLengthRef.current = countCharacters(activeDocument.content); }}
                onCompositionEnd={(event) => {
                  const startLength = compositionStartLengthRef.current;
                  compositionStartLengthRef.current = null;
                  const committed = countCharacters(event.data || "");
                  if (committed > 0) typingMetrics.recordTypedCharacters(committed);
                  else if (startLength !== null) typingMetrics.recordTypedCharacters(Math.max(0, countCharacters(event.currentTarget.value) - startLength));
                }}
                placeholder="在此处开始创作小说正文..."
                aria-label={`${activeDocument.title} 正文编辑器`}
                spellCheck={false}
              />
            </article>
            <footer className="editor-status">
              <span>正文模式</span>
              <span>宋体 · 17px · 行距 1.85</span>
              <span>{activeDocument.dirty ? "未保存" : activeDocument.stale ? "磁盘有更新" : "已同步"}</span>
            </footer>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: "10px" }}>
            <FileText size={40} style={{ color: "var(--muted)" }} />
            <p style={{ fontSize: "12px", color: "var(--muted)" }}>双击左侧章节列表打开文档进行编辑</p>
          </div>
        )}
      </main>

      {/* 右栏：AI 写作侧栏 */}
      {assistantOpen ? (
        <aside className="editor-assistant">
          <div className="assistant-head">
            <div>
              <Sparkles size={16} />
              <strong>AI 助手</strong>
            </div>
            <button className="icon-button subtle" type="button" onClick={() => setAssistantOpen(false)} title="收起">
              <PanelRightClose size={16} />
            </button>
          </div>
          <div className="context-strip">
            <span>本次读取</span>
            <button type="button" disabled>当前章节</button>
            <button type="button" disabled>大纲 / 设定</button>
          </div>

          <div className="assistant-thread" style={{ overflowY: "auto", flex: 1 }}>
            {sidebarStatus && (
              <p style={{ fontSize: "12px", padding: "6px", background: "var(--stone-deep)", borderRadius: "4px", margin: "0 0 10px" }}>
                {sidebarStatus}
              </p>
            )}

            {!sidebarMessages.length && <p className="editor-mini-chat-empty">这是独立的新对话。可直接提问，不会切换到完整 AI 助手。</p>}
            {sidebarMessages.map((message) => (
              <div className={`editor-mini-message ${message.role}`} key={message.id}>
                <strong>{message.role === "user" ? "你" : "ArcWriter AI"}</strong>
                {message.reasoning_content && <details><summary>思考过程</summary><p>{message.reasoning_content}</p></details>}
                <p>{message.content || (sidebarSending && message.role === "assistant" ? "正在生成..." : "")}</p>
              </div>
            ))}

            <div className="suggestion-block" style={{ marginTop: "15px" }}>
              <span>快捷操作</span>
              <button type="button" onClick={() => handleShortcut("续写当前段落，保持现有叙事视角和文风。")}>
                <WandSparkles size={14} /> 续写当前段落
              </button>
              <button type="button" onClick={expandCurrentParagraph}>
                <Plus size={14} /> 扩写当前段落
              </button>
              <button type="button" onClick={() => handleShortcut("检查当前章节的人物口吻，避免现代用语。")}>
                <BookCheck size={14} /> 检查人物口吻
              </button>
              <button type="button" onClick={() => handleShortcut("增强当前章节的悬念感，延迟答案揭示。")}>
                <Zap size={14} /> 增强悬念
              </button>
            </div>
          </div>

          <div className="composer">
            <textarea
              value={sidebarInput}
              onChange={(e) => setSidebarInput(e.target.value)}
              placeholder="输入续写、修改或分析要求..."
            />
            <div>
              <button className="context-button" type="button" disabled>
                <Bot size={14} /> 当前章节 · 自动项目上下文
              </button>
              <button
                className="send-button"
                type="button"
                onClick={send}
                disabled={!sidebarInput.trim() || sidebarSending}
              >
                <Sparkles size={16} />
              </button>
            </div>
          </div>
          <p className="assistant-footnote">生成内容先预览，确认后才会写入正文</p>
        </aside>
      ) : (
        <button className="assistant-reopen" type="button" onClick={() => setAssistantOpen(true)} title="打开 AI 助手">
          <Sparkles size={17} />
        </button>
      )}
    </section>
  );
}

function localSidebarMessage(role: ConversationMessage["role"], content: string): ConversationMessage {
  return {
    id: `sidebar-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
    role,
    content,
    created_at: new Date().toISOString(),
    metadata: {}
  };
}

function currentParagraph(content: string, cursor: number): string {
  const safeCursor = Math.max(0, Math.min(cursor, content.length));
  const before = content.slice(0, safeCursor);
  const after = content.slice(safeCursor);
  const startBreak = before.search(/(?:\r?\n){2}[^\n]*$/);
  const start = startBreak >= 0 ? startBreak + before.slice(startBreak).match(/^(?:\r?\n){2}/)![0].length : 0;
  const endMatch = after.match(/(?:\r?\n){2}/);
  const end = endMatch?.index === undefined ? content.length : safeCursor + endMatch.index;
  return content.slice(start, end).trim();
}

// 递归章节树项组件
function ChapterNodeItem({
  node,
  activePath,
  onOpen
}: {
  node: any;
  activePath: string;
  onOpen: (path: string) => void;
}) {
  const isFile = node.kind === "file";
  const [collapsed, setCollapsed] = useState(false);

  if (isFile) {
    return (
      <button
        type="button"
        className={activePath === node.path ? "active" : ""}
        style={{ paddingLeft: "20px", width: "100%", height: "30px", display: "flex", alignItems: "center", gap: "6px", border: 0, background: "transparent", textAlign: "left", fontSize: "12px" }}
        onClick={() => onOpen(node.path)}
      >
        <FileText size={13} style={{ color: "var(--muted)" }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name.replace(/\.txt|\.md/g, "")}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        style={{ width: "100%", height: "30px", display: "flex", alignItems: "center", gap: "6px", border: 0, background: "transparent", textAlign: "left", fontSize: "12px", fontWeight: "bold", paddingLeft: "10px" }}
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span>{node.name}</span>
      </button>
      {!collapsed && node.children && (
        <div style={{ paddingLeft: "10px" }}>
          {node.children.map((child: any) => (
            <ChapterNodeItem key={child.path} node={child} activePath={activePath} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

// 章节文件过滤器
function filterOnlyChapters(nodes: any[], query: string): any[] {
  const result: any[] = [];
  for (const node of nodes) {
    if (node.name.startsWith(".")) continue;
    // 过滤掉设定集、大纲、规则、任务等非正文卷章目录
    if (
      node.name.includes("设定") ||
      node.name.includes("大纲") ||
      node.name.includes("规则") ||
      node.name.includes("api") ||
      node.name.endsWith(".json") ||
      node.name.endsWith(".jsonl") ||
      node.name.endsWith(".agent")
    ) {
      continue;
    }

    const filteredChildren = node.children ? filterOnlyChapters(node.children, query) : [];
    if (node.kind === "file") {
      if (query && !node.name.toLowerCase().includes(query.toLowerCase())) {
        continue;
      }
      result.push(node);
    } else {
      if (filteredChildren.length > 0 || (query && node.name.toLowerCase().includes(query.toLowerCase()))) {
        result.push({
          ...node,
          children: filteredChildren
        });
      }
    }
  }
  return result;
}

function findChapterDirectory(nodes: TreeNode[]): string {
  for (const node of nodes) {
    if (node.kind !== "file" && /正文|章节/.test(node.name)) return node.path;
    if (node.children?.length) {
      const nested = findChapterDirectory(node.children);
      if (nested) return nested;
    }
  }
  return "";
}
