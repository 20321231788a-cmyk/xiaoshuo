import { ChevronDown, PanelRightClose, Sparkles } from "lucide-react";
import type { UserFeature } from "../navigation.js";
import { workbenchFooterNavigation, workbenchNavigation } from "../navigation.js";

export function WorkbenchNavigation({
  feature,
  collapsed,
  projectName,
  projectPath,
  onToggleCollapsed,
  onSelect,
  onOpenProject
}: {
  feature: UserFeature;
  collapsed: boolean;
  projectName: string;
  projectPath: string;
  onToggleCollapsed: () => void;
  onSelect: (feature: UserFeature) => void;
  onOpenProject: () => void;
}) {
  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="brand-row">
        <div className="brand-mark"><Sparkles size={17} strokeWidth={1.8} /></div>
        <div><strong>ArcWriter</strong><span>小说创作工作台</span></div>
        <button className="icon-button subtle" type="button" aria-label={collapsed ? "展开导航" : "收起导航"} title={collapsed ? "展开导航" : "收起导航"} aria-pressed={collapsed} onClick={onToggleCollapsed}><PanelRightClose size={16} /></button>
      </div>

      <button className="project-switcher" type="button" onClick={onOpenProject}>
        <div className="cover-mini">{projectName.trim().slice(0, 1) || "新"}</div>
        <span>
          <strong>{projectName || "打开小说项目"}</strong>
          <small>{projectPath || "选择本地项目目录"}</small>
        </span>
        <ChevronDown size={15} />
      </button>

      <nav className="nav-groups" aria-label="主导航">
        {workbenchNavigation.map((group) => (
          <div className="nav-group" key={group.label}>
            <span className="nav-label">{group.label}</span>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = feature === item.feature;
              return (
                <button
                  key={item.feature}
                  type="button"
                  className={`nav-item ${active ? "active" : ""}`}
                  onClick={() => onSelect(item.feature)}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        {workbenchFooterNavigation.map((item) => {
          const Icon = item.icon;
          const active = feature === item.feature;
          return (
            <button
              key={item.feature}
              type="button"
              className={`nav-item ${active ? "active" : ""}`}
              onClick={() => onSelect(item.feature)}
              aria-current={active ? "page" : undefined}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={16} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <div className="save-state">
          <span>已保存到本地</span>
        </div>
      </div>
    </aside>
  );
}
