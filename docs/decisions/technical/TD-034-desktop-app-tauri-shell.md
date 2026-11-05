# TD-034 — The desktop app is a Tauri v2 shell in `apps/desktop`: Rust drives an allow-list of Docker verbs over a bundle in its own data directory, the worker's page runs in a window with no IPC, and releases are signed, attested and published to a channel release that the Tauri updater reads

- **Status:** proposed. It is **planned; build after the worker is verified** (M24's S-24.0).
- **Date:** 2026-11-05
- **Relates to:** BD-033, BD-014, BD-022, BD-032, TD-001, TD-017, TD-018, TD-019, TD-021, TD-031 (worker-UI, first-run, no-bearer and `compose.yml` amendments), TD-032 §3, §6 and *As built*, research/20

## Context

The worker's page is served at `127.0.0.1:${APP_WORKER_UI_PORT:-7357}` (`compose.worker.yml:111-114`).
- It refuses a foreign `Host` with `421`.
- A `POST` must carry an exact `Origin`, `application/json` and `Sec-Fetch-Site: same-origin` when present.
- Its default auth is `none` (TD-031's no-bearer amendment).

The bundle's project name is fixed (`name: agentic-worker`, `compose.worker.yml:55`).

The updater reaches the bundle's folder through a bind mount at a fixed container path
(`/var/lib/platform/host-bundle`, from `${APP_WORKER_BUNDLE_DIR:-.}`), whose source Docker resolves,
and writes each applied build back into it; it reads no host path off a label (TD-032's 2026-11-05
decision-4 amendment, S-22.21). It labels its apply container `org.platform.update-apply` (`updater.ts:80`). It
rewrites the `.env` block and renders the template from the **verified image**, never from a file the
core served (TD-032 §3).

`release` and `compose.yml` are public (TD-031). There is no Rust in this repository (TD-001), and the
repository has no Actions secrets (`image.yml:17-21`).

## Decision

1. **Layout and language.** The app lives in `apps/desktop`, a Tauri v2 crate (`src-tauri/`) with
   `rust-toolchain.toml` and a committed `Cargo.lock`. **Rust is admitted only there**, as a scoped
   exception to TD-001: the shell's logic is small and the domain stays in TypeScript.
   - The shell's own screens are a third Vite entry of `apps/web` (`desktop.html`), as `worker.html`
     is. So `ui/untrusted.tsx`, `no-html.test.ts` and `bundle:check` (≤ 120 kB gz) cover it.
   - The manifests stay at `0.0.0`, and the version is stamped at build (§6).
2. **The bundle lives in the app's data directory, never in a git repository.** On macOS that is
   `~/Library/Application Support/<id>/worker/`; on Windows, `%APPDATA%\<id>\worker\`. It holds
   `compose.yaml`, the updater's `.env` and `app.json` (the chosen core URL, the install's digests).
   - **The app writes `compose.yaml` only at install and at *Change platform*.** After that the file
     and `.env` belong to the updater.
   - Before anything else, `docker compose ls` must show `agentic-worker` either absent or with its
     `working_dir` equal to this directory. If another install already holds the name, the app opens
     that install's page and refuses to install a second one.
3. **Install never applies a compose file the core served**, which is TD-032 §3's rule extended to the
   app. The steps:
   1. Validate the core URL with the first-run amendment §3's rules: `https:`, or loopback and
      `host.docker.internal` for http, no userinfo, no redirect, 5 s, 64 KiB, strict schema.
   2. `GET /api/worker/v1/release` returns the four digests.
   3. Each reference must be `<trusted repository>@sha256:<64 hex>`. The trusted repository is the
      app's build constant, `ghcr.io/<owner>/platform…`, overridable only in *Advanced*.
   4. `docker image pull` the `platform` digest.
   5. Read `/opt/platform/compose.worker.yml` out of it with `docker run --rm --network none --read-only`.
   6. Render it with the same three inputs as the core's renderer: the digests, the repository and the
      core URL.
   7. `up -d`.

   **Residual:** at install, the core picks any digest that exists in the trusted repository, a
   downgrade included. From the first update on, the updater's attestation check bounds it (TD-032 §3).
4. **Docker through Rust only, by an allow-list.** The webview never builds an argument.
   - It calls typed commands: `status`, `install(core_url)`, `start`, `stop`, `remove`,
     `remove_with_data`, `open_page`. Each maps to one fixed argv, run without a shell.
   - The verbs: `docker version`, `docker compose version`, `docker compose ls`, and a compose
     `ps/up -d/start/stop/down/port` with `--project-name agentic-worker --project-directory <dir> -f <dir>/compose.yaml`.
   - Also: `docker image pull <validated ref>`, the read-only `run` of §3, and
     `docker ps --filter label=org.platform.update-apply`.
   - `down --volumes` (which deletes the credential and the Claude token) needs a second confirmation.
   - **Nothing runs while an apply container exists** (the app does not fight the updater). The app
     never uses `pull` for an update, never `--pull always`, and never edits `.env`.
   - The `docker` binary comes from a fixed list of absolute paths per OS (Docker Desktop, OrbStack,
     Rancher Desktop, Homebrew) or a path the user picks, **never `PATH`**. A GUI process does not
     inherit the shell's `PATH`, and an ambiguous lookup is an injection surface.
   - **No shell plugin** is enabled. A test reads the capability files and fails on `shell:*`, a
     `remote` block, or `windows: ["*"]`.
5. **The worker's page runs in its own window, with no IPC.**
   - The `worker` window loads `http://127.0.0.1:<port>/`, and **no capability names it**. A remote
     origin gets no IPC by default (research/20 § 5), and the census above holds that.
   - The window opens only after `docker compose port remote-worker 7357` names that port, so a process
     squatting on 7357 while the worker is down is not shown as the worker.
   - Navigation is limited to that origin. An `https:` link (Claude's sign-in, the core's
     `/workers/approve`, which needs the user's core session) opens in the **system browser**.
     Everything else is refused, new windows included.
   - The shell's own window gets a strict CSP and capabilities for its own commands only.
   - The page's `Host`/`Origin`/`Sec-Fetch-Site` checks and any macOS ATS exception for loopback `http:`
     are measured in WKWebView and WebView2 (V-DA3). If either refuses the page, the fix goes into the
     app, never a widening of the worker's checks.
   - Only `APP_WORKER_UI_AUTH=none` is supported in M24. A `token` install is opened in the browser.
6. **Versions and channel.** The app has its own SemVer line, `desktop-vX.Y.Z`.
   - It is computed by `scripts/version.mjs` with a tag prefix and a path filter, over the commits that
     touch the desktop paths. It does not depend on `RELEASE_VERSIONING`, because the app talks to any
     core through two public routes and the local state.
   - A push to `main` that yields a version is the release (TD-019's rule), behind the repository
     variable `DESKTOP_RELEASES=enabled`.
   - Each release is a GitHub **pre-release** `desktop-vX.Y.Z`, so it never takes the repository's
     single *latest* from a core `vX.Y.Z`.
   - One fixed pre-release, **`desktop-stable`**, carries `latest.json` and stable-named copies of the
     installers. It is the README's download link and the updater's only endpoint
     (`…/releases/download/desktop-stable/latest.json`), and it is replaced **last**, after every leg
     has signed, notarised and been attested.
   - Pull-request builds are unsigned workflow artifacts and are never offered to the updater.
7. **The app's updater.** `tauri-plugin-updater` checks at start and every 6 h, downloads in the
   background, checks the signature with the public key built into the app, and installs at quit or on
   *Restart to update*. On Windows it uses `passive` mode with a per-user NSIS install.
   - The default comparator (`>`) refuses a downgrade.
   - An app update leaves the containers running. The worker's images update only through TD-032 §6,
     and the tray shows that updater's *update pending*.
8. **State and notifications.** The tray reads `GET /api/local/state` (a second consumer of
   `packages/contracts/src/worker-local.ts`), parsed **tolerantly**: an unknown key is ignored and a
   missing field reads *unknown*.
   - This is a stated exception to the strict-boundary rule. The worker updates itself independently
     of the app, so version skew is the normal case, and the reader only displays.
   - Notifications use platform words plus a ticket key matched to `[A-Z0-9_-]{1,32}`, never a title
     (BD-022).
   - Launch at login is off until the user turns it on. Quitting the app leaves the worker running,
     because the containers are `unless-stopped`.
9. **CI is `desktop.yml`, outside `main`'s required checks.** `scripts/release.test.ts`'s pin and
   timeout rules cover it, but it is not in the required-check list. It has four jobs:
   - **`desktop-check`** (ubuntu): `fmt`, `clippy -D warnings`, `cargo test`, `cargo deny check
     licenses advisories`, the capability census, and the staleness of the crate-licence file.
   - **`desktop-build`**: `macos-15` building `universal-apple-darwin`, and `windows-2025` building x64
     NSIS. On a pull request it is ad-hoc signed and the result uploaded as an artifact.
   - **`desktop-release`**: environment `desktop-release`, `main` only, the owner's approval. It holds
     the secrets: `TAURI_SIGNING_PRIVATE_KEY`(+`_PASSWORD`), `APPLE_CERTIFICATE`(+`_PASSWORD`),
     `APPLE_SIGNING_IDENTITY`, `APPLE_API_*`, and the Windows route's credential (Q129). It signs,
     notarises, runs `tauri-action` against a draft, and attests the installers and the updater
     archives with `actions/attest-build-provenance`.
   - **`desktop-channel`**: un-drafts the release and replaces `desktop-stable`.

   Triggers: a pull request or a push touching `apps/desktop/**`, `apps/web/src/desktop/**`,
   `packages/contracts/src/worker-local.ts`, `compose.worker.yml` or `desktop.yml`, plus
   `workflow_dispatch`. `ci.yml` is unchanged, so `main` keeps its ~6 minutes. MSI is not built: NSIS
   is per user, and the updater needs only one format.
10. **Licences (TD-018 and WP-23).** `deny.toml` allows `Apache-2.0`, `MIT`, `BSD-2-Clause`,
    `BSD-3-Clause`, `ISC`, `Zlib`, `Unicode-3.0`, `CC0-1.0` and `MPL-2.0` (file-level). It refuses
    every other licence.
    - `desktop-check` regenerates `apps/desktop/third-party-crates.json` (name, version, SPDX, source).
    - `scripts/notices.mjs` reads that committed file, so `notices:check` needs no Rust.
    - WebView2 is fetched by Microsoft's bootstrapper and is not redistributed.
    - The app carries no Claude binary, so TD-018's open item is unaffected.

## Rejected

- GitHub Packages or ORAS on ghcr.io: no generic type, no browser download, unreadable by the updater.
- `releases/latest/download/latest.json`: it collides with core releases.
- Coupling to `RELEASE_VERSIONING`: an app release for every core `feat`.
- Cross-building NSIS from Linux: a last resort, signing needs a custom command, and public runners are
  free anyway.
- Applying the core's `compose.yml`: a compromised core would choose the mounts.
- The shell plugin with argument validators: the frontend would own argv.
- The OS keychain for the Claude token: optional per the owner, and the `worker-state` volume keeps the
  app secret-free.
- A `remote` capability for the page: the one thing an injected page could abuse.

## Consequences and residuals

- **The secrets are a new trust root.** Whoever holds the updater key can push code to every installed
  app, and the minisign check is only as strong as the environment's approval and branch rule. The
  Sigstore attestation is a second check for a human, not for the updater.
- **The Windows worker** was blocked by `plan.ts:30` (backlog 990); S-22.21 closed it (TD-032's
  2026-11-05 decision-4 amendment). What is left is measuring one real update there (V-DA1, S-24.W).
- The app is root-equivalent through Docker, as the CLI user already is (TD-021's residual).
- V-DA1–V-DA7 (docs/TODO.md) are measured by the named slices.

## Parked (2026-11-05, orchestrator-authorised, owner's decision)

The owner wants the easiest distribution with a great experience and does not mind the mechanism. A
one-command install served by the core (S-22.20: `install.sh` for macOS and Linux, `install.ps1` for
Windows; then the S-22.17 wizard, with the S-22.10 updater keeping the bundle current) covers it
without signing costs or a second release pipeline. M24 is **parked, not cancelled**: this record
and the owner's answers (Q128-Q133) stand, and it is un-parked on the owner's request.
