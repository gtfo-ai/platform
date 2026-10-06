/**
 * **A provider that does not answer is not an answer** (PROGRESS backlog 490, first local test,
 * 2026-10-06).
 *
 * AUT-6820 waited at `ci_gate` on a poll-only GitLab binding when the host's network to gitlab.com
 * dropped. The gate's read threw — a bare `TimeoutError`, then `IntegrationError {code:
 * "unavailable"}` — so `stage.execute` threw, pg-boss spent the queue's two retries in about ten
 * minutes and failed the job, the stranded-stage recovery re-enqueued it once (it failed the same
 * way) and escalated the task with a brief saying the stage had *"never started"*. The provider had
 * been unreachable; nothing about the merge request had been decided.
 *
 * So a **transient** provider failure during a gate's evaluation is a third answer beside
 * *settled* and *pending*: the gate asks again, with a growing delay, for as long as the gate's own
 * bound allows, and then parks the task with a brief that names the provider and the failure. This
 * module is the pure half — which failures are transient, the delay, the decision and the words;
 * `gates.ts` turns a thrown failure into a {@link GateProviderOutage} and `jobs.ts` applies the
 * decision.
 *
 * ## Which failures are transient
 *
 *  - an {@link IntegrationError} whose own `retryable` says so — `unavailable` (5xx, a transport
 *    failure the adapter wrapped) and `rate_limited` (429), the two codes the executor itself
 *    retries. Every other code (`unauthorised`, `forbidden`, `not_found`, `conflict`,
 *    `invalid_request`, `invalid_response`, `unsupported_capability`) is a fault a later attempt
 *    does not fix, and keeps today's ending: the job throws.
 *  - a bare error the adapter did not wrap, recognised by its **class or code**, never its message:
 *    `TimeoutError` (what `AbortSignal.timeout` rejects with — including while a response body is
 *    still being read, after the adapter's own `catch` has passed, which is the first error AUT-6820
 *    showed), undici's `TypeError: fetch failed`, and the socket-level codes in
 *    {@link NETWORK_ERROR_CODES}. The cause chain is followed a few links, because a transport error
 *    is usually the cause of the error that reaches the gate.
 *
 * ## The bound is a time, not the five checks
 *
 * A failed read is not a check: `gate_checks` does not move, so an outage cannot spend
 * `MAX_GATE_CHECKS`. The gate re-asks after {@link GATE_OUTAGE_FIRST_RECHECK_MS}, doubling up to
 * {@link GATE_OUTAGE_MAX_RECHECK_MS}, and stops at a deadline:
 *
 *  - **the CI gate on a poll-only binding** keeps WP-136's clock: `pipeline.limits.ci_timeout_minutes`
 *    from the gate's entry (`task_stages.entered_at`), so an outage cannot extend the wait a person
 *    configured, and the last re-check is moved up to the deadline rather than past it;
 *  - **every other gate** gets {@link GATE_OUTAGE_LIMIT_MINUTES} from the first failure in a row,
 *    which travels in the job's payload (`provider_failing_since`) because the process that re-asks
 *    may not be the one that failed. One answer — even a `pending` — clears it.
 *
 * A **backstop count** ({@link gateOutageBackstop}) bounds the chain even if a clock were wrong, as
 * WP-136's does; an instant that does not parse is past the deadline, never within it (standing
 * rule 16).
 */
import { IntegrationError } from '../ports/integrations/common.js';

/** What the brief names: the executor's two retryable codes, or what a bare error was. */
export type TransientProviderCode = 'unavailable' | 'rate_limited' | 'timeout' | 'network';

/**
 * Socket-level codes Node and undici put on a failed connection. A **closed** list: a code not on it
 * is not guessed at, and the failure keeps today's ending.
 */
export const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** How far down a cause chain the classifier looks. */
const MAX_CAUSE_DEPTH = 5;

const field = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

/**
 * Is this failure a provider that did not answer? Answers the code the brief names, or `null` for
 * every other failure — which the caller rethrows, unchanged.
 */
export const transientProviderFailure = (error: unknown): TransientProviderCode | null => {
  let node: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (node === null || typeof node !== 'object') {
      return null;
    }
    // The adapter's own classification wins: a non-retryable code is the adapter saying "a later
    // attempt does not fix this", whatever transport error it carries as a cause.
    if (node instanceof IntegrationError) {
      return node.retryable && (node.code === 'unavailable' || node.code === 'rate_limited')
        ? node.code
        : null;
    }
    const name = field(node, 'name');
    if (name === 'TimeoutError') {
      return 'timeout';
    }
    const code = field(node, 'code');
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
      return 'network';
    }
    if (node instanceof TypeError && node.message === 'fetch failed') {
      return 'network';
    }
    node = field(node, 'cause');
  }
  return null;
};

/** The first re-ask after a failed read: the gate's own thirty seconds (`GATE_RECHECK_MS`). */
export const GATE_OUTAGE_FIRST_RECHECK_MS = 30_000;

/** The delay's ceiling: one read every five minutes while the provider stays away. */
export const GATE_OUTAGE_MAX_RECHECK_MS = 5 * 60_000;

/**
 * How long a gate other than the poll-only CI wait keeps asking a provider that does not answer —
 * the default CI timeout's sixty minutes (`DEFAULT_CI_TIMEOUT_MINUTES`), so every gate tolerates the
 * outage the CI gate tolerates out of the box.
 */
export const GATE_OUTAGE_LIMIT_MINUTES = 60;

const MINUTE_MS = 60_000;

/** The delay before re-ask number `failures + 1`: 30 s, 60 s, 2 min, 4 min, then 5 min. */
export const gateOutageDelayMs = (failures: number): number =>
  Math.min(
    GATE_OUTAGE_MAX_RECHECK_MS,
    GATE_OUTAGE_FIRST_RECHECK_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)),
  );

/**
 * The backstop: one more failure than the bound could hold at the **shortest** delay, so it is
 * reached only if a clock were wrong.
 */
export const gateOutageBackstop = (limitMinutes: number): number =>
  Math.ceil((limitMinutes * MINUTE_MS) / GATE_OUTAGE_FIRST_RECHECK_MS) + 1;

export type GateOutageDecision =
  | { readonly kind: 'recheck'; readonly delayMs: number }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'backstop'; readonly limit: number };

/**
 * What a failed read does next. `failures` counts this one (the first is 1). The delay is clamped to
 * the deadline, so the last re-ask happens **at** it rather than a backoff step past it; a fire at
 * or after the deadline parks.
 */
export const decideGateOutage = (input: {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly failures: number;
  readonly limitMinutes: number;
}): GateOutageDecision => {
  const left = input.deadlineMs - input.nowMs;
  if (!(left > 0)) {
    return { kind: 'timed_out' };
  }
  const limit = gateOutageBackstop(input.limitMinutes);
  if (!(input.failures < limit)) {
    return { kind: 'backstop', limit };
  }
  return { kind: 'recheck', delayMs: Math.min(gateOutageDelayMs(input.failures), left) };
};

/** Which bound the gate waited to — named in the brief, so a person knows what to raise. */
export type GateOutageBound =
  | { readonly kind: 'ci_timeout'; readonly minutes: number }
  | { readonly kind: 'ceiling'; readonly minutes: number };

/** Everything the brief says, all of it platform text or a closed code. */
export interface GateOutageFacts {
  readonly stage: string;
  /** The binding's host (`gitlab.com`), or the provider id when the binding names none. */
  readonly where: string;
  readonly code: TransientProviderCode;
  readonly failures: number;
  /** Whole minutes since the first failure in a row; `null` when that instant did not parse. */
  readonly minutes: number | null;
  readonly bound: GateOutageBound;
}

const CODE_WORDS: Readonly<Record<TransientProviderCode, string>> = {
  unavailable: 'unavailable',
  rate_limited: 'rate_limited (the provider asked the platform to slow down)',
  timeout: 'timeout (no answer within the request’s time limit)',
  network: 'network (the connection could not be made or was dropped)',
};

const forHowLong = (minutes: number | null): string =>
  minutes === null
    ? 'for an unmeasured time'
    : `for ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;

const boundWords = (bound: GateOutageBound): string =>
  bound.kind === 'ci_timeout'
    ? `the CI timeout of ${String(bound.minutes)} minutes from the gate's entry (\`pipeline.limits.ci_timeout_minutes = ${String(bound.minutes)}\`)`
    : `the platform's ${String(bound.minutes)}-minute limit for a provider outage at a gate`;

/** The escalation's reason — the gate's row and `task.escalated` carry it. */
export const gateOutageReason = (facts: GateOutageFacts, decision: GateOutageDecision): string =>
  `the "${facts.stage}" gate could not be decided: ${facts.where} did not answer ${forHowLong(facts.minutes)}: ${facts.code} (${String(facts.failures)} failed ${facts.failures === 1 ? 'read' : 'reads'}); ${
    decision.kind === 'backstop'
      ? `it stopped at its backstop of ${String(decision.limit)} failed reads`
      : `it stopped at ${boundWords(facts.bound)}`
  } (PROGRESS backlog 490)`;

/** The brief a person reads on the task page. */
export const gateOutageBrief = (facts: GateOutageFacts): string =>
  `${facts.where} did not answer ${forHowLong(facts.minutes)}: ${CODE_WORDS[facts.code]}. ` +
  `The "${facts.stage}" gate asked ${String(facts.failures)} ${facts.failures === 1 ? 'time' : 'times'} without an answer, waiting 30 seconds and then twice as long each time up to 5 minutes, until ${boundWords(facts.bound)}. ` +
  'Nothing about the merge request was decided: this is the provider being unreachable, not a result. ' +
  `Check that ${facts.where} is reachable from the platform's host (and its status page), then hand the task back at ${facts.stage}.`;
