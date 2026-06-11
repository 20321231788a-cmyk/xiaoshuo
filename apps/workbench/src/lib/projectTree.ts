import type { TreeNode } from "@xiaoshuo/shared";

export function filterProjectTree(nodes: TreeNode[], query: string): TreeNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  return nodes
    .map((node) => filterProjectTreeNode(node, normalizedQuery))
    .filter((node): node is TreeNode => Boolean(node));
}

function filterProjectTreeNode(node: TreeNode, normalizedQuery: string): TreeNode | null {
  const children = node.children
    .map((child) => filterProjectTreeNode(child, normalizedQuery))
    .filter((child): child is TreeNode => Boolean(child));
  const matches = node.name.toLowerCase().includes(normalizedQuery) || node.path.toLowerCase().includes(normalizedQuery);

  if (!matches && !children.length) {
    return null;
  }

  return {
    ...node,
    children
  };
}
