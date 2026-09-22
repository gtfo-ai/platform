# TD-012 — Secret redaction as a pure function in the single persistence path; gitleaks-derived rules plus exact-match of injected secrets

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/07, technical/03, BD-002, BD-003

## Decision
Before any write to `run_messages`, `integration_actions`, `events.payload`, `config_audit`, artifacts and KB commits: (1) replace every secret value the platform injected into the run/environment (`[REDACTED:integration:<name>]`), (2) apply a curated subset of gitleaks' rule set compiled for JS (generic API keys, private keys, cloud/provider tokens incl. Anthropic/OpenAI, JWTs, connection strings) with `[REDACTED sha256:<6>]` placeholders, (3) optional entropy heuristic in key-like contexts. Record `redaction_count` and `redaction_log`. Originals are never stored (append-only rows cannot be fixed later). The rule set has unit tests with fake secrets and a CI check that fixtures contain none.

## Amendment (WP-52, 2026-09-22) — the two prompt columns join the list, and an *identifier* is refused rather than rewritten

Recorded by the orchestrator before WP-52 implemented it, because the code would otherwise have
contradicted this record by implication. Two changes and one clarification.

**1. The write list gains `runs.system_prompt` and `runs.user_prompt`.** Q64 recommends storing the
assembled prompt, redacted at the write, and amending this list in the same change. An enumeration a
new write path is merely absent from is how `inbox` carried raw deliveries from `0005` until WP-15c
found them, so the column is named here rather than left to be implied by "any write". The prompt is
the **fourth** copy of somebody else's words — after `inbox.payload`, `tasks.ticket_snapshot` and
`kb_chunks` — and the first that concatenates the ticket, the pack and the platform's own role prompt
into one document, which is why it is enumerated and not assumed.

**2. Step (1) does not apply to a field the platform branches on.** The original decision says
*"replace every secret value the platform injected"*, and over **structured artifact data** that
instruction is unsafe as written. `packages/application/src/pipeline/saga.ts`'s `recordMergeRequest`
reads the `ImplementationNotes` **row** back and addresses a merge request with `mr.head_sha` and
`mr.url`; a `[REDACTED:integration:…]` written into either is a value the platform then queries a
provider with. So each artifact type declares which of its fields are **identifiers** and which are
**prose**:

- **prose** is redacted, as step (1) has always said;
- an **identifier** that *contains* an injected secret is **refused** — the write fails by name and
  the run escalates — never rewritten.

This is the answer `idempotencyScopeFor` already gives for an idempotency key and for the same reason:
redaction is many-to-one, an identity must not be, and a rewritten identifier answers one question
with another question's subject. The refusal is fail-closed in the direction that costs one run.

**3. `redaction_count` is a column, not a hope.** This decision requires the count on the row; the
`artifacts` table shipped without one (`0004_pipeline.sql:138-150`), so a redaction that *did* happen
left no trace. It is added, and it is asserted in **both** directions (a run with nothing to redact
reads `0`; a writer that redacted nothing is not reachable), because a count that only ever grows from
a default is indistinguishable from a redactor that stopped working — the argument
`integration_actions.redaction_count` and `inbox.redaction_count` already carry.

**The redactor is the run's own**, built from `RunSpec.env` and `RunSpec.secretEnvNames` — the same
construction `apps/server/src/agent.ts` uses for the transcript sink — so an artifact and the
transcript of the run that produced it cannot name different secrets.
