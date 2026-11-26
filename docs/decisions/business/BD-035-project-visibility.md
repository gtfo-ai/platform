# BD-035 — A person sees only the projects they work in

- **Status:** accepted
- **Date:** 2026-11-26
- **Deciders:** the product owner
- **Relates to:** product/11 (amends its role list), TD-022 (2026-11-26 visibility amendment), TD-031 (claim scope, decision 8), technical/08, BD-032

## Context
The product owner's rule, verbatim: *"Users should not see 'NEEDS YOU' and on board other tasks — everywhere I see tickets or projects, I should see only projects I am assigned to."* Asked to clarify, the owner answered:

- organisation **admins keep seeing every project**, because they configure projects and people;
- **"assigned" means the projects a person chose for their worker** in the *Add a worker* wizard's Choose projects step (`workers.claim_project_ids`, where `null` means every project). The person must be able to change that choice later.

Today every signed-in user reads every project: `project.read`, `task.read` and `run.read` are `viewer` (`packages/domain/src/permissions.ts:149-189`), and a project membership only promotes a role, never demotes it (`apps/server/src/auth/rbac.ts:51`). `project_members` has no API writer. On fontai on 2026-11-26 it had 0 rows. Of fontai's 9 members, 1 had a worker scoped to one project, 2 had workers scoped to every project, and 6 had no worker.

## Decision
A person's **visible projects** are:

1. **every project** for an organisation `admin`;
2. **every project** for anyone else who has nothing that narrows it: no worker that is not revoked, and no `project_members` row;
3. otherwise, the union of:
   - each worker the person has that is not revoked, contributing its `claim_project_ids`. Whatever the claim policy, a `null` contributes every project. A legacy `'{}'` (migration 0108) also contributes every project, because it already reads as `null` wherever the project list narrows;
   - each `project_members` row the person holds;
   - each project where the person **owns a task that is not terminal**.

The last source closes a hole. A pick ignores the claim scope and usually makes the picker the owner, and a maintainer can assign an owner. Without this source, a person's own task, and the questions on it, would disappear from their view. When the task becomes terminal, its project is hidden again.

Rule 2 exists because a viewer, or anyone who does not run a worker, has chosen nothing. Reading their empty choice as "no projects" would leave them nothing to see.

**A hidden project answers like a project that does not exist.** Its reads and commands, and those of its tasks, runs, artifacts and shadow batches, answer `404` with the same body as a missing id. Lists and aggregates leave it out, and the live stream carries nothing about it. The server enforces this. The web app shows what the server answers.

**What a person may choose is not what they see.** The *What this machine takes* card, `project_not_eligible` and the worker protocol's `claim-scope` list keep offering every project where the person's role is `member` or above. That is how a narrowed person widens their scope later. The card therefore discloses the key, name and execution setting of those projects, and nothing of their work. This is the one exception.

## Rationale
The rule reuses a choice people already make. It needs no new administration screen and no data migration, and on day one it narrows exactly the people who already chose: one person on fontai.

Visibility is a **focus filter, not a confidentiality boundary**. Anyone at `member` or above can widen their own worker and see the project again. The boundary between what a person may do and what they may not stays the role table (product/11, TD-022).

## Alternatives considered
- **Visibility only through `project_members`.** Rejected: nothing writes that table, and the owner named the worker choice.
- **A missing choice means no projects.** Rejected: six of nine fontai members would see an empty product.
- **Limit the card's list to visible projects.** Rejected: a narrowed person could then never widen their scope.
- **Answer `403` for a hidden project.** Rejected: `403` confirms that the project exists, and a filter that tells you what it hides is not doing its job.

## Consequences
- Rows S-30.1 to S-30.3 of technical/13 build this. TD-022's visibility amendment lists every surface and the one function that computes the set.
- A new worker starts at `null`, which is every project. Until its person scopes it, a person whose other worker is narrowed sees everything again. Recorded as **Q135**.
- `maintainer` is narrowed like `member`, because the owner exempted only admins. Recorded as **Q136**.
- **Residual:** a pick that claims without assigning (a task held elsewhere, or an ask) runs on the person's machine, and its project may stay hidden on the web. The worker's local page still shows the run.
- **Not covered:** outbound posts in a chat channel or tracker, an administrator's exports, and a worker's run-token calls about the run it holds. None of these is a person browsing.
