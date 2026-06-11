import type { ComponentPropsWithoutRef, ReactNode } from "react";

export function Panel({
  title,
  eyebrow,
  aside,
  children,
  className = "",
  ...sectionProps
}: {
  title: string;
  eyebrow: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
} & ComponentPropsWithoutRef<"section">) {
  return (
    <section className={`panel ${className}`.trim()} {...sectionProps}>
      <div className="panel-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
