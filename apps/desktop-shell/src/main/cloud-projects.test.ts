import { loadPublicConfig } from "@xiaoshuo/config-service";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudProjectService } from "./cloud-projects.js";

const mockExportCloudCoreArchiveToTemp = vi.hoisted(() => vi.fn());
const mockLoadLicenseStatusForRoot = vi.hoisted(() => vi.fn());

vi.mock("@xiaoshuo/config-service", () => ({
  loadPublicConfig: vi.fn()
}));

vi.mock("./project-archive.js", () => ({
  defaultProjectArchiveName: vi.fn(() => "Demo.arcwriter.zip"),
  CLOUD_CORE_DATA_LIMIT_BYTES: 30 * 1024 * 1024,
  exportCloudCoreArchiveToTemp: mockExportCloudCoreArchiveToTemp,
  exportProjectArchive: vi.fn(),
  importCloudCoreArchiveToExisting: vi.fn(),
  inspectCloudCoreProject: vi.fn()
}));

vi.mock("./runtime/license-guard.js", () => ({
  loadLicenseStatusForRoot: mockLoadLicenseStatusForRoot
}));

describe("CloudProjectService", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPublicConfig).mockResolvedValue({
      website_profile: {
        api_key: "website-token",
        license_account_key: "website-token"
      }
    } as Awaited<ReturnType<typeof loadPublicConfig>>);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
  });

  it("blocks cloud uploads before archiving when the account is not licensed", async () => {
    mockLoadLicenseStatusForRoot.mockResolvedValue({
      ok: true,
      licensed: false,
      status: "not_found",
      message: "当前账号未授权"
    });
    const service = new CloudProjectService({
      appRoot: "D:\\xiaoshuo\\ts-migration",
      tempRoot: os.tmpdir()
    });

    await expect(
      service.upload({
        project_path: "D:\\projects\\Demo",
        project_name: "Demo",
        slot_id: 1
      })
    ).rejects.toThrow("当前账号未授权，无法上传云项目");

    expect(mockLoadLicenseStatusForRoot).toHaveBeenCalledWith("D:\\xiaoshuo\\ts-migration");
    expect(mockExportCloudCoreArchiveToTemp).not.toHaveBeenCalled();
  });

  it("skips an unchanged core snapshot after confirming the remote slot revision", async () => {
    mockLoadLicenseStatusForRoot.mockResolvedValue({ ok: true, licensed: true, status: "active", message: "" });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-cloud-service-"));
    tempDirs.push(tempDir);
    const archivePath = path.join(tempDir, "Demo.arcwriter.zip");
    await fs.writeFile(archivePath, "archive", "utf8");
    mockExportCloudCoreArchiveToTemp.mockResolvedValue({
      archivePath,
      inspection: {
        total_bytes: 12,
        file_count: 1,
        files: [{ path: "02_正文/正文.txt", size: 12, sha256: "a".repeat(64) }],
        largest_files: [{ path: "02_正文/正文.txt", size: 12 }]
      }
    });
    const slot = { id: "cloud-one", slot_id: 1, project_name: "Demo", project_id: "project-one", file_name: "Demo.zip", size: 7, core_size: 12, revision: 1, sha256: "", created_at: "2026-07-21T00:00:00.000Z", updated_at: "2026-07-21T00:00:00.000Z" };
    let listCalls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ ok: true, slot, uploaded_bytes: 7, daily_upload_limit: 10, today_upload_count: 1, today_upload_remaining: 9 }), { status: 200 });
      listCalls += 1;
      return new Response(JSON.stringify({ slots: listCalls === 1 ? [] : [slot], limit: 3, max_upload_bytes: 30 * 1024 * 1024, daily_upload_limit: 10, today_upload_count: 1, today_upload_remaining: 9 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new CloudProjectService({ appRoot: tempDir, tempRoot: tempDir, stateRoot: tempDir });
    const request = { project_path: path.join(tempDir, "Demo"), project_name: "Demo", project_id: "project-one", slot_id: 1 as const, sync_mode: "manual" as const };

    const first = await service.upload(request);
    const second = await service.upload(request);

    expect(first.unchanged).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(second.uploaded_bytes).toBe(0);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
  });
});
