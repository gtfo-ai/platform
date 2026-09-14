/**
 * The **fold** behind `TaskDetailResponse.human_time` — product/19 §16, product/09:29 (WP-29).
 *
 * It is a module of its own rather than a loop inside `findHumanTime` for one reason: everything
 * below is a pure function of rows and a configuration document, and everything in
 * `pipeline-queries.ts` needs a database to reach. Splitting them means the arithmetic a task page
 * publishes — the four buckets, the per-user rollup, the two identity shapes, and the setting that
 * decides whether anybody is named at all — is asserted in the unit tier rather than only through a
 * container.
 *
 * ## Two things it does not do
 *
 * **It never multiplies minutes by a rate, because this build has none** (Q73). product/09:29 asks
 * for human minutes *"shown next to token cost as total cost of delivery"*, and *next to* is what
 * this answers: `TaskRecord.cost_actual_usd` and `HumanTimeSummary.total_minutes` travel in one
 * document and are never added. No configuration key anywhere in this repository carries an hourly
 * rate, and a default one would be published on every task page as though it had been measured.
 *
 * **It never invents a bucket.** `by_kind` is built from `humanTimeKindSchema.options`, so a kind
 * added to the enum is a key here on the same commit — rather than a bucket whose absence a reader
 * would have to notice (standing rules 18 and 68).
 */
import type {
  AgenticConfig,
  HumanTimeByUser,
  HumanTimeKind,
  HumanTimeSummary,
  Id,
} from '@platform/contracts';
import { agenticConfigSchema, humanTimeKindSchema } from '@platform/contracts';

/** One `human_time_entries` row joined to `users`, as the read selects it. */
export interface HumanTimeRow {
  readonly kind: HumanTimeKind;
  readonly userId: string | null;
  readonly userName: string | null;
  readonly externalAuthor: string | null;
  /** `numeric(10,2)` arrives as a string from `pg`; `null` is a window still open. */
  readonly minutes: string | number | null;
}

/** `numeric(10,2)` sums exactly; repeated floating-point addition of them does not. */
export const roundMinutes = (value: number): number => Math.round(value * 100) / 100;

/**
 * product/18:32's one setting, **off** unless the project's effective configuration says otherwise.
 *
 * The document is parsed through the published schema rather than indexed into as `unknown`, and a
 * document that does not parse is read as the default — which is *off*, the direction that
 * publishes fewer names — and that means **any** unknown key anywhere in the stored document turns
 * the breakdown off, not only a malformed `features.human_time`. Strict schemas refuse rather than drop (technical/12), and on a **read**
 * the conservative answer is the right one (standing rule 20 splits the two sides).
 */
export const perUserBreakdownEnabled = (config: unknown): boolean => {
  const parsed = agenticConfigSchema.safeParse(config);
  return breakdownOf(parsed.success ? parsed.data : null);
};

const breakdownOf = (config: AgenticConfig | null): boolean =>
  config?.features?.human_time?.per_user_breakdown === true;

/**
 * The rows of one task, folded into what the API publishes.
 *
 * The per-user key is `user_id` when there is one and the provider account otherwise, which is the
 * same partition the projector writes windows under: on an instance where nobody has mapped an
 * account (BD-006, Q10) every row has `user_id: null`, and folding them all into one line would
 * publish a number that is nobody's.
 */
export const summariseHumanTime = (
  rows: readonly HumanTimeRow[],
  options: { readonly perUserBreakdown: boolean },
): HumanTimeSummary => {
  const byKind = Object.fromEntries(humanTimeKindSchema.options.map((kind) => [kind, 0])) as Record<
    HumanTimeKind,
    number
  >;
  const perUser = new Map<string, HumanTimeByUser>();
  let total = 0;

  for (const row of rows) {
    // A window still open has no minutes yet; it is an entry and contributes nothing (rule 16).
    const minutes = row.minutes === null ? 0 : Number(row.minutes);
    total += minutes;
    byKind[row.kind] += minutes;
    // A uuid contains no colon, so the prefix cannot collide with a platform user's id.
    const key = row.userId ?? `external:${row.externalAuthor ?? ''}`;
    const existing = perUser.get(key);
    perUser.set(key, {
      user_id: (row.userId as Id | null) ?? null,
      user_name: row.userName,
      // **The first account wins, not the last.** A mapped person's rows are a mixture: a review
      // window carries the provider account it came from and an approval or a steer carries none,
      // so overwriting would show or hide the account depending on which kind happened last. The
      // field is provenance — *where these minutes came from* — and the first one the task saw is a
      // stable answer; a person with two accounts is shown the first, which is stated rather than
      // implied because nothing here can merge them.
      external_author: existing?.external_author ?? row.externalAuthor,
      minutes: (existing?.minutes ?? 0) + minutes,
    });
  }

  return {
    total_minutes: roundMinutes(total),
    by_kind: Object.fromEntries(
      Object.entries(byKind).map(([kind, minutes]) => [kind, roundMinutes(minutes)]),
    ) as Record<HumanTimeKind, number>,
    by_user: options.perUserBreakdown
      ? [...perUser.values()].map((entry) => ({ ...entry, minutes: roundMinutes(entry.minutes) }))
      : null,
    entries: rows.length,
  };
};
