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

## Amendment (M5 architect pass, session 8, 2026-09-27) — a minted credential is redacted everywhere by its *shape*, never by a stored copy of its value

**The gap.** Step (1)'s exact-match replacement of a *minted* run credential lives only in the memory
of the process that minted it (`packages/application/src/pipeline/run-redaction.ts:96-126`, WP-72's
decision (a) of PROGRESS backlog 154). Every other process — on the shipped topology that is `app`,
which handles every webhook — relies on step (2)'s gitleaks-derived `gitlab-token` rule, which knows
GitLab's default `glpat-` prefix and nothing else. GitLab lets an administrator change the token prefix
and project access tokens inherit it (the citation is in backlog **259**), so on such an instance a
minted credential quoted back in a merge-request comment reaches `events.payload` unredacted in every
process but one.

**Decision.** The minting process records, beside the mint's audit row, a **non-secret shape** of the
credential — its observed prefix (the characters before the provider's documented random part), its
character class and its length — and every process compiles one additional step-(2) rule per recorded
shape from those rows at composition and on the existing configuration refresh. A shape is never a
value: it names no characters of the random part, so storing it breaks neither BD-002 nor this record's
*"originals are never stored"*. The rule over-redacts any other token of the same shape, which is the
safe direction and is counted in `redaction_count` like every other rule.

A provider that declares `credentialMinting` must also declare that its minted values **have** a stable
shape; a provider that cannot is refused minting (the capability is declined at registration) until a
decision on a shared exact-value registry exists. That registry — the minted value sealed in `secrets`
per run and readable by every product process (backlog 259's option (b)) — is **rejected for 0.1**:
it puts a recoverable copy of a live push credential in the one database every product process can
read, which is precisely the copy this record exists to prevent, and it buys nothing over the shape
rule for the one minting provider this build ships.

*Consequences.* One table or column for the shapes (migration, technical/03 amended); the stale
sentence at `packages/application/src/ports/integrations/git-provider.ts:377` (*"`false` means the
operator's static bot token is used as-is"*, contradicting TD-028 decision 6) is corrected in the same
change. Built by M5 **WP-80**.

## Amendment (M6 architect pass, session 9, 2026-09-30) — a shape reaches every process on commit, a repository reading redacts by the project's credentials, and the write guard uses the redactor's corpus

Three gaps M5's delivery left around the shape rule and the stored reading. None changes the M5
amendment's decision (a shape, never a stored value).

1. **Propagation.** The M5 amendment compiles the recorded shapes *"on the existing configuration
   refresh"*, which WP-80 built as a five-second timer, so a process that did not mint learns a new
   shape up to one interval late, and a refresher that keeps failing keeps a stale set while logging a
   warning (PROGRESS backlog **276**). **Decision:** the transaction that records a shape notifies on
   commit through the transactional broadcast, and every process — every `ROLE` — listens on its own
   channel and re-reads on it; the timer stays as the guarantee (TD-028 decision 9's argument: the
   notification is latency, the poll is the guarantee). After a stated number of consecutive failed
   refreshes the process reports at `error`. *As built at WP-107 (session 11):* the number is **12** —
   one minute at the 5 s cadence — reported once at `error`, later failures at `debug`, and the next
   success at `info`.
2. **The repository reading.** Since WP-92 the refresh stores up to 64 files of free text a human wrote
   (`.agentic/prompts/`) under pattern redaction only, and hands it byte-identical to the planner, so a
   binding credential committed there in a shape no rule knows is stored, sent to the model and kept in
   `runs.user_prompt` (PROGRESS backlog **316**). **Decision:** the reading composes an exact-value
   redactor over the decrypted credentials of the project's bindings — the loader already decrypts them,
   and the reading runs outside any transaction — before the texts are stored. The platform cannot
   un-leak a secret committed to the project's history; it stops making more copies of it.
3. **One corpus.** The write-content guard refuses secret-shaped content through the gitleaks-derived
   list alone, while the redactor applies the shape rules first, so since WP-80 the redactor's corpus is
   larger than the guard's (PROGRESS backlog **277**). **Decision:** the guard uses the redactor's
   current rules, accepting that a same-shape non-secret write is refused, which is the safe direction.

*Consequences.* No migration. `docs/technical/05`'s WP-80 amendment and redaction section and the stale
comment on the refresher are corrected by the rows that build them: (1) and (2) by M6 **WP-107**, (3)
by M6 **WP-104**.

*As built at WP-107 (session 11), part (2):* a binding whose credentials cannot be decrypted never
keeps a restriction from applying — the reading's configuration half is stored as usual, and only the
prompt texts fail closed: while any of the project's integrations is unreadable, no prompt text is
stored (the previous ones are dropped with the row, because they may predate this amendment), and the
refresh names each such integration (`prompts_withheld`) and logs at `error` (PROGRESS backlog 358,
found as a regression of the row's first version). The exact-value set is the decrypted `secret_ids` of
the project's bindings; a credential an operator left in `integrations.config` and an organisation
account with no binding are outside it (backlog 362, 364).

## Amendment (M7 architect pass, session 11, 2026-10-02) — a reading says how it was redacted, and the exact-value set covers every credential the platform holds

Three gaps were left by amendment (2) of the M6 pass, as built at WP-107 (PROGRESS backlog **359**,
**362**, **364**, **363**). None of them changes decisions 1–3.

1. **A reading records its redaction.** The stored repository reading gains a mark, `patterns` for
   every row written before this amendment and `exact` for every new one. At upgrade, a pass in the
   process that runs the index re-reads each project whose reading is `patterns`, bounded per pass. A
   `patterns` reading that cannot be re-read serves **no** prompt text to the planner, and records why.
   This is the direction WP-107 chose for an unreadable binding: a stale copy that may hold a
   credential is withheld, never served.
2. **The exact-value set is every credential the platform holds for the project.** That means the
   bindings' decrypted `secret_ids`, plus each provider's declared secret fields
   (`packages/integrations/src/catalogue.ts`) found in its `integrations.config`, which only a row
   written before WP-100 or by SQL can carry. It also includes the decrypted credentials of the
   organisation's communication accounts, which have no binding but sit in the same `secrets` table.
3. **A withheld text is recorded, not only logged.** The reading stores the integrations whose
   credentials could not be read. `GET …/config` and the run's prompt record carry the list, so a run
   whose convention-append files are missing says why.

*Consequences.* One migration (the mark and the withheld list). Built by M7 **WP-121**, which also
updates technical/05's WP-107 amendment. The platform still cannot un-leak a credential committed to
a project's history; it stops making copies of it.
