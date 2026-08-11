import { DocumentService } from "@xiaoshuo/document-service";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReferenceContextBlocks } from "./reference-context.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-reference-context-"));
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "章纲内容".repeat(1000), "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("reference-context", () => {
  it("builds document context blocks for readable references", async () => {
    const blocks = await buildReferenceContextBlocks({
      documents: new DocumentService({ projectRoot: tempDir }),
      maxCharsPerFile: 1200,
      references: [
        {
          label: "章纲",
          path: "01_大纲/章纲.txt",
          kind: "alias",
          confidence: 0.98,
          reason: "用户提到“章纲”",
          matched_text: "章纲",
          exists: true,
          readable: true,
          chars: 100,
          updated_at: ""
        }
      ]
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: "reference:01_大纲/章纲.txt",
      source: "document",
      priority: "high",
      metadata: {
        role: "reference_file",
        path: "01_大纲/章纲.txt",
        kind: "alias"
      }
    });
    expect(blocks[0]?.content).toContain("【引用原因：用户提到“章纲”】");
    expect(blocks[0]?.content.length).toBeLessThan(1400);
  });
});
