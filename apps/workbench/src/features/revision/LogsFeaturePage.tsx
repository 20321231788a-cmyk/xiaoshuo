import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";

type CenterFeature =
  | "editor"
  | "conversations"
  | "timeline"
  | "settings-set"
  | "style-library"
  | "theme-library"
  | "batch"
  | "crawl"
  | "card_draw"
  | "ledger"
  | "revision"
  | "skills"
  | "traces"
  | "consistency"
  | "settings"
  | "terminal";

export function LogsFeaturePage({ controller, onSelectFeature }: { controller: WorkbenchController; onSelectFeature: (feature: CenterFeature) => void }) {
  const logs = controller.snapshot?.revisionLog || [];
  const caches = controller.snapshot?.localState?.generated_caches || [];
  return (
    <section className="xw-feature-page">
      <div className="xw-feature-toolbar">
        <strong>修正日志</strong>
        <button className="xw-secondary-button compact" onClick={() => void controller.clearRevisionLog()} disabled={controller.projectBusy || !logs.length}>清空日志</button>
      </div>
      <div className="xw-feature-list">
        {logs.map((log, index) => (
          <article key={`${log.path}-${index}`} className="xw-feature-card">
            <div className="xw-feature-card-head">
              <strong>{log.path || "修正记录"}</strong>
              <small>{log.timestamp || (log.score ? `评分 ${log.score}` : "")}</small>
            </div>
            <span>{log.risks.length ? log.risks.join("、") : log.excerpt || log.raw || "记录了正文二次修正结果"}</span>
          </article>
        ))}
        {caches.filter((cache) => cache.status === "pending").map((cache) => (
          <article key={cache.cache_id} className="xw-feature-card">
            <div className="xw-feature-card-head">
              <strong>生成缓存：{cache.skill_id || cache.source}</strong>
              <small>{cache.cache_chars} 字</small>
            </div>
            <span>{cache.target_path || cache.target_paths.join("、") || "未指定目标"}</span>
            <div className="xw-feature-actions">
              <button className="xw-secondary-button compact" onClick={() => void controller.restoreGeneratedCache(cache)}>恢复</button>
              <button className="xw-secondary-button compact" onClick={() => void controller.copyGeneratedCacheContent(cache)}>复制</button>
              <button className="xw-danger-button compact" onClick={() => void controller.discardGeneratedCacheRecord(cache)}>丢弃</button>
            </div>
          </article>
        ))}
      </div>
      {!logs.length && !caches.length && <p className="xw-feature-empty">暂无日志或生成缓存</p>}
      <button className="xw-secondary-button compact" onClick={() => onSelectFeature("timeline")}>查看时间线</button>
    </section>
  );
}
