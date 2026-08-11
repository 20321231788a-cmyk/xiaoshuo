import { Clock3, Database, FolderOpen, FolderPlus, FolderTree, RefreshCw, Save, Search, ScrollText, Sparkles } from "lucide-react";
import type { VectorSearchHit } from "@xiaoshuo/shared";
import { useMemo, useState } from "react";
import { Panel } from "../components/Panel.js";
import type { DashboardSnapshot } from "../lib/dashboard.js";
import { filterProjectTree } from "../lib/projectTree.js";

export function ProjectView({
  snapshot,
  busy,
  message,
  vectorSearchBusy,
  vectorSearchMessage,
  vectorSearchResults,
  pendingProjectSwitchRequest,
  projectPathInput,
  projectNameInput,
  onProjectPathChange,
  onProjectNameChange,
  onOpenProject,
  onCreateProject,
  onPickOpenProject,
  onPickCreateProject,
  onOpenProjectPath,
  onRenameProject,
  onRefreshProject,
  onCancelProjectSwitch,
  onConfirmProjectSwitch,
  onRebuildVectorIndex,
  onProcessPendingVectorFiles,
  onSearchVectorIndex,
  onOpenDocument
}: {
  snapshot: DashboardSnapshot;
  busy: boolean;
  message: string;
  vectorSearchBusy: boolean;
  vectorSearchMessage: string;
  vectorSearchResults: VectorSearchHit[];
  pendingProjectSwitchRequest: {
    title: string;
    detail: string;
  } | null;
  projectPathInput: string;
  projectNameInput: string;
  onProjectPathChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onOpenProject: () => void;
  onCreateProject: () => void;
  onPickOpenProject: () => void;
  onPickCreateProject: () => void;
  onOpenProjectPath: (path: string) => void;
  onRenameProject: () => void;
  onRefreshProject: () => void;
  onCancelProjectSwitch: () => void;
  onConfirmProjectSwitch: () => void;
  onRebuildVectorIndex: () => void;
  onProcessPendingVectorFiles: () => void;
  onSearchVectorIndex: (query: string) => void;
  onOpenDocument: (path: string) => void;
}) {
  const hasProject = Boolean(snapshot.currentProject.path);
  const manifest = snapshot.projectManifest;
  const vectorIndex = snapshot.vectorIndex;
  const [treeQuery, setTreeQuery] = useState("");
  const [vectorQuery, setVectorQuery] = useState("");
  const filteredTree = useMemo(() => filterProjectTree(snapshot.projectChrome.tree, treeQuery), [snapshot.projectChrome.tree, treeQuery]);

  return (
    <div className="content-stack">
      <div className="double-grid">
        <Panel eyebrow="Project" title="项目入口与结构" aside={<FolderTree size={17} />} className="project-panel" data-testid="project-panel">
          <div className="status-banner compact-banner">
            <strong>{message || (hasProject ? "项目已经接入 ArcWriter，可以从这里继续切换、重命名和刷新。" : "当前还没有打开项目，先从这里进入真实小说目录。")}</strong>
          </div>
          {pendingProjectSwitchRequest && (
            <div className="close-guard project-switch-guard" data-testid="project-switch-guard">
              <div>
                <strong>{pendingProjectSwitchRequest.title}</strong>
                <p>{pendingProjectSwitchRequest.detail}</p>
              </div>
              <div className="action-pair">
                <button
                  data-testid="project-switch-cancel-button"
                  className="ghost-button"
                  onClick={() => onCancelProjectSwitch()}
                >
                  <span>返回当前项目</span>
                </button>
                <button
                  data-testid="project-switch-confirm-button"
                  className="refresh-button"
                  onClick={() => onConfirmProjectSwitch()}
                >
                  <span>仍然切换</span>
                </button>
              </div>
            </div>
          )}
          <div className="project-entry-grid">
            <label className="field">
              <span id="project-path-label">{hasProject ? "项目目录 / 新项目父目录" : "项目目录或新项目父目录"}</span>
              <input
                id="project-path-input"
                aria-labelledby="project-path-label"
                data-testid="project-path-input"
                value={projectPathInput}
                onChange={(event) => onProjectPathChange(event.target.value)}
                placeholder="例如 D:\\小说项目\\我的新书"
              />
            </label>
            <label className="field">
              <span id="project-name-label">{hasProject ? "显示名 / 新项目名称" : "新项目名称或显示名"}</span>
              <input
                id="project-name-input"
                aria-labelledby="project-name-label"
                data-testid="project-name-input"
                value={projectNameInput}
                onChange={(event) => onProjectNameChange(event.target.value)}
                placeholder="例如 都市逆袭长篇"
              />
            </label>
          </div>
          <div className="project-action-grid">
            <button data-testid="project-open-button" className="refresh-button" onClick={() => onOpenProject()} disabled={busy || !projectPathInput.trim()}>
              <FolderOpen size={15} />
              <span>{busy ? "处理中" : "按路径打开"}</span>
            </button>
            <button data-testid="project-pick-open-button" className="ghost-button" onClick={() => onPickOpenProject()} disabled={busy}>
              <FolderTree size={15} />
              <span>选择目录打开</span>
            </button>
            <button data-testid="project-create-button" className="refresh-button" onClick={() => onCreateProject()} disabled={busy || !projectPathInput.trim() || !projectNameInput.trim()}>
              <FolderPlus size={15} />
              <span>在这里新建</span>
            </button>
            <button data-testid="project-pick-create-button" className="ghost-button" onClick={() => onPickCreateProject()} disabled={busy || !projectNameInput.trim()}>
              <FolderPlus size={15} />
              <span>选择父目录新建</span>
            </button>
            <button data-testid="project-rename-button" className="ghost-button" onClick={() => onRenameProject()} disabled={busy || !hasProject || !projectNameInput.trim()}>
              <Save size={15} />
              <span>保存显示名</span>
            </button>
            <button data-testid="project-refresh-button" className="ghost-button" onClick={() => onRefreshProject()} disabled={busy}>
              <RefreshCw size={15} />
              <span>刷新项目</span>
            </button>
          </div>
          <div className="project-meta">
            <div>
              <span>项目名</span>
              <strong>{snapshot.currentProject.name || "未打开项目"}</strong>
            </div>
            <div>
              <span>目录</span>
              <strong>{snapshot.currentProject.path || "等待选择目录"}</strong>
            </div>
          </div>
          <label className="field compact-field">
            <span>搜索项目文件</span>
            <input
              value={treeQuery}
              onChange={(event) => setTreeQuery(event.target.value)}
              placeholder="输入章节、设定或文件名"
            />
          </label>
          <div className="tree-shell">
            {filteredTree.length ? (
              filteredTree.map((node) => <TreeBranch key={node.path} node={node} depth={0} onOpenDocument={onOpenDocument} />)
            ) : (
              <p className="empty-copy">
                {snapshot.projectChrome.tree.length ? "没有匹配的文件，换个关键词试试。" : "打开项目后，这里会显示完整目录树，文件节点可以直接送进编辑器。"}
              </p>
            )}
          </div>
        </Panel>

        <Panel eyebrow="Status" title="索引与资料状态" aside={<Database size={17} />}>
          <div className="status-card-grid">
            <article data-testid="manifest-status-card" className="status-card">
              <div className="status-card-head">
                <strong>Manifest</strong>
                <span className={`status-chip ${manifest.ready ? "ready" : "idle"}`}>{manifest.ready ? "Ready" : "Waiting"}</span>
              </div>
              <dl className="status-card-meta">
                <div>
                  <dt>文件数</dt>
                  <dd>{manifest.files}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{manifest.version}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>{manifest.generated_at || "尚未生成"}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>{manifest.source || "empty"}</dd>
                </div>
              </dl>
            </article>

            <article data-testid="vector-status-card" className="status-card">
              <div className="status-card-head">
                <strong>向量索引</strong>
                <span className={`status-chip ${vectorIndex.ready ? "ready" : vectorIndex.pending_files ? "warn" : "idle"}`}>
                  {vectorIndex.ready ? "Ready" : vectorIndex.pending_files ? "Pending" : "Idle"}
                </span>
              </div>
              <dl className="status-card-meta">
                <div>
                  <dt>分块</dt>
                  <dd>{vectorIndex.chunks}</dd>
                </div>
                <div>
                  <dt>当前可检索</dt>
                  <dd>{vectorIndex.current_embedded_chunks}</dd>
                </div>
                <div>
                  <dt>待处理</dt>
                  <dd>{vectorIndex.pending_files}</dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>{vectorIndex.embedding_model || "未配置"}</dd>
                </div>
              </dl>
            </article>
          </div>
          <div className="project-action-grid">
            <button data-testid="vector-rebuild-button" className="ghost-button" onClick={() => onRebuildVectorIndex()} disabled={busy || !hasProject}>
              <Sparkles size={15} />
              <span>重建向量索引</span>
            </button>
            <button data-testid="vector-process-pending-button" className="ghost-button" onClick={() => onProcessPendingVectorFiles()} disabled={busy || !hasProject}>
              <Database size={15} />
              <span>处理待嵌入文件</span>
            </button>
            <button data-testid="project-status-refresh-button" className="ghost-button" onClick={() => onRefreshProject()} disabled={busy}>
              <RefreshCw size={15} />
              <span>刷新状态</span>
            </button>
          </div>
          <p className="inline-message">
            {vectorIndex.enabled
              ? vectorIndex.configured
                ? `向量功能已启用，数据库位于 ${vectorIndex.db || "未创建"}。`
                : "向量功能已启用，但 Embedding 配置还没填完整。"
              : "当前还没启用向量能力，先在配置页补齐 Embedding 设置。"}
          </p>
          <div className="vector-search-panel">
            <div>
              <p className="section-label">召回调试</p>
              <p className="inline-message">输入设定、人物或剧情问题，查看当前索引实际能召回哪些片段。</p>
            </div>
            <div className="vector-search-row">
              <input
                value={vectorQuery}
                onChange={(event) => setVectorQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onSearchVectorIndex(vectorQuery);
                  }
                }}
                placeholder="例如：主角的秘密、某个伏笔、世界观规则"
                disabled={vectorSearchBusy || !hasProject}
              />
              <button className="refresh-button" onClick={() => onSearchVectorIndex(vectorQuery)} disabled={vectorSearchBusy || !vectorQuery.trim() || !hasProject}>
                <Search size={15} />
                <span>{vectorSearchBusy ? "搜索中" : "搜索索引"}</span>
              </button>
            </div>
            {vectorSearchMessage && <p className="inline-message">{vectorSearchMessage}</p>}
            <div className="vector-hit-list">
              {vectorSearchResults.map((hit, index) => (
                <article key={`${hit.path}-${index}-${hit.score}`} className="vector-hit-card">
                  <div className="vector-hit-head">
                    <button className="timeline-path" onClick={() => onOpenDocument(hit.path)}>
                      {hit.title || hit.path}
                    </button>
                    <span>{hit.source_type} · {hit.score.toFixed(3)}</span>
                  </div>
                  <p>{hit.path}</p>
                  <pre>{hit.text}</pre>
                </article>
              ))}
            </div>
          </div>
        </Panel>

        <Panel eyebrow="Knowledge" title="资料卡与时间线" aside={<ScrollText size={17} />}>
          <div className="library-counts">
            <article>
              <span>资料卡</span>
              <strong>{snapshot.projectChrome.libraries.length}</strong>
            </article>
            <article>
              <span>时间线</span>
              <strong>{snapshot.projectChrome.timeline.length}</strong>
            </article>
          </div>
          <div className="list-stack">
            {snapshot.projectChrome.libraries.slice(0, 6).map((card) => (
              <button key={card.key} className="row-card action-card" onClick={() => onOpenDocument(card.path)}>
                <div>
                  <strong>{card.title}</strong>
                  <p>{card.path}</p>
                </div>
                <span>{card.chars} 字</span>
              </button>
            ))}
            {!snapshot.projectChrome.libraries.length && <p className="empty-copy">还没有资料卡，后面可以继续接入旧界面的资料库区块。</p>}
          </div>
        </Panel>

        <Panel eyebrow="Local State" title="桌面最近项目" aside={<Clock3 size={17} />}>
          {snapshot.localState?.recent_projects.length ? (
            <div className="list-stack" data-testid="recent-project-list">
              {snapshot.localState.recent_projects.map((project) => (
                <button key={project.path} className="row-card action-card" onClick={() => onOpenProjectPath(project.path)}>
                  <div>
                    <strong>{project.name}</strong>
                    <p>{project.path}</p>
                    <p>
                      本地快照：会话 {project.conversation_count} / 任务 {project.job_count}
                      {project.last_synced_at ? ` / ${formatOpenedAt(project.last_synced_at)}` : ""}
                    </p>
                  </div>
                  <span>{formatOpenedAt(project.opened_at)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-copy" data-testid="recent-project-empty">
              {snapshot.localState ? "最近打开的桌面项目会记录到本地 SQLite。" : "浏览器模式不读取桌面本地库。"}
            </p>
          )}
          <dl className="detail-list compact-detail-list">
            <div>
              <dt>本地库</dt>
              <dd>{snapshot.localState?.db_path || "未连接"}</dd>
            </div>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function TreeBranch({ node, depth, onOpenDocument }: { node: DashboardSnapshot["projectChrome"]["tree"][number]; depth: number; onOpenDocument: (path: string) => void }) {
  const isFile = node.kind === "file";

  return (
    <div className="tree-branch" style={{ paddingLeft: `${depth * 14}px` }}>
      <button className={`tree-row ${isFile ? "clickable" : ""}`} onClick={() => isFile && onOpenDocument(node.path)}>
        <span>{node.kind === "directory" ? "DIR" : "FILE"}</span>
        <strong>{node.name}</strong>
      </button>
      {node.children.map((child) => (
        <TreeBranch key={child.path} node={child} depth={depth + 1} onOpenDocument={onOpenDocument} />
      ))}
    </div>
  );
}
