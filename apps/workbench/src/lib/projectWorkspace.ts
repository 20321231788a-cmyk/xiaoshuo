import type { TreeNode } from "@xiaoshuo/shared";

const starterDocumentCandidates = ["01_大纲/大纲.txt", "02_正文/正文.txt", "01_大纲/细纲.txt", "01_大纲/章纲.txt"];

function flattenFilePaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];

  for (const node of nodes) {
    if (node.kind === "file") {
      paths.push(node.path);
      continue;
    }

    paths.push(...flattenFilePaths(node.children));
  }

  return paths;
}

export function findStarterDocumentPath(tree: TreeNode[], options: { lastActivePath?: string } = {}): string {
  const filePaths = flattenFilePaths(tree);
  if (!filePaths.length) {
    return "";
  }

  const fileSet = new Set(filePaths);
  if (options.lastActivePath && fileSet.has(options.lastActivePath)) {
    return options.lastActivePath;
  }

  const latestBody = findLatestBodyPath(filePaths);
  if (latestBody) {
    return latestBody;
  }

  for (const candidate of starterDocumentCandidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }

  const outlineFallback = filePaths.find((path) => path.startsWith("01_大纲/") && path.endsWith(".txt"));
  if (outlineFallback) {
    return outlineFallback;
  }

  const bodyFallback = filePaths.find((path) => path.startsWith("02_正文/") && path.endsWith(".txt"));
  if (bodyFallback) {
    return bodyFallback;
  }

  return filePaths.find((path) => path.endsWith(".txt")) || filePaths[0] || "";
}

function findLatestBodyPath(filePaths: string[]): string {
  const bodyPaths = filePaths.filter((path) => path.startsWith("02_正文/") && path.endsWith(".txt"));
  if (!bodyPaths.length) {
    return "";
  }

  return [...bodyPaths].sort((left, right) => {
    const rightChapter = chapterNumber(right);
    const leftChapter = chapterNumber(left);
    if (rightChapter !== leftChapter) {
      return rightChapter - leftChapter;
    }
    return right.localeCompare(left, "zh-CN", { numeric: true });
  })[0] || "";
}

function chapterNumber(path: string): number {
  const match = path.match(/第\s*0*(\d+)\s*[章节回]/);
  return match ? Number(match[1]) : -1;
}
