/**
 * Sentry vocabulary → port vocabulary, and the caps that bound it (technical/06, BD-022).
 *
 * Nothing here does I/O, so every rule below is a pure function with a unit test. Three of them
 * are the reason the file exists.
 *
 *  1. **A read maps unknown vendor values, it does not refuse them** (standing rule 20, earned at
 *     WP-09: `mapPipelineStatus` threw on an unknown status inside `normalise`, so a status GitLab
 *     added later turned every such delivery into a permanently failing job). Sentry's `level` and
 *     `status` both gain values — `substatus` and `priority` arrived after this port was written —
 *     and reading an issue is being *told* something. So an unrecognised value falls back to the
 *     nearest safe member of the port's enum and is **reported** through `onUnmapped`, which the
 *     provider forwards; a test asserts the report positively rather than asserting the absence of
 *     a throw.
 *  2. **Truncation is visible.** A stack trace cut at 50 frames and handed to an agent as if it
 *     were the whole trace is the error-tracker version of `truncated: false` on a truncated log
 *     query. Every cap here leaves a marker line in the text saying what was dropped and which
 *     configuration key dropped it.
 *  3. **A byte cap never splits a character.** `truncateUtf8` walks back off a UTF-8 continuation
 *     byte, so the tail of a multi-byte character can never become U+FFFD — which matters because
 *     a stack trace is the one place in the platform where non-ASCII identifiers are routine.
 */
import { type Breadcrumb, IntegrationError, type Issue } from '@platform/application';
import type { IsoDateTime } from '@platform/contracts';
import type { SentryBreadcrumb, SentryEvent, SentryExceptionValue } from './schemas.js';

// ── Reporting a value the vendor added after this file was written ────────────

export interface UnmappedValue {
  /** Which field carried it: `issue.level`, `issue.status`. */
  readonly field: string;
  /** The vendor's value, truncated — it is untrusted text on its way to a log (BD-022). */
  readonly value: string;
  /** What the adapter used instead. */
  readonly usedInstead: string;
}

export type UnmappedSink = (value: UnmappedValue) => void;

/** 64 characters is plenty to identify a new enum member and short enough to log. */
const describeValue = (value: unknown): string => String(value).slice(0, 64);

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Sentry prints `2018-11-06T21:19:55Z` on an issue and `2020-06-17T22:26:56.098086Z` — six
 * fractional digits — on an event. Both are normalised to the platform's millisecond wire format
 * rather than passed through, so `isoDateTimeSchema` never has to decide about microseconds.
 */
export const toIsoDateTime = (
  value: string | null | undefined,
  fallback: IsoDateTime,
): IsoDateTime => {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? fallback : (new Date(at).toISOString() as IsoDateTime);
};

// ── Enums ────────────────────────────────────────────────────────────────────

const LEVELS: ReadonlySet<Issue['level']> = new Set(['fatal', 'error', 'warning', 'info', 'debug']);

/**
 * Sentry's own level vocabulary is wider than the port's — `sample` and `critical` both appear in
 * the wild, and the SDKs accept anything. Unknown becomes `error`: an event the platform cannot
 * classify is not less serious than one it can, and under-reporting severity is the direction that
 * loses a bug.
 */
export const mapIssueLevel = (raw: unknown, onUnmapped?: UnmappedSink): Issue['level'] => {
  if (typeof raw === 'string' && LEVELS.has(raw as Issue['level'])) {
    return raw as Issue['level'];
  }
  if (raw === 'critical') {
    return 'fatal';
  }
  onUnmapped?.({ field: 'issue.level', value: describeValue(raw), usedInstead: 'error' });
  return 'error';
};

/**
 * `muted` is Sentry's legacy spelling of `ignored` and still appears on older issues, so it is a
 * *known* mapping rather than a fallback. Anything else becomes `unresolved`, which is the value
 * that keeps the platform looking: claiming an issue is resolved because its status was spelled in
 * a way this adapter has not seen would hide a live bug.
 */
export const mapIssueStatus = (raw: unknown, onUnmapped?: UnmappedSink): Issue['status'] => {
  if (raw === 'unresolved' || raw === 'resolved' || raw === 'ignored') {
    return raw;
  }
  if (raw === 'muted') {
    return 'ignored';
  }
  onUnmapped?.({ field: 'issue.status', value: describeValue(raw), usedInstead: 'unresolved' });
  return 'unresolved';
};

// ── Byte caps ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Truncation {
  readonly text: string;
  /** Bytes of provider text that were dropped. `0` means the value is complete. */
  readonly droppedBytes: number;
}

/**
 * Cuts `text` to at most `maxBytes` **UTF-8 bytes**, never mid-character.
 *
 * A naive `slice(0, n)` counts UTF-16 code units, which is neither what a database column nor a
 * token budget counts, and slicing an encoded buffer at an arbitrary index turns the tail of a
 * multi-byte character into U+FFFD. So the cut walks back while the byte at the boundary is a
 * continuation byte (`0b10xxxxxx`).
 */
export const truncateUtf8 = (text: string, maxBytes: number): Truncation => {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return { text, droppedBytes: 0 };
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { text: decoder.decode(bytes.subarray(0, end)), droppedBytes: bytes.length - end };
};

const truncationMarker = (droppedBytes: number, capName: string, maxBytes: number): string =>
  `\n… truncated: ${droppedBytes} more bytes (cap: ${capName}=${maxBytes})`;

/**
 * `truncateUtf8` plus the marker that makes the cut visible — **never longer than `maxBytes`**.
 *
 * ## Why the marker is inside the budget (review round 2)
 *
 * Round 1 appended the marker *after* the cut, so the result exceeded `maxBytes` by the marker's
 * own length. The argument was that the cap bounds the provider's text and a marker that could be
 * truncated is a warning that disappears when it matters. It cost more than it bought, because a
 * marker-bearing cap of that shape **is not idempotent**: applying it twice measures the already
 * truncated text, so the second pass cuts the marker off and reports a dropped-byte count that is
 * about the marker rather than about the data. Two call sites did apply it twice —
 * `mapEvent`'s `field(environment)` and `mapCorrelationIds`' tag branch — and the same event
 * carried `tags.environment` saying "976 more bytes" beside `environment` saying "58 more bytes".
 * One of those numbers is a lie about how much of a value the platform threw away.
 *
 * So the rule is now the simpler one, and it is the *stronger* bound: **the emitted string is at
 * most `maxBytes` UTF-8 bytes**, marker included. Room for the marker is reserved up front using
 * the largest count it could ever report (everything dropped), so the real marker never overflows
 * the reservation. Idempotence follows from the bound rather than from recognising the marker —
 * a second pass sees a string that already fits and returns it unchanged — which matters because
 * the input is untrusted (BD-022) and a provider can forge any suffix it likes, but it cannot
 * forge a length. `mapping.test.ts` asserts both properties over generated inputs.
 *
 * A cap smaller than its own marker keeps no provider text at all and emits the marker cut to
 * `maxBytes`; that still reads as truncation, and it keeps the bound total rather than true for
 * the configurations someone happened to test.
 */
export const capText = (text: string, maxBytes: number, capName: string): string => {
  const totalBytes = encoder.encode(text).length;
  if (totalBytes <= maxBytes) {
    return text;
  }
  const reserved = encoder.encode(truncationMarker(totalBytes, capName, maxBytes)).length;
  if (maxBytes <= reserved) {
    return truncateUtf8(truncationMarker(totalBytes, capName, maxBytes), maxBytes).text;
  }
  const { text: kept, droppedBytes } = truncateUtf8(text, maxBytes - reserved);
  return `${kept}${truncationMarker(droppedBytes, capName, maxBytes)}`;
};

// ── Stack traces ─────────────────────────────────────────────────────────────

/** `total (src/billing/totals.ts:42:11)` — one frame, with every member optional in Sentry. */
export const formatFrame = (frame: {
  readonly function?: string | null;
  readonly module?: string | null;
  readonly filename?: string | null;
  readonly absPath?: string | null;
  readonly lineNo?: number | null;
  readonly colNo?: number | null;
}): string => {
  const name = frame.function ?? frame.module ?? '<anonymous>';
  const file = frame.filename ?? frame.absPath ?? frame.module ?? '<unknown>';
  const position =
    frame.lineNo === null || frame.lineNo === undefined
      ? ''
      : `:${frame.lineNo}${frame.colNo === null || frame.colNo === undefined ? '' : `:${frame.colNo}`}`;
  return `${name} (${file}${position})`;
};

export interface RenderedStackTrace {
  readonly text: string;
  readonly framesTotal: number;
  readonly framesKept: number;
}

/**
 * Renders the `exception` entry of an event into the single string the port publishes.
 *
 * Frames are kept from the **end** — the innermost calls, where the crash is — because a runaway
 * recursion pads the *front* with ten thousand identical frames and the useful ones are the last
 * few. What was dropped is stated on the first line, with the configuration key that dropped it,
 * so an agent reading a 50-frame trace is never left to assume it saw the whole stack.
 */
export const renderStackTrace = (
  values: readonly SentryExceptionValue[],
  maxFrames: number,
): RenderedStackTrace => {
  const groups = values.map((value) => ({
    header: `${value.type ?? 'Error'}: ${value.value ?? ''}`,
    frames: value.stacktrace?.frames ?? value.rawStacktrace?.frames ?? [],
  }));
  const framesTotal = groups.reduce((sum, group) => sum + group.frames.length, 0);
  const framesKept = Math.min(framesTotal, maxFrames);
  let toDrop = framesTotal - framesKept;

  const lines: string[] = [];
  if (toDrop > 0) {
    lines.push(
      `… ${toDrop} of ${framesTotal} stack frames omitted (cap: max_stack_frames=${maxFrames})`,
    );
  }
  for (const group of groups) {
    lines.push(group.header);
    for (const frame of group.frames) {
      if (toDrop > 0) {
        toDrop -= 1;
        continue;
      }
      lines.push(`    at ${formatFrame(frame)}`);
    }
  }
  return { text: lines.join('\n'), framesTotal, framesKept };
};

// ── Breadcrumbs and tags ─────────────────────────────────────────────────────

/**
 * The **newest** breadcrumbs are kept: a breadcrumb trail is a timeline ending at the crash, and
 * the crumbs next to the crash are the ones that explain it. A dropped prefix is announced by a
 * synthetic first crumb whose `category` is `agentic.truncation`, so a consumer that renders the
 * trail as a list sees the gap without having to read a separate field.
 *
 * **All three text members are capped, not one** (standing rule 37, WP-11a). `category` and
 * `level` are `z.string().nullish()` in `sentryBreadcrumbSchema` and in `breadcrumbSchema`, which
 * is to say they are untrusted provider text of unbounded length (BD-022) heading for a context
 * pack and an `integration_actions` row — but three review rounds capped `message` and never
 * looked at the two fields beside it in the same object literal, because each round audited the
 * call sites that cap things rather than the members of the type being emitted. Measured at the
 * shipped defaults (`max_breadcrumbs=25`, `max_breadcrumb_bytes=1024`) on 50 crumbs of
 * 2,000,000-byte fields, `mapBreadcrumbs` emitted **100,027,762 bytes** of JSON: `message` cut to
 * 1024, `category` and `level` straight through at 2,000,000 each, no marker and nothing setting
 * `truncated`. That figure is asserted by `mapping.test.ts`, which reproduces the defect through
 * this very function by passing an unbounded `maxFieldBytes` — the earlier claim of "200,106,401
 * bytes at the shipped defaults" was taken at doubled caps and did not reproduce (WP-11a review
 * round 1). The bound is now stated in `config.ts` as a formula and
 * asserted at the shipped defaults by `mapping.test.ts`, and every emitted field of both adapters
 * is walked by `providers/emitted-bounds.test.ts` rather than listed in a docblock.
 *
 * `category` and `level` take `max_field_bytes` rather than `max_breadcrumb_bytes`: they are
 * short-string members like a tag name or a release, and `max_breadcrumb_bytes` is documented as
 * "bytes kept of one breadcrumb *message*".
 */
export const mapBreadcrumbs = (
  crumbs: readonly SentryBreadcrumb[],
  options: {
    readonly maxBreadcrumbs: number;
    readonly maxBreadcrumbBytes: number;
    readonly maxFieldBytes: number;
    readonly fallbackTimestamp: IsoDateTime;
  },
): Breadcrumb[] => {
  const shortField = (value: string | null | undefined): string | null =>
    value === null || value === undefined
      ? null
      : capText(value, options.maxFieldBytes, 'max_field_bytes');
  const dropped = Math.max(0, crumbs.length - options.maxBreadcrumbs);
  const kept = crumbs.slice(dropped).map((crumb) => ({
    timestamp: toIsoDateTime(crumb.timestamp, options.fallbackTimestamp),
    category: shortField(crumb.category),
    level: shortField(crumb.level),
    // Sentry prints `"message": null` for an `http` crumb whose detail lives in `data`; the port
    // requires a string, and `''` is the honest rendering of "this crumb carried no message".
    message: capText(crumb.message ?? '', options.maxBreadcrumbBytes, 'max_breadcrumb_bytes'),
  }));
  if (dropped === 0) {
    return kept;
  }
  return [
    {
      timestamp: options.fallbackTimestamp,
      category: 'agentic.truncation',
      level: 'info',
      message: `… ${dropped} earlier breadcrumbs omitted (cap: max_breadcrumbs=${options.maxBreadcrumbs})`,
    },
    ...kept,
  ];
};

/**
 * `tags` arrives as a list of `{key, value}` pairs and the port publishes a record.
 *
 * A duplicate key keeps the **first** occurrence, because Sentry lists a tag once and a repeat is
 * a shape nobody documents; overwriting would make which value survives depend on ordering.
 * `loki/provider.ts` cites this rule as the precedent for its own label sets, so it has to be true
 * here rather than merely written here.
 *
 * **Both axes are capped.** Round 1 capped the count and left the value unbounded, which is a cap
 * that measures the wrong thing: 50 tags of 2 MB each is 100 MB inside a "capped" record. The name
 * is capped as well — a key is provider text too, and a record key is not somewhere a caller thinks
 * to look for a megabyte. When the count cap fires, a marker entry says so, because a silently
 * shorter tag set reads exactly like a complete one.
 *
 * ## Why the duplicate check is `Object.hasOwn` over the **capped** key (WP-11a, standing rule 38)
 *
 * It used to be `tag.key in record`, and that was wrong twice over — both measured, neither
 * reported by three review rounds:
 *
 *  1. `in` walks the prototype chain, so `'toString' in {}` is `true` and every tag named after an
 *     `Object.prototype` member was **silently dropped**. Measured: a tag list of `toString`,
 *     `constructor`, `valueOf`, `hasOwnProperty`, `__proto__` and `app` came back as
 *     `{"app":"api"}` — five tags gone, no marker, `truncated` untouched.
 *  2. It tested the **raw** key against **capped** keys, so two names that are different before the
 *     cap and identical after it both got written, and the record kept the **last**. Measured with
 *     `{"A"×200 + "x": "first"}` and `{"A"×200 + "y": "second"}` at `maxBytes: 128`: one entry,
 *     value `"second"` — the opposite of what the paragraph above promises and of what Loki cites.
 *
 * `Object.hasOwn(record, capped)` fixes both: it asks about own properties only, and it asks about
 * the string that is actually going to be a key.
 *
 * **The one name this cannot save is `__proto__`**, and the reason is two rings out rather than
 * here. `record['__proto__'] = 'v'` runs `Object.prototype`'s setter instead of creating an own
 * property; writing it with `Object.defineProperty` would fix *this* function and change nothing a
 * caller sees, because `parseProviderData(errorEventSchema, …)` parses `tags` with `z.record`, and
 * zod 4.5.4 never writes that key into a record's output — measured, and deliberate on its side
 * (`node_modules/zod/v4/core/compile.cjs`: `throw new ZodCompileUnsupportedError('record key
 * "__proto__"')` for the compiled path, `if (k === "__proto__") continue;` for the runtime one).
 * So a `__proto__` tag is dropped at the port boundary whatever this function does; it is stated
 * here, asserted by `mapping.test.ts`, and recorded as work for the ring that owns `z.record`
 * rather than pretended away.
 */
export const mapTags = (
  tags: readonly { readonly key: string; readonly value?: string | null }[],
  limits: { readonly maxTags: number; readonly maxBytes: number },
): Record<string, string> => {
  const record: Record<string, string> = {};
  let seen = 0;
  for (const tag of tags) {
    if (Object.keys(record).length >= limits.maxTags) {
      break;
    }
    seen += 1;
    const key = capText(tag.key, limits.maxBytes, 'max_field_bytes');
    if (!Object.hasOwn(record, key)) {
      record[key] = capText(tag.value ?? '', limits.maxBytes, 'max_field_bytes');
    }
  }
  if (seen < tags.length) {
    record['agentic.truncation'] =
      `… ${tags.length - seen} more tags omitted (cap: max_tags=${limits.maxTags})`;
  }
  return record;
};

/**
 * The ids the logs provider can query on — `trace_id` and `span_id` from `contexts.trace`, plus
 * any tag the application set with a correlation-shaped name.
 *
 * The tag names are a **convention**, not a Sentry feature: nothing in the documentation says an
 * application tags its events with `request_id`. So the list is small, explicit, and stated here
 * rather than inferred from whatever the event happens to carry — an adapter that copied every
 * tag whose name ended in `_id` would put customer identifiers into a context pack.
 */
export const CORRELATION_TAGS = ['trace_id', 'request_id', 'transaction_id'] as const;

export const mapCorrelationIds = (
  event: SentryEvent,
  tags: Readonly<Record<string, string>>,
  maxBytes: number,
): Record<string, string> => {
  const ids: Record<string, string> = {};
  // `contexts.trace` is opaque provider JSON, so its members are capped here rather than trusted
  // to be the 32 hex characters the SDKs write. The tag values arrive already capped by `mapTags`,
  // and capping twice is a **no-op** rather than a second cut — `capText` emits at most `maxBytes`,
  // which is what makes it idempotent, and `mapping.test.ts` asserts that over generated inputs.
  // Round 1 claimed the same thing about a cap that was not idempotent: the second pass measured
  // the first pass's marker and reported a dropped-byte count about the marker (review round 2).
  const trace = event.contexts?.trace;
  if (trace !== null && typeof trace === 'object') {
    const traceId = (trace as Record<string, unknown>).trace_id;
    const spanId = (trace as Record<string, unknown>).span_id;
    if (typeof traceId === 'string' && traceId !== '') {
      ids.trace_id = capText(traceId, maxBytes, 'max_field_bytes');
    }
    if (typeof spanId === 'string' && spanId !== '') {
      ids.span_id = capText(spanId, maxBytes, 'max_field_bytes');
    }
  }
  for (const name of CORRELATION_TAGS) {
    const value = tags[name];
    if (value !== undefined && value !== '' && ids[name] === undefined) {
      ids[name] = capText(value, maxBytes, 'max_field_bytes');
    }
  }
  return ids;
};

/**
 * A provider **identifier** — an id, a slug, a permalink — refused rather than truncated.
 *
 * A truncated id is worse than no id: it still looks like one, and this adapter builds URLs and
 * issues `PUT`s out of it. Sentry's own ids are short, so the cap can only fire on a response this
 * adapter should not be reading (BD-022: a vendor's shape is not a promise).
 *
 * @throws {IntegrationError} `invalid_response`.
 */
export const boundedIdentifier = (
  value: string,
  maxBytes: number,
  field: string,
  context: { readonly provider: string; readonly action: string },
): string => {
  const { droppedBytes } = truncateUtf8(value, maxBytes);
  if (droppedBytes === 0) {
    return value;
  }
  throw new IntegrationError(
    'invalid_response',
    context.provider,
    `${field} is ${encoder.encode(value).length} bytes, past the ${maxBytes}-byte max_field_bytes cap`,
    { action: context.action },
  );
};
