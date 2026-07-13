import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(`[release-evidence] ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      fail(`expected --key value pairs, received: ${argv.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function sha256(filePath) {
  const contents = await fs.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function findInstaller(artifactDir) {
  const entries = await fs.readdir(artifactDir, { withFileTypes: true });
  const installer = entries.find((entry) => entry.isFile() && /^ArcWriter-Setup-.+\.exe$/i.test(entry.name));
  if (!installer) {
    fail(`no ArcWriter installer found in ${artifactDir}`);
  }
  return path.join(artifactDir, installer.name);
}

async function readInstalledEvidence(evidencePath, installerHash, commit) {
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  if (evidence.source_commit !== commit) {
    fail(`installed smoke commit ${evidence.source_commit} does not match ${commit}`);
  }
  if (evidence.workspace_dirty === true) {
    fail("installed smoke was run from a dirty workspace and cannot be used as release evidence");
  }
  if (evidence.installer_sha256 !== installerHash) {
    fail("installed smoke was not run against this installer");
  }
  if (!evidence.application_started || !evidence.application_was_running || !evidence.uninstall_completed) {
    fail("installed smoke evidence is incomplete");
  }
  return evidence;
}

async function readUpgradeRollbackEvidence(evidencePath, installerHash, commit) {
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  if (evidence.source_commit !== commit) {
    fail(`upgrade and rollback smoke commit ${evidence.source_commit} does not match ${commit}`);
  }
  if (evidence.workspace_dirty === true) {
    fail("upgrade and rollback smoke was run from a dirty workspace and cannot be used as release evidence");
  }
  if (evidence.candidate_installer_sha256 !== installerHash) {
    fail("upgrade and rollback smoke was not run against this installer");
  }
  const stages = evidence.stages || {};
  for (const stage of ["baseline_install", "baseline_started", "candidate_upgrade", "candidate_started", "baseline_rollback", "rollback_started"]) {
    if (stages[stage] !== true) {
      fail(`upgrade and rollback smoke is missing successful stage ${stage}`);
    }
  }
  if (evidence.uninstall_completed !== true) {
    fail("upgrade and rollback smoke did not uninstall the application");
  }
  return evidence;
}

const args = parseArgs(process.argv.slice(2));
const artifactDir = path.resolve(args.get("artifact-dir") || fail("--artifact-dir is required"));
const outputPath = path.resolve(args.get("out") || fail("--out is required"));
const channel = args.get("channel") || fail("--channel is required");
const sourceCommit = process.env.GITHUB_SHA || process.env.XIAOSHUO_SOURCE_COMMIT;
if (!sourceCommit || !/^[0-9a-f]{7,64}$/i.test(sourceCommit)) {
  fail("GITHUB_SHA or XIAOSHUO_SOURCE_COMMIT must contain the source commit");
}

const installerPath = await findInstaller(artifactDir);
const installerHash = await sha256(installerPath);
const desktopPackage = JSON.parse(
  await fs.readFile(path.resolve("apps", "desktop-shell", "package.json"), "utf8")
);
const installedEvidencePath = args.get("installed-evidence");
const installedEvidence = installedEvidencePath
  ? await readInstalledEvidence(path.resolve(installedEvidencePath), installerHash, sourceCommit)
  : null;
const upgradeRollbackEvidencePath = args.get("upgrade-rollback-evidence");
const upgradeRollbackEvidence = upgradeRollbackEvidencePath
  ? await readUpgradeRollbackEvidence(path.resolve(upgradeRollbackEvidencePath), installerHash, sourceCommit)
  : null;

const files = await Promise.all(
  (await fs.readdir(artifactDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map(async (entry) => ({
      name: entry.name,
      sha256: await sha256(path.join(artifactDir, entry.name))
    }))
);

const evidence = {
  schema_version: 1,
  source_commit: sourceCommit,
  channel,
  desktop_version: desktopPackage.version,
  generated_at: new Date().toISOString(),
  installer: {
    name: path.basename(installerPath),
    sha256: installerHash
  },
  files,
  installed_smoke: installedEvidence,
  upgrade_rollback_smoke: upgradeRollbackEvidence
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`[release-evidence] wrote ${outputPath} for ${sourceCommit}`);
