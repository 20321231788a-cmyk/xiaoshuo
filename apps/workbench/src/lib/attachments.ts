export function attachmentDisplayName(name: string, maxChars = 4): string {
  const fileName = String(name || "").split(/[\\/]/).pop()?.trim() || "附件";
  const extensionIndex = fileName.lastIndexOf(".");
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex).trim() : fileName;
  return Array.from(stem || fileName).slice(0, maxChars).join("");
}
