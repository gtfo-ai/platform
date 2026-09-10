/**
 * The Loki adapter — `ObservabilityLogsPort` for Grafana Loki, single- and multi-tenant (WP-11).
 *
 * ## What it is not
 *
 * It is **not** where retries, backoff or shadow mode live: `IntegrationActionExecutor` owns those
 * (technical/06 § "Outbound: actions"), and `test/contract/integrations/loki-executor.contract.test.ts`
 * proves the composition — a recorded `429` arrives as `IntegrationRateLimitedError` and is waited
 * out on the executor's injected timer, and a read is still performed in shadow mode because a read
 * changes nothing.
 *
 * It is also **not a LogQL engine**. `queryRange` writes exactly one shape of query — a validated
 * stream selector plus at most one escaped literal line filter — and refuses everything else. An
 * agent that needs a parser stage or an aggregation uses `logcli`, which this provider declares as
 * agent tooling and whose credential is run-scoped (BD-025).
 *
 * ## Divergences from real Loki, stated rather than implied
 *
 * The fake's register (`packages/integrations/src/logs/fake.ts`) lists two kindnesses: "no quota,
 * no tenant checks, no partial responses". Both are real behaviours, and they live here.
 *
 *  1. **Quota is real.** Loki answers `429` when a tenant's outstanding-request limit is reached;
 *     `http.ts` maps it to `IntegrationRateLimitedError` with `Retry-After` when a proxy sends one.
 *     Grafana's HTTP API reference publishes no status table, so the mapping is recorded as a
 *     choice in `http.ts` rather than presented as a transcription.
 *  2. **Tenancy is real.** `X-Scope-OrgID` is sent when the binding names a tenant; a multi-tenant
 *     Loki answers `401`/`403` without it, which reaches the caller as `unauthorised`/`forbidden`
 *     instead of an empty result.
 *  3. **Partial answers are real, and they set `truncated`.** Loki caps a query at `limit` and, in
 *     3.x, reports a degraded answer in a `warnings` array. Either one sets `truncated: true`,
 *     because the port's whole reason for that flag is that "is this error still happening?" reads
 *     the same on a complete answer and a clipped one. So does hitting a byte cap.
 *  4. **The adapter does not trust the server's own limit.** A response carrying more entries than
 *     the query asked for is cut to `limit` here and reported as truncated. Loki should never do
 *     that; "should never" is not a bound, and the fake — which slices its own array — cannot
 *     reach this state at all.
 *  5. **Ordering is global, not per stream — and grouping gives way to it.** Loki orders entries
 *     **within** a stream by `direction`; nothing orders them across streams. The port's consumers
 *     read `streams[*].lines` flattened, so this adapter sorts every line globally and then groups
 *     by **contiguous run** rather than by label-set identity. One label set can therefore appear
 *     in two `streams` entries, which is the honest trade: identity grouping and a monotonic
 *     flattening are incompatible the moment two streams interleave in time, and ordering is the
 *     property an agent reasons with ("did it keep happening after the deploy?").
 *  6. **Byte caps the port does not name, and they count what is actually emitted.**
 *     `max_line_bytes` bounds one line (a 50 MB base64 blob is one line), `max_label_bytes` and
 *     `max_labels` bound the label set that is copied onto **every** line, `max_label_values`
 *     bounds a `labels()` listing, `max_series` bounds a `series()` listing, and
 *     `max_total_bytes` bounds the whole result of `queryRange` **and** of `series` after that.
 *     Every one leaves a visible marker naming the cap that fired and every one that can sets
 *     `truncated` (technical/06 § "Two caps the port does not name"). `series` returns a bare
 *     array with no such flag, so its marker is a label set of its own.
 *
 *     The first version of this adapter counted `line.line` and nothing else, so a 2 MB label value
 *     across 20 lines produced a **42,002,998-byte** result reporting `truncated: false` — a cap
 *     defeated by the field it did not measure. The accounting is now the emitted bytes: a line
 *     costs its own UTF-8 length plus the length of every label name and value copied onto it. What
 *     that buys is a **stated bound**: the result is at most
 *     `max_total_bytes + (max_line_bytes + max_labels × 2 × max_label_bytes) + one marker`, the
 *     middle term being the one line that is always kept so that a budget smaller than the first
 *     line answers with something rather than with nothing. `series` is bounded the same way with
 *     one label set in the middle term, and a `labels()` listing by
 *     `max_label_values × max_label_bytes`. Every marker is *inside* its cap since review round 2
 *     (see `capBytes`), which is what makes a cap idempotent and the bound tight.
 *
 *     WP-11a added the two members of an emitted type that no call site capped because no call
 *     site looked like a cap (standing rule 37): `HealthProbe.detail`, bounded by
 *     `max_line_bytes` *after* redaction, and `LabelValues.name`, which is the caller's own
 *     argument echoed back and is **refused** past `max_label_bytes` rather than cut, because it
 *     names the label being listed. `providers/emitted-bounds.test.ts` now walks every field of
 *     every answer instead of trusting this list.
 *  7. **Nanoseconds are read as `BigInt`, and that is load-bearing** — the opposite of what this
 *     register claimed at review round 1. A Loki timestamp is a nanosecond epoch string well past
 *     `Number.MAX_SAFE_INTEGER`, where doubles are 256 ns apart, so `Number(ns)` rounds to the
 *     nearest representable value and the rounding **crosses millisecond boundaries**:
 *     `Number('1780309799999999872')` is `1780309800000000000`, which dates the entry
 *     `10:30:00.000Z` instead of its true `10:29:59.999Z`. Measured on this machine, 192 of every
 *     1e6 consecutive nanosecond values around that instant land in a different millisecond, and
 *     that millisecond **is** the emitted `timestamp` and the key this adapter sorts on. The
 *     round-1 claim that "a `Number` implementation produces the same instant" was wrong, the
 *     surviving mutation was a real hole in the suite rather than a benign one, and
 *     `index.test.ts` now kills it by name. Also load-bearing is the digit check in front of it:
 *     `BigInt('')` is `0n` rather than a throw, so an entry with an empty timestamp would otherwise
 *     be dated 1970 and sort to the bottom of a "newest first" answer.
 *  8. **Every line is untrusted text** (BD-022) and is run through TD-012's redactor before it
 *     leaves this ring — discharging the obligation written on `logLineSchema.line`: "the most
 *     likely single place in this port for a credential to appear, because an application that
 *     logs a request logs its headers".
 *
 *     The redactor is **required** (standing rule 31) and is applied at **one** place, `http.ts`,
 *     over the parsed response document, so there is no per-field list to keep in step and no
 *     unredacted twin of a redacted value for later code to read by mistake. It is also composed:
 *     whatever the caller injected, *plus* a redactor over this binding's own resolved bearer token
 *     and password, so a caller passing `noSecretsRedactor()` cannot disarm the one secret this
 *     adapter is certain about. Because redaction happens before any cap, a secret straddling a cap
 *     boundary is replaced whole rather than cut into a surviving fragment. What redaction cannot
 *     do is remove a secret the platform never injected; `exactSecretRedactor` is not a pattern
 *     scanner (TD-012 steps 2 and 3).
 *  9. **A label *name* is provider-controlled too, and the shared redactor does not reach it.**
 *     `redactJson` walks string **values** and leaves object keys alone by design, which
 *     `redaction.ts` states and justifies ("the platform never builds a key out of secret
 *     material, and rewriting keys could collide two fields into one"). That justification is
 *     about keys the *platform* writes. Loki is the only provider in this repository whose object
 *     keys come from the **provider** — a stream is `{"<label name>": "<value>"}` — so
 *     `{"<secret>": "v"}` survived the one pass in `http.ts` verbatim in `queryRange` and in
 *     `series` (review round 2; Sentry is immune because its tags are `[{key, value}]`, where the
 *     key is a value).
 *
 *     The choice here was between recording the divergence and closing it. It is **closed**, and
 *     locally: `capLabelSet` — the only place this adapter emits a provider key — redacts the name
 *     before it caps it, so the shared helper keeps the behaviour every other consumer relies on
 *     and the one provider that needs more pays for it. The collision hazard `redaction.ts` names
 *     is real and is answered explicitly rather than avoided: two names that redact or cap to the
 *     same string keep the **first** value, count into `droppedBytes` so the answer reports
 *     `truncated`, and are named in the label set's own truncation marker. A test plants a secret
 *     as a label name in both methods (standing rule 12: the kindest divergence needs a positive
 *     assertion, not a warning).
 */
import {
  type AgentTooling,
  bindingSecretRedactor,
  composeSecretRedactors,
  type HealthProbe,
  IntegrationError,
  type IntegrationRef,
  type LabelValues,
  type LogLine,
  type LogQueryResult,
  type LogRangeQuery,
  logQueryResultSchema,
  type ObservabilityLogsCapabilities,
  type ObservabilityLogsPort,
  parseProviderData,
  type SecretRedactor,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Clock } from '@platform/domain';
import type { LokiConfig } from './config.js';
import { createLokiHttp, type LokiFetch, type LokiHttp, lokiAuthHeaders } from './http.js';
import { buildRangeQuery, LOKI_PROVIDER_ID, parseStreamSelector } from './logql.js';
import {
  lokiSeriesResponseSchema,
  lokiStreamsResponseSchema,
  lokiValuesResponseSchema,
} from './schemas.js';

export interface LokiProviderOptions {
  readonly integrationId: Id;
  readonly config: LokiConfig;
  /** `{bearer_token, password}` from the secret store. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Injected so replay needs no HTTP interception; production passes `globalThis.fetch`. */
  readonly fetchImpl?: LokiFetch;
  /** Injected: `labels`/`series` take no window, so "now" is a value, not a hardware reading. */
  readonly clock: Clock;
  /**
   * TD-012, and the obligation `logLineSchema.line` writes down by name: every log line, every
   * label value and the health probe's `detail` go through it before leaving this ring.
   *
   * **Required, never defaulted** (standing rule 31). An optional security dependency is an absent
   * one: while this was optional, the registration did not pass it and `redact.apply` was the
   * identity function along the only production path. The adapter composes it with a redactor built
   * from its own resolved credentials, so the injected one carries what the *caller* knows and the
   * binding's own token is covered either way.
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. Optional so a unit test can assert on it. */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
}

export type LokiProvider = ObservabilityLogsPort;

/**
 * What an agent may be handed inside a run (technical/06 § "Agent tooling exposure").
 *
 * Unlike Sentry's, Loki's agent-facing tool has a **published environment contract**, which is the
 * whole reason one is declared here and none is declared there:
 * <https://grafana.com/docs/loki/latest/query/logcli/getting-started/> (retrieved 2026-09-10)
 * documents `LOKI_ADDR` ("Server address"), `LOKI_BEARER_TOKEN` ("adds the Authorization header to
 * API requests for authentication purposes") and `LOKI_ORG_ID` ("adds X-Scope-OrgID to API
 * requests for representing tenant ID").
 *
 * Names only — there is no field for a value, by design (BD-002, BD-025). `LOKI_USERNAME` and
 * `LOKI_PASSWORD` are documented too and are **not** declared: the run-scoped credential the
 * platform means to hand an agent is a read-only token, and a spec that also named a basic-auth
 * pair would invite an operator to inject the binding's own account into a run container.
 *
 * `skill` is `null` rather than a path: `packages/prompts/` has no `skills/` directory yet (WP-17
 * owns prompts), and a `SkillRef` naming a directory that is not on disk is a promise the runner
 * cannot keep. Recorded as discovered work rather than written as a claim.
 */
export const LOKI_AGENT_TOOLING: AgentTooling = {
  cli: {
    command: 'logcli',
    version: null,
    env: {
      variables: [
        {
          name: 'LOKI_ADDR',
          secret: false,
          description: 'Loki server address, e.g. https://loki.internal:3100',
        },
        {
          name: 'LOKI_BEARER_TOKEN',
          secret: true,
          description: 'Read-only token, injected by the runner for the run only (BD-025)',
        },
        {
          name: 'LOKI_ORG_ID',
          secret: false,
          description: 'Tenant id sent as X-Scope-OrgID; unset on a single-tenant instance',
        },
      ],
    },
  },
  mcp: null,
  skill: null,
  env: {
    variables: [
      {
        name: 'LOKI_ADDR',
        secret: false,
        description: 'Loki server address, e.g. https://loki.internal:3100',
      },
      {
        name: 'LOKI_BEARER_TOKEN',
        secret: true,
        description: 'Read-only token, injected by the runner for the run only (BD-025)',
      },
      {
        name: 'LOKI_ORG_ID',
        secret: false,
        description: 'Tenant id sent as X-Scope-OrgID; unset on a single-tenant instance',
      },
    ],
  },
};

const NS_PER_MS = 1_000_000n;

/**
 * Nanosecond epoch string → the platform's millisecond wire format.
 *
 * **Two guards, not one.** The digit check is the first: `BigInt('')` is `0n` rather than a throw,
 * so an entry with an empty timestamp would be dated 1970-01-01 and sort to the bottom of a
 * "newest first" answer instead of being refused. The `BigInt` is the second, and review round 1
 * got it wrong in this adapter's favour: doubles are 256 ns apart at 1.8e18, so `Number(value)`
 * rounds to a neighbour that can sit in a **different millisecond** — `Number` reads
 * `1780309799999999872` as `1780309800000000000` and dates the entry `10:30:00.000Z` rather than
 * its true `10:29:59.999Z`. The division is done in `BigInt` and only the millisecond result — far
 * inside `Number.MAX_SAFE_INTEGER` until the year 287396 — becomes a `Number`.
 */
const NANOSECOND_EPOCH = /^-?\d+$/;

export const nanosecondsToIso = (value: string, action: string): IsoDateTime => {
  if (!NANOSECOND_EPOCH.test(value)) {
    throw new IntegrationError(
      'invalid_response',
      LOKI_PROVIDER_ID,
      'a log entry carried a timestamp that is not a nanosecond epoch',
      { action },
    );
  }
  const nanos = BigInt(value);
  const millis = Number(nanos / NS_PER_MS);
  if (!Number.isFinite(millis)) {
    throw new IntegrationError(
      'invalid_response',
      LOKI_PROVIDER_ID,
      'a log entry carried a timestamp outside the representable range',
      { action },
    );
  }
  return new Date(millis).toISOString() as IsoDateTime;
};

/** Milliseconds → the nanosecond epoch string Loki's `start`/`end` accept. */
export const millisecondsToNanoseconds = (millis: number): string =>
  (BigInt(Math.trunc(millis)) * NS_PER_MS).toString();

const invalid = (action: string, detail: string): IntegrationError =>
  new IntegrationError('invalid_request', LOKI_PROVIDER_ID, detail, { action });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Decodes the first `maxBytes` bytes without splitting a UTF-8 character.
 *
 * A cut at an arbitrary byte turns the tail of a multi-byte character into U+FFFD, and a log line
 * is the place non-ASCII arrives without warning, so the cut walks back off a continuation byte.
 */
const cutUtf8 = (bytes: Uint8Array, maxBytes: number): string => {
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
};

const utf8Length = (text: string): number => encoder.encode(text).length;

const truncationMarker = (droppedBytes: number, capName: string, maxBytes: number): string =>
  `… truncated: ${droppedBytes} more bytes (cap: ${capName}=${maxBytes})`;

/**
 * One string, cut to `maxBytes` **including** the marker naming the cap that cut it.
 *
 * Redaction has already happened (`http.ts`), so a cut can never split a `[REDACTED:…]`
 * placeholder or leave a fragment of a secret behind.
 *
 * The marker used to be appended *outside* the budget, which made the result exceed `maxBytes` by
 * the marker's own length and — the part that mattered — made the cap **not idempotent**: a second
 * application measured the first one's marker and reported a dropped-byte count about platform
 * text. Sentry's twin shipped that defect live (`sentry/mapping.ts`, review round 2), and one rule
 * for both adapters is worth more than one rule per file. So: `capBytes(capBytes(t)) ===
 * capBytes(t)`, because the output already fits, and the emitted bound is the tighter
 * `maxBytes` rather than `maxBytes + marker`. Room is reserved using the largest count the marker
 * could ever report, so the real marker never overflows the reservation. A cap smaller than its
 * own marker keeps no provider text and emits the marker cut to `maxBytes`.
 */
export const capBytes = (
  text: string,
  maxBytes: number,
  capName: string,
): { readonly text: string; readonly droppedBytes: number } => {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return { text, droppedBytes: 0 };
  }
  const marker = truncationMarker(bytes.length, capName, maxBytes);
  const reserved = utf8Length(marker);
  if (maxBytes <= reserved) {
    return { text: cutUtf8(encoder.encode(marker), maxBytes), droppedBytes: bytes.length };
  }
  const kept = cutUtf8(bytes, maxBytes - reserved);
  const dropped = bytes.length - utf8Length(kept);
  return {
    text: `${kept}${truncationMarker(dropped, capName, maxBytes)}`,
    droppedBytes: dropped,
  };
};

/** The key a marker is published under, so a consumer can tell platform text from a label. */
export const LOKI_TRUNCATION_LABEL = 'agentic.truncation';

export const createLokiProvider = (options: LokiProviderOptions): LokiProvider => {
  const { config } = options;
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: LOKI_PROVIDER_ID,
    type: 'logs',
  };
  const auth = {
    mode: config.auth_mode,
    bearerToken: options.secrets.bearer_token ?? config.bearer_token ?? null,
    username: config.username ?? null,
    password: options.secrets.password ?? config.password ?? null,
    tenantId: config.tenant_id ?? null,
  } as const;
  /**
   * The redactor this adapter actually uses: what the caller injected, plus this binding's own
   * resolved credentials (divergence 8, standing rule 31).
   *
   * The second half is what a caller cannot take away. `secrets` is the normal route, but Loki's
   * schema also lets an operator put the token straight in `config`, so the redactor is built from
   * the **effective** credential rather than from `ProviderCreateInput.secrets` — a redactor
   * assembled beside a binding instead of from it is one that does not know the token it is meant
   * to hide (the phrasing is WP-08's, and it is the same defect here).
   */
  const redactor = composeSecretRedactors(
    options.redactor,
    bindingSecretRedactor([
      auth.bearerToken === null ? null : { name: 'loki_bearer_token', value: auth.bearerToken },
      auth.password === null ? null : { name: 'loki_password', value: auth.password },
    ]),
  );

  const http: LokiHttp = createLokiHttp({
    baseUrl: config.base_url,
    auth,
    fetchImpl: options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init)),
    timeoutMs: config.request_timeout_ms,
    clock: options.clock,
    // The choke point: every response body is redacted once, before a schema or a cap sees it.
    redactor,
    ...(options.onRedaction === undefined ? {} : { onRedaction: options.onRedaction }),
  });

  // `labels` and `series` are constants rather than configuration: Loki documents both endpoints
  // on every instance, so a flag would be a branch nothing can drive (standing rule 22).
  const capabilities: ObservabilityLogsCapabilities = {
    labels: true,
    series: true,
    maxRangeMs: config.max_range_ms,
    maxLines: config.max_lines,
  };

  /**
   * The health probe's `detail`: redacted, then **bounded**, in that order.
   *
   * Redaction closes the one path that does not go through a response body — the probe quotes an
   * `IntegrationError` message, and a failing probe is where an HTTP client quotes the request it
   * made. The cap is second because redaction is the one transformation here that makes text
   * *longer*: an 8-byte secret becomes a 30-plus-byte `[REDACTED:integration:…]` placeholder once
   * per occurrence, so a bound taken before it would not bound what is emitted.
   *
   * `max_line_bytes` is the cap, because a probe detail is one line of text and that is this
   * binding's cap for one line. Every message `http.ts` builds today is platform text — the
   * method, a constant path and a status — so the *provider* cannot drive this cap; the redactor
   * can, and does in `providers/emitted-bounds.test.ts`. It is here because "every message in this
   * file is platform text" is a claim about call sites, and a claim about call sites is what three
   * WP-11 rounds got wrong (standing rule 37); `HealthProbe.detail` is a member of an emitted
   * type, so it gets a bound of its own.
   */
  const redactDetail = (action: string, text: string): string => {
    const outcome = redactor.redactText(text);
    if (outcome.count > 0) {
      options.onRedaction?.({ action, count: outcome.count });
    }
    return capBytes(outcome.value, config.max_line_bytes, 'max_line_bytes').text;
  };

  /**
   * One label set as it will be emitted: at most `max_labels` entries, each name **redacted** and
   * then cut at `max_label_bytes` along with its value, with a marker when a cap fired or two
   * names collided.
   *
   * `queryRange` copies this onto every line, which is why it is capped here rather than counted
   * once: the emitted bytes are what `max_total_bytes` has to bound. It is also the **only** place
   * this adapter emits a provider-controlled object key, which is why divergence 9 lives here.
   *
   * **One known gap — and WP-11a measured that it is not where this paragraph used to say.** A
   * label literally named `__proto__` never arrives here at all: `redactJson` in the application
   * ring rebuilds every object with `value[key] = …` (`integrations/redaction.ts`), and that
   * assignment runs `Object.prototype`'s setter rather than creating a property, so `http.ts`'s
   * one redaction pass turns `{"__proto__":"v","app":"api"}` into `{"app":"api"}` before
   * `capLabelSet` is called. Writing this function's own assignment with `Object.defineProperty`
   * would therefore change nothing a caller sees — and would still change nothing further out,
   * because `logQueryResultSchema` parses `labels` with `z.record`, and zod 4.5.4 never writes
   * that key into a record's output either (`node_modules/zod/v4/core/compile.cjs`, measured). It is not prototype pollution — the
   * value is a string, so every one of those assignments is a no-op — it is silent data loss in
   * the one label name JavaScript treats differently, it is owned by the ring that owns
   * `redactJson` and `z.record`, and it stays reported as discovered work rather than papered over
   * here. `providers/emitted-bounds.test.ts` asserts the behaviour so the claim cannot go stale.
   *
   * **Collisions keep the first entry** — the rule `mapTags` states next door for a duplicate
   * Sentry tag, and for the same reason: overwriting makes which value survives depend on the
   * order Loki happened to serialise the stream in. Two names can collide after redaction (two
   * keys that were both the same secret) or after the cap (two names sharing a prefix and a
   * length), and both are counted into the marker and into `droppedBytes`, so a collision sets
   * `truncated` instead of silently dropping a label.
   */
  const capLabelSet = (
    labels: Readonly<Record<string, string>>,
    action: string,
  ): { readonly labels: Record<string, string>; readonly droppedBytes: number } => {
    const entries = Object.entries(labels);
    const kept = entries.slice(0, config.max_labels);
    const result: Record<string, string> = {};
    let droppedBytes = 0;
    let collisions = 0;
    let redactions = 0;
    for (const [name, value] of kept) {
      // Divergence 9: `redactJson` walks string **values**, so the one pass in `http.ts` does not
      // reach a label *name*. Loki is the only provider whose keys come from the provider, and the
      // name is redacted here — before the cap, like every other string in this adapter — rather
      // than by widening the shared helper for the one caller that needs it.
      const redactedName = redactor.redactText(name);
      redactions += redactedName.count;
      const cappedName = capBytes(redactedName.value, config.max_label_bytes, 'max_label_bytes');
      const cappedValue = capBytes(value, config.max_label_bytes, 'max_label_bytes');
      droppedBytes += cappedName.droppedBytes + cappedValue.droppedBytes;
      if (Object.hasOwn(result, cappedName.text)) {
        collisions += 1;
        droppedBytes += utf8Length(cappedName.text) + utf8Length(cappedValue.text);
        continue;
      }
      result[cappedName.text] = cappedValue.text;
    }
    const notes: string[] = [];
    if (entries.length > kept.length) {
      const omitted = entries.length - kept.length;
      droppedBytes += entries
        .slice(kept.length)
        .reduce((sum, [name, value]) => sum + utf8Length(name) + utf8Length(value), 0);
      notes.push(`… ${omitted} more labels omitted (cap: max_labels=${config.max_labels})`);
    }
    if (collisions > 0) {
      notes.push(
        `… ${collisions} label names collided after redaction or max_label_bytes; the first value of each was kept`,
      );
    }
    if (notes.length > 0) {
      result[LOKI_TRUNCATION_LABEL] = notes.join(' ');
    }
    if (redactions > 0) {
      options.onRedaction?.({ action, count: redactions });
    }
    return { labels: result, droppedBytes };
  };

  /** What one emitted label set costs the total budget: every name and every value. */
  const labelSetBytes = (labels: Readonly<Record<string, string>>): number =>
    Object.entries(labels).reduce(
      (sum, [name, value]) => sum + utf8Length(name) + utf8Length(value),
      0,
    );

  /** What one emitted line costs the total budget: its text plus the labels copied onto it. */
  const lineBytes = (line: LogLine): number => utf8Length(line.line) + labelSetBytes(line.labels);

  /** The window `labels` and `series` use when the caller names none. */
  const lookbackWindow = (since?: string): { start: string; end: string } => {
    const nowMs = Date.parse(options.clock.now());
    const startMs = since === undefined ? nowMs - config.label_lookback_ms : Date.parse(since);
    return {
      start: millisecondsToNanoseconds(startMs),
      end: millisecondsToNanoseconds(nowMs),
    };
  };

  const port: ObservabilityLogsPort = {
    ref,
    capabilities: () => ({ ...capabilities }),

    testConnection: async (): Promise<HealthProbe> => {
      const checkedAt: IsoDateTime = options.clock.now();
      try {
        // Rule 18: a `bearer`/`basic` binding with no usable credential refuses here, before any
        // request, and the probe reports *that* rather than an anonymous request's 401.
        lokiAuthHeaders(auth, 'test_connection');
        const window = lookbackWindow();
        const response = await http.request({
          path: '/labels',
          query: { start: window.start, end: window.end },
          action: 'test_connection',
        });
        const parsed = parseProviderData(lokiValuesResponseSchema, response.body, {
          provider: LOKI_PROVIDER_ID,
          action: 'test_connection',
        });
        const detail = redactDetail(
          'test_connection',
          `Loki answered with ${(parsed.data ?? []).length} label names`,
        );
        return { ok: true, checked_at: checkedAt, detail, token_expires_at: null };
      } catch (error) {
        const detail = redactDetail(
          'test_connection',
          error instanceof IntegrationError ? error.message : 'the probe failed',
        );
        return { ok: false, checked_at: checkedAt, detail, token_expires_at: null };
      }
    },

    queryRange: async (query: LogRangeQuery): Promise<LogQueryResult> => {
      const action = 'query_range';
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        throw invalid(action, 'from and to must be ISO-8601 instants');
      }
      if (from >= to) {
        throw invalid(action, 'from must be before to');
      }
      if (to - from > capabilities.maxRangeMs) {
        throw invalid(
          action,
          `range of ${to - from} ms exceeds the ${capabilities.maxRangeMs} ms cap`,
        );
      }
      if (!Number.isInteger(query.limit) || query.limit < 1) {
        throw invalid(action, 'limit must be a positive integer');
      }
      if (query.limit > capabilities.maxLines) {
        throw invalid(action, `limit ${query.limit} exceeds the ${capabilities.maxLines} line cap`);
      }
      const filter = query.filter ?? null;
      if (filter !== null && filter.length > config.max_filter_length) {
        throw invalid(
          action,
          `filter of ${filter.length} characters exceeds the ${config.max_filter_length} character cap`,
        );
      }
      // Validated, never interpolated: `parseStreamSelector` refuses anything that is not a stream
      // selector, so a line filter or a parser stage smuggled in here is `invalid_request`.
      parseStreamSelector(query.selector, action);
      const direction = query.direction ?? 'backward';

      const response = await http.request({
        path: '/query_range',
        query: {
          query: buildRangeQuery(query.selector, filter),
          start: millisecondsToNanoseconds(from),
          end: millisecondsToNanoseconds(to),
          limit: query.limit,
          direction,
        },
        action,
      });
      const parsed = parseProviderData(lokiStreamsResponseSchema, response.body, {
        provider: LOKI_PROVIDER_ID,
        action,
      });
      if (parsed.status !== 'success') {
        throw new IntegrationError(
          'invalid_response',
          LOKI_PROVIDER_ID,
          `query_range answered status "${parsed.status.slice(0, 32)}"`,
          { action },
        );
      }
      if (parsed.data.resultType !== 'streams') {
        // A metric query (`count_over_time(...)`) answers `matrix`. That is the caller's mistake,
        // not a broken provider: this port returns log lines.
        throw invalid(
          action,
          `selector produced a "${parsed.data.resultType.slice(0, 32)}" result; this port returns log lines`,
        );
      }

      // Every string below was redacted in `http.ts` before it reached this line (divergence 8),
      // so the caps here can only ever cut platform-safe text.
      const flat: LogLine[] = [];
      let bytesDropped = 0;
      for (const stream of parsed.data.result) {
        const labelSet = capLabelSet(stream.stream, action);
        bytesDropped += labelSet.droppedBytes * stream.values.length;
        for (const entry of stream.values) {
          const line = capBytes(entry.line, config.max_line_bytes, 'max_line_bytes');
          bytesDropped += line.droppedBytes;
          flat.push({
            timestamp: nanosecondsToIso(entry.timestampNs, action),
            line: line.text,
            labels: { ...labelSet.labels },
          });
        }
      }

      flat.sort((left, right) =>
        direction === 'forward'
          ? Date.parse(left.timestamp) - Date.parse(right.timestamp)
          : Date.parse(right.timestamp) - Date.parse(left.timestamp),
      );

      // Divergence 4: the server's own limit is not trusted, and neither is the total size.
      //
      // The budget counts what is **emitted** — the line plus the label set copied onto it — which
      // is the review's third blocker: counting `line` alone let a 2 MB label value across 20 lines
      // answer with 42 MB and `truncated: false`. The first line is kept whatever it costs, so that
      // a budget smaller than one line answers with something; that overshoot is bounded by the
      // per-line caps and is stated in divergence 6.
      const overLimit = flat.length > query.limit;
      const withinLimit = flat.slice(0, query.limit);
      const kept: LogLine[] = [];
      let totalBytes = 0;
      let overBudget = false;
      for (const line of withinLimit) {
        const size = lineBytes(line);
        if (totalBytes + size > config.max_total_bytes && kept.length > 0) {
          overBudget = true;
          break;
        }
        totalBytes += size;
        kept.push(line);
      }
      const droppedByBudget = withinLimit.length - kept.length;

      // Divergence 5, second half: grouping is by **contiguous run**, not by label-set identity,
      // so one label set may appear in two `streams` entries. The port's consumers read
      // `streams[*].lines` flattened and the contract suite asserts that flattening is monotonic;
      // identity grouping cannot be both monotonic and grouped once two streams interleave in
      // time, and ordering is the property an agent reasons with.
      const grouped: { labels: Record<string, string>; lines: LogLine[] }[] = [];
      let currentKey: string | null = null;
      for (const line of kept) {
        const key = JSON.stringify(line.labels);
        if (key !== currentKey) {
          grouped.push({ labels: line.labels, lines: [] });
          currentKey = key;
        }
        (grouped[grouped.length - 1] as { lines: LogLine[] }).lines.push(line);
      }

      // technical/06: "Both truncate with a visible marker naming the cap that fired." The total
      // cap had none, so a consumer reading the lines saw a short answer and no reason for it. The
      // marker is a stream of its own, labelled so that it cannot be read as a log line, and it
      // carries the last kept line's timestamp so the flattened order stays monotonic.
      if (overBudget) {
        const last = kept[kept.length - 1];
        grouped.push({
          labels: { [LOKI_TRUNCATION_LABEL]: 'max_total_bytes' },
          lines: [
            {
              timestamp: last?.timestamp ?? options.clock.now(),
              line: `… ${droppedByBudget} more lines omitted after ${totalBytes} bytes (cap: max_total_bytes=${config.max_total_bytes})`,
              labels: { [LOKI_TRUNCATION_LABEL]: 'max_total_bytes' },
            },
          ],
        });
      }

      return parseProviderData(
        logQueryResultSchema,
        {
          streams: grouped,
          // Provider lines only: the marker above is platform text, and counting it would make
          // `line_count` disagree with the number of log lines the caller can reason about.
          line_count: kept.length,
          truncated:
            overLimit ||
            overBudget ||
            bytesDropped > 0 ||
            kept.length >= query.limit ||
            (parsed.warnings ?? []).length > 0,
        },
        { provider: LOKI_PROVIDER_ID, action },
      );
    },

    labels: async (name?: string): Promise<LabelValues> => {
      const action = 'labels';
      // `LabelValues.name` is emitted, and it is the caller's argument echoed back — the one
      // member of an emitted type here whose text does not come from Loki (an agent's tool call
      // reaches this port, and agent output is untrusted too, BD-022). It is **refused** past
      // `max_label_bytes` rather than truncated, for the reason `sentry/mapping.ts` refuses an
      // identifier: this string names the label whose values are being listed and is spliced into
      // the request path, so a truncated one would quietly answer about a different label.
      if (name !== undefined && utf8Length(name) > config.max_label_bytes) {
        throw invalid(
          action,
          `label name of ${utf8Length(name)} bytes exceeds the ${config.max_label_bytes}-byte max_label_bytes cap`,
        );
      }
      const window = lookbackWindow();
      const response = await http.request({
        path: name === undefined ? '/labels' : `/label/${encodeURIComponent(name)}/values`,
        query: { start: window.start, end: window.end },
        action,
      });
      const parsed = parseProviderData(lokiValuesResponseSchema, response.body, {
        provider: LOKI_PROVIDER_ID,
        action,
      });
      // Bounded like every other answer: a label with a million values, or one value that is a
      // megabyte, is the same denial of service as a 50 MB log line. Both caps leave a marker.
      const all = parsed.data ?? [];
      const values = all
        .slice(0, config.max_label_values)
        .map((value) => capBytes(value, config.max_label_bytes, 'max_label_bytes').text);
      if (all.length > values.length) {
        values.push(
          `… ${all.length - values.length} more values omitted (cap: max_label_values=${config.max_label_values})`,
        );
      }
      // `__name__` for the label-name listing matches the in-memory fake, so a consumer reading
      // `LabelValues.name` sees one vocabulary rather than two.
      return { name: name ?? '__name__', values };
    },

    series: async (selector, since) => {
      const action = 'series';
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) {
        throw invalid(action, 'since must be an ISO-8601 instant');
      }
      // The same cap `queryRange` enforces, and for the same reason: `series` builds a window from
      // `since` to now and sends it to Loki. Round 1 sent `since: 1970-01-01` as `start=0` — a
      // 56-year scan — because the check lived in one method rather than beside the window. A cap
      // one method honours is a cap the binding does not have.
      const nowMs = Date.parse(options.clock.now());
      if (nowMs - sinceMs > capabilities.maxRangeMs) {
        throw invalid(
          action,
          `range of ${nowMs - sinceMs} ms exceeds the ${capabilities.maxRangeMs} ms cap`,
        );
      }
      parseStreamSelector(selector, action);
      const window = lookbackWindow(since);
      const response = await http.request({
        path: '/series',
        query: { 'match[]': selector, start: window.start, end: window.end },
        action,
      });
      const parsed = parseProviderData(lokiSeriesResponseSchema, response.body, {
        provider: LOKI_PROVIDER_ID,
        action,
      });

      // Divergence 6, second half — and the one method the volume caps did not reach until review
      // round 2. `series` answered every label set Loki sent: 10 000 series of 5 kB of labels
      // produced **11,068,891 bytes** with no marker, because the per-label caps bound one label
      // and nothing bound the list. `max_series` bounds the count and `max_total_bytes` bounds the
      // bytes — the same pair, and the same "keep the first entry whatever it costs" rule, that
      // `queryRange` uses, so the stated bound is `max_total_bytes + one label set + one marker`.
      //
      // The marker is a label set of its own rather than a flag: `series` returns a bare array, so
      // there is no `truncated` field to set, and a short list of streams reads exactly like a
      // complete one to an agent deciding which stream to query next.
      const all = parsed.data ?? [];
      const emitted: Record<string, string>[] = [];
      let totalBytes = 0;
      let overBudget = false;
      for (const labels of all.slice(0, config.max_series)) {
        const capped = capLabelSet(labels, action).labels;
        const size = labelSetBytes(capped);
        if (totalBytes + size > config.max_total_bytes && emitted.length > 0) {
          overBudget = true;
          break;
        }
        totalBytes += size;
        emitted.push(capped);
      }
      const omitted = all.length - emitted.length;
      if (omitted > 0) {
        emitted.push({
          [LOKI_TRUNCATION_LABEL]: overBudget
            ? `… ${omitted} more series omitted after ${totalBytes} bytes (cap: max_total_bytes=${config.max_total_bytes})`
            : `… ${omitted} more series omitted (cap: max_series=${config.max_series})`,
        });
      }
      return emitted;
    },

    agentTooling: () => LOKI_AGENT_TOOLING,
  };

  return port;
};
