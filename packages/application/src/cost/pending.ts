/**
 * What an admission counts **beside** the ledger — and why every cap in this platform needs it.
 *
 * ## The defect, measured
 *
 * A cap is enforced at admission (`cost/guard.ts`, and the three feature caps in the stage
 * executor) and read from `cost_entries`, which the cost **ledger** writes from a handler on
 * `run.finished` / `run.failed` in its own transaction, *after* the run's own transaction has
 * committed. Between those two commits the platform has spent money that no query can see. A
 * second admission in that window reads a spend that is lower than it is and starts a run the cap
 * should have refused.
 *
 * It is not a theory. On WP-40's tree, with the ledger handler delayed by 8 s and nothing else
 * changed, `test/e2e/onboarding/history-bootstrap.e2e.test.ts` › "stops the batch when its budget
 * cap is spent" admitted **2** runs against a cap that allows **1**, three times out of three —
 * where the same case passes on an idle machine because the dispatcher happens to win the race.
 * The same shape is what failed that case once under a load average of 11 in a full `verify:e2e`.
 * Every cap on this mechanism is exposed the same way: the organisation and project budgets
 * (WP-19), the shadow budget (WP-34), the maintenance budget (WP-36) and the history bootstrap's
 * (WP-35) — by up to one run per admission that lands inside the window.
 *
 * ## The rule
 *
 * > **A cap is compared against what the scope has spent *and* what it has committed.** A run the
 * > ledger has not recorded is counted at what it may still spend — the stage's per-run cap, the
 * > same figure the admission already adds for the run it is about to start — while it is live,
 * > and at the figure its **own** transaction wrote (`runs.usd_reported`, or `runs.usd_estimated`
 * > when the platform priced it — WP-47) once it has ended.
 *
 * The two halves are what make the term self-clearing rather than a second running total to keep
 * true: a live run's reservation disappears the moment it ends, an ended run's reported figure is
 * replaced by the ledger's rows the moment they exist (the entries sum to the provider's run
 * total, BD-011, so the number does not move), and a run that never reaches the ledger at all is
 * counted at what it really cost rather than at a reservation nobody can retire.
 *
 * **The task cap needs none of this**, and that is the argument for the shape rather than an
 * exception to it: `taskBudgetExhausted` reads `tasks.cost_actual`, which `record`'s own
 * transaction increments together with `runs.finish` and `run.finished`. A cap read from a column
 * the run's transaction moves cannot lag the run; a cap read from a projection a later handler
 * writes always can.
 *
 * ## The residual, **closed at WP-47**
 *
 * A run that ended **without a figure of its own** — a local-mode run whose cost the platform
 * prices from `price_list`, or a `run.failed` that carried no cost — used to contribute **nothing**
 * to the pending term between its own commit and its ledger row, because `runs.usd_reported` is
 * `null` for it. Under BD-004 `local` mode that is *every* run (`is_estimate: spec.providerMode ===
 * 'local'`), so one whole provider mode was invisible to every cap for the dispatcher's latency —
 * the reading PROGRESS backlog **110** added to this paragraph's own understatement.
 *
 * It is closed by giving `runs.usd_estimated` its first writer — `RunRepository.finish` puts the
 * run's own figure there when it is an estimate (migration 0035 made the column nullable, because
 * `not null default 0` could not tell "nobody priced it" from "it cost zero") — and by reading
 * `coalesce(usd_reported, usd_estimated, 0)` here. Pricing **at admission** is still refused for the
 * reason it always was: a price table is the ledger's to read, not an admission's.
 *
 * What remains is the honest absence: a run **nobody measured** — the one the lease sweep ends —
 * has neither column set and counts 0, with no ledger row ever written for it either (standing
 * rule 16). That is not a gap in the term; it is the term saying that nothing is known.
 *
 * The other direction is stated too: a **live** run is counted at the admitting stage's per-run
 * cap, which is exact when the scope is one kind of work (a bootstrap batch mines with one stage)
 * and an approximation when it is a whole organisation. It is deliberately the figure WP-19
 * already knows rather than a new number to configure, and it is spent only while a run is live,
 * so the approximation has the lifetime of a run and not of a window.
 *
 * **The sharp edge of that was unbounded until WP-47, and now it is not.** A run whose process died
 * stayed `running` for ever and therefore held its reservation for ever — against *every* future
 * daily and monthly window, because a live run is always in the window and nothing retires it.
 * Nothing expired a run's lease: `runs.lease_owner`/`lease_expires_at` had no reader and no writer,
 * and `recovery/stranded.ts` said in as many words that *"is there a run that will never finish?"*
 * was a different question with no owner. Both halves exist now — `pipeline/lease.ts` writes the
 * lease on a heartbeat inside `stage.execute`, and `recovery/run-lease.ts` ends a run nothing is
 * renewing — so the approximation's lifetime is a run **plus the lease's TTL and one pass
 * interval**, about six minutes at the shipped numbers, rather than for ever. It was backlog
 * **109** (the lease) and **110** (the unreported figure).
 *
 * The direction of the remaining error is unchanged and deliberate: a cap that reads high refuses a
 * run (standing rule 20: a mutation fails closed), and it is **visible** — the pause names the
 * committed figure apart from the spent one, which is why {@link capSpendDetail} keeps them apart.
 * The alternative, counting only runs that have ended, trades a stuck cap for silently spending past
 * one, and a platform that spends somebody's money is the worse failure.
 *
 * **A fourth residual has the same shape as the defect this closes, and is narrower.** The cap
 * reads and the `runs` insert happen in one transaction (`stage-executor.ts`), at READ COMMITTED,
 * with no row lock between them: two `stage.execute` jobs admitting **at the same instant** each
 * read a pending set that cannot yet contain the other's row, and both are admitted. The window
 * is the admitting transaction's own length rather than the dispatcher's latency to the ledger,
 * and it is pre-existing — WP-19's guard had it before the pending term existed. Closing it is a
 * serialising lock on the scope row (the project, the organisation, the batch) taken before the
 * read, which is a decision about lock ordering across every admitter and not this change's.
 */
import type { Slug } from '@platform/contracts';

/** What a cap is measured against: the ledger's rows, and the runs it cannot see yet. */
export interface CapSpend {
  /** Recorded in `cost_entries` — the ledger, and the platform's record of money spent. */
  readonly spentUsd: number;
  /** Committed by runs the ledger has not recorded; see this module's docblock for the valuation. */
  readonly pendingUsd: number;
}

/** A cap, what it has been charged, and what the run being admitted may add to it. */
export interface CapAdmission extends CapSpend {
  readonly capUsd: number;
  /** What *this* run may spend — `runBudgetUsd`, added for `taskBudgetExhausted`'s reason. */
  readonly reserveUsd: number;
}

/**
 * Would admitting this run take the scope past its cap?
 *
 * `>` rather than `>=`: a run that exactly fills the cap is admitted, which is the comparison
 * `taskBudgetExhausted` has always made and the one the shipped figures are derived from
 * (`features.history_bootstrap.budget_usd` = 20 is ten $2 runs, not nine).
 */
export const capIsSpent = (admission: CapAdmission): boolean =>
  admission.spentUsd + admission.pendingUsd + admission.reserveUsd > admission.capUsd;

/**
 * The words a pause carries, with the two numbers kept apart.
 *
 * An operator raising a cap has to be able to tell a charge from a reservation: *"0.4 spent"* is a
 * fact about money, *"2 committed"* is a fact about a run that has not been charged yet, and a
 * single summed figure would present the second as the first — which is the same reason the
 * pending term is a separate column of the port's answer rather than folded into the spend
 * (standing rule 16's neighbour: a number whose meaning is guessed at is worse than two numbers).
 */
export const capSpendDetail = (admission: CapAdmission, stage: Slug): string =>
  `${admission.spentUsd} spent` +
  (admission.pendingUsd > 0
    ? ` and ${admission.pendingUsd} committed by runs the ledger has not recorded yet`
    : '') +
  ` of ${admission.capUsd} USD, and "${stage}" may spend ${admission.reserveUsd} more`;
