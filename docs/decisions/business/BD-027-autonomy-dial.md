# BD-027 — One autonomy dial with presets over granular policies

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/18, BD-006, BD-018, BD-026

## Decision
Each project has an autonomy level — Observe, Assist, Supervised (default), Autonomous — that sets the granular policies (plan approval, probation, auto-apply, question timeout, review-only, shadow). Granular policies remain overridable; an override shows the dial as *Custom* with the differences. Readiness suggests a maximum level; maintainers may override visibly.

## Rationale
Eight independent policies are precise but hard to reason about; a dial gives teams a single, explainable step-up path while keeping precision available.

## Consequences
- Preset tables are versioned; changing a preset definition in a release never silently changes a project's effective policies (they are materialised at selection time and the UI offers "re-apply preset").
