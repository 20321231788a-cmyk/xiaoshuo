import { describe, it, expect } from "vitest";
import {
  ContextScheduler,
  ContextBlock,
  calculateSimilarity,
  truncateBlockContent,
  defaultTokenizer
} from "./context-scheduler.js";

describe("ContextScheduler - Phase P4", () => {
  
  describe("Similarity calculation", () => {
    it("should calculate Jaccard similarity correctly", () => {
      const text1 = "hello world this is a test";
      const text2 = "hello world another test";
      // words1: hello, world, this, is, a, test (6 words)
      // words2: hello, world, another, test (4 words)
      // intersection: hello, world, test (3 words)
      // union: 6 + 4 - 3 = 7 words
      // Jaccard: 3/7 = 0.42857...
      expect(calculateSimilarity(text1, text2)).toBeCloseTo(3/7, 4);
    });

    it("should handle empty strings", () => {
      expect(calculateSimilarity("", "")).toBe(1.0);
      expect(calculateSimilarity("hello", "")).toBe(0.0);
    });
  });

  describe("Safety filter (allow_instruction)", () => {
    it("should force allowInstruction: false on web, document, cache types", () => {
      const scheduler = new ContextScheduler({
        modelContextLimit: 1000,
        toolDefinitionsMargin: 100,
        systemReserve: 50,
      });

      const candidates: ContextBlock[] = [
        {
          id: "1",
          path: "file1.txt",
          content: "web material",
          type: "web",
          relevance: 1.0,
          priority: 1.0,
          trust: 1.0,
          freshness: 1.0,
          allowInstruction: true, // untrusted but passed as true
        },
        {
          id: "2",
          path: "file2.txt",
          content: "document block",
          type: "document",
          relevance: 1.0,
          priority: 1.0,
          trust: 1.0,
          freshness: 1.0,
          allowInstruction: true,
        },
        {
          id: "3",
          path: "file3.txt",
          content: "model-generated cache",
          type: "cache",
          relevance: 1.0,
          priority: 1.0,
          trust: 1.0,
          freshness: 1.0,
          allowInstruction: true,
        },
        {
          id: "4",
          path: "file4.txt",
          content: "user instruction",
          type: "user",
          relevance: 1.0,
          priority: 1.0,
          trust: 1.0,
          freshness: 1.0,
          allowInstruction: true, // trusted type
        }
      ];

      const result = scheduler.schedule(candidates);
      expect(result).toHaveLength(4);
      
      const webBlock = result.find(b => b.type === "web");
      const docBlock = result.find(b => b.type === "document");
      const cacheBlock = result.find(b => b.type === "cache");
      const userBlock = result.find(b => b.type === "user");

      expect(webBlock?.allowInstruction).toBe(false);
      expect(docBlock?.allowInstruction).toBe(false);
      expect(cacheBlock?.allowInstruction).toBe(false);
      expect(userBlock?.allowInstruction).toBe(true);
    });
  });

  describe("Budget Thresholds", () => {
    it("should respect total budget limits and truncate last fitting block", () => {
      // totalBudget = 100 - 20 - 10 = 70 tokens
      // 70 tokens ≈ 280 characters using defaultTokenizer (1 token = 4 chars)
      const scheduler = new ContextScheduler({
        modelContextLimit: 100,
        toolDefinitionsMargin: 20,
        systemReserve: 10,
      });

      const block1: ContextBlock = {
        id: "1",
        path: "a.txt",
        content: "a".repeat(120), // 30 tokens
        type: "user",
        relevance: 0.9,
        priority: 0.9,
        trust: 0.9,
        freshness: 0.9,
      };

      const block2: ContextBlock = {
        id: "2",
        path: "b.txt",
        content: "b".repeat(120), // 30 tokens
        type: "user",
        relevance: 0.8,
        priority: 0.8,
        trust: 0.8,
        freshness: 0.8,
      };

      const block3: ContextBlock = {
        id: "3",
        path: "c.txt",
        content: "c".repeat(120), // 30 tokens
        type: "user",
        relevance: 0.7,
        priority: 0.7,
        trust: 0.7,
        freshness: 0.7,
      };

      const result = scheduler.schedule([block1, block2, block3]);

      // block1 (30 tokens) + block2 (30 tokens) = 60 tokens.
      // Remaining budget is 10 tokens.
      // block3 needs to be truncated to <= 10 tokens.
      expect(result).toHaveLength(3);
      expect(result[0]?.id).toBe("1");
      expect(result[0]?.tokenCount).toBe(30);
      expect(result[1]?.id).toBe("2");
      expect(result[1]?.tokenCount).toBe(30);
      
      expect(result[2]?.id).toBe("3");
      // Truncated block3 must have tokenCount <= 10
      expect(result[2]?.tokenCount).toBeLessThanOrEqual(10);
      expect(result[2]?.content).toContain("[Truncated Paragraph Context]");
    });

    it("should return empty array if budget is <= 0", () => {
      const scheduler = new ContextScheduler({
        modelContextLimit: 50,
        toolDefinitionsMargin: 40,
        systemReserve: 20,
      });

      const block: ContextBlock = {
        id: "1",
        path: "a.txt",
        content: "hello",
        type: "user",
        relevance: 1.0,
        priority: 1.0,
        trust: 1.0,
        freshness: 1.0,
      };

      const result = scheduler.schedule([block]);
      expect(result).toEqual([]);
    });
  });

  describe("MMR Scoring and Path Quota", () => {
    it("should prioritize blocks based on weight (relevance, priority, trust, freshness, novelty)", () => {
      const scheduler = new ContextScheduler({
        modelContextLimit: 1000,
        toolDefinitionsMargin: 0,
        systemReserve: 0,
      });

      const blockA: ContextBlock = {
        id: "A",
        path: "a.txt",
        content: "unique content A",
        type: "user",
        relevance: 1.0,
        priority: 0.0,
        trust: 0.0,
        freshness: 0.0,
      };

      const blockB: ContextBlock = {
        id: "B",
        path: "b.txt",
        content: "unique content B",
        type: "user",
        relevance: 0.0,
        priority: 1.0,
        trust: 0.0,
        freshness: 0.0,
      };

      const result = scheduler.schedule([blockB, blockA]); 
      expect(result[0]?.id).toBe("A");
      expect(result[1]?.id).toBe("B");
    });

    it("should discount score based on similarity (novelty)", () => {
      const scheduler = new ContextScheduler({
        modelContextLimit: 1000,
        toolDefinitionsMargin: 0,
        systemReserve: 0,
      });

      const block1: ContextBlock = {
        id: "1",
        path: "a.txt",
        content: "same text content",
        type: "user",
        relevance: 1.0,
        priority: 0.5,
        trust: 0.5,
        freshness: 0.5,
      };

      const block2: ContextBlock = {
        id: "2",
        path: "b.txt",
        content: "same text content", 
        type: "user",
        relevance: 0.9,
        priority: 0.5,
        trust: 0.5,
        freshness: 0.5,
      };

      const block3: ContextBlock = {
        id: "3",
        path: "c.txt",
        content: "completely different words here", 
        type: "user",
        relevance: 0.8,
        priority: 0.5,
        trust: 0.5,
        freshness: 0.5,
      };

      const result = scheduler.schedule([block1, block2, block3]);
      expect(result[0]?.id).toBe("1");
      expect(result[1]?.id).toBe("3");
      expect(result[2]?.id).toBe("2");
    });

    it("should enforce path quota (max 2 segments per path)", () => {
      const scheduler = new ContextScheduler({
        modelContextLimit: 1000,
        toolDefinitionsMargin: 0,
        systemReserve: 0,
      });

      const block1: ContextBlock = {
        id: "1",
        path: "same.txt",
        content: "content 1",
        type: "user",
        relevance: 1.0,
        priority: 1.0,
        trust: 1.0,
        freshness: 1.0,
      };
      const block2: ContextBlock = {
        id: "2",
        path: "same.txt",
        content: "content 2",
        type: "user",
        relevance: 0.9,
        priority: 0.9,
        trust: 0.9,
        freshness: 0.9,
      };
      const block3: ContextBlock = {
        id: "3",
        path: "same.txt",
        content: "content 3",
        type: "user",
        relevance: 0.8,
        priority: 0.8,
        trust: 0.8,
        freshness: 0.8,
      };
      const block4: ContextBlock = {
        id: "4",
        path: "other.txt",
        content: "content 4",
        type: "user",
        relevance: 0.1,
        priority: 0.1,
        trust: 0.1,
        freshness: 0.1,
      };

      const result = scheduler.schedule([block1, block2, block3, block4]);
      expect(result).toHaveLength(3);
      const selectedIds = result.map(b => b.id);
      expect(selectedIds).toContain("1");
      expect(selectedIds).toContain("2");
      expect(selectedIds).toContain("4");
      expect(selectedIds).not.toContain("3");
    });
  });

  describe("Semantic partition cuts", () => {
    it("should truncate Markdown by paragraphs", () => {
      const markdown = "# Header\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph.";
      const truncated = truncateBlockContent(markdown, "doc.md", 20, defaultTokenizer);
      expect(truncated).toContain("First paragraph here.");
      expect(truncated).not.toContain("Second paragraph here.");
      expect(truncated).toContain("... [Truncated Markdown Context] ...");
    });

    it("should truncate JSON arrays", () => {
      const jsonArray = JSON.stringify([
        { name: "item1", value: 1 },
        { name: "item2", value: 2 },
        { name: "item3", value: 3 },
        { name: "item4", value: 4 },
        { name: "item5", value: 5 },
      ], null, 2);

      const charCountTokenizer = (text: string) => text.length;

      const truncated = truncateBlockContent(jsonArray, "data.json", 180, charCountTokenizer);
      const parsed = JSON.parse(truncated);
      
      expect(parsed).toHaveLength(3); 
      expect(parsed[0].name).toBe("item1");
      expect(parsed[1].name).toBe("item2");
      expect(parsed[2]._truncated).toBeDefined();
    });

    it("should truncate JSON objects", () => {
      const jsonObject = JSON.stringify({
        key1: "long_value_1_long_value_1",
        key2: "long_value_2_long_value_2",
        key3: "long_value_3_long_value_3",
        key4: "long_value_4_long_value_4",
        key5: "long_value_5_long_value_5",
      }, null, 2);

      const charCountTokenizer = (text: string) => text.length;

      const truncated = truncateBlockContent(jsonObject, "data.json", 160, charCountTokenizer);
      const parsed = JSON.parse(truncated);

      expect(parsed.key1).toBe("long_value_1_long_value_1");
      expect(parsed.key2).toBe("long_value_2_long_value_2");
      expect(parsed.key3).toBeUndefined();
      expect(parsed._truncated).toBeDefined();
    });

    it("should fallback to text truncation for invalid JSON", () => {
      const invalidJson = "{ key1: 'value1', key2: ";
      const truncated = truncateBlockContent(invalidJson, "broken.json", 15, defaultTokenizer);
      expect(truncated).toContain("[Truncated JSON Context]");
    });
  });
});
