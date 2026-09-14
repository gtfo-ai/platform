-- 0028 — the dependency gate's finding, and the reviewers a merge request needs (WP-38).
--
-- Two columns, two work packages' halves, one migration because both are `tasks` and both are read
-- by one screen: product/10:38's Checks panel.
--
-- ## `dependencies` — product/04:58, product/18:43, BD-030
--
-- *"Adding a third-party dependency follows the project policy (`ask` by default → a question with
-- license and maintenance status; `allow` for allow-listed packages; `block`)"*. Until this
-- migration `policies.dependency_policy` had a default and **no reader**, and nothing in the
-- platform could see a dependency being added at all: the only code that looked at a change's
-- contents kept the paths and threw every patch away.
--
-- What the column holds (`taskDependenciesSchema`, parsed before every write for the reason
-- `coverage` is — a `jsonb` column accepts any document and the disagreement surfaces at the
-- reader, WP-15h):
--
--   {"head_sha": …, "decision": "none" | "allow" | "ask" | "block",
--    "added": [{"ecosystem": "npm", "name": …, "from": "manifest" | "lockfile", "path": …,
--               "policy": …, "allowlisted": false,
--               "metadata": {"status": "not_checked" | "checked" | "unavailable" | "unsupported",
--                            "license": … | null, "last_published_at": … | null,
--                            "deprecated": … | null, "source_url": … | null}}],
--    "unread": [{"ecosystem": "maven", "path": "pom.xml"}],
--    "truncated": false, "question_id": … | null, "checked_at": …}
--
-- `null` on the column is a **third** answer beside the record's own: the gate has not run, because
-- no implementation stage has completed on this task. A record whose `added` is empty is the gate
-- saying *"it ran and this diff touched no manifest"*, and the panel prints a different sentence for
-- each (standing rule 18). `unread` is the same rule one level down: a `pom.xml` in the diff is
-- named rather than answered with silence, because this build cannot read Maven.
--
-- Every string inside is untrusted (BD-022): a package name and a manifest path come out of
-- somebody's diff, and a licence out of a package registry. All three are bounded by the schema and
-- redacted at the write through the git binding's redactor.
--
-- ## `required_reviewers` — product/10:38, product/19:138
--
-- WP-37 computed this and kept it nowhere. The people a merge request needs a review from lived
-- only in the `set_reviewers` row of `integration_actions`, and **that row is written only when at
-- least one handle resolved to an account** — so a `CODEOWNERS` naming a group, a team or somebody
-- who has left left no record at all, and a projection over the audit would have printed "none
-- required" for exactly the case a maintainer needs to see. The column records what the platform
-- *asked for*; the merge request remains the record of who is assigned on the provider, and the two
-- may differ (`set_reviewers` adds and never replaces, so a human who added themselves stays).
--
--   {"source": "codeowners" | "project_config" | "requester" | "none",
--    "handles": [...], "assigned": [...], "unresolved": [...],
--    "truncated": false, "routed_at": …}
--
-- ## Ownership
--
-- One writer each — `TaskRepository.saveDependencies` and `saveRequiredReviewers` — narrow for the
-- reason every narrow writer here is (standing rule 79): both run in `pipeline.outbound` jobs beside
-- the stage executor's transactions, so a whole-row `save` from either would put back the state, the
-- stage and the cost as they were when the job started (measured at 0.40 USD of a task's recorded
-- spend in WP-15d). Neither bumps `tasks.version`: `save` does not name these columns, so a token
-- bump here would refuse an in-flight aggregate write that never touched them.

alter table tasks add column dependencies jsonb;
alter table tasks add column required_reviewers jsonb;

comment on column tasks.dependencies is
  'What the dependency gate found in this task''s diff and what it did about it (WP-38, product/04:58): the packages an added manifest or lockfile line named, the policy each resolved to, the registry metadata if an operator declared a registry host, and the manifests this build cannot read. Null means the gate has not run — see taskDependenciesSchema.';

comment on column tasks.required_reviewers is
  'Who this merge request needs a review from, as the risk_route duty computed it (WP-38, product/10:38): the handles the precedence chose, the accounts they resolved to, and the ones that resolved to nobody — which the set_reviewers audit row cannot record, because no call is made when nothing resolved.';
