import type { ReactNode } from "react";

export function AppShell({
  navigation,
  left,
  center,
  dialog
}: {
  navigation: ReactNode;
  left?: ReactNode;
  center: ReactNode;
  dialog?: ReactNode;
}) {
  return (
    <div className="shell xw-shell">
      <main className={`xw-workspace-shell ${left ? "with-project-sidebar" : "page-layout"}`}>
        {navigation}
        {left}
        <section className="xw-center surface">{center}</section>
      </main>
      {dialog}
    </div>
  );
}
