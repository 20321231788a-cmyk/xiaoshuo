import type { TreeNode } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";

function flattenProjectFilePaths(nodes: TreeNode[] = []): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      paths.push(node.path);
    }
    if (node.children?.length) {
      paths.push(...flattenProjectFilePaths(node.children));
    }
  }
  return paths;
}

export function ProjectFileSelect({
  label,
  value,
  onChange,
  controller,
  emptyLabel = "留空使用当前文档或粘贴文本"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  controller: WorkbenchController;
  emptyLabel?: string;
}) {
  const files = flattenProjectFilePaths(controller.snapshot?.projectChrome.tree || []);
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  const hasValue = Boolean(value && (files.includes(value) || value === activeDocument?.path));
  const selectableFiles = activeDocument ? files.filter((path) => path !== activeDocument.path) : files;
  return (
    <label>
      <span>{label}</span>
      <div style={{ display: "flex", gap: "8px" }}>
        <select value={hasValue ? value : ""} onChange={(event) => onChange(event.target.value)} style={{ flex: 1, minWidth: 0 }}>
          <option value="">{emptyLabel}</option>
          {activeDocument && <option value={activeDocument.path}>当前文档：{activeDocument.title}</option>}
          {selectableFiles.map((path) => (
            <option key={path} value={path}>{path}</option>
          ))}
        </select>
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="也可输入项目相对路径" style={{ flex: 1, minWidth: 0 }} />
      </div>
    </label>
  );
}

export function AutoReviewGeneratedToggle({ controller }: { controller: WorkbenchController }) {
  const enabled = Boolean(controller.configDraft?.enable_consistency_revision);
  return (
    <label className="xw-check-row">
      <input
        type="checkbox"
        checked={enabled}
        onChange={() => controller.patchConfig({ enable_consistency_revision: !enabled })}
      />
      <span>自动审查生成文件</span>
    </label>
  );
}
