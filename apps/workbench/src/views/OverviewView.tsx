import { Activity, ArchiveRestore, BookCopy, Bot, CheckCircle2, Copy, Database, Download, FileText, FolderKanban, LibraryBig, MonitorDot, Plus, ScrollText, ShieldCheck, Sparkles, TerminalSquare, Trash2, Undo2 } from "lucide-react";
import { motion } from "framer-motion";
import { useState } from "react";
import type { LedgerItem, LocalStateGeneratedCache, RevisionLogEntry } from "@xiaoshuo/shared";
import type { DashboardSnapshot } from "../lib/dashboard.js";
import { deriveWorkbenchNextActions, pendingGeneratedCachesForCurrentProject } from "../lib/nextActions.js";
import type { WorkbenchTab } from "../hooks/useWorkbenchController.js";

const REVISION_LOG_PATH = "00_设定集/修正日志/正文二次修正日志.txt";

export function OverviewView({
  snapshot,
  apiBase,
  onNavigate,
  onOpenDocument,
  onClearRevisionLog,
  onAddLedgerItem,
  onToggleLedgerItem,
  onRestoreGeneratedCache,
  onCopyGeneratedCacheContent,
  onDiscardGeneratedCacheRecord,
  busy = false
}: {
  snapshot: DashboardSnapshot;
  apiBase: string;
  onNavigate: (tab: WorkbenchTab) => void;
  onOpenDocument: (path: string) => void;
  onClearRevisionLog: (confirmDelete?: boolean) => void;
  onAddLedgerItem: (desc: string) => void;
  onToggleLedgerItem: (itemId: string) => void;
  onRestoreGeneratedCache: (cache: LocalStateGeneratedCache) => void;
  onCopyGeneratedCacheContent: (cache: LocalStateGeneratedCache) => void;
  onDiscardGeneratedCacheRecord: (cache: LocalStateGeneratedCache) => void;
  busy?: boolean;
}) {
  const nextActions = deriveWorkbenchNextActions(snapshot);
  const [confirmClearRevisionLog, setConfirmClearRevisionLog] = useState(false);
  const [ledgerDraft, setLedgerDraft] = useState("");
  const [showAllGeneratedCaches, setShowAllGeneratedCaches] = useState(false);
  const recentRevisionLog = snapshot.revisionLog.slice(0, 4);
  const openLedgerItems = snapshot.ledger.filter((item) => item.status === "open");
  const closedLedgerItems = snapshot.ledger.filter((item) => item.status === "closed").slice(0, 4);
  const currentPendingGeneratedCaches = pendingGeneratedCachesForCurrentProject(snapshot);
  const pendingGeneratedCaches = showAllGeneratedCaches ? currentPendingGeneratedCaches : currentPendingGeneratedCaches.slice(0, 6);
  const hiddenGeneratedCacheCount = Math.max(0, currentPendingGeneratedCaches.length - pendingGeneratedCaches.length);

  function handleClearRevisionLog() {
    if (!confirmClearRevisionLog) {
      setConfirmClearRevisionLog(true);
      return;
    }
    setConfirmClearRevisionLog(false);
    onClearRevisionLog(true);
  }

  function handleAddLedgerItem() {
    const text = ledgerDraft.trim();
    if (!text) {
      return;
    }
    onAddLedgerItem(text);
    setLedgerDraft("");
  }

  const summaryCards = [
    {
      label: "后端",
      value: snapshot.health.version,
      detail: snapshot.desktopBackend?.ready ? `PID ${snapshot.desktopBackend.pid ?? "?"}` : snapshot.license.licensed ? "已授权" : "待授权",
      icon: Activity
    },
    {
      label: "当前项目",
      value: snapshot.currentProject.name,
      detail: snapshot.currentProject.path,
      icon: FolderKanban
    },
    {
      label: "主模型",
      value: snapshot.config.model || "未配置",
      detail: snapshot.config.base_url || "未设置 Base URL",
      icon: Bot
    },
    {
      label: "技能数",
      value: String(snapshot.skills.length),
      detail: `会话 ${snapshot.conversations.length} / 任务 ${snapshot.jobs.length}`,
      icon: LibraryBig
    }
  ];

  const activityCards = [
    {
      title: "授权与模型",
      icon: ShieldCheck,
      lines: [
        `授权状态：${snapshot.license.licensed ? "已激活" : snapshot.license.status || "未激活"}`,
        `向量召回：${snapshot.config.embedding_enabled ? "开启" : "关闭"}`,
        `联网素材搜索：${describeWebSearchStatus(snapshot.config)}`
      ]
    },
    {
      title: "工作流队列",
      icon: Sparkles,
      lines: [
        `运行中任务：${snapshot.jobs.filter((job) => job.status === "running").length}`,
        `本地任务快照：${snapshot.localState?.recent_projects.find((project) => project.path === snapshot.currentProject.path)?.job_count ?? 0} 条`,
        `待处理生成缓存：${currentPendingGeneratedCaches.length} 条`,
        `伏笔账本：${snapshot.ledger.filter((item) => item.status === "open").length} 条未关闭`,
        `修正日志：${snapshot.revisionLog.length} 条`
      ]
    },
    {
      title: "上下文资产",
      icon: ScrollText,
      lines: [
        `技能目录：${snapshot.skills.length} 项`,
        `会话历史：${snapshot.conversations.length} 条`,
        `本地会话索引：${snapshot.localState?.recent_projects.find((project) => project.path === snapshot.currentProject.path)?.conversation_count ?? 0} 条`,
        `时间线：${snapshot.timeline.length} 条`
      ]
    }
  ];
  const capabilityCards = snapshot.desktopCapabilities
    ? [
        { label: "终端", capability: snapshot.desktopCapabilities.terminal, icon: TerminalSquare },
        { label: "本地库", capability: snapshot.desktopCapabilities.localDatabase, icon: Database },
        { label: "下载", capability: snapshot.desktopCapabilities.downloads, icon: Download },
        { label: "监控", capability: snapshot.desktopCapabilities.monitoring, icon: MonitorDot }
      ]
    : [];

  return (
    <motion.section
      className="content-stack"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="summary-grid">
        {summaryCards.map((card, index) => (
          <motion.article
            key={card.label}
            className="summary-card"
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 * index, duration: 0.35 }}
          >
            <div className="summary-head">
              <span>{card.label}</span>
              <card.icon size={17} />
            </div>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
          </motion.article>
        ))}
      </div>

      <div className="panel-grid">
        <section className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Next</p>
              <h2>下一步建议</h2>
            </div>
            <Sparkles size={17} />
          </div>
          <div className="next-action-grid">
            {nextActions.map((action) => (
              <button key={`${action.title}-${action.targetTab}`} className={`next-action-card ${action.priority}`} onClick={() => onNavigate(action.targetTab)}>
                <span>{action.priority === "high" ? "优先处理" : action.priority === "medium" ? "建议处理" : "可以继续"}</span>
                <strong>{action.title}</strong>
                <p>{action.detail}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Generated</p>
              <h2>待处理生成结果</h2>
            </div>
            <div className="tiny-pill">
              <ArchiveRestore size={14} />
              <span>{currentPendingGeneratedCaches.length} 条待确认</span>
            </div>
          </div>
          <div className="generated-cache-list">
            {pendingGeneratedCaches.map((cache) => (
              <GeneratedCacheCard
                key={cache.cache_id}
                cache={cache}
                busy={busy}
                onOpenDocument={onOpenDocument}
                onRestore={onRestoreGeneratedCache}
                onCopy={onCopyGeneratedCacheContent}
                onDiscard={onDiscardGeneratedCacheRecord}
              />
            ))}
            {!pendingGeneratedCaches.length && <p className="empty-copy">当前没有遗留的生成结果缓存。</p>}
            {currentPendingGeneratedCaches.length > 6 && (
              <button className="ghost-button generated-cache-toggle" onClick={() => setShowAllGeneratedCaches((value) => !value)} disabled={busy}>
                <ArchiveRestore size={15} />
                <span>{showAllGeneratedCaches ? "收起列表" : `显示全部，另有 ${hiddenGeneratedCacheCount} 条`}</span>
              </button>
            )}
          </div>
        </section>

        <section className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Ledger</p>
              <h2>伏笔账本</h2>
            </div>
            <div className="tiny-pill">
              <BookCopy size={14} />
              <span>{openLedgerItems.length} 条未回收</span>
            </div>
          </div>
          <div className="ledger-compose">
            <input
              value={ledgerDraft}
              onChange={(event) => setLedgerDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  handleAddLedgerItem();
                }
              }}
              placeholder="记一条伏笔、线索或待回收承诺"
              disabled={busy || !snapshot.currentProject.path}
            />
            <button className="refresh-button" onClick={handleAddLedgerItem} disabled={busy || !ledgerDraft.trim() || !snapshot.currentProject.path}>
              <Plus size={15} />
              <span>加入账本</span>
            </button>
          </div>
          <div className="ledger-list">
            {openLedgerItems.slice(0, 8).map((item) => (
              <LedgerCard key={item.id} item={item} onToggle={onToggleLedgerItem} busy={busy} />
            ))}
            {!openLedgerItems.length && <p className="empty-copy">当前没有未回收伏笔。可以在这里记录新线索，后续写到正文里再标记完成。</p>}
          </div>
          {closedLedgerItems.length > 0 && (
            <details className="ledger-closed-group">
              <summary>最近已回收伏笔</summary>
              <div className="ledger-list">
                {closedLedgerItems.map((item) => (
                  <LedgerCard key={item.id} item={item} onToggle={onToggleLedgerItem} busy={busy} />
                ))}
              </div>
            </details>
          )}
        </section>

        <section className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Runtime</p>
              <h2>运行时概况</h2>
            </div>
            <div className="tiny-pill">
              <TerminalSquare size={14} />
              <span>{snapshot.desktopBackend?.url || apiBase}</span>
            </div>
          </div>
          <div className="runtime-list">
            {activityCards.map((card) => (
              <article key={card.title} className="runtime-card">
                <div className="runtime-title">
                  <card.icon size={16} />
                  <strong>{card.title}</strong>
                </div>
                {card.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </article>
            ))}
          </div>
          {capabilityCards.length > 0 && (
            <div className="capability-grid" data-testid="desktop-capability-grid">
              {capabilityCards.map((card) => (
                <article key={card.label} className={`capability-card ${card.capability.available ? "ready" : "idle"}`}>
                  <div className="runtime-title">
                    <card.icon size={16} />
                    <strong>{card.label}</strong>
                  </div>
                  <p>{card.capability.available ? `${card.capability.package} 可用` : card.capability.reason || `${card.capability.package} 未就绪`}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Revision</p>
              <h2>AI 修正日志</h2>
            </div>
            <div className="action-pair">
              <button className="ghost-button" onClick={() => onOpenDocument(REVISION_LOG_PATH)} disabled={busy || !snapshot.currentProject.path}>
                <FileText size={15} />
                <span>打开日志</span>
              </button>
              <button className={confirmClearRevisionLog ? "refresh-button" : "ghost-button"} onClick={handleClearRevisionLog} disabled={busy || !snapshot.revisionLog.length}>
                <Trash2 size={15} />
                <span>{confirmClearRevisionLog ? "确认清空" : "清空"}</span>
              </button>
            </div>
          </div>
          {confirmClearRevisionLog && <p className="revision-warning">再次点击会清空修正日志文件，不会改动正文。</p>}
          <div className="revision-log-list">
            {recentRevisionLog.map((entry, index) => (
              <RevisionLogCard key={entry.id || `${entry.path}-${entry.timestamp}-${index}`} entry={entry} onOpenDocument={onOpenDocument} />
            ))}
            {!recentRevisionLog.length && <p className="empty-copy">暂无 AI 二次修正记录。</p>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Recent State</p>
              <h2>最新快照</h2>
            </div>
            <span className="timestamp">{formatDate(snapshot.fetchedAt)}</span>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Base URL</dt>
              <dd>{snapshot.config.base_url || "未配置"}</dd>
            </div>
            <div>
              <dt>Embedding</dt>
              <dd>{snapshot.config.embedding_model || "未配置"}</dd>
            </div>
            <div>
              <dt>联网搜索</dt>
              <dd>{describeWebSearchStatus(snapshot.config)}</dd>
            </div>
            <div>
              <dt>当前项目路径</dt>
              <dd>{snapshot.currentProject.path}</dd>
            </div>
            <div>
              <dt>最近错误</dt>
              <dd>{snapshot.desktopBackend?.error || "暂无"}</dd>
            </div>
            <div>
              <dt>桌面能力</dt>
              <dd>{snapshot.desktopCapabilities ? "已完成本地能力探测" : "浏览器模式未启用"}</dd>
            </div>
            <div>
              <dt>本地偏好</dt>
              <dd>{snapshot.localState?.settings.updated_at ? `已保存 ${formatDate(snapshot.localState.settings.updated_at)}` : "未写入"}</dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Collections</p>
              <h2>迁移优先资产</h2>
            </div>
            <BookCopy size={17} />
          </div>
          <ul className="asset-list">
            <li>配置表单已经能保存到 `/api/config`</li>
            <li>项目树、资料卡和时间线现在来自 `project/chrome`</li>
            <li>会话视图已接入列表、详情和新建逻辑</li>
          </ul>
        </section>
      </div>
    </motion.section>
  );
}

function GeneratedCacheCard({
  cache,
  busy,
  onOpenDocument,
  onRestore,
  onCopy,
  onDiscard
}: {
  cache: LocalStateGeneratedCache;
  busy: boolean;
  onOpenDocument: (path: string) => void;
  onRestore: (cache: LocalStateGeneratedCache) => void;
  onCopy: (cache: LocalStateGeneratedCache) => void;
  onDiscard: (cache: LocalStateGeneratedCache) => void;
}) {
  const paths = cache.target_paths.length ? cache.target_paths : [cache.target_path].filter(Boolean);
  const primaryTarget = paths[0] || "";
  const targetLabel = paths.length > 1 ? `${paths[0]} 等 ${paths.length} 个文件` : paths[0] || "尚未指定目标";
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  return (
    <article className="generated-cache-card">
      <div className="generated-cache-head">
        <div>
          <strong>{targetLabel}</strong>
          <p>{cache.source === "chat" ? "会话生成" : "技能生成"} · {cache.skill_id || "未标记技能"} · {cache.cache_chars} 字</p>
        </div>
        <span className="status-chip warn">{cache.mode === "append" ? "追加" : "覆盖"}</span>
      </div>
      <p>{cache.cache_path || cache.cache_id}</p>
      <div className="action-pair">
        <button className="refresh-button" onClick={() => onRestore(cache)} disabled={busy}>
          <ArchiveRestore size={15} />
          <span>恢复处理</span>
        </button>
        <button className="ghost-button" onClick={() => onCopy(cache)} disabled={busy}>
          <Copy size={15} />
          <span>复制内容</span>
        </button>
        {primaryTarget && (
          <button className="ghost-button" onClick={() => onOpenDocument(primaryTarget)} disabled={busy}>
            <FileText size={15} />
            <span>打开目标</span>
          </button>
        )}
        <button
          className={confirmDiscard ? "refresh-button" : "ghost-button"}
          onClick={() => {
            if (!confirmDiscard) {
              setConfirmDiscard(true);
              return;
            }
            setConfirmDiscard(false);
            onDiscard(cache);
          }}
          disabled={busy}
        >
          <Trash2 size={15} />
          <span>{confirmDiscard ? "确认丢弃" : "丢弃"}</span>
        </button>
      </div>
      {confirmDiscard && <p className="preview-warning">再次点击会丢弃这条缓存记录；可以先复制内容。</p>}
    </article>
  );
}

function LedgerCard({ item, onToggle, busy }: { item: LedgerItem; onToggle: (itemId: string) => void; busy: boolean }) {
  const isClosed = item.status === "closed";

  return (
    <article className={`ledger-card ${isClosed ? "closed" : ""}`}>
      <div>
        <strong>{item.desc}</strong>
        <p>{formatDate(item.updated_at || item.created_at)}</p>
      </div>
      <button className={isClosed ? "ghost-button" : "refresh-button"} onClick={() => onToggle(item.id)} disabled={busy}>
        {isClosed ? <Undo2 size={15} /> : <CheckCircle2 size={15} />}
        <span>{isClosed ? "重新打开" : "标记回收"}</span>
      </button>
    </article>
  );
}

function RevisionLogCard({ entry, onOpenDocument }: { entry: RevisionLogEntry; onOpenDocument: (path: string) => void }) {
  const path = entry.path || "";
  const score = typeof entry.score === "number" ? `${entry.score} 分` : "未评分";

  return (
    <article className="revision-log-card">
      <div className="revision-log-head">
        <div>
          <strong>{path || "未标记文件"}</strong>
          <p>{entry.timestamp || "时间未知"} · {score}</p>
        </div>
        {path && (
          <button className="ghost-button" onClick={() => onOpenDocument(path)}>
            <FileText size={15} />
            <span>打开正文</span>
          </button>
        )}
      </div>
      {entry.risks.length > 0 && (
        <div className="revision-risk-list">
          {entry.risks.slice(0, 5).map((risk) => (
            <span key={risk}>{risk}</span>
          ))}
        </div>
      )}
      <p>{compactRevisionExcerpt(entry.excerpt || entry.raw || "")}</p>
    </article>
  );
}

function compactRevisionExcerpt(value: string): string {
  const text = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return text.length > 240 ? `${text.slice(0, 240)}...` : text || "没有可预览内容。";
}

function describeWebSearchStatus(config: DashboardSnapshot["config"]): string {
  if (!config.web_search_enabled) {
    return "关闭";
  }
  if (config.web_search_provider === "custom" && !config.web_search_base_url?.trim()) {
    return "自定义接口待配置";
  }
  const provider = config.web_search_provider === "custom" ? "自定义接口" : config.web_search_provider === "duckduckgo" ? "DuckDuckGo" : "Bing";
  return `${provider}，最多 ${config.web_search_max_results ?? 3} 条`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
