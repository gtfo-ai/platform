/**
 * Who acts on each `features.<key>` the platform ships — the table the product's own screens are
 * compared against (WP-44, criteria 5 and 6; PROGRESS backlog 108 and 72).
 *
 * Twice a feature card told a maintainer standing in the wizard that a working feature did not work
 * — *"Stored; nothing in this build sends a notification of any kind"* on the digest card after
 * WP-32 shipped the notify band, and *"Ask the task — not built in this release"* after WP-31 — and
 * once the reverse: `features.epic_split` and `features.spike` shipped with **no** card, so no screen
 * could turn either on. Every one of those survived because the screen's list was a copy nobody
 * compared with anything. This table is the platform's own answer to *"does something read this
 * key?"*, and `apps/web/src/features/operating-mode.test.tsx` holds the cards to it in both
 * directions: every shipped key is a card or a declared exemption, every card is a shipped key, and
 * a card may say its feature is unbuilt **exactly when** this table names no reader.
 *
 * The keys are held to **`featuresConfigSchema`'s** key set — every `features.<key>` a project may
 * write, which is one more than `PLATFORM_DEFAULT_CONFIG.features` ships defaults for
 * (`history_bootstrap` has none; its reader defaults to off) — by the type below, and every path is
 * resolved against the tree by `feature-readers.test.ts` — a file git knows about whose text names
 * `features.<key>`, which may not be the defaults module (it declares every key, so citing it would
 * prove nothing). What the check cannot see, stated rather than implied: whether the cited module
 * **acts** on the value — no grep can, which is `autonomy-readers.test.ts`'s own limit.
 */
import type { PLATFORM_DEFAULT_CONFIG } from './effective-config.js';

export type FeatureKey = keyof NonNullable<(typeof PLATFORM_DEFAULT_CONFIG)['features']>;

/**
 * The modules that read each key, from the repository root. An empty list would be a key the
 * platform stores and nothing acts on — the case a card must then say out loud.
 */
export const FEATURE_READERS = {
  ticket_linter: ['packages/application/src/pipeline/ticket-lint.ts'],
  review_only: ['packages/application/src/pipeline/review-only.ts'],
  maintenance: ['packages/application/src/maintenance/scheduler.ts'],
  digest: ['packages/application/src/notify/policy.ts'],
  shadow_mode: ['packages/application/src/shadow/batch.ts'],
  history_bootstrap: ['packages/application/src/bootstrap/batch.ts'],
  epic_split: ['packages/application/src/pipeline/settings.ts'],
  spike: ['packages/application/src/pipeline/settings.ts'],
  human_time: ['apps/server/src/queries/human-time-summary.ts'],
  ask: ['packages/application/src/ask/settings.ts'],
} as const satisfies Record<FeatureKey, readonly string[]>;
