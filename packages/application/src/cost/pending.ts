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
 * > when the platform priced it — WP-47) once it has ended — or, when nothing wrote one, **held** at
 * > the reservation it was admitted at (WP-131, below).
 *
 * The two halves are what make the term self-clearing rather than a second running total to keep
 * true: a live run's reservation disappears the moment it ends, an ended run's reported figure is
 * replaced by the ledger's rows the moment they exist (the entries sum to the provider's run
 * total, BD-011, so the number does not move), and a run that never reaches the ledger at all is
 * counted at what it really cost rather than at a reservation nobody can retire. A run with **no**
 * figure is the one exception, and its hold has two retirements of its own (a late figure, the
 * window) — see *"held at its reservation"* below.
 *
 * **The task cap needs no pending term, and since WP-131 it needs the hold.** `taskBudgetExhausted`
 * reads `tasks.cost_actual`, which `record`'s own transaction increments together with `runs.finish`
 * and `run.finished` — a cap read from a column the run's transaction moves cannot lag the run, so
 * the *lag* half of this module is not its problem. The *unmeasured* half is: a run nobody measured
 * moves `cost_actual` by nothing, ever, so the task cap reads the same hold the other five do
 * (`RunRepository.heldFor`, below), and never writes it into `cost_actual`, which is spend.
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
 * ## A run nobody measured is **held** at its reservation — WP-131
 *
 * A run whose ending carried no figure — both cost columns null: the lease sweep's ending, a cancel
 * ended in place, a stop or a crash that read no `result` (WP-47, WP-101, WP-119), each **after**
 * the run asked for its CLI (WP-150, below) — used to count
 * **0** here once it had ended, and this paragraph called that *"the term saying that nothing is
 * known"*. It was over-admission stated as a decision (PROGRESS backlog **402**): the reservation the
 * run held while live disappeared at its ending and nothing replaced it, so a scope whose runs kept
 * ending unmeasured admitted past its cap by up to one per-run cap per run, and the task cap — which
 * never counted earlier runs at all — admitted every retry of a task whose runs timed out unmeasured.
 *
 * The ruling on 402 (option (a), BD-010's *"predictable worst case comes from per-run caps"*):
 *
 * > **An ended run nobody measured is held at the reservation it was admitted at** —
 * > `runs.reserve_usd` (migration 0072), written by both run inserts; a row written before it is
 * > held at the admitting stage's reserve. Every cap counts the hold: the five ledger-backed caps
 * > through the pending query, the task cap through `RunRepository.heldFor`.
 *
 * - **Held, never spent** (standing rule 16). No ledger row, no rollup and no `cost_actual` is
 *   written from a hold; {@link Hold} is its own pair of numbers, and {@link capSpendDetail} names it
 *   apart from the spend and from the pending reservations — *"N runs nobody measured, held at their
 *   caps"*.
 * - **Released by a figure.** The hold ends when `cost/late.ts`'s `recordCost` writes the run's cost,
 *   which then moves `cost_actual` in the same transaction (it did not before WP-131, so the task cap
 *   would have lost the money at the release).
 * - **Or by the window.** A windowed cap counts the hold in the window that contains the run's
 *   `ended_at`, and it ages out with that window; a batch-scoped cap (the history bootstrap) holds it
 *   for the batch's life. **The task cap never rolls over**: the task stays paused until a human
 *   raises the cap.
 * - **One exclusion, and it is a proof — WP-150** (BD-010's 2026-10-06 amendment, PROGRESS backlogs
 *   410 and 489). A run counts `0` only when its row proves no CLI process was asked for:
 *   `runs.cli_spawn_requested_at` (migration 0085) is written, in its own committed transaction, by
 *   the process holding the run **before** it sends the run shim its `spawn` frame, and no CLI is
 *   started without it (`../pipeline/cli-spawn.ts`). A run whose marker is null — refused at the
 *   handshake, cancelled in place or swept while it was provisioned — is a **measured zero**: its
 *   ending writes `usd_reported = 0`, and the held set excludes it besides
 *   (`pending-run-spend.ts`). Until WP-150 there was no such column, so a run swept or cancelled
 *   before its process spawned was indistinguishable on the row from one that ran, and was held —
 *   which paused AUT-6820 at its task cap for a run its shim had refused. A run **with** the marker
 *   and no figure is held exactly as above.
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

/**
 * The runs of a scope **nobody measured**, held at the reservations they were admitted at (WP-131).
 *
 * Never spend: it is a bound on what the scope may already have spent and nobody knows, kept apart
 * from {@link CapSpend.spentUsd} and from {@link Commitment.pendingUsd} so a pause can say which is
 * which.
 */
export interface Hold {
  readonly heldUsd: number;
  /** How many runs {@link Hold.heldUsd} is for — the *N* of *"N runs nobody measured"*. */
  readonly heldRuns: number;
}

/** What the runs of a scope have committed that the ledger has not recorded: the pending term and the hold. */
export interface Commitment extends Hold {
  /** Live runs at their reservation, ended ones at their own figure; see this module's docblock. */
  readonly pendingUsd: number;
}

/** What a cap is measured against: the ledger's rows, and the runs it cannot see yet. */
export interface CapSpend extends Commitment {
  /** Recorded in `cost_entries` — the ledger, and the platform's record of money spent. */
  readonly spentUsd: number;
}

/** A cap, what it has been charged, and what the run being admitted may add to it. */
export interface CapAdmission extends CapSpend {
  readonly capUsd: number;
  /** What *this* run may spend — `runBudgetUsd`, added for `taskBudgetExhausted`'s reason. */
  readonly reserveUsd: number;
}

/** No hold — a scope with no unmeasured run, or a store that has none to report. */
export const NO_HOLD: Hold = { heldUsd: 0, heldRuns: 0 };

/**
 * The hold over a set of runs nobody measured, from the reservations they were admitted at.
 *
 * `null` — a run written before migration 0072 recorded none — is held at `admittingReserveUsd`,
 * which is what `pending-run-spend.ts`'s `coalesce(r.reserve_usd, $reserve)` does; this is that
 * valuation for the in-memory stores, which hold rows rather than a query.
 */
export const holdOf = (
  reserves: readonly (number | null)[],
  admittingReserveUsd: number,
): Hold => ({
  heldUsd: reserves.reduce<number>((total, reserve) => total + (reserve ?? admittingReserveUsd), 0),
  heldRuns: reserves.length,
});

/**
 * Would admitting this run take the scope past its cap?
 *
 * `>` rather than `>=`: a run that exactly fills the cap is admitted, which is the comparison
 * `taskBudgetExhausted` has always made and the one the shipped figures are derived from
 * (`features.history_bootstrap.budget_usd` = 20 is ten $2 runs, not nine). The hold is counted
 * beside the spend and the pending term (WP-131).
 */
export const capIsSpent = (admission: CapAdmission): boolean =>
  admission.spentUsd + admission.pendingUsd + admission.heldUsd + admission.reserveUsd >
  admission.capUsd;

/**
 * The hold in words, or `''` when there is none: *"N runs nobody measured, held at their caps: X
 * USD"* — never folded into a spent figure (standing rule 16).
 */
export const holdDetail = (hold: Hold): string =>
  hold.heldRuns > 0
    ? `${hold.heldRuns} ${hold.heldRuns === 1 ? 'run' : 'runs'} nobody measured, held at ` +
      `${hold.heldRuns === 1 ? 'its cap' : 'their caps'}: ${hold.heldUsd} USD`
    : '';

/**
 * The words a pause carries, with the three numbers kept apart.
 *
 * An operator raising a cap has to be able to tell a charge from a reservation: *"0.4 spent"* is a
 * fact about money, *"2 committed"* is a fact about a run that has not been charged yet, and *"1 run
 * nobody measured, held at its cap: 15"* is a bound on money nobody knows the amount of — a single
 * summed figure would present the second and third as the first (standing rule 16's neighbour: a
 * number whose meaning is guessed at is worse than three numbers).
 */
export const capSpendDetail = (admission: CapAdmission, stage: Slug): string =>
  `${admission.spentUsd} spent` +
  (admission.pendingUsd > 0
    ? ` and ${admission.pendingUsd} committed by runs the ledger has not recorded yet`
    : '') +
  ` of ${admission.capUsd} USD` +
  (admission.heldRuns > 0 ? `, with ${holdDetail(admission)}` : '') +
  `, and "${stage}" may spend ${admission.reserveUsd} more`;
