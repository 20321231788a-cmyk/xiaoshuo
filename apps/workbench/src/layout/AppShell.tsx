import type { CSSProperties, ReactNode } from "react";

export function AppShell({
  rightWidth,
  rightOpen,
  navigation,
  left,
  center,
  splitter,
  right,
  dialog
}: {
  rightWidth: number;
  rightOpen: boolean;
  navigation: ReactNode;
  left: ReactNode;
  center: ReactNode;
  splitter: ReactNode;
  right: ReactNode;
  dialog?: ReactNode;
}) {
  return (
    <div className="shell xw-shell">
      <main className={`xw-workspace-shell ${rightOpen ? "right-open" : "right-closed"}`} style={{ "--xw-right-col": `${rightWidth}px` } as CSSProperties}>
        {navigation}
        {left}
        <section className="xw-center surface">{center}</section>
        {splitter}
        {right}
      </main>
      {dialog}
    </div>
  );
}
