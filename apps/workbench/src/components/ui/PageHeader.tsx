import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, detail, actions }: { eyebrow?: string; title: string; detail?: string; actions?: ReactNode }) {
  return (
    <header className="xw-page-header">
      <div>
        {eyebrow && <span>{eyebrow}</span>}
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
      </div>
      {actions && <div className="xw-page-header-actions">{actions}</div>}
    </header>
  );
}
