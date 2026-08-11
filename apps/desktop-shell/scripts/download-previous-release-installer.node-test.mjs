import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const downloaderPath = path.join(rootDir, "apps", "desktop-shell", "scripts", "download-previous-release-installer.ps1");

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test("previous release downloader expands API arrays and selects the highest lower version", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baseline-downloader-test-"));
  try {
    const installerBytes = Buffer.from("baseline-installer-v0.3.2");
    const installerHash = createHash("sha256").update(installerBytes).digest("hex");
    const installerBase64 = installerBytes.toString("base64");
    const outputPath = path.join(root, "ArcWriter-Setup-baseline.exe");
    const metadataPath = path.join(root, "baseline-release.json");
    const harnessPath = path.join(root, "harness.ps1");
    const harness = `
$ErrorActionPreference = "Stop"
function Invoke-RestMethod {
  param([string]$Uri, [hashtable]$Headers)
  return @(
    [pscustomobject]@{ tag_name = "v0.4.0"; draft = $false; prerelease = $false; id = 400; published_at = "2026-07-08T00:00:00Z"; assets = @() },
    [pscustomobject]@{
      tag_name = "v0.3.2"; draft = $false; prerelease = $false; id = 302; published_at = "2026-06-28T00:00:00Z"
      assets = @([pscustomobject]@{
        id = 320; name = "ArcWriter-Setup-0.3.2.exe"; size = ${installerBytes.length}
        browser_download_url = "https://github.com/owner/repo/releases/download/v0.3.2/ArcWriter-Setup-0.3.2.exe"
        digest = "sha256:${installerHash}"
      })
    },
    [pscustomobject]@{ tag_name = "v0.3.1"; draft = $false; prerelease = $false; id = 301; published_at = "2026-06-27T00:00:00Z"; assets = @() }
  )
}
function Invoke-WebRequest {
  param([uri]$Uri, [hashtable]$Headers, [string]$OutFile)
  [IO.File]::WriteAllBytes($OutFile, [Convert]::FromBase64String("${installerBase64}"))
}
& ${psQuote(downloaderPath)} -Repository "owner/repo" -OutputPath ${psQuote(outputPath)} -MetadataOutputPath ${psQuote(metadataPath)} -CandidateVersion "0.4.0"
`;
    await fs.writeFile(harnessPath, harness, "utf8");

    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", harnessPath], {
      cwd: rootDir,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(await fs.readFile(outputPath), installerBytes);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.baseline_version, "0.3.2");
    assert.equal(metadata.version_relation, "previous");
    assert.equal(metadata.asset_id, 320);
    assert.equal(metadata.sha256, installerHash);
    assert.equal(metadata.published_at, "2026-06-28T00:00:00.000Z");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
