-- WP-30 — the autonomy dial, materialised (BD-027), and one stored configuration value repaired.
--
-- ## `projects.autonomy_policies` — BD-027's one consequence
--
-- BD-027:14: *"Preset tables are versioned; changing a preset definition in a release never silently
-- changes a project's effective policies (they are materialised at selection time and the UI offers
-- 're-apply preset')."* Until this migration a project stored only the **word** (`autonomy_level`),
-- so editing `AUTONOMY_PRESETS` in a release changed every project's policies at once — the exact
-- thing the decision forbids. The column below is the copy the decision asks for: the fifteen
-- granular policies plus the version of the table they came from, written when the dial is set.
--
-- Its shape is `materialisedAutonomySchema` (`packages/contracts/src/records.ts`) and it is parsed
-- through that schema on every read, so a document this migration or a later release wrote that does
-- not match is a named refusal rather than a silent default.
--
-- **Nullable, with no database default, and that is deliberate.** A default frozen in SQL would hand
-- a project created in a *later* release the preset of this one — the same re-derivation bug one
-- layer down. Every writer supplies the document (`POST /api/projects`, `PUT …/config`,
-- `PUT …/autonomy`), so the only rows that can be null are ones inserted by a test harness or by a
-- process older than this migration; `resolveMaterialisedAutonomy` answers those by **saying they are
-- not materialised** rather than by inventing a preset, and the pipeline's plan-approval gate keeps
-- its pre-WP-30 behaviour for them (standing rule 16 — an absent value is not a default, and the
-- absent case must not be the quiet one).
--
-- ## The backfill is frozen on purpose
--
-- The four documents below are `AUTONOMY_PRESETS` at `AUTONOMY_PRESET_VERSION = 1`, transcribed. A
-- later release that edits a preset **must not** edit them (TD-011: forward-only, never edited once
-- applied) — the disagreement that then appears between this file and the source is not drift, it is
-- the property BD-027 is asking for, and "re-apply preset" is how an operator opts into the new
-- values. `test/integration/server/settings.integration.test.ts` asserts the equality while the
-- version is 1 and says so when it is not, by re-running the statements below over rows as a
-- pre-0021 build would have left them ("gives a pre-0021 row the policies its level meant, for all
-- four levels"). The comment is corrected in place, which TD-011's forward-only rule allows only
-- because this file has not shipped in any release yet — the statements themselves are untouched.
alter table projects add column autonomy_policies jsonb;

update projects set autonomy_policies = jsonb_build_object(
  'level', 'observe',
  'preset_version', 1,
  'applied_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'applied_by', null,
  'policies', '{"picks_up_new_tickets":false,"stop_after_stage":null,"plan_approval":"always","plan_approval_size_threshold":null,"plan_approval_for_risk_classes":true,"probation":true,"probation_tasks":5,"business_review":false,"question_timeout":"1 working day","human_mr_rounds":3,"knowledge_auto_apply":false,"budget_approval_threshold_usd":null,"review_only":true,"shadow_mode":true,"suggested_readiness_min":0}'::jsonb
) where autonomy_level = 'observe';

update projects set autonomy_policies = jsonb_build_object(
  'level', 'assist',
  'preset_version', 1,
  'applied_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'applied_by', null,
  'policies', '{"picks_up_new_tickets":true,"stop_after_stage":"architecture","plan_approval":"always","plan_approval_size_threshold":null,"plan_approval_for_risk_classes":true,"probation":true,"probation_tasks":5,"business_review":false,"question_timeout":"1 working day","human_mr_rounds":3,"knowledge_auto_apply":false,"budget_approval_threshold_usd":20,"review_only":false,"shadow_mode":false,"suggested_readiness_min":0}'::jsonb
) where autonomy_level = 'assist';

update projects set autonomy_policies = jsonb_build_object(
  'level', 'supervised',
  'preset_version', 1,
  'applied_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'applied_by', null,
  'policies', '{"picks_up_new_tickets":true,"stop_after_stage":null,"plan_approval":"above_size","plan_approval_size_threshold":"L","plan_approval_for_risk_classes":true,"probation":true,"probation_tasks":5,"business_review":true,"question_timeout":"1 working day","human_mr_rounds":3,"knowledge_auto_apply":false,"budget_approval_threshold_usd":50,"review_only":false,"shadow_mode":false,"suggested_readiness_min":1}'::jsonb
) where autonomy_level = 'supervised';

update projects set autonomy_policies = jsonb_build_object(
  'level', 'autonomous',
  'preset_version', 1,
  'applied_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'applied_by', null,
  'policies', '{"picks_up_new_tickets":true,"stop_after_stage":null,"plan_approval":"never","plan_approval_size_threshold":null,"plan_approval_for_risk_classes":true,"probation":false,"probation_tasks":0,"business_review":true,"question_timeout":"1 working day","human_mr_rounds":5,"knowledge_auto_apply":true,"budget_approval_threshold_usd":null,"review_only":false,"shadow_mode":false,"suggested_readiness_min":2}'::jsonb
) where autonomy_level = 'autonomous';

-- ## `features.review_only.trigger = 'manual'` → `'paths'` with an empty list (PROGRESS backlog 58)
--
-- WP-24 narrowed the enum from `label | all | manual` to `label | all | paths`. Boundary schemas are
-- strict, so the old value is **refused** rather than dropped — right on the write side and wrong on
-- the read side, where `GET /api/projects/:id/config` answered `500 invalid_stored_config` for the
-- whole document and named no key. The platform's own `PUT …/config` was the producer of the value
-- (WP-21 accepted `manual`), so the population is small but not empty.
--
-- `paths: []` and **not** `label`: an empty path list matches nothing, which is exactly what the
-- pipeline already does with a stored `manual` (`matchesReviewOnly`'s `default:` branch takes the
-- paths route and matches nothing). So this migration changes the document and **no behaviour**.
-- Rewriting to `label` would start an enabled project reviewing every labelled merge request it
-- never asked for — a decision that spends money and posts to a provider, which is standing rule
-- 20's fail-closed direction.
--
-- The read side of backlog 58 is repaired in the same work package and is the general fix: the
-- endpoint now names the key and the value it could not parse, so a stored document this migration
-- does not know about is a `409` an operator can act on rather than a `500`.
update projects
set config = jsonb_set(
  jsonb_set(config, '{features,review_only,trigger}', '"paths"'::jsonb, true),
  '{features,review_only,paths}',
  coalesce(config #> '{features,review_only,paths}', '[]'::jsonb),
  true
)
where config #>> '{features,review_only,trigger}' = 'manual';
