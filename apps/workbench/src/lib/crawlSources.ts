export interface CrawlSourceOption {
  id: string;
  name: string;
  url?: string;
  isCustom?: boolean;
}

export const DEFAULT_CRAWL_SOURCES: CrawlSourceOption[] = [
  { id: "bing", name: "Bing" },
  { id: "auto", name: "自动选择旧来源" },
  { id: "shukuge", name: "书库阁" },
  { id: "zxtyz", name: "zxtyz" },
  { id: "biquge", name: "22biqu" }
];

export const CUSTOM_CRAWL_SOURCE_STORAGE_KEY = "arcwriter.customCrawlSourceUrl";
export const CRAWL_SOURCES_STORAGE_KEY = "arcwriter.crawlSources";
export const SELECTED_CRAWL_SOURCE_KEY = "arcwriter.selectedCrawlSourceId";

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function loadInitialCrawlSources(localStorageMock?: Storage): CrawlSourceOption[] {
  const storage = localStorageMock || (typeof window !== "undefined" ? window.localStorage : null);
  if (!storage) {
    return [...DEFAULT_CRAWL_SOURCES];
  }

  try {
    const stored = storage.getItem(CRAWL_SOURCES_STORAGE_KEY);
    let list: CrawlSourceOption[] = stored ? JSON.parse(stored) : [...DEFAULT_CRAWL_SOURCES];

    // 迁移旧的单一自定义 URL
    const oldCustomUrl = storage.getItem(CUSTOM_CRAWL_SOURCE_STORAGE_KEY);
    if (oldCustomUrl && isHttpUrl(oldCustomUrl)) {
      const exists = list.some(item => item.url === oldCustomUrl || item.id === oldCustomUrl);
      if (!exists) {
        list.push({
          id: oldCustomUrl,
          name: oldCustomUrl,
          url: oldCustomUrl,
          isCustom: true
        });
        storage.setItem(CRAWL_SOURCES_STORAGE_KEY, JSON.stringify(list));
      }
    }
    return list;
  } catch {
    return [...DEFAULT_CRAWL_SOURCES];
  }
}

export function restoreDefaultCrawlSources(currentSources: CrawlSourceOption[]): CrawlSourceOption[] {
  const customOnes = currentSources.filter(item => item.isCustom || item.url);
  const merged = [...DEFAULT_CRAWL_SOURCES];
  for (const custom of customOnes) {
    if (!merged.some(item => item.url === custom.url || item.id === custom.id)) {
      merged.push(custom);
    }
  }
  return merged;
}
