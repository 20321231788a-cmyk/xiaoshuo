import { Database, RefreshCw, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";

export function VectorTestFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [vectorQuery, setVectorQuery] = useState("");
  const snapshot = controller.snapshot;

  if (!snapshot) {
    return null;
  }

  const hasProject = Boolean(snapshot.currentProject.path);
  const vectorIndex = snapshot.vectorIndex;

  return (
    <section className="xw-feature-page xw-vector-test-page">
      <div className="xw-feature-toolbar">
        <strong>向量测试</strong>
        <span>{vectorIndex.ready ? "索引就绪" : vectorIndex.pending_files ? "有待处理文件" : "未就绪"}</span>
        <button className="xw-secondary-button compact" onClick={() => void controller.refreshProjectWorkspace()} disabled={controller.projectBusy}>
          <RefreshCw size={14} />
          <span>刷新状态</span>
        </button>
      </div>

      <div className="status-card-grid">
        <article data-testid="vector-test-status-card" className="status-card">
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

      <div className="project-action-grid xw-vector-test-actions">
        <button data-testid="vector-test-rebuild-button" className="ghost-button" onClick={() => void controller.rebuildVectorIndex()} disabled={controller.projectBusy || !hasProject}>
          <Sparkles size={15} />
          <span>重建向量索引</span>
        </button>
        <button data-testid="vector-test-process-pending-button" className="ghost-button" onClick={() => void controller.processPendingVectorFiles()} disabled={controller.projectBusy || !hasProject}>
          <Database size={15} />
          <span>处理待嵌入文件</span>
        </button>
        <button data-testid="vector-test-refresh-button" className="ghost-button" onClick={() => void controller.refreshProjectWorkspace()} disabled={controller.projectBusy}>
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
                void controller.searchVectorIndex(vectorQuery);
              }
            }}
            placeholder="例如：主角的秘密、某个伏笔、世界观规则"
            disabled={controller.vectorSearchBusy || !hasProject}
          />
          <button
            className="refresh-button"
            onClick={() => void controller.searchVectorIndex(vectorQuery)}
            disabled={controller.vectorSearchBusy || !vectorQuery.trim() || !hasProject}
          >
            <Search size={15} />
            <span>{controller.vectorSearchBusy ? "搜索中" : "搜索索引"}</span>
          </button>
        </div>
        {controller.vectorSearchMessage && <p className="inline-message">{controller.vectorSearchMessage}</p>}
        <div className="vector-hit-list">
          {controller.vectorSearchResults.map((hit, index) => (
            <article key={`${hit.path}-${index}-${hit.score}`} className="vector-hit-card">
              <div className="vector-hit-head">
                <button className="timeline-path" onClick={() => void controller.openDocument(hit.path)}>
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
    </section>
  );
}
