# TD-017 — GitHub Actions layout, pinning, Renovate, secret scanning, attestations

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/09, technical/11, BD-002

## Decision
Workflows as listed in technical/11; all `uses:` pinned to SHAs; Renovate (`config:best-practices`, weekly, custom managers for Dockerfile `ARG *_VERSION`) with Dependabot security alerts only; gitleaks in pre-commit and CI plus trufflehog weekly and GitHub push protection; CodeQL default setup; native arm64 runners (no QEMU); registry build cache on main, gha cache on PRs; provenance and SBOM attestations on images; rulesets with merge queue; DCO check; licence allow-list check with `pnpm licenses` and a `THIRD_PARTY_NOTICES.md` covering bundled binaries.
