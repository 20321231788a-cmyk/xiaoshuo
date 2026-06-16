import { describe, it, expect } from "vitest";
import {
  loadInitialCrawlSources,
  restoreDefaultCrawlSources,
  DEFAULT_CRAWL_SOURCES,
  CUSTOM_CRAWL_SOURCE_STORAGE_KEY,
  CRAWL_SOURCES_STORAGE_KEY,
  CrawlSourceOption
} from "./crawlSources.js";

class MockLocalStorage implements Storage {
  private store: Record<string, string> = {};
  get length() { return Object.keys(this.store).length; }
  clear() { this.store = {}; }
  getItem(key: string) { return this.store[key] || null; }
  key(index: number) { return Object.keys(this.store)[index] || null; }
  removeItem(key: string) { delete this.store[key]; }
  setItem(key: string, value: string) { this.store[key] = String(value); }
}

describe("crawlSources", () => {
  it("loads default sources when storage is empty", () => {
    const mockStorage = new MockLocalStorage();
    const result = loadInitialCrawlSources(mockStorage);
    expect(result).toEqual(DEFAULT_CRAWL_SOURCES);
  });

  it("migrates old custom url and appends it to list", () => {
    const mockStorage = new MockLocalStorage();
    mockStorage.setItem(CUSTOM_CRAWL_SOURCE_STORAGE_KEY, "https://example.com/old-crawl");
    const result = loadInitialCrawlSources(mockStorage);
    
    expect(result.length).toBe(DEFAULT_CRAWL_SOURCES.length + 1);
    const migrated = result.find(x => x.url === "https://example.com/old-crawl");
    expect(migrated).toBeDefined();
    expect(migrated?.isCustom).toBe(true);

    // Verify it saved back to storage
    const saved = JSON.parse(mockStorage.getItem(CRAWL_SOURCES_STORAGE_KEY) || "[]");
    expect(saved.length).toBe(DEFAULT_CRAWL_SOURCES.length + 1);
  });

  it("does not duplicate when old custom url already exists in storage", () => {
    const mockStorage = new MockLocalStorage();
    mockStorage.setItem(CUSTOM_CRAWL_SOURCE_STORAGE_KEY, "https://example.com/old-crawl");
    const initialList: CrawlSourceOption[] = [
      ...DEFAULT_CRAWL_SOURCES,
      { id: "https://example.com/old-crawl", name: "Old", url: "https://example.com/old-crawl", isCustom: true }
    ];
    mockStorage.setItem(CRAWL_SOURCES_STORAGE_KEY, JSON.stringify(initialList));

    const result = loadInitialCrawlSources(mockStorage);
    expect(result.length).toBe(DEFAULT_CRAWL_SOURCES.length + 1);
  });

  it("restores default sources but keeps custom ones", () => {
    const currentSources: CrawlSourceOption[] = [
      { id: "bing", name: "Bing" }, // Only bing is left from default
      { id: "https://custom.com", name: "Custom", url: "https://custom.com", isCustom: true }
    ];
    const restored = restoreDefaultCrawlSources(currentSources);
    expect(restored.length).toBe(DEFAULT_CRAWL_SOURCES.length + 1);
    expect(restored.some(x => x.id === "auto")).toBe(true);
    expect(restored.some(x => x.id === "shukuge")).toBe(true);
    expect(restored.some(x => x.url === "https://custom.com")).toBe(true);
  });
});
