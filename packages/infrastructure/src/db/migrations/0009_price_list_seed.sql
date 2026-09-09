-- 0009 — initial price list (BD-011, BD-013).
--
-- USD per million tokens, verified 2026-08-28 in docs/research/04-claude-platform-capabilities.md
-- § 3 against https://platform.claude.com/docs/en/about-claude/pricing and
-- https://platform.claude.com/docs/en/build-with-claude/prompt-caching. Cache multipliers on base
-- input: 5-minute write 1.25x, 1-hour write 2x, read 0.1x — except Claude Fable 5.1, whose cache
-- reads are 0.025x. batch_multiplier is the Batch API's flat 50 %.
--
-- fast_input / fast_output stay null: fast mode is a research preview on part of the range and its
-- pricing is not covered by the verified source above. The price-table maintenance job (WP-19)
-- fills them in when they are verified.
--
-- Seeding is idempotent; an operator who has already superseded a row keeps their own.
insert into price_list (
  model_id,
  effective_from,
  input,
  output,
  cache_write_5m,
  cache_write_1h,
  cache_read,
  batch_multiplier,
  source_url,
  verified_at
)
values
  ('claude-fable-5-1', timestamptz '2026-08-28 00:00:00+00', 10, 50, 12.5, 20, 0.25, 0.5,
   'https://platform.claude.com/docs/en/about-claude/pricing', timestamptz '2026-08-28 00:00:00+00'),
  ('claude-opus-5', timestamptz '2026-08-28 00:00:00+00', 5, 25, 6.25, 10, 0.5, 0.5,
   'https://platform.claude.com/docs/en/about-claude/pricing', timestamptz '2026-08-28 00:00:00+00'),
  ('claude-sonnet-5', timestamptz '2026-08-28 00:00:00+00', 2, 10, 2.5, 4, 0.2, 0.5,
   'https://platform.claude.com/docs/en/about-claude/pricing', timestamptz '2026-08-28 00:00:00+00'),
  -- research/04 records this model as `claude-haiku-4-5-20251001`; the undated id is the one the
  -- API and the SDKs take, and the one BD-013 names.
  ('claude-haiku-4-5', timestamptz '2026-08-28 00:00:00+00', 1, 5, 1.25, 2, 0.1, 0.5,
   'https://platform.claude.com/docs/en/about-claude/pricing', timestamptz '2026-08-28 00:00:00+00')
on conflict (model_id, effective_from) do nothing;
