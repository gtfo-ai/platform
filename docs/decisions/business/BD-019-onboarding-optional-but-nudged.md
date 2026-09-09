# BD-019 — Project onboarding is optional but strongly nudged and scored

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/06

## Decision
A project can run tasks without onboarding; the platform will auto-generate a technical baseline from the repository. Business onboarding (interview + document import) is optional. The UI shows a **knowledge completeness score** and the refinement agent labels drift only when a product direction exists. Missing knowledge sections are called out in retrospectives ("this return would have been avoided by a documented X").

## Rationale
Reduce time-to-first-value while making the value of onboarding visible rather than mandatory.
