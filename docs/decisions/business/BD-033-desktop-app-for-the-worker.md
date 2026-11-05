# BD-033 — A desktop app for the worker on macOS and Windows: a thin, signed, self-updating shell around the worker bundle, released from this repository

- **Status:** proposed. It is **planned; build after the worker is verified** (plan § "Milestone M24", gate slice S-24.0). The owner's questions are Q128–Q133.
- **Date:** 2026-11-05
- **Deciders:** the product owner (request of 2026-11-05, and the earlier agreement to a thin wrapper, Docker kept, the token on disk); the architect, session 22, wrote it down. TD-034 holds the technical side.
- **Relates to:** BD-002, BD-003, BD-014, BD-020, BD-021, BD-022, BD-029, BD-032, TD-018, TD-019, TD-031 (the worker-UI and first-run amendments), TD-032, TD-034, research/20

## Context

A worker (BD-032) installs today from a terminal. The person downloads `compose.yaml`, runs
`docker compose up -d` and opens `http://127.0.0.1:7357`, where the first-run wizard (S-22.17) connects
to a platform, signs in to Claude and approves the machine. That suits the developers who build this
platform. It does not suit the colleagues the owner wants as workers, at least one of whom uses Windows.
The owner asked for an app they download and set up entirely inside it, securely, published by this
repository's CI beside the Docker images.

Two facts set the cost (research/20 § 2):
- **macOS.** A downloaded app that is not notarised opens only after the user goes to *System
  Settings → Privacy & Security → Open Anyway*, because Sequoia removed the Control-click override.
  Notarising needs the Apple Developer Program, **USD 99 a year**.
- **Windows.** An unsigned installer shows *"Windows protected your PC"*, and the user has to click
  *More info → Run anyway*. Signing needs either SignPath Foundation's free open-source programme
  (manual approval of each release, and an existing release first) or Azure Artifact Signing from
  **USD 9.99 a month**. Artifact Signing is open to an EU *organisation*, but individuals only in the US
  or Canada. Even a signed installer warns until it has built a reputation.

## Decision

1. **Who it is for.** A developer who runs a worker for a core they have an account on, on **macOS
   (Apple Silicon and Intel) and Windows 10/11 (x64)**. The terminal install stays and is documented.
   Linux users keep using it, and no Linux app is planned.
2. **What the app is.** A **thin shell**. It finds the container engine and helps the user install
   one. It installs, starts and stops the worker bundle from its own folder. It shows the worker's own
   page and its wizard instead of re-implementing them. It shows the worker's state in the menu bar or
   tray, and it can launch at login. **The worker stays in Docker**. The app never runs agent work,
   never holds a platform secret, and never writes or reads the developer's Claude token, which the
   wizard stores in the worker's own state (TD-031, first-run amendment §4).
3. **A container engine is required and is the user's.** The app links to the installer of Docker
   Desktop, or of another engine with Compose v2, and never installs one itself. **Docker Desktop's
   licence is the user's organisation's matter**: it is free under 250 employees **and** under
   USD 10 million revenue, and paid above either. The app says this before it links.
4. **Two updaters, two jobs, never crossing.** The app updates **itself** from this repository's
   releases. The worker's images update **themselves** through the worker's updater, following the
   core (TD-032 decision 6). The app never pulls images for an update and never re-pins the bundle.
5. **Releases come from this repository's CI, on GitHub Releases**, not GitHub Packages. GitHub
   Packages has no type for a desktop app, and a browser cannot download from ghcr.io. Every app build
   is attested the way the images are (TD-032 §3). The app has **its own version line**,
   independent of the core's (TD-034 §6, Q132).
6. **Signing is part of the product, and the first release says what it lacks.** A public macOS
   release is signed with a Developer ID and notarised (Q128). Windows follows the route of Q129. **A
   release that is not signed may go only to the people the owner names** (Q131). Its download page
   carries the exact steps to open it and the reason for each step, never a workaround that disables
   Gatekeeper or SmartScreen.
7. **Releasing becomes an approved act** (Q133). This repository has had no Actions secrets until now
   (`image.yml`'s header). The app needs four kinds: the updater's signing key, the Apple certificate,
   the notarisation key and a Windows signing credential. They live in **one GitHub Environment**,
   which only `main` may deploy to and which waits for the owner's approval. None of them is ever in the
   repository (BD-002).
8. **Everything is auditable (BD-003).** Each app release names its commit and carries a provenance
   attestation. Each worker install that the app performs is the same install a person would make, so
   the core's existing records hold, with nothing new.

## Rationale

The wizard, the page, the approval flow and the self-update already exist and are reviewed. A shell
that hosts them adds ease of use and no second implementation to keep true. Keeping the worker in
Docker keeps BD-021's run isolation identical on every platform. Paying for signing buys the one thing
a thin wrapper is for: a colleague installs it without a terminal and without a warning they have
learnt to click through. A warning trained away on our app is a warning trained away for the next app.

## Alternatives considered

- **Re-implement the wizard natively.** Rejected: two copies of a secret-handling flow, one of them
  outside BD-022's text-node census.
- **Run the worker without Docker (a native worker process).** Rejected: run isolation (BD-021) would
  need a second sandbox per OS.
- **A Docker Desktop extension.** Rejected: it works with Docker Desktop only, while the owner allowed
  other engines, and it is distributed through Docker's marketplace.
- **Electron.** Rejected: it ships a browser (around 100 MB or more, `[unverified]`), and the owner
  asked for Tauri.
- **Publish to GitHub Packages or as an OCI artifact on ghcr.io.** Rejected in decision 5.

## Consequences

- **Costs, if the owner agrees:** USD 99 a year (Apple). For Windows, nothing (SignPath) or from
  USD 119.88 a year (Artifact Signing, through a legal entity). Public-repository runners are free.
- **An unsigned first release** costs each named user one or two extra clicks per install, and on
  Windows 11 Smart App Control may block it entirely. Q131 decides who may receive one.
- **New owner duties:** approving each app release, holding a backup of the updater key (losing it
  means every installed app must be reinstalled by hand), and renewing the Apple membership.
- **The worker must work on Windows first.** Today the worker's updater refuses a Windows project
  directory (research/20 § 6, backlog 990), so a Windows worker cannot self-update. The gate slice
  S-24.0 measures and fixes this before any app work starts.
- **Q123 matters more.** An app makes a personal-subscription worker one download away, so Anthropic's
  terms for that use should be answered before the first public release (S-24.0).

## Parked (2026-11-05, orchestrator-authorised, owner's decision)

The owner wants the easiest distribution with a great experience and does not mind the mechanism. A
one-command install served by the core (S-22.20: `install.sh` for macOS and Linux, `install.ps1` for
Windows; then the S-22.17 wizard, with the S-22.10 updater keeping the bundle current) covers it
without signing costs or a second release pipeline. M24 is **parked, not cancelled**: this record
and the owner's answers (Q128-Q133) stand, and it is un-parked on the owner's request.
