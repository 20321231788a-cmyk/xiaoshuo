import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EmbeddingClient } from "./embedding-client.js";
import { VectorIndex, getSourceType, splitChunks } from "./indexer.js";
import { cosineSimilarity, getKeywordTerms, mergeHits, hashText } from "./search.js";

const fakeEmbeddingConfig = {
  enabled: true,
  api_key: "fake-key",
  base_url: "https://ark.cn-beijing.volces.com/api/v3",
  model: "ep-test-model",
  timeout: 10,
  batch_size: 16,
  configured: true
};

describe("vector-service", () => {
  describe("EmbeddingClient", () => {
    it("resolves endpoint and requests doubao multimodal format", async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                embedding: [0.1, 0.2, 0.3]
              }
            ]
          }),
          { status: 200 }
        )
      );

      const client = new EmbeddingClient(fakeEmbeddingConfig, { fetchFn: mockFetch as typeof fetch });
      const vectors = await client.embed(["你好"]);

      expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
      expect(client.storageModel()).toBe("doubao_multimodal:ep-test-model@https://ark.cn-beijing.volces.com/api/v3");

      const [url, requestInit] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("/embeddings/multimodal");
      const body = JSON.parse(requestInit.body as string);
      expect(body.input).toEqual([{ type: "text", text: "你好" }]);
    });

    it("parses embedded dense or float objects in response", async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                embedding: { dense: [0.9, 0.8] }
              }
            ]
          }),
          { status: 200 }
        )
      );

      const client = new EmbeddingClient(fakeEmbeddingConfig, { fetchFn: mockFetch as typeof fetch });
      const vectors = await client.embed(["test"]);
      expect(vectors).toEqual([[0.9, 0.8]]);
    });

    it("parses ark multimodal data.embedding object responses", async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              embedding: [0.7, 0.6],
              object: "embedding"
            }
          }),
          { status: 200 }
        )
      );

      const client = new EmbeddingClient(fakeEmbeddingConfig, { fetchFn: mockFetch as typeof fetch });
      const vectors = await client.embed(["test"]);
      expect(vectors).toEqual([[0.7, 0.6]]);
    });

    it("requests doubao multimodal embeddings one input at a time", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: { embedding: [0.1, 0.2] } }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: { embedding: [0.3, 0.4] } }), { status: 200 }));

      const client = new EmbeddingClient(fakeEmbeddingConfig, { fetchFn: mockFetch as typeof fetch });
      const vectors = await client.embed(["第一段", "第二段"]);

      expect(vectors).toEqual([
        [0.1, 0.2],
        [0.3, 0.4]
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body)).input).toEqual([{ type: "text", text: "第一段" }]);
      expect(JSON.parse(String((mockFetch.mock.calls[1]![1] as RequestInit).body)).input).toEqual([{ type: "text", text: "第二段" }]);
    });

    it("tests the embedding connection with a real embedding request", async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                embedding: [0.1, 0.2, 0.3, 0.4]
              }
            ]
          }),
          { status: 200 }
        )
      );

      const client = new EmbeddingClient(fakeEmbeddingConfig, { fetchFn: mockFetch as typeof fetch });
      const result = await client.test();

      expect(result).toEqual({
        ok: true,
        model: "ep-test-model",
        configured_model: "ep-test-model",
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        provider: "doubao_multimodal",
        dimensions: 4
      });
      const [, requestInit] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(requestInit.body)).input).toEqual([{ type: "text", text: "test embedding connection" }]);
    });
  });

  describe("splitChunks", () => {
    it("splits body text with correct targets", () => {
      const longText = Array(150).fill("这是测试段落内容。").join("\n\n");
      const chunks = splitChunks(longText, "body");
      expect(chunks.length).toBeGreaterThan(1);
      // check body chunk limits (1100, 120)
      for (const [start, end, chunkText] of chunks) {
        expect(chunkText.length).toBeLessThanOrEqual(1540); // 1.4 * target limit
        expect(end).toBeGreaterThan(start);
      }
    });

    it("splits normal document text with correct targets", () => {
      const longText = Array(150).fill("大纲细节。").join("\n\n");
      const chunks = splitChunks(longText, "outline");
      expect(chunks.length).toBeGreaterThan(1);
      for (const [start, end, chunkText] of chunks) {
        expect(chunkText.length).toBeLessThanOrEqual(980); // 1.4 * 700
      }
    });
  });

  describe("search helpers", () => {
    it("extracts keyword terms for CJK runs", () => {
      const query = "我的逆袭人生故事";
      const terms = getKeywordTerms(query);
      // CJK Runs of size 2-4 and query parts
      expect(terms).toContain("我的");
      expect(terms).toContain("逆袭");
      expect(terms).toContain("人生");
      expect(terms).toContain("故事");
    });

    it("calculates cosine similarity correctly", () => {
      expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0);
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
      expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1.0);
    });

    it("merges hits up to 2 chunks per path", () => {
      const hit1 = { path: "doc1.txt", source_type: "body", title: "d1", text: "chunk1", score: 0.9 };
      const hit2 = { path: "doc1.txt", source_type: "body", title: "d1", text: "chunk2", score: 0.8 };
      const hit3 = { path: "doc1.txt", source_type: "body", title: "d1", text: "chunk3", score: 0.7 };
      const hit4 = { path: "doc2.txt", source_type: "body", title: "d2", text: "chunk4", score: 0.85 };

      const merged = mergeHits([hit1, hit2, hit3], [hit4], 10);
      expect(merged.length).toBe(3);
      // doc1.txt only allows 2 chunks (hit1, hit2)
      const doc1Hits = merged.filter((h) => h.path === "doc1.txt");
      expect(doc1Hits.length).toBe(2);
      expect(doc1Hits[0]!.score).toBe(0.9);
      expect(doc1Hits[1]!.score).toBe(0.8);
    });
  });

  describe("VectorIndex with DB", () => {
    let tempDir = "";
    let index: VectorIndex | null = null;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoshuo-vector-test-"));
      // Create subdirectories
      fs.mkdirSync(path.join(tempDir, "00_设定集", ".agent"), { recursive: true });
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
    });

    afterEach(() => {
      if (index) {
        index.close();
      }
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("gets source type correctly", () => {
      expect(getSourceType("02_正文/第一章.txt")).toBe("body");
      expect(getSourceType("01_大纲/大纲.txt")).toBe("outline");
      expect(getSourceType("00_设定集/角色设定.txt")).toBe("lore");
      expect(getSourceType("其他文档.txt")).toBe("document");
    });

    it("does not refresh pending files when path and action are unchanged", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const first = index!.markChanged(["02_正文/第一章.txt"], "upsert");
        const conn = (index as any).db.db;
        const firstRow = conn.prepare("SELECT action, updated_at FROM pending_files WHERE path = ?").get("02_正文/第一章.txt") as {
          action: string;
          updated_at: number;
        };

        nowSpy.mockReturnValue(1_005_000);
        const duplicate = index!.markChanged(["02_正文/第一章.txt"], "upsert");
        const duplicateRow = conn.prepare("SELECT action, updated_at FROM pending_files WHERE path = ?").get("02_正文/第一章.txt") as {
          action: string;
          updated_at: number;
        };

        const changedAction = index!.markChanged(["02_正文/第一章.txt"], "delete");
        const changedRow = conn.prepare("SELECT action, updated_at FROM pending_files WHERE path = ?").get("02_正文/第一章.txt") as {
          action: string;
          updated_at: number;
        };

        expect(first).toEqual({ queued: 1, paths: ["02_正文/第一章.txt"], action: "upsert" });
        expect(firstRow).toEqual({ action: "upsert", updated_at: 1000 });
        expect(duplicate).toEqual({ queued: 0, paths: [], action: "upsert" });
        expect(duplicateRow).toEqual(firstRow);
        expect(changedAction).toEqual({ queued: 1, paths: ["02_正文/第一章.txt"], action: "delete" });
        expect(changedRow).toEqual({ action: "delete", updated_at: 1005 });
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("can status, rebuild, process pending and search", async () => {
      // Create test files
      fs.writeFileSync(path.join(tempDir, "02_正文", "第一章.txt"), "主角走在繁华的大街上，逆袭人生的故事拉开了序幕。", "utf8");
      fs.writeFileSync(path.join(tempDir, "00_设定集", "主角设定.txt"), "姓名：林风。林风具有极强的领袖气质，踏上逆袭之路。", "utf8");

      let st = await index!.status();
      expect(st.chunks).toBe(0);

      // Rebuild (using a mock embedding provider or empty since we only test rebuild DB flow)
      // Since EmbeddingClient is internally constructed, let's mock its fetch so that embedding requests don't hit live endpoints
      let embeddingIndex = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        embeddingIndex += 1;
        return (
        new Response(
          JSON.stringify({
            data: { embedding: Array(128).fill(embeddingIndex / 10) }
          }),
          { status: 200 }
        )
        );
      });
      // Inject global fetch mock for tests or mock the EmbeddingClient
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        const rebuildRes = await index!.rebuild();
        expect(rebuildRes.chunks).toBe(2);
        expect(rebuildRes.embedded_chunks).toBe(2);

        st = await index!.status();
        expect(st.chunks).toBe(2);
        expect(st.ready).toBe(true);

        // Search - CJK Keyword search should fire
        const hits = await index!.search("林风");
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]!.path).toContain("主角设定");
        expect(hits[0]!.text).toContain("林风");

        // Test incremental marking
        index!.markChanged(["02_正文/第一章.txt"], "upsert");
        st = await index!.status();
        expect(st.pending_files).toBe(1);

        // Process pending
        const pendingRes = await index!.processPending();
        expect(pendingRes.processed_files).toBe(1);
        expect(pendingRes.pending_files).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
