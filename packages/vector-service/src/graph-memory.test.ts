import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphExtractor } from "./graph-extractor.js";
import { GraphMemory } from "./graph-memory.js";
import { VectorDb } from "./vector-db.js";

describe("GraphMemory", () => {
  let tempDir = "";
  let db: VectorDb | null = null;
  let memory: GraphMemory | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoshuo-graph-memory-test-"));
    fs.mkdirSync(path.join(tempDir, "00_设定集", ".agent"), { recursive: true });
    db = new VectorDb(tempDir);
    memory = new GraphMemory(tempDir);
  });

  afterEach(() => {
    memory?.close();
    db?.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function insertChunk(input: {
    path: string;
    sourceType: string;
    title: string;
    text: string;
    chunkIndex?: number;
  }): void {
    db!.init();
    db!.db.prepare(`
      INSERT INTO chunks(path, source_type, title, chunk_index, start_char, end_char, text, text_hash, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.path,
      input.sourceType,
      input.title,
      input.chunkIndex ?? 0,
      0,
      input.text.length,
      input.text,
      `${input.path}:${input.text.length}`,
      Date.now()
    );
  }

  it("keeps outline claims planned and body claims confirmed", () => {
    insertChunk({
      path: "01_大纲/第一章大纲.md",
      sourceType: "outline",
      title: "第一章",
      text: "陆尘将在青云山脚偶遇林风。"
    });
    insertChunk({
      path: "02_正文/第一章.txt",
      sourceType: "body",
      title: "第一章正文",
      text: "陆尘拔出太古青锋剑，与林风在山脚下对立而视。"
    });

    memory!.rebuild();

    const claims = db!.db.prepare(`
      SELECT predicate, status, source_type
      FROM graph_claims
      ORDER BY id
    `).all() as Array<{ predicate: string; status: string; source_type: string }>;

    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: "plot_plan", status: "planned", source_type: "outline" }),
        expect.objectContaining({ predicate: "occurrence", status: "confirmed", source_type: "body" })
      ])
    );
  });

  it("records appears_in when a registered character appears in body text", () => {
    insertChunk({
      path: "00_设定集/设定库/角色设定.md",
      sourceType: "lore",
      title: "角色设定",
      text: "### 陆尘\n青云宗大弟子，修为通天。"
    });
    insertChunk({
      path: "02_正文/第一章.txt",
      sourceType: "body",
      title: "第一章正文",
      text: "陆尘推开山门。"
    });

    memory!.rebuild();

    const relation = db!.db.prepare(`
      SELECT source_entity_id, predicate, target_entity_id, status
      FROM graph_relations
      WHERE predicate = 'appears_in'
    `).get() as { source_entity_id: string; predicate: string; target_entity_id: string; status: string } | undefined;

    expect(relation).toEqual({
      source_entity_id: "character:陆尘",
      predicate: "appears_in",
      target_entity_id: "event:chapter_1",
      status: "confirmed"
    });
  });

  it("returns a blocking claim when draft text negates a confirmed fact", async () => {
    insertChunk({
      path: "00_设定集/设定库/角色设定.md",
      sourceType: "lore",
      title: "角色设定",
      text: "### 陆尘\n青云宗大弟子，修为通天。"
    });

    memory!.rebuild();

    const result = await memory!.checkDraftConsistency("陆尘不是青云宗大弟子，他只是路过的散修。");

    expect(result.score).toBeLessThan(100);
    expect(result.risks.length).toBeGreaterThan(0);
    expect(result.blocking_claims).toEqual([
      expect.objectContaining({
        claim: expect.stringContaining("青云宗大弟子"),
        source_path: "00_设定集/设定库/角色设定.md"
      })
    ]);
    expect(result.suggested_fix).toContain("confirmed graph facts");
  });

  it("builds writing context through GraphContext and applies maxChars", async () => {
    insertChunk({
      path: "00_设定集/设定库/角色设定.md",
      sourceType: "lore",
      title: "角色设定",
      text: "### 陆尘\n青云宗大弟子，修为通天。"
    });

    memory!.rebuild();

    const context = await memory!.buildWritingContext("陆尘", { maxChars: 40 });

    expect(context.length).toBeLessThanOrEqual(40);
    expect(context).toContain("Graph");
  });

  it("keeps GraphExtractor as a rule-based facade", () => {
    const extractor = new GraphExtractor(tempDir);

    try {
      const result = extractor.extract({
        chunkId: 1,
        sourceType: "outline",
        sourcePath: "01_大纲/第一章大纲.md",
        chunkTitle: "第一章",
        text: "陆尘将在青云山脚偶遇林风。"
      });

      expect(result.entities[0]?.status).toBe("planned");
      expect(result.claims[0]?.predicate).toBe("plot_plan");
    } finally {
      extractor.close();
    }
  });
});
