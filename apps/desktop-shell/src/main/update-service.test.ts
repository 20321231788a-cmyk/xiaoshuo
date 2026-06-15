import { describe, expect, it, vi } from "vitest";
import type { AppUpdater } from "electron-updater";
import { UpdateService } from "./update-service.js";

function createPackagedApp() {
  return {
    getVersion: () => "0.2.3",
    isPackaged: true
  };
}

function createAutoUpdater(checkForUpdates = vi.fn().mockResolvedValue(undefined)) {
  const feeds: unknown[] = [];
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    on: vi.fn(),
    setFeedURL: vi.fn((feed: unknown) => {
      feeds.push(feed);
    }),
    checkForUpdates,
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn()
  } as unknown as AppUpdater;
  return { feeds, updater };
}

describe("UpdateService", () => {
  it("uses the COS mirror as the default update feed", () => {
    const { feeds, updater } = createAutoUpdater();
    const service = new UpdateService({ app: createPackagedApp(), autoUpdater: updater });

    expect(service.getStatus().updateSource).toBe("mirror");
    expect(feeds[0]).toEqual({
      provider: "generic",
      url: "https://ai-downloads-1318078295.cos.ap-guangzhou.myqcloud.com/software/novel/"
    });
  });

  it("falls back to GitHub when the mirror check fails", async () => {
    const checkForUpdates = vi.fn().mockRejectedValueOnce(new Error("mirror 404")).mockResolvedValueOnce(undefined);
    const { feeds, updater } = createAutoUpdater(checkForUpdates);
    const service = new UpdateService({ app: createPackagedApp(), autoUpdater: updater });

    const status = await service.checkForUpdates();

    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(feeds[1]).toEqual({
      provider: "generic",
      url: "https://ai-downloads-1318078295.cos.ap-guangzhou.myqcloud.com/software/novel/"
    });
    expect(feeds[2]).toEqual({
      provider: "github",
      owner: "20321231788a-cmyk",
      repo: "xiaoshuo",
      private: false
    });
    expect(status.updateSource).toBe("github");
  });
});
