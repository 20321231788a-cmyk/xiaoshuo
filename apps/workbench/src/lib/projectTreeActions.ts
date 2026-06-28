import type { TreeNode } from "@xiaoshuo/shared";

const INVALID_FILE_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const SUPPORTED_FILE_EXTENSIONS = new Set([".txt", ".md"]);

export function normalizeNewProjectFileName(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("请输入文件名。");
  }
  if (INVALID_FILE_NAME_CHARS.test(raw) || /^\.+$/.test(raw) || raw.endsWith(".")) {
    throw new Error("文件名不能包含 / \\ : * ? \" < > |，也不能只由点号组成。");
  }

  const extensionIndex = raw.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return `${raw}.txt`;
  }

  const extension = raw.slice(extensionIndex).toLowerCase();
  if (!SUPPORTED_FILE_EXTENSIONS.has(extension)) {
    throw new Error("项目树新建文件只支持 .txt 或 .md。");
  }
  return raw;
}

export function parentDirectoryPath(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function childProjectPath(directoryPath: string, fileName: string): string {
  const directory = normalizeProjectPath(directoryPath);
  return directory ? `${directory}/${fileName}` : fileName;
}

export function treePathExists(nodes: TreeNode[], targetPath: string): boolean {
  const normalizedTarget = normalizeProjectPath(targetPath);
  for (const node of nodes) {
    if (normalizeProjectPath(node.path) === normalizedTarget) {
      return true;
    }
    if (treePathExists(node.children || [], normalizedTarget)) {
      return true;
    }
  }
  return false;
}

function normalizeProjectPath(projectPath: string): string {
  return String(projectPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
