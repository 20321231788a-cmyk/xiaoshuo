export const AUTO_SYNC_DEBOUNCE_MS = 5 * 60 * 1000;
export const AUTO_SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000;
export const AUTO_SYNC_DAILY_LIMIT = 6;

export function nextAutoSyncDelay(input: {
  lastSyncAt: string;
  autoSyncCount: number;
  todayUploadRemaining: number | null;
  dailyBytesRemaining?: number;
  expectedBytes?: number;
  now?: number;
}): number | null {
  if (input.autoSyncCount >= AUTO_SYNC_DAILY_LIMIT) return null;
  if (input.todayUploadRemaining !== null && input.todayUploadRemaining <= 0) return null;
  if ((input.dailyBytesRemaining || 0) > 0 && (input.expectedBytes || 0) > input.dailyBytesRemaining!) return null;
  const now = input.now ?? Date.now();
  const lastSyncAt = Date.parse(input.lastSyncAt || "");
  const intervalRemaining = Number.isFinite(lastSyncAt) ? Math.max(0, lastSyncAt + AUTO_SYNC_MIN_INTERVAL_MS - now) : 0;
  return Math.max(AUTO_SYNC_DEBOUNCE_MS, intervalRemaining);
}
