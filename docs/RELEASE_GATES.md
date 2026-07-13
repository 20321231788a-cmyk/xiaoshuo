# Desktop Release Gates

The desktop workflows are deliberately fail-closed. A tag release is not allowed to
build a new installer or manufacture new qualification evidence. It may publish only
the signed installer and evidence from a successful RC run for the exact commit
targeted by that tag.

## Workflows

- `Windows PR CI` runs type checking, unit tests, workbench and desktop builds,
  browser E2E, and the source-tree Electron smoke test on `windows-latest`.
- `Desktop RC and Nightly` runs an unsigned nightly build on every `main` push or
  when manually dispatched with `channel=nightly`. Nightly does not attach a GitHub Environment, consume signing
  secrets, or require configured reviewers.
  It runs typecheck, unit tests, ordinary workspace evals, builds, browser E2E,
  source smoke, installed smoke, and upgrade/rollback smoke, then uploads a
  downloadable `arcwriter-nightly-<sha>` artifact. A manually dispatched `rc` uses
  the protected `release-candidate` environment, runs manifest-bound RC evaluations,
  validates Authenticode, and creates strict `arcwriter-rc-<sha>` and
  `eval-evidence-rc-<sha>` artifacts.
- `Release Desktop` runs only for a pushed `v*` tag in the protected `production`
  environment. It resolves the tag target, validates the package version, downloads
  both required artifacts from one successful manually dispatched RC run for that
  exact SHA, rechecks the installer signature, hashes, smokes, state contract, and
  case-level evaluation evidence, then publishes the downloaded files. The release
  verification evidence records the selected RC run/attempt and both immutable
  artifact IDs and is published as the Release asset `release-evidence.json`; the
  original RC evidence remains immutable input. It does not run `npm ci`, tests, or
  packaging.

The RC bundle contains exactly the current version's installer, matching blockmap,
and `latest.yml`; recursive build directories and unrelated old installers are not
uploaded. `release-evidence.json` schema v2 records the source commit, version,
those three file hashes, hashes and full copies of both smoke records, and the
upgrade state-contract hash. Missing `workspace_dirty=false`, duplicate files, an
unexpected channel, or a short/ambiguous commit identifier fails closed.

The upgrade contract starts with a real execution-store schema v2 fixture. Baseline
startup must preserve v2 without a migration backup. The installed candidate opens
that project through its authenticated runtime probe, observes the declared pending
run, migrates to schema v3, and creates one healthy v2 backup. Rollback startup must
remain healthy on v3 and preserve the exact same migration backup. Every phase also
binds the installed executable's Windows `ProductVersion` to the baseline/candidate
provenance and checks runtime health, project hashes, SQLite `quick_check`, the
pending run, and commit-journal backup. Merely observing a process for several
seconds is not accepted as runtime health evidence.

The upgrade baseline is downloaded from the highest stable GitHub Release strictly
below the candidate version. Its exact release ID, asset ID, URL, SHA-256,
and version relation are captured in `baseline-release.json`, bound into both smoke
and release evidence, and revalidated during promotion. A missing prior stable
release fails closed; first-release workflows require an explicitly reviewed design,
not a fabricated fallback installer.

## RC Dataset Gate

Do not create `evals/rc-dataset-manifest.json` until authorized, anonymized real
samples have been collected. The repository may contain only the dataset version,
hashes, project-group assignment, partition, and case metadata. Sealed-holdout
content stays in protected CI storage.

RC also requires `evals/rc-runner-manifest.json`. It maps every declared dataset to
a unique eval name and one or more repository-local Vitest files. The dispatcher
passes that dataset's case manifest to `run-eval.mjs`; it does not execute arbitrary
commands from the manifest. The seven ordinary workspace eval commands remain
development regression checks and cannot be substituted for the thirteen RC
categories.

Each required category must contain its real minimum number of cases and at least
20% sealed holdout: routing 150, skill selection 120, file references 100, planning
80, replanning 50, memory 60, canon conflict 60, save safety 60, strict format 50,
recovery 30, author E2E 50, context citation 80, and canon timeline/perspective 60.
Train and sealed holdout must use distinct project groups, so adjacent chapters
cannot cross the partition boundary. `verify-rc-eval-evidence.mjs` computes those
facts from case metadata and case-level result manifests; it rejects self-reported
counts, hashes, holdout ratios, and commit identifiers.

## Required GitHub Configuration

GitHub Environments do not add a separate charge for this public repository, and
the nightly preview does not reference one. A workflow reference can auto-create an
unprotected environment, but it cannot configure reviewers, protection rules, or
secrets, and it cannot approve a deployment. Before using strict RC or release,
configure the following outside the repository:

- Create protected `release-candidate` and `production` environments with the
  appropriate reviewers. The tag workflow is intentionally blocked until
  `production` approval is granted.
- Store `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` only in the protected
  `release-candidate` environment. They must point to a real Authenticode
  certificate accepted by the Windows trust store and a matching key password.
  The `production` promotion job does not rebuild or sign and must not receive
  signing secrets.
- Permit the GitHub Actions `contents: write` token to create releases, or use
  an approved release token if organization policy requires it.
- Protect release tags, require an annotated `v<desktop-version>` tag, and prevent
  force-updating or deleting a tag while promotion is running.

The repository verifies an existing signature and timestamp. It does not create
test certificates, skip missing certificates, or treat an unsigned installer as
an RC/release success. The installed smoke is a real silent NSIS installation,
launch observation, and uninstall on the Windows runner. It is intentionally a
startup/package test, not a substitute for the required fixed-device crash-boundary
rehearsals, two-hour soak, performance records, or blinded human comparison.

The strict RC job's 180-minute timeout only leaves enough room for future soak
automation; it is not itself a two-hour soak. At present the crash-boundary repetitions, two-hour soak,
ten fixed-device performance records, and blinded human calibration remain external
release blockers enforced by the protected-environment reviewers. Do not approve
the `production` environment until those records are attached to the candidate.

## Public Preview / Nightly

The nightly artifact is intended for the repository's small public free preview.
It is explicitly unsigned, is not a GitHub Release, is not an updater channel, and
does not claim the 13-category RC dataset, two-hour soak, fault-injection count, or
human calibration. Users must download it from the successful Actions run and accept
the normal Windows warning for an unsigned preview. Do not rename a nightly artifact
to RC, attach it to a stable Release, or point `latest.yml` at it from a published
release. Preview convenience does not relax the `release-candidate` or `production`
gates.

Nightly has no cron trigger or other unbudgeted background autonomy and has a
90-minute job timeout; strict RC retains the 180-minute ceiling. A successful
preview artifact is retained for 7 days; strict RC artifacts are retained for 30
days. Failed runs never publish the installable bundle name and may retain only a
7-day diagnostic artifact without the installer or staged release directory. A new
nightly/main push cancels an older in-progress nightly for the same ref; strict RC
runs use a unique run-ID concurrency group and are not replaced or auto-cancelled by
later RC dispatches.

## Release Order

1. Push a clean development baseline. A historical CI run or an installer built
   from a dirty workspace is not an RC candidate.
2. Complete the protected real dataset and configure the GitHub environment secrets.
3. Commit the final version, for example `0.4.1`, without creating a tag.
4. Dispatch `Desktop RC and Nightly` with `channel=rc` on that commit and retain
   both same-SHA artifacts plus the required manual evidence.
5. Only after all gates pass, create and push the matching annotated `v0.4.1` tag.
   Never create a Release page manually and never tag a commit before its RC passes.
