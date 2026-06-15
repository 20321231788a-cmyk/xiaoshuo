import { loadPublicConfig } from "@xiaoshuo/config-service";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudProjectService } from "./cloud-projects.js";

const mockExportProjectArchiveToTemp = vi.hoisted(() => vi.fn());
const mockLoadLicenseStatusForRoot = vi.hoisted(() => vi.fn());

vi.mock("@xiaoshuo/config-service", () => ({
  loadPublicConfig: vi.fn()
}));

vi.mock("./project-archive.js", () => ({
  defaultProjectArchiveName: vi.fn(() => "Demo.arcwriter.zip"),
  exportProjectArchive: vi.fn(),
  exportProjectArchiveToTemp: mockExportProjectArchiveToTemp,
  importProjectArchiveToExisting: vi.fn()
}));

vi.mock("./runtime/license-guard.js", () => ({
  loadLicenseStatusForRoot: mockLoadLicenseStatusForRoot
}));

describe("CloudProjectService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPublicConfig).mockResolvedValue({
      website_profile: {
        api_key: "website-token",
        license_account_key: "website-token"
      }
    } as Awaited<ReturnType<typeof loadPublicConfig>>);
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
    expect(mockExportProjectArchiveToTemp).not.toHaveBeenCalled();
  });
});
