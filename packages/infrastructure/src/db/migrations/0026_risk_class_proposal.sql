-- 0026 — the risk classes a Discovery run proposed, waiting for somebody to accept them (WP-37).
--
-- product/18:52 makes this a **wizard step** rather than a setting: *"Risk classes proposed from the
-- repository structure; reviewer routing from CODEOWNERS if present"*. So the six classes of
-- product/19 §14 are **not** in `PLATFORM_DEFAULT_CONFIG` and a Discovery agent's answer is **not**
-- written to `projects.config`: putting either there would gate every existing project's migrations
-- on the next deploy with nobody having chosen it, which is the one direction this feature must not
-- fail in. A proposal is a thing a human accepts (product/06: *"Nothing is committed without
-- acceptance"*), and acceptance is the ordinary `PUT /api/projects/:id/config` with its
-- `human_actions` row.
--
-- **Why a column on `projects` rather than a queue of its own.** `kb_proposals` is the platform's
-- other acceptance queue and it accepts *pages*: a row there carries a target path and a diff, is
-- applied by committing to an `agentic/knowledge/*` branch, and is decided one page at a time. A
-- risk-class set is one decision about one configuration key, and modelling it as N page-shaped
-- rows would add a second apply path and a second decision endpoint for something the config `PUT`
-- already does. One nullable column, one narrow writer, one reader.
--
--  * `null` — no Discovery run has proposed anything (every project before this migration, and
--    every project whose discovery run drafted no classes). The wizard then offers the platform's
--    own five from product/19 §14, which is a different sentence on the screen and deliberately so:
--    "the agent looked at your repository and suggests these" is not "here is the standard set".
--  * a JSON object — the *config-shaped* map, ready to be sent back through the configuration
--    write. It is stored in the shape it will be accepted in, so that acceptance is a copy rather
--    than a translation somebody has to keep in step with the schema.
--
-- The value is **model output about somebody's repository** (BD-022): the paths are bounded by
-- `discoveryDraftDataSchema` and the class *names* are the platform's own — `onboarding/record.ts`
-- maps what the model said onto `PROPOSED_RISK_CLASSES` and drops a name outside that table, so a
-- repository cannot invent a class, and `require` is never taken from the model at all.
--
-- **Ownership.** One writer, `ReadinessStore.saveRiskClassProposal`, which is narrow for the reason
-- `projects.readiness_level`'s writer is (standing rule 79): it runs in the `onboarding.discovery`
-- job, beside whatever wizard step is editing the project row, and a whole-row update from there
-- would put back a name, a configuration or an autonomy dial a human had just changed.

alter table projects add column proposed_risk_classes jsonb;

comment on column projects.proposed_risk_classes is
  'Risk classes a Discovery run proposed from the repository structure (product/18:52, WP-37), config-shaped and never applied: policies.risk_classes changes only through the configuration write a human makes. Null means nothing has been proposed.';
