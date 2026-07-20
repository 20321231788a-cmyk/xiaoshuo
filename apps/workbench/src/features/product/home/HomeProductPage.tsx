import { BookOpen, Bot, FolderOpen, PenLine, Plus } from "lucide-react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { UserFeature } from "../../../navigation.js";
import { EmptyState } from "../shared/SharedStates.js";

export function HomeProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: UserFeature) => void;
}) {
  const snapshot = controller.snapshot;
  if (!snapshot) return null;

  const project = snapshot.currentProject;
  const recentProjects = snapshot.localState?.recent_projects || [];
  const documentCount = countTreeFiles(snapshot.projectChrome.tree);
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || controller.openDocuments[0];

  if (!project.path) {
    return (
      <div className="page-scroll home-page" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <EmptyState
          title="还没有打开小说项目"
          description="项目只保存在你选择的位置。打开已有目录，或创建带大纲、设定与正文结构的新项目。"
          icon={BookOpen}
          primaryAction={{
            label: "新建小说",
            icon: Plus,
            onClick: () => void controller.pickAndOpenProject("create")
          }}
          secondaryAction={{
            label: "打开项目",
            icon: FolderOpen,
            onClick: () => void controller.pickAndOpenProject("open")
          }}
        />
      </div>
    );
  }

  return (
    <div className="page-scroll home-page">
      <div className="content-head">
        <div>
          <h1>{greeting()}，主笔</h1>
          <p>{activeDocument ? `继续编辑《${activeDocument.title}》。` : "选择一个章节开始今天的写作。"}</p>
        </div>
        <div className="content-actions">
          <button className="button secondary" type="button" onClick={() => void controller.pickAndOpenProject("open")} disabled={controller.projectBusy}>
            <FolderOpen size={15} />打开项目
          </button>
          <button className="button primary" type="button" onClick={() => void controller.pickAndOpenProject("create")} disabled={controller.projectBusy}>
            <Plus size={15} />新建小说
          </button>
        </div>
      </div>

      <section className="continue-band">
        <div className="book-cover">
          {project.name.trim().slice(0, 2) || "小说"}
          <span>主笔 著</span>
        </div>
        <div className="continue-main">
          <span className="eyebrow">继续创作</span>
          <h2>{activeDocument?.title || "打开正文开始写作"}</h2>
          <p style={{ minHeight: "38px" }}>
            {activeDocument?.content
              ? activeDocument.content.slice(0, 100).replace(/[\r\n]+/g, " ") + (activeDocument.content.length > 100 ? "..." : "")
              : "项目已就绪，选择正文或大纲文档继续。"}
          </p>
          <div className="progress-row">
            <span>
              <i style={{ width: `${Math.min(100, ((activeDocument?.chars || 0) / 4000) * 100)}%` }} />
            </span>
            <strong>{activeDocument?.chars || 0} / 4,000 字</strong>
          </div>
          <div className="inline-actions">
            <button className="button primary" type="button" onClick={() => onSelectFeature("editor")}>
              <PenLine size={15} />继续写作
            </button>
            <button className="button secondary" type="button" onClick={() => onSelectFeature("conversations")}>
              <Bot size={15} />询问 AI
            </button>
          </div>
        </div>
        <dl className="project-facts">
          <div>
            <dt>项目文件</dt>
            <dd>{documentCount}</dd>
          </div>
          <div>
            <dt>打开文档</dt>
            <dd>{controller.openDocuments.length}</dd>
          </div>
          <div>
            <dt>资料卡</dt>
            <dd>{snapshot.projectChrome.libraries.length}</dd>
          </div>
          <div>
            <dt>改稿记录</dt>
            <dd>{snapshot.timeline.length}</dd>
          </div>
        </dl>
      </section>

      <div className="home-grid">
        <section className="home-section recent-section">
          <div className="section-title">
            <h3>最近项目</h3>
          </div>
          {recentProjects.slice(0, 4).map((recent, index) => (
            <button
              className={`project-row ${recent.path === project.path ? "selected" : ""}`}
              key={recent.path}
              type="button"
              onClick={() => void controller.openProjectFromInput(recent.path)}
            >
              <span className={`project-glyph tone-${index % 3}`}>{recent.name.trim().slice(0, 1)}</span>
              <span>
                <strong>{recent.name}</strong>
                <small>{recent.path}</small>
              </span>
              <time>{formatDate(recent.opened_at)}</time>
            </button>
          ))}
          {!recentProjects.length && <p className="xw-feature-empty" style={{ fontSize: "12px", color: "var(--muted)", padding: "10px" }}>最近打开过的项目会显示在这里。</p>}
        </section>

        <section className="home-section today-section">
          <div className="section-title">
            <h3>当前写作</h3>
          </div>
          <div className="today-total">
            <strong>{activeDocument?.chars || 0}</strong>
            <span>字</span>
            <small>{activeDocument?.dirty ? "有未保存修改" : "已保存到本地"}</small>
          </div>
          <p className="quiet-note">
            {activeDocument ? `当前章节最后读取于 ${formatDate(activeDocument.updatedAt) || "本次会话"}` : "打开正文后，这里会显示当前章节状态。"}
          </p>
        </section>
      </div>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "上午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function countTreeFiles(nodes: Array<{ kind: string; children: any[] }>): number {
  return nodes.reduce(
    (total, node) =>
      total + (node.kind === "file" ? 1 : countTreeFiles(node.children || [])),
    0
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
