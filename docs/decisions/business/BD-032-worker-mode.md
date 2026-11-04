# BD-032 — Worker mode: agent runs may execute on developers' machines with the developer's own Claude subscription, beside or instead of the server's runner

- **Status:** accepted
- **Date:** 2026-11-04
- **Deciders:** the product owner (decisions 1–13 of the 2026-11-04 session, and the Autix deployment input of the same day); the architect, session 21, wrote them down and owns the technical choices in TD-031 and TD-032
- **Relates to:** BD-003, BD-004 (amended here), BD-009, BD-010, BD-011, BD-020, BD-021, BD-022, BD-025, TD-003, TD-011, TD-019, TD-021, TD-022, TD-025, TD-028, TD-031, TD-032, Q123, Q124, Q125, plan § "Milestone M22"

## Context

Until now every agent run executes in the core's own `runner` container (TD-028 decision 6), with one
credential the operator puts on the server: an `ANTHROPIC_API_KEY` (`api` mode) or a
`CLAUDE_CODE_OAUTH_TOKEN` (`local` mode, BD-004 decision 3). Two things make that the wrong only shape:

- **Whose subscription.** A team whose developers each hold a Claude subscription has no reason to buy a
  second, shared credential for the server, and the owner will not put a subscription token on a
  shared server at all. Today the only way to use the developers' subscriptions is to not use the
  platform.
- **The first production deployment has no runner.** The core will be deployed on Autix infrastructure
  as a Docker Swarm stack (Traefik, secrets synced from Infisical, `docker stack deploy` from an infra
  repository's CI with the image tag pinned there), with **no runner, no launcher and no
  docker-socket-proxy on the server**. Under TD-028's WP-53 amendment such an instance runs everything
  except agent stages *and the platform gates*. That has to stop being a degraded mode.

## Decision

Decided by the product owner on 2026-11-04. These rulings override any contrary sentence in the
product and technical documents, which are amended to match.

1. **The core is the brain; a worker is thin.** The core keeps planning (prompt, skills, command
   policy, context pack), every provider call, every credential but the developer's Claude token, the
   knowledge base, the cost ledger, redaction and gate evaluation. A **worker** runs on a developer's
   machine, receives a *run package*, executes it in the same isolated run container the server uses
   (BD-021), streams the transcript back, calls platform tools through the core, and reports the
   result. It has no database, no instance secret key and no integration secrets.
2. **The developer's Claude token never leaves the developer's machine.** The core never receives,
   stores or logs it. Runs on a worker are `local`-mode runs (BD-004 decision 2): their cost is
   estimated from the price table and labelled an estimate (BD-011).
3. **Three execution modes, per project:** `server_only`, `workers_only` and `hybrid`. The default is
   `hybrid` with the server preferred: the server's runner takes a run while it has a free slot and
   workers take what it cannot start. With *workers preferred*, workers take runs first and the server
   may take one that nobody claimed within a stated time. **A core with no runner at all is a
   supported deployment** — every project on it behaves as `workers_only`, and the platform's own work
   (intake, gates, knowledge, notifications) is unaffected by whether any worker is connected.
4. **One pool, no double work.** Every agent run becomes an *offer*; the server's runner and every
   worker take offers through the same claim, so two claimants never run the same work and a task
   never runs two stages at once.
5. **Who may take a run.** A worker takes runs only in projects its user is a member of. A run whose
   ticket is assigned to a developer is offered to that developer's worker first, for a short window,
   then to the pool.
6. **A lost worker** (a laptop closed mid-run) ends the run as today's lost lease does; the stage is
   started again **once** on any claimant; a second loss of the same stage entry goes to *Needs human*.
7. **A usage limit is not a failure.** A worker that knows it is at its subscription's usage limit
   does not take work and hands back an offer unspent; a run that hits the limit mid-run ends with its
   own reason (not a task failure), the stage is offered **once** more to another claimant, and the
   worker pauses until the limit resets. The UI shows *paused: usage limit until HH:MM*.
8. **A worker signs in with the platform's own login, never claude.ai's.** A device code shown by the
   worker is approved by the developer in the platform UI; the result is a per-machine credential tied
   to the user, listed and revocable per machine. Every run records which worker executed it.
9. **Installing and updating a worker is one compose file and nothing else.** The core serves a worker
   compose file pinned to its own image digests. An updater beside the worker updates it when idle,
   checks it, and reverts it if the check fails. Workers follow the core's version, never the
   registry's newest. The core accepts its own worker protocol version and the previous one; a worker
   outside that range stops taking work and says it must update.
10. **The core updates itself automatically — unless it is deployed by something else.** A
    self-managed core (the shipped compose file) updates itself without approval, always: backup,
    migrate, replace, check, and roll the code back when the check fails and every new migration was
    additive. A core deployed by an orchestrator or a CI pipeline (Swarm, Kubernetes, an infra
    repository pinning tags) does **not** update itself; it only advertises its own digests and
    protocol range to workers. The migration classes and the schema guard hold in both.
11. **A worker reaches the core over its public HTTPS hostname**, possibly through a CDN proxy (the
    Autix deployment: Cloudflare, no access gateway in front). Nothing in worker mode may depend on a
    connection held longer than such a proxy allows.
12. **Everything is auditable (BD-003):** who claimed which run, on which machine, under which lease,
    what it sent back, which update ran, from which digests to which, and what it rolled back.

## Rationale

Developers already pay for the model capacity; worker mode lets the platform use it without moving
any other secret, any decision or any record off the core. Keeping the worker thin keeps the trust
boundary small: a tampered worker can damage only the run it holds, whose push uses a short-lived
credential for that run's project — limited to unprotected branches by the provider's branch protection,
not to `agentic/*` (the in-container guard is the worker's own code) and whose result is judged by the core and by the provider's own CI
(BD-024). One offer pool instead of two schedulers is what makes *hybrid* safe: there is one claim and
one lease, so "never the same work twice" is a property of a row, not of coordination between systems.

## Alternatives considered

- **A fat worker** (its own database replica or planning) — rejected: moves secrets and decisions to
  machines the operator does not control, and two planners drift.
- **Routing by queue** (a remote queue beside `stage.execute`) — rejected: two schedulers, and the
  hybrid fall-back becomes a race between them.
- **Asking for approval before every core update** — offered and rejected by the owner in favour of
  always-automatic updates with migration classes; the residual is stated in TD-032.
- **Collecting developers' tokens on the core** — rejected by decision 2 and by BD-004 decision 3.

## Consequences

- **Anthropic's terms are unverified for this use (Q123).** Whether a developer may use a personal
  Pro/Max (or a Team/Enterprise seat's) subscription credential to run a company platform's automated
  agents has not been checked against Anthropic's current terms. BD-004 already makes subscription use
  the operator's responsibility; the operator guide repeats it for worker mode. **Recommendation:
  verify before enabling worker mode in production.** Implementation proceeds.
- **The developer's machine is a trust boundary** (technical/05 gains it): the developer can tamper with
  their worker, read their run's workspace and its git credential, and alter what their worker reports.
  It can also **under-report its token usage**: a worker's cost is an estimate the core computes from the
  usage the worker reports, so a tampered worker can make its runs look cheap and evade the organisation,
  project and task caps (BD-010) — the core cannot measure a subscription's spend. And with the
  per-integration opt-in for a static token or a deploy key (Q124), its push reach widens beyond the run's
  project or lifetime (TD-031 decision 5).
  What holds regardless: the credential's scope and lifetime, the core's re-redaction and re-validation
  of everything it receives, gates read from the provider, and a human merge (BD-007).
- **Routing is project configuration in the database, not in `.agentic/config.yml`** — where code
  runs and whose subscription pays is an administrator's decision, not something a pushed commit may
  change (BD-025; TD-031 decision 8).
- **Costs on workers are estimates** (BD-011); a hybrid project mixes reported and estimated costs, each
  labelled.
- New product surfaces: a *Workers* screen (mine; all for an administrator), worker approval page, a
  per-project *Execution* setting, the run page's *executed by*, the *paused* state, and an *Updates*
  panel for administrators of a self-managed core. Delivered by plan § "Milestone M22".
