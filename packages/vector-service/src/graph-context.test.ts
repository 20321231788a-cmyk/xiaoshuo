import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { GraphContext } from "./graph-context.js";
import { VectorIndex } from "./indexer.js";

describe("GraphContext", () => {
  let tempDir = "";
  let index: VectorIndex | null = null;
  let graph: GraphContext | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoshuo-graph-test-"));
    fs.mkdirSync(path.join(tempDir, "00_设定集", ".agent"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "00_设定集", "设定库"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "00_设定集", "风格库"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "00_设定集", "题材库"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "02_正文"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "01_大纲"), { recursive: true });

    const settingJson = {
      embedding_enabled: true,
      embedding_api_key: "test-key",
      embedding_base_url: "https://ark.cn-beijing.volces.com/api/v3",
      embedding_model: "ep-model",
      embedding_timeout: 15,
      embedding_batch_size: 16
    };
    fs.writeFileSync(path.join(tempDir, "studio_config.json"), JSON.stringify(settingJson, null, 2), "utf8");

    index = new VectorIndex(tempDir);
    graph = new GraphContext(tempDir);
  });

  afterEach(() => {
    if (index) {
      index.close();
    }
    if (graph) {
      graph.close();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("extractGraphData", () => {
    it("extracts lore characters correctly", () => {
      const text = "### 陆尘\n青云宗大弟子，性格沉默寡言，使用太古青锋剑。";
      const data = graph!.extractGraphData(1, text, "lore", "00_设定集/设定库/人物角色设定.md", "人物角色设定");

      expect(data.entities.length).toBe(1);
      expect(data.entities[0]!.name).toBe("陆尘");
      expect(data.entities[0]!.type).toBe("character");
      expect(data.entities[0]!.status).toBe("confirmed");

      expect(data.claims.length).toBe(1);
      expect(data.claims[0]!.subject_entity_id).toBe("character:陆尘");
      expect(data.claims[0]!.predicate).toBe("description");
      expect(data.claims[0]!.object_text).toBe("青云宗大弟子，性格沉默寡言，使用太古青锋剑。");
      expect(data.claims[0]!.status).toBe("confirmed");
    });

    it("extracts planned outlines correctly", () => {
      const text = "陆尘将在青云山脚偶遇林风，并引发一系列冲突。";
      const data = graph!.extractGraphData(2, text, "outline", "01_大纲/第一章大纲.md", "第一章");

      expect(data.entities.length).toBe(1);
      expect(data.entities[0]!.type).toBe("chapter_plan");
      expect(data.entities[0]!.status).toBe("planned");

      expect(data.claims.length).toBe(1);
      expect(data.claims[0]!.subject_entity_id).toBe("chapter_plan:第一章");
      expect(data.claims[0]!.predicate).toBe("plot_plan");
      expect(data.claims[0]!.object_text).toBe(text);
      expect(data.claims[0]!.status).toBe("planned");
    });

    it("extracts body events correctly", () => {
      const text = "陆尘拔出太古青锋剑，与林风在山脚下对立而视。";
      const data = graph!.extractGraphData(3, text, "body", "02_正文/第一章.txt", "第一章正文");

      expect(data.entities.length).toBe(1);
      expect(data.entities[0]!.type).toBe("event");
      expect(data.entities[0]!.status).toBe("confirmed");

      expect(data.claims.length).toBe(1);
      expect(data.claims[0]!.subject_entity_id).toBe("event:chapter_1");
      expect(data.claims[0]!.predicate).toBe("occurrence");
      expect(data.claims[0]!.status).toBe("confirmed");
    });
  });

  describe("rebuildGraph and buildWritingContext", () => {
    it("can run rebuild, process mentions, and search graph writing context", async () => {
      // Mock global fetch for rebuild embeddings
      const mockFetch = vi.fn().mockImplementation(async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: Array(128).fill(0.1) },
              { embedding: Array(128).fill(0.2) },
              { embedding: Array(128).fill(0.3) }
            ]
          }),
          { status: 200 }
        )
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        // Write test files
        fs.writeFileSync(path.join(tempDir, "00_设定集", "设定库", "角色设定.md"), "### 陆尘\n青云宗大弟子，修为通天。\n\n### 林风\n普通少年，性格坚韧。", "utf8");
        fs.writeFileSync(path.join(tempDir, "01_大纲", "第一章大纲.md"), "陆尘与林风在青云山脚相遇。", "utf8");
        fs.writeFileSync(path.join(tempDir, "02_正文", "第一章.txt"), "陆尘独自走在路上，正好撞见了少年林风。", "utf8");

        // rebuild vector index (this will automatically rebuild graph context)
        const rebuildRes = await index!.rebuild();
        expect(rebuildRes.chunks).toBe(3);

        const status = graph!.getStatus();
        expect(status.entities).toBeGreaterThan(0);
        expect(status.claims).toBeGreaterThan(0);

        // check buildWritingContext output
        const context = await graph!.buildWritingContext("陆尘");
        expect(context).toContain("【已确认事实（Graph Confirmed）】");
        expect(context).toContain("陆尘");
        expect(context).toContain("林风");
        expect(context).toContain("【大纲与计划（Graph Planned）】");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("checks consistency without crashing when text mentions a registered entity", async () => {
      const mockFetch = vi.fn().mockImplementation(async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: Array(128).fill(0.1) }
            ]
          }),
          { status: 200 }
        )
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        fs.writeFileSync(
          path.join(tempDir, "00_设定集", "设定库", "角色设定.md"),
          "### 陆尘\n青云宗大弟子，修为通天。",
          "utf8"
        );

        await index!.rebuild();

        const result = await graph!.checkConsistency("陆尘推开山门。");

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.reason).toContain("图谱实体");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
