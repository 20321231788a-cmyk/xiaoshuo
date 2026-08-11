import { DocumentService } from "@xiaoshuo/document-service";
import type { ProjectFileReferenceCandidate } from "@xiaoshuo/shared";
import type { ContextBlock } from "./context-block.js";

export async function buildReferenceContextBlocks(input: {
  documents: DocumentService;
  references: ProjectFileReferenceCandidate[];
  maxCharsPerFile: number;
}): Promise<ContextBlock[]> {
  const blocks: ContextBlock[] = [];
  const maxCharsPerFile = Math.max(500, Math.trunc(input.maxCharsPerFile || 12000));

  for (const reference of input.references) {
    if (!reference.path || reference.readable === false) {
      continue;
    }
    const text = await input.documents.readRawText(reference.path, maxCharsPerFile).catch(() => "");
    if (!text.trim()) {
      continue;
    }
    blocks.push({
      id: `reference:${reference.path}`,
      title: `参考文件：${reference.path}`,
      source: "document",
      priority: "high",
      content: [`【参考文件：${reference.path}】`, `【引用原因：${reference.reason || "用户引用"}】`, "", text].join("\n"),
      maxChars: maxCharsPerFile,
      metadata: {
        role: "reference_file",
        path: reference.path,
        label: reference.label,
        kind: reference.kind,
        confidence: reference.confidence,
        reason: reference.reason,
        matched_text: reference.matched_text
      }
    });
  }

  return blocks;
}
