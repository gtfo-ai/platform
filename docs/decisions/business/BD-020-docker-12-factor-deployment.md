# BD-020 — Docker is the only supported deployment; 12-factor

- **Status:** accepted
- **Date:** 2026-08-28

## Decision
The platform ships as container images: a **base image** with runtime plus all required CLIs (git, Claude Code SDK binary, `glab`, and the integration tools chosen in research/03) and a **product image** layered on top with the platform code, so code changes do not rebuild the tool layer. Configuration only via environment variables (with documented defaults), logs to stdout, stateless processes, backing services attached by URL, health endpoints. A single `docker compose` starts a complete instance.

## Rationale
Cloud-native, reproducible agent environments, simple self-hosting, matches the brief.

## Consequences
- Agent workspaces need their own isolation model (BD-021; Round 2 decides container-per-run vs shared runner).
- Version pins for every bundled CLI; image is rebuilt on a schedule for security updates.
