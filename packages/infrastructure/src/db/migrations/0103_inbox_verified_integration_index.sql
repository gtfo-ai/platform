-- migration-class: additive
-- 0103 — the index behind an integration's newest verified delivery (S-25.3, product/08's
-- 2026-11-06 amendment: health is read from traffic).
--
-- `GET /api/integrations` publishes, for every integration, the newest `inbox` row it delivered
-- that passed its signature check (`activity.last_delivery_at`), and derives `current_health` from it
-- beside the newest outbound call (`apps/server/src/queries/integration-queries.ts`,
-- `readIntegrationTraffic`). `inbox` had no index that leads with `integration_id` except
-- `inbox_refused_idx`, which is partial on `error is not null`, so the read would have been a scan
-- of every delivery ever received — the table no sweep shortens — once per listed integration.
--
-- Partial on `verified`, because that is the only row the read wants: an unverified delivery is
-- evidence of nothing (it writes no row today, migration 0014's note, and a row from before that
-- reads `false`). `(integration_id, received_at desc)` answers `order by received_at desc limit 1`
-- with one index probe. The outbound half needs nothing new: `integration_actions_integration_idx
-- (integration_id, created_at desc)` (migration 0007) is on every partition.
--
-- Additive by TD-032's list: an index the previous build never names. An index only, so the Drizzle
-- definitions and the parity test are unchanged (the parity test does not compare secondary
-- indexes — migration 0039's note).
create index inbox_verified_integration_idx
  on inbox (integration_id, received_at desc)
  where verified;
