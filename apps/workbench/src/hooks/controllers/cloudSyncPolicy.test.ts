import { describe, expect, it } from "vitest";
import { AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MIN_INTERVAL_MS, nextAutoSyncDelay } from "./cloudSyncPolicy.js";

describe("cloud sync policy", () => {
  const now = Date.parse("2026-07-21T08:00:00.000Z");

  it("debounces a newly pending sync for five minutes", () => {
    expect(nextAutoSyncDelay({ lastSyncAt: "", autoSyncCount: 0, todayUploadRemaining: 10, now })).toBe(AUTO_SYNC_DEBOUNCE_MS);
  });

  it("enforces the thirty minute minimum interval", () => {
    expect(nextAutoSyncDelay({ lastSyncAt: "2026-07-21T07:50:00.000Z", autoSyncCount: 1, todayUploadRemaining: 9, now })).toBe(AUTO_SYNC_MIN_INTERVAL_MS - 10 * 60 * 1000);
  });

  it("pauses after six automatic uploads or exhausted server quota", () => {
    expect(nextAutoSyncDelay({ lastSyncAt: "", autoSyncCount: 6, todayUploadRemaining: 4, now })).toBeNull();
    expect(nextAutoSyncDelay({ lastSyncAt: "", autoSyncCount: 1, todayUploadRemaining: 0, now })).toBeNull();
  });

  it("does not schedule an upload larger than the remaining byte quota", () => {
    expect(nextAutoSyncDelay({ lastSyncAt: "", autoSyncCount: 1, todayUploadRemaining: 4, dailyBytesRemaining: 1024, expectedBytes: 2048, now })).toBeNull();
  });
});
