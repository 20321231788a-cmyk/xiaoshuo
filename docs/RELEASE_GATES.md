# Desktop Release Gates

The desktop workflows are deliberately fail-closed. A tag release is not allowed to
publish an installer until the quality checks, a signed installer, an installation
smoke run, and JSON evidence all describe the same `GITHUB_SHA`.

## Workflows

- `Windows PR CI` runs type checking, unit tests, workbench and desktop builds,
  browser E2E, and the source-tree Electron smoke test on `windows-latest`.
- `Desktop RC and Nightly` runs nightly evidence builds. A manually dispatched
  `rc` uses the `release-candidate` GitHub environment, validates Authenticode,
  installs the NSIS package, starts the installed executable, and uninstalls it.
- `Release Desktop` repeats all quality checks on the tag commit inside the
  protected `production` GitHub environment. It validates that the tag equals
  `v` plus `apps/desktop-shell/package.json`'s version before publishing.

`release-evidence.json` records the source commit, version, installer SHA-256,
all packaged file hashes, and the installed-smoke evidence. Publication happens
only after that evidence is created in the same job and from the same installer.

## Required GitHub Configuration

Repository workflow files cannot create or approve GitHub environments. Before
using RC or release, configure the following outside the repository:

- Create protected `release-candidate` and `production` environments with the
  appropriate reviewers. The tag workflow is intentionally blocked until
  `production` approval is granted.
- Store `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` as secrets in both protected
  environments. They must point to a real Authenticode certificate accepted by
  the Windows trust store and a matching key password.
- Permit the GitHub Actions `contents: write` token to create releases, or use
  an approved release token if organization policy requires it.

The repository verifies an existing signature and timestamp. It does not create
test certificates, skip missing certificates, or treat an unsigned installer as
an RC/release success. The installed smoke is a real silent NSIS installation,
launch observation, and uninstall on the Windows runner. It is intentionally a
startup/package test, not a substitute for a fixed-device manual upgrade and
rollback rehearsal required by the P0 release report.
