import { ChevronRight, Sparkles } from "lucide-react";
import type { CenterFeature } from "../navigation.js";
import { workbenchNavigation } from "../navigation.js";

export function WorkbenchNavigation({
  feature,
  projectName,
  projectPath,
  onSelect,
  onOpenProject
}: {
  feature: CenterFeature;
  projectName: string;
  projectPath: string;
  onSelect: (feature: CenterFeature) => void;
  onOpenProject: () => void;
}) {
  return (
    <aside className="xw-primary-nav" aria-label="主导航">
      <div className="xw-nav-brand">
        <span><Sparkles size={17} /></span>
        <div>
          <strong>ArcWriter</strong>
          <small>小说创作工作台</small>
        </div>
      </div>

      <button className="xw-nav-project" type="button" onClick={onOpenProject} title={projectPath || "打开小说项目"}>
        <span className="xw-nav-project-mark">{projectName.trim().slice(0, 1) || "新"}</span>
        <span>
          <strong>{projectName || "打开小说项目"}</strong>
          <small>{projectPath || "选择本地项目目录"}</small>
        </span>
        <ChevronRight size={15} />
      </button>

      <nav className="xw-nav-groups">
        {workbenchNavigation.map((group) => (
          <section key={group.label} className="xw-nav-group" aria-label={group.label}>
            <span className="xw-nav-group-label">{group.label}</span>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = feature === item.feature ||
                (item.feature === "studio" && feature === "novel_agent") ||
                (item.feature === "review" && feature === "consistency");
              return (
                <button
                  key={item.feature}
                  type="button"
                  className={active ? "active" : ""}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  onClick={() => onSelect(item.feature)}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </section>
        ))}
      </nav>

    </aside>
  );
}
