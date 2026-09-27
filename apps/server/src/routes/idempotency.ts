/**
 * `Idempotency-Key` — technical/08 § "Principles", shared by every command route.
 *
 * It was WP-21's, inside `routes/onboarding.ts`, and it moved here when WP-15i added eleven more
 * commands: two copies of a key's character set, its cap and its digest would be two things to keep
 * true, and the second copy is the one that would silently accept a key the first refuses.
 *
 * ## The record (WP-67, migration 0053)
 *
 * One row of `command_idempotency` per `(user, action, key)`: the **digest of the canonical
 * request**, when the key was claimed, and — once the command performed — which `human_actions`
 * row recorded it. Until WP-67 the record *was* that audit row, read with a JSON predicate, and that
 * is why two requests that arrived together were both performed: both reads returned null under
 * READ COMMITTED and nothing unique stood between them. The audit stays append-only and complete;
 * the table is the key's identity (the migration's header says why it is not a unique index on
 * `human_actions`).
 *
 * - **Scope** `(user_id, action, key)` — see "A key belongs to the caller" below.
 * - **Retention: none.** A key is honoured for as long as the audit it points at, which is kept;
 *   a window after which a key is forgotten is a window after which a retry performs twice.
 * - **A replay answers the first attempt**: {@link claimIdempotentAttempt} returns the `params` the
 *   first attempt's audit row recorded (the ids it made, the branch it took), and the route answers
 *   from them with `performed: false` and writes nothing.
 * - **A different request digest under a used key** is `409 idempotency_key_reused`.
 *
 * ## The write ordering, decided rather than inherited
 *
 * Two orderings close the concurrent double-perform, and they trade different failures:
 *
 * - **Claim with the effect** — the key's row is inserted in the *same* transaction as the
 *   command's writes, so a second request blocks on the first's uncommitted key and meets it once
 *   the first commits. No window at all, but it needs the route to hold the effect's transaction.
 *   Where it does — the business interview (`claimIdempotentAttemptInTransaction`) — this is what
 *   is used.
 * - **Claim before the effect** — the row is committed **first**, the command performs in its own
 *   transaction in the application ring, and the `human_actions` row completes the claim. This is
 *   what every other keyed command uses ({@link claimIdempotentAttempt}), because none of them
 *   holds its command's transaction: `pause`, `retry-stage`, a shadow batch and a breakdown decision
 *   are application commands with their own unit of work.
 *
 * Claim-before-effect trades a **double-perform** for a **key that claims a command nobody
 * performed**, and WP-67 takes that trade deliberately. What each ending does:
 *
 * - the command **refuses, 404s, or answers "already"** → the claim is released, so a retry under
 *   the key is a first attempt again — WP-15i's "none is left for a refused one" holds for the
 *   record too. The route's `run` releases in a `finally` **only while the effect has not
 *   returned**: the route calls `performed()` the moment its application command returns having
 *   done something, and from then on nothing releases the key;
 * - the command **performs** → the audit row completes the claim, and every later request under the
 *   key is a replay;
 * - a second request arrives **while the first is performing** → `409 idempotency_key_in_flight`,
 *   never a second performance;
 * - anything fails **after the effect returned** — the audit insert, the completion, the route's
 *   own bookkeeping — or the **process dies** between the claim and the audit row → the claim stays.
 *   A retry is refused `409 idempotency_key_in_flight` for {@link CLAIM_IN_FLIGHT_MS}, then
 *   `409 idempotency_attempt_unknown` for good: the platform cannot tell whether the effect
 *   committed, so it says so and asks for a new key after the caller has looked at the resource. It
 *   is **never** re-claimed automatically, because a re-claim is exactly the double-perform this
 *   closes. (Review round 1 of WP-67: the first version released in the `finally` on *any* throw,
 *   so an audit insert refused after the effect committed freed the key and the retry performed
 *   again; pool errors are per connection, so "the release will fail too" was not an argument.)
 *
 * The one residual left is inside the command: an application command that commits its effect and
 * **then** throws is read as a refusal and its key released. The commands this server composes
 * commit in their last statement, so that is a claim about them, stated rather than enforced.
 *
 * ## Two shapes of answer, and the difference is the resource's
 *
 * - **A create with a natural key** (the wizard's project and integration creates) answers a retry
 *   by re-reading the resource through `projects.key` or `(integrations.org_id, type, name)`; the
 *   record is what turns a *different* body under a used key into a `409`. These two are **not**
 *   on the claim: their audit row is written inside the create's own transaction, and the natural
 *   key stops a second row, so a concurrent different body is answered with the first resource
 *   instead of a 409 — stated at `findIdempotentAttempt`.
 * - **A command with no natural key** (every task and run command, the shadow batch, the
 *   bootstrap, discovery, the breakdown decision, the settings and configuration writes) claims.
 *
 * ## A key belongs to the caller
 *
 * Every lookup here is scoped to `(user_id, action, key)`. technical/08 says an `Idempotency-Key`
 * goes on a command a client may retry and does not say whose it is; the caller is the only honest
 * owner, because the string is generated by a client per attempt and nothing distinguishes one
 * client's `retry-1` from another's. An installation-wide lookup would answer this caller a
 * `409 idempotency_key_reused` for a key a stranger used — a wrong refusal, and an oracle for the
 * existence of somebody else's command. `findIdempotentAttempt` carries the full argument and what
 * the narrower scope gives up.
 */
import { createHash } from 'node:crypto';
import type { JsonObject } from '@platform/contracts';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';
import type { CommandAttemptClaim } from '../queries/idempotency-queries.js';
import type { Database } from '../queries/identity-queries.js';
import { findIdempotentAttempt } from '../queries/onboarding-queries.js';

/** Longest `Idempotency-Key` this server stores in an audit row. */
export const MAX_IDEMPOTENCY_KEY_CHARS = 200;

/**
 * The key a client sent, or `null` when it sent none.
 *
 * Client-chosen text on its way to a `human_actions` row, so it is bounded and its character set is
 * fixed rather than escaped: a key is an identity, and anything outside the set is refused rather
 * than rewritten (the argument `idempotencyScopeFor` makes for a provider key, one layer out).
 */
export const readIdempotencyKey = (request: FastifyRequest): string | null => {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.length === 0) {
    return null;
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_CHARS || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new HttpError(
      400,
      'invalid_request',
      `the Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters of A-Z a-z 0-9 . _ : -`,
    );
  }
  return value;
};

/** The same, for a command that **creates** and therefore requires the header. */
export const requireIdempotencyKey = (request: FastifyRequest): string => {
  const key = readIdempotencyKey(request);
  if (key === null) {
    throw new HttpError(
      400,
      'idempotency_key_required',
      'this command creates something, so it needs an Idempotency-Key header: send the same key when you retry (technical/08)',
    );
  }
  return key;
};

/**
 * Refuses a request that reuses a key with a **different** body, and passes anything else.
 *
 * The decision, separated from the read so it can be driven directly: it has three branches and
 * two of them are "do nothing", which is exactly the shape that reads as tested because the happy
 * path runs constantly (standing rule 67).
 *
 * The digest is over the canonical JSON of whatever the command considers its request — the body
 * for a create, the path's project for a command whose body is empty — so key ordering does not
 * make two identical requests look different (`configHashOf` uses the same serialiser and says
 * why).
 *
 * Absent is not an error: a key nobody has used is the first attempt, and a row written before this
 * guard existed carries no digest and is treated as one (there is nothing to compare it to, and
 * refusing would break a retry of a command that already succeeded).
 */
export const assertIdempotentRequest = (input: {
  readonly action: string;
  readonly key: string;
  /** The digest recorded by a previous attempt under this key, or `null` when there was none. */
  readonly previousDigest: string | null;
  readonly digest: string;
}): void => {
  if (input.previousDigest !== null && input.previousDigest !== input.digest) {
    throw new HttpError(
      409,
      'idempotency_key_reused',
      `Idempotency-Key "${input.key}" was already used for a ${input.action} with different arguments; use a new key, or send the request you sent the first time`,
    );
  }
};

/** Reads the previous attempt and refuses a mismatched body; answers this request's digest. */
export const idempotencyGuard = async (
  database: Database,
  input: {
    /** Whose key this is — the scope of the lookup, see the module note. */
    readonly userId: string;
    readonly action: string;
    readonly key: string;
    readonly request: unknown;
  },
): Promise<string> => {
  const digest = configHashOf(input.request);
  const previous = await findIdempotentAttempt(database, {
    userId: input.userId,
    action: input.action,
    key: input.key,
  });
  assertIdempotentRequest({
    action: input.action,
    key: input.key,
    previousDigest: previous?.bodyDigest ?? null,
    digest,
  });
  return digest;
};

/**
 * Has this key already performed this command?
 *
 * `true` means **do nothing and answer the current state**: the `human_actions` row exists, so the
 * command was performed, and the same key with the same body is a retry of it. A different body
 * under the same key never reaches here — {@link assertIdempotentRequest} refuses it first — and a
 * key nobody has used is the first attempt.
 *
 * It is the half of the header the wizard's creates do not need (they have a natural key to
 * re-read) and every task and run command does, because "pause this task" has no row to find.
 */
export const idempotentReplay = async (
  /** How a previous attempt is found — injected, so a route module need name no database. */
  findAttempt: (query: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
  }) => Promise<{ readonly bodyDigest: string | null; readonly params: JsonObject } | null>,
  input: {
    /** Whose key this is — the scope of the lookup, see the module note. */
    readonly userId: string;
    readonly action: string;
    readonly key: string | null;
    readonly request: unknown;
  },
): Promise<{
  readonly replayed: boolean;
  readonly digest: string | null;
  /** The `params` of the attempt this request replays, so its answer can carry what it made. */
  readonly previous: JsonObject | null;
}> => {
  if (input.key === null) {
    return { replayed: false, digest: null, previous: null };
  }
  const digest = configHashOf(input.request);
  const previous = await findAttempt({
    userId: input.userId,
    action: input.action,
    key: input.key,
  });
  assertIdempotentRequest({
    action: input.action,
    key: input.key,
    previousDigest: previous?.bodyDigest ?? null,
    digest,
  });
  return { replayed: previous !== null, digest, previous: previous?.params ?? null };
};

/**
 * How long a claim nobody completed is reported as *still running* rather than *unknown*.
 *
 * Five minutes: every command this server takes answers inside one HTTP request, and the longest
 * of them — a configuration export, which opens a merge request — is bounded by the provider
 * client's own timeouts well inside it. After this, the claim is the residue of a process that
 * died, and the answer changes from "retry" to "look first, then use a new key".
 */
export const CLAIM_IN_FLIGHT_MS = 5 * 60_000;

/** The two statements a claiming route needs, injected so a route module names no database. */
export interface IdempotencyRecords {
  readonly claimAttempt: (query: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
    readonly digest: string;
  }) => Promise<CommandAttemptClaim>;
  readonly releaseAttempt: (query: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
  }) => Promise<void>;
}

export interface ClaimedAttempt {
  /** `true`: this key already performed this command — answer from `previous`, perform nothing. */
  readonly replayed: boolean;
  readonly digest: string | null;
  /** The `params` the performing attempt's audit row recorded, so the answer can carry what it made. */
  readonly previous: JsonObject | null;
  /**
   * Runs the rest of the command under the claim. `body` calls `performed()` as soon as the
   * application command has returned **having done something**; until it does, any ending — a
   * throw, a 404, an `already` answer — releases the key in a `finally`. After it, nothing does:
   * a throw from the audit insert leaves the claim held, so a retry is answered in flight or
   * unknown and is never performed again (module note). A request with no key, or a replay, runs
   * `body` with nothing to release.
   */
  readonly run: <T>(body: (performed: () => void) => Promise<T>) => Promise<T>;
}

/**
 * Claims this request's key before the command performs — the ordering the module note decides.
 *
 * Absent key: nothing to claim, and the command performs as a request with no header always has.
 * A key another request of this caller **performed** with the same digest is a replay; with a
 * different digest, `409 idempotency_key_reused`. A key a request is **still holding** is
 * `409 idempotency_key_in_flight` — or `idempotency_attempt_unknown` once the claim is older than
 * {@link CLAIM_IN_FLIGHT_MS} — and a different digest there is `idempotency_key_reused` first,
 * because that answer is true whatever became of the other request.
 */
export const claimIdempotentAttempt = async (
  records: IdempotencyRecords,
  input: {
    readonly userId: string;
    readonly action: string;
    readonly key: string | null;
    readonly request: unknown;
    /** The clock the staleness is read against; injected for the tests. */
    readonly now?: () => number;
  },
): Promise<ClaimedAttempt> => {
  const passThrough = <T>(body: (performed: () => void) => Promise<T>): Promise<T> =>
    body(() => undefined);
  if (input.key === null) {
    return { replayed: false, digest: null, previous: null, run: passThrough };
  }
  const key = input.key;
  const digest = configHashOf(input.request);
  const query = { userId: input.userId, action: input.action, key };
  const claim = await records.claimAttempt({ ...query, digest });
  if (claim.status === 'claimed') {
    return {
      replayed: false,
      digest,
      previous: null,
      run: async (body) => {
        let effectReturned = false;
        try {
          return await body(() => {
            effectReturned = true;
          });
        } finally {
          if (!effectReturned) {
            await records.releaseAttempt(query);
          }
        }
      },
    };
  }
  assertIdempotentRequest({
    action: input.action,
    key,
    previousDigest: claim.bodyDigest,
    digest,
  });
  if (claim.status === 'performed') {
    return { replayed: true, digest, previous: claim.params, run: passThrough };
  }
  const age = (input.now ?? Date.now)() - Date.parse(claim.claimedAt);
  if (age < CLAIM_IN_FLIGHT_MS) {
    throw new HttpError(
      409,
      'idempotency_key_in_flight',
      `a ${input.action} under Idempotency-Key "${key}" is still being performed; send the same request again once it has answered`,
    );
  }
  throw new HttpError(
    409,
    'idempotency_attempt_unknown',
    `a ${input.action} under Idempotency-Key "${key}" started at ${claim.claimedAt} and never recorded an outcome, so this server cannot say whether it was performed; check the resource, then use a new key`,
  );
};

/**
 * `projects.config_hash` — a digest of a document, over its canonical JSON.
 *
 * It is what `GET …/config` publishes as `hash` and what a later `PUT` may send back as
 * `base_hash`, so the two have to be the same function; it is also what every command digests its
 * request with. Keys are sorted so that a document and the same document with its keys in another
 * order hash alike — a client that round-trips through `JSON.parse` must not be told its
 * configuration moved, and two identical retries must not look like two different requests.
 */
export const configHashOf = (config: unknown): string =>
  createHash('sha256').update(canonicalJson(config)).digest('hex').slice(0, 32);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};
