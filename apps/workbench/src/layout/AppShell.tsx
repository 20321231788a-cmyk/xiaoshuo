import type { CSSProperties, ReactNode } from "react";

export function AppShell({
  rightWidth,
  left,
  center,
  splitter,
  right,
  dialog
}: {
  rightWidth: number;
  left: ReactNode;
  center: ReactNode;
  splitter: ReactNode;
  right: ReactNode;
  dialog?: ReactNode;
}) {
  return (
    <div className="shell xw-shell">
      <main className="xw-workspace-shell" style={{ "--xw-right-col": `${rightWidth}px` } as CSSProperties}>
        {left}
        <section className="xw-center surface">{center}</section>
        {splitter}
        {right}
      </main>
      {dialog}
    </div>
  );
}
