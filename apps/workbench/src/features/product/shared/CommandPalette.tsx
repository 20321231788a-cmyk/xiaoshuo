import { FileText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductCommand, ProductRoute } from "../../../navigation.js";

export type SearchableDocument = { path: string; title: string };

export function CommandPalette({
  open,
  commands,
  documents,
  onClose,
  onNavigate,
  onOpenDocument
}: {
  open: boolean;
  commands: ProductCommand[];
  documents: SearchableDocument[];
  onClose: () => void;
  onNavigate: (route: ProductRoute) => void;
  onOpenDocument: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const visibleCommands = useMemo(
    () => commands.filter((command) => !normalized || [command.label, command.detail, ...command.keywords].join(" ").toLocaleLowerCase("zh-CN").includes(normalized)),
    [commands, normalized]
  );
  const visibleDocuments = useMemo(
    () => documents.filter((document) => normalized && `${document.title} ${document.path}`.toLocaleLowerCase("zh-CN").includes(normalized)).slice(0, 12),
    [documents, normalized]
  );

  if (!open) return null;

  return (
    <div className="aw-command-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="aw-command-palette" role="dialog" aria-modal="true" aria-label="搜索项目与命令">
        <label className="aw-command-search">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索页面、章节或命令"
            aria-label="搜索页面、章节或命令"
          />
          <kbd>Esc</kbd>
        </label>
        <div className="aw-command-results">
          {visibleDocuments.length > 0 && (
            <div className="aw-command-group">
              <span>项目文档</span>
              {visibleDocuments.map((document) => (
                <button key={document.path} type="button" onClick={() => { onOpenDocument(document.path); onClose(); }}>
                  <FileText size={15} />
                  <span><strong>{document.title}</strong><small>{document.path}</small></span>
                </button>
              ))}
            </div>
          )}
          <div className="aw-command-group">
            <span>页面与命令</span>
            {visibleCommands.map((command) => (
              <button key={command.id} type="button" onClick={() => { onNavigate(command.route); onClose(); }}>
                <Search size={15} />
                <span><strong>{command.label}</strong><small>{command.detail}</small></span>
              </button>
            ))}
          </div>
          {!visibleCommands.length && !visibleDocuments.length && <p className="aw-command-empty">没有匹配的页面或文档。</p>}
        </div>
      </section>
    </div>
  );
}
