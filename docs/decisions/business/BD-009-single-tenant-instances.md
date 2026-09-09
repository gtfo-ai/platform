# BD-009 — One instance per organisation (tenant); many projects per instance

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/11

## Context
Brief: consider multi-tenancy; leaning to complete isolation.

## Decision
An instance serves exactly one organisation. Multiple projects per organisation with per-project isolation of knowledge, config, budgets and workspaces. No tenant identifier in the domain model.

## Rationale
Isolation by construction, simplest self-hosting story, no cross-tenant leak class of bugs; hosting later = one deployment per customer.

## Alternatives considered
- Shared multi-tenant DB with `tenant_id` — adds risk and complexity with no current customer.

## Consequences
- Cross-organisation analytics not possible without a separate control plane (TODO, later).
