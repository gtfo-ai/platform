# Research 20 — a Tauri desktop app for the worker: build, signing, distribution, updater

Gathered by the architect (session 22) and one research agent, retrieved **2026-11-05**, for BD-033 and
TD-034. Every line carries its source. Nothing here was built or run. A row that first relies on a line
re-checks it (docs/TODO.md § Verification, V-DA*).

## 1. Building on GitHub Actions

- The documented pipeline is `tauri-apps/tauri-action@v1`. Its matrix builds macOS on `macos-latest`
  twice (`--target aarch64-apple-darwin` and `--target x86_64-apple-darwin`) and Windows on
  `windows-latest`. The job needs `contents: write` to publish a release. — https://v2.tauri.app/distribute/pipelines/github/
- The action builds without publishing when `tagName`, `releaseName` and `releaseId` are all omitted.
  `uploadWorkflowArtifacts` (default `false`) uploads the bundles as workflow artifacts.
  `uploadUpdaterJson` defaults to `true` and `updaterJsonPreferNsis` to `false`. `releaseDraft`,
  `prerelease`, `releaseAssetNamePattern` and `retryAttempts` are also inputs, and `artifactPaths` is an
  output. — https://github.com/tauri-apps/tauri-action
- `universal-apple-darwin` is a CLI target that builds both architectures and joins them with `lipo`.
  Both Rust targets must be installed. — https://docs.rs/crate/tauri-cli/2.11.2/source/src/build.rs ·
  https://www.github.com/tauri-apps/tauri/pull/3318. The action's docs do not mention it.
  `[unverified]` for the action: V-DA7.
- **A Windows installer needs a Windows runner in practice.** *"`.msi` installers can only be created on
  Windows as WiX can only run on Windows systems"*. An NSIS cross-build from Linux or macOS with
  `cargo-xwin` works *"with caveats"*, is *"not tested as much"* and is meant *"only… as a last
  resort"*. Signing a cross-built installer needs a custom `signCommand`. — https://v2.tauri.app/distribute/windows-installer/
- NSIS installs per user by default under `%LOCALAPPDATA%`, with no administrator rights. The default
  WebView2 option downloads the bootstrapper when the runtime is missing. — same page.
- **Runners.** The arm64 macOS labels are `macos-latest`, `macos-15` and `macos-26`. The Intel labels are
  `macos-15-intel` and `macos-26-intel`. The Windows labels are `windows-2022`, `windows-2025` and
  `windows-11-arm`. — https://docs.github.com/en/actions/reference/runners/github-hosted-runners.
  macos-14 was retired on 2026-11-02. — https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement
- **Cost.** Standard runners are free in public repositories. A private repository pays per minute:
  $0.006 on Linux, $0.010 on Windows and $0.062 on macOS. — https://docs.github.com/en/billing/reference/actions-runner-pricing.
  Build time is not documented. `[unverified]` V-DA4.

## 2. Signing

**macOS**
- The Apple Developer Program costs **USD 99 a year**. An organisation needs a legal entity, a D-U-N-S
  number and a website. — https://developer.apple.com/programs/enroll/
- Distribution outside the App Store needs a *Developer ID Application* certificate. Tauri reads it from
  `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`. Notarisation uses an
  App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) or an Apple ID.
  Signing identity `-` gives an ad-hoc signature, and *users still have to allow the app in Privacy &
  Security*. — https://v2.tauri.app/distribute/sign/macos/
- macOS Sequoia removed the Control-click override for software that is not notarised. What remains is
  System Settings → Privacy & Security → **Open Anyway**. — https://support.apple.com/en-us/102445 ·
  https://www.macrumors.com/2024/08/06/macos-sequoia-gatekeeper-security-change/. Whether macOS 26
  changed this again is `[unverified]`.
- Native arm64 code must carry at least an ad-hoc signature. — https://eclecticlight.co/2020/08/22/apple-silicon-macs-will-require-signed-code/.
  Without one, a downloaded Apple Silicon build reads as *damaged*. — https://v2.tauri.app/distribute/pipelines/github/

**Windows**
- An unsigned file shows *"Windows protected your PC"* until the user clicks **More info → Run anyway**.
  Smart App Control on Windows 11 may block it outright. A signed file still warns until it has built a
  reputation, and *"EV certificates no longer bypass SmartScreen"*. — https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- **Azure Artifact Signing** (formerly Trusted Signing) *"starts at $9.99/month"*. Organisations in the
  EU are eligible. **Individual developers must be in the US or Canada.** Organisation validation takes
  1–20 business days. — same page; https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart ·
  https://learn.microsoft.com/en-us/azure/artifact-signing/faq. Tauri supports it through
  `artifact-signing-cli` and `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID`. — https://v2.tauri.app/distribute/sign/windows/
- **SignPath Foundation** signs for free. Its terms require:
  - an OSI licence, no proprietary code and no commercial dual licensing;
  - active maintenance with **an existing release**;
  - MFA for every team member, and author, reviewer and approver roles;
  - a published *code signing policy* on the home and download pages;
  - a verifiable build from source, and a **manual approval of every release**.

  SignPath Foundation, not the project, holds the certificate. — https://signpath.org/terms
- Since 2023-06-01 a code-signing key must sit in hardware (FIPS 140-2 L2 or CC EAL 4+). A CI build
  therefore needs a cloud HSM or a signing service. — https://venafi.com/blog/new-ca-b-forum-requirements-for-code-signing-start-in-june-will-you-be-ready
  (secondary source). Certum's open-source certificate costs from €69 and comes on a smart card. — https://shop.certum.eu/open-source-code-signing.html

## 3. Distribution

- **GitHub Packages has no generic binary type.** It covers npm, RubyGems, Maven, Gradle, NuGet and
  containers. — https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages
- ghcr.io accepts OCI artifacts, for example `oras push ghcr.io/<owner>/…:1.0 ./file:<mediatype>`. — https://oras.land/docs/compatible_oci_registries.
  A user cannot download a file from ghcr.io with a browser. The Tauri updater reads a JSON document
  and a plain `url` per platform (§ 4), and does not speak OCI.
- A release asset must be smaller than 2 GiB, and a release holds at most 1,000 assets. — https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases.
  `…/releases/latest/download/<asset>` resolves to the newest release that is neither a draft nor a
  pre-release. — https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases ·
  https://docs.github.com/en/rest/releases/releases#get-the-latest-release.
  **There is one "latest" per repository**, so this repository's `vX.Y.Z` core releases (TD-019's
  switch) would compete with the app's for it.
- `actions/attest-build-provenance` (v4 wraps `actions/attest`) attests files, and a public repository
  needs no extra plan. `gh attestation verify <file> --repo <owner/repo> --signer-workflow …` is the
  check. — https://github.com/actions/attest-build-provenance · https://cli.github.com/manual/gh_attestation_verify

## 4. The Tauri v2 updater

Source for all of § 4: https://v2.tauri.app/plugin/updater/

- **Keys and signing.** `tauri signer generate` writes the key pair. The build reads
  `TAURI_SIGNING_PRIVATE_KEY` (a path or the content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from the
  environment; *".env files do not work"*. Signature checking *"cannot be disabled"*. The page does not
  name the algorithm. The tool is said to be minisign-compatible (`[unverified]`).
- **Config.** `bundle.createUpdaterArtifacts: true` produces the updater artefacts.
- **The static JSON.** It holds `version`, `notes`, `pub_date` and `platforms.<os>-<arch>.{url,
  signature}`. The documented example is
  `https://github.com/user/repo/releases/latest/download/latest.json`.
- **Endpoints.** `endpoints` is an ordered list, and the next one is tried only on a non-2xx answer.
  TLS is enforced in production. The URL variables are `{{target}}`, `{{arch}}` and `{{current_version}}`.
- **Versions.** A version must be SemVer, and the default comparator applies an update only when it is
  greater than the running version. A custom `version_comparator` exists.
- **Channels.** None is built in; a different endpoint per channel is the documented pattern.
- **Windows install modes.** `passive` is the default (a progress bar, no interaction). `basicUi` and
  `quiet` are the alternatives.

## 5. The shell's security model

- *"By default the API is only accessible to bundled code shipped with the Tauri App."* A remote origin
  gets IPC only through a capability's `remote.urls`. A capability targets windows by label. — https://v2.tauri.app/security/capabilities/
- *"By default all potentially dangerous plugin commands and scopes are blocked"*. The shell plugin's
  `shell:allow-execute` scopes a command with per-argument regex validators. — https://v2.tauri.app/plugin/shell/
- The Rust core is *"the only component with full access to the operating system"*. — https://v2.tauri.app/concept/process-model/
- The CSP in the Tauri config covers the app's own assets: nonces and hashes are added at compile time.
  The page advises against remote content. — https://v2.tauri.app/security/csp/
- The single-instance plugin is `tauri-plugin-single-instance` 2.4.0. — https://docs.rs/crate/tauri-plugin-single-instance/latest/source.
  Autostart and tray usage are `[unverified]` against the official plugin pages, and the row reads them.
- Tauri is licensed Apache-2.0 and MIT. — https://github.com/tauri-apps/tauri.
  `cargo-deny` evaluates every crate's licence against the configuration, falling back to
  `license-file`. — https://embarkstudios.github.io/cargo-deny/checks/licenses/index.html

## 6. The engine on the user's machine

- Docker Desktop is free for companies with fewer than 250 employees **and** less than USD 10 million in
  annual revenue. Above either threshold it needs a paid per-user subscription. — https://docs.docker.com/subscription/desktop-license/
  (the FAQ wording is from the search snippet; re-read by S-24.7).
- **Found reading this repository, not the web.** The worker's updater refuses a project directory that
  does not start with `/`, in `apps/server/src/updater/plan.ts:26-38` (`absolutePath`). The apply
  container mounts the directory at its host path (TD-032's *As built* §5). On Docker Desktop for
  Windows the host path is `C:\…`, so **a worker started from a Windows directory cannot self-update
  today**. This is backlog 990 and the gate slice S-24.0.

## 7. Measurements

Empty until S-24.W and S-24.0 record theirs: the Windows `working_dir` form, the real Autix run ids, the observed self-update, and the CI Docker-check runs.
