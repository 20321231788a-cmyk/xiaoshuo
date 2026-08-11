import type { TreeNode } from "@xiaoshuo/shared";
import { FilePlus2, FileText, Folder, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent as ReactFormEvent } from "react";
import { parentDirectoryPath } from "../../lib/projectTreeActions.js";

export function ProjectTreeNode({
  node,
  activePath,
  busy,
  onOpenDocument,
  onCreateFile,
  onDeleteFile
}: {
  node: TreeNode;
  activePath: string;
  busy: boolean;
  onOpenDocument: (path: string) => void | Promise<void>;
  onCreateFile: (directoryPath: string, fileName: string) => Promise<boolean>;
  onDeleteFile: (path: string) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fileNameDraft, setFileNameDraft] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isFile = node.kind === "file";
  const createDirectoryPath = isFile ? parentDirectoryPath(node.path) : node.path;

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeOnOutsideClick(event: MouseEvent) {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      setMenuOpen(false);
      setDeleteConfirm(false);
    }

    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => window.removeEventListener("mousedown", closeOnOutsideClick);
  }, [menuOpen]);

  async function submitCreateFile(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await onCreateFile(createDirectoryPath, fileNameDraft);
    if (!created) {
      return;
    }
    setFileNameDraft("");
    setMenuOpen(false);
    setDeleteConfirm(false);
    if (!isFile) {
      setExpanded(true);
    }
  }

  async function confirmDeleteFile() {
    if (!isFile) {
      return;
    }
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    const deleted = await onDeleteFile(node.path);
    if (deleted) {
      setMenuOpen(false);
      setDeleteConfirm(false);
    }
  }

  return (
    <div className="xw-tree-node">
      <button
        className={`xw-tree-row ${isFile ? "file" : "dir"} ${activePath === node.path ? "active" : ""}`}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(true);
          setDeleteConfirm(false);
        }}
        onClick={() => {
          if (isFile) {
            void onOpenDocument(node.path);
            return;
          }
          setExpanded((value) => !value);
        }}
      >
        {isFile ? <FileText size={15} /> : <Folder size={15} />}
        <span>{node.name}</span>
        {!isFile && <em>{expanded ? "-" : "+"}</em>}
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="xw-tree-context-menu"
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="xw-tree-context-head">
            <strong title={node.path}>{node.name}</strong>
            <span>{isFile ? "文件" : "文件夹"}</span>
          </div>
          <form className="xw-tree-create-form" onSubmit={submitCreateFile}>
            <input
              value={fileNameDraft}
              onChange={(event) => setFileNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setMenuOpen(false);
                  setDeleteConfirm(false);
                }
              }}
              placeholder={isFile ? "同级新文件名" : "新文件名"}
              disabled={busy}
              autoFocus
            />
            <button type="submit" className="xw-secondary-button compact" disabled={busy || !fileNameDraft.trim()}>
              <FilePlus2 size={13} />
              <span>创建</span>
            </button>
          </form>
          {isFile && (
            <button type="button" className="xw-danger-button compact" onClick={confirmDeleteFile} disabled={busy}>
              <Trash2 size={13} />
              <span>{deleteConfirm ? "确认删除" : "删除文件"}</span>
            </button>
          )}
        </div>
      )}
      {!isFile && expanded && node.children.length > 0 && (
        <div className="xw-tree-children">
          {node.children.map((child) => (
            <ProjectTreeNode
              key={child.path}
              node={child}
              activePath={activePath}
              busy={busy}
              onOpenDocument={onOpenDocument}
              onCreateFile={onCreateFile}
              onDeleteFile={onDeleteFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
