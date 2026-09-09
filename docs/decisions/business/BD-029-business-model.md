# BD-029 — Everything is Apache-2.0; revenue from hosting, support and a registry service

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** BD-002, product/01

## Decision
No feature gating in the open-source product; audit, cost and governance features are never paid. Revenue candidates: managed single-tenant instances (BD-009 makes this a deployment, not a re-architecture), support and onboarding services, and an organisation-level registry service for pipeline templates, role prompts, skills and shared knowledge.

## Rationale
Trust is the product; gating the trust features would undercut it. Hosting and services monetise convenience, not capability.

## Consequences
- Marketing metric: cost and cycle time per merged MR, never lines of code.
- The registry format is designed in the open (product/13 skills, `.agentic` layout) so a hosted registry is a convenience, not a lock-in.
