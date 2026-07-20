import type { ReactNode } from "react";

export function AppShell({
  navigation,
  topbar,
  center,
  dialog,
  navigationCollapsed = false
}: {
  navigation: ReactNode;
  topbar: ReactNode;
  center: ReactNode;
  dialog?: ReactNode;
  navigationCollapsed?: boolean;
}) {
  return (
    <div className={`app-shell${navigationCollapsed ? " nav-collapsed" : ""}`}>
      {navigation}
      <section className="app-main">
        {topbar}
        <div className="page-slot">
          {center}
        </div>
      </section>
      {dialog}
    </div>
  );
}
