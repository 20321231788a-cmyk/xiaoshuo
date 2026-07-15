import { BookOpen, Clock3, FileText, FolderOpen, FolderPlus, MessageSquareText, PenLine, RefreshCw } from "lucide-react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";
import type { CenterFeature } from "../../navigation.js";
import { PageHeader } from "../../components/ui/PageHeader.js";

export function HomeFeaturePage({ controller, onSelectFeature }: { controller: WorkbenchController; onSelectFeature: (feature: CenterFeature) => void }) {
  const snapshot = controller.snapshot;
  if (!snapshot) return null;

  const project = snapshot.currentProject;
  const recentProjects = snapshot.localState?.recent_projects || [];
  const documentCount = countTreeFiles(snapshot.projectChrome.tree);
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || controller.openDocuments[0];

  async function openDocument(path: string) {
    const opened = await controller.openDocument(path);
    if (opened) onSelectFeature("editor");
  }

  return (
    <section className="xw-feature-page xw-home-page">
      <PageHeader
        eyebrow="当前小说"
        title={project.name || "开始一个小说项目"}
        detail={project.path || "打开本地项目，正文、大纲、设定和 AI 协作会在同一工作台中保持一致。"}
        actions={
          <>
            <button className="xw-secondary-button compact" type="button" onClick={() => controller.pickAndOpenProject("open")} disabled={controller.projectBusy}>
              <FolderOpen size={15} />打开项目
            </button>
            <button className="xw-primary-button compact" type="button" onClick={() => controller.pickAndOpenProject("create")} disabled={controller.projectBusy}>
              <FolderPlus size={15} />新建项目
            </button>
          </>
        }
      />

      {project.path ? (
        <section className="xw-home-continue" aria-label="继续写作">
          <div className="xw-home-project-mark">{project.name.trim().slice(0, 1) || "书"}</div>
          <div className="xw-home-continue-copy">
            <span>继续写作</span>
            <h2>{activeDocument?.title || "打开正文开始写作"}</h2>
            <p>{activeDocument?.path || "项目已就绪，选择正文或大纲文档继续。"}</p>
            <div>
              <button className="xw-primary-button" type="button" onClick={() => onSelectFeature("editor")}>
                <PenLine size={16} />进入正文
              </button>
              <button className="xw-secondary-button" type="button" onClick={() => onSelectFeature("conversations")}>
                <MessageSquareText size={16} />打开 AI 助手
              </button>
            </div>
          </div>
          <dl className="xw-home-facts">
            <div><dt>项目文件</dt><dd>{documentCount}</dd></div>
            <div><dt>打开文档</dt><dd>{controller.openDocuments.length}</dd></div>
            <div><dt>资料卡</dt><dd>{snapshot.projectChrome.libraries.length}</dd></div>
            <div><dt>时间记录</dt><dd>{snapshot.timeline.length}</dd></div>
          </dl>
        </section>
      ) : (
        <section className="xw-home-empty">
          <BookOpen size={24} />
          <h2>还没有打开小说项目</h2>
          <p>项目只保存在你选择的位置。打开已有目录，或创建带大纲、设定与正文结构的新项目。</p>
        </section>
      )}

      <div className="xw-home-columns">
        <section className="xw-home-section">
          <div className="xw-home-section-head"><div><span>最近项目</span><h2>继续之前的创作</h2></div><Clock3 size={18} /></div>
          <div className="xw-home-list">
            {recentProjects.slice(0, 6).map((recent) => (
              <button key={recent.path} type="button" onClick={() => void controller.openProjectFromInput(recent.path)}>
                <span className="xw-home-list-icon"><BookOpen size={15} /></span>
                <span><strong>{recent.name}</strong><small>{recent.path}</small></span>
                <time>{formatDate(recent.opened_at)}</time>
              </button>
            ))}
            {!recentProjects.length && <p className="xw-feature-empty">打开过的本地项目会出现在这里。</p>}
          </div>
        </section>

        <section className="xw-home-section">
          <div className="xw-home-section-head"><div><span>项目资料</span><h2>设定与规划</h2></div><FileText size={18} /></div>
          <div className="xw-home-list compact">
            {snapshot.projectChrome.libraries.slice(0, 6).map((card) => (
              <button key={card.key} type="button" onClick={() => void openDocument(card.path)}>
                <span className="xw-home-list-icon"><FileText size={15} /></span>
                <span><strong>{card.title}</strong><small>{card.path}</small></span>
                <em>{card.chars} 字</em>
              </button>
            ))}
            {!snapshot.projectChrome.libraries.length && <p className="xw-feature-empty">项目资料文件会显示在这里。</p>}
          </div>
          <button className="xw-home-refresh" type="button" onClick={() => void controller.refreshProjectWorkspace()} disabled={controller.projectBusy}>
            <RefreshCw size={14} />刷新项目状态
          </button>
        </section>
      </div>
    </section>
  );
}

function countTreeFiles(nodes: Array<{ kind: string; children: unknown[] }>): number {
  return nodes.reduce((total, node) => total + (node.kind === "file" ? 1 : countTreeFiles(node.children as Array<{ kind: string; children: unknown[] }>)), 0);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
