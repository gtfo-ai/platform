/**
 * **Every field the two observability adapters emit, walked rather than listed** — WP-11a,
 * standing rule 37 (technical/10 unit tier).
 *
 * ## Why this file exists
 *
 * WP-11 spent three review rounds on one defect class: a provider string reaching a context pack
 * and an `integration_actions` row without a cap. Each round audited *the call sites that cap
 * things*, found the ones it was looking for, and declared the sweep complete. Round 3 wrote
 * "the one string routing around every cap was Sentry's health probe" — and a breadcrumb's
 * `category` and `level` were going out raw the whole time, in the same object literal as the
 * `message` every round had capped, because nobody enumerated the **members of the emitted type**.
 * At the shipped defaults — `max_breadcrumbs=25`, `max_breadcrumb_bytes=1024` — a 50-crumb trail
 * of 2,000,000-byte fields was **100,027,762 bytes** of JSON; `sentry/mapping.test.ts` asserts that
 * figure rather than quoting it, by driving the shipped function with an unbounded `max_field_bytes`
 * (the "200,106,401 bytes at the shipped defaults" this file claimed until WP-11a's own review was
 * measured at *doubled* caps and did not reproduce).
 *
 * A list in a docblock cannot prevent the next one (standing rule 30: a lesson recorded only in
 * prose does not prevent recurrence; standing rule 33: a guard with no test of its own is not a
 * guard). So the enumeration is executed:
 *
 *  1. every port method of both adapters is driven from a **hostile document** — every member
 *     whose bound is a **cut** carries a value far longer than every cap. The members whose bound
 *     is a **refusal** carry *safe* values there, because a hostile one throws and the walk would
 *     then measure nothing at all; each of those gets a hostile document of its own in
 *     "an identifier over the cap is refused", asserting the `invalid_response` and the field it
 *     names. **A hostile-document enumeration is only as wide as the values it dares send**, and
 *     until WP-11a review round 1 this file dared send none of them: deleting `identifier()` from
 *     `ref.short_id`, `ref.url`, `project`, `event_id` or `issue_id` left all 758 tests green;
 *  1b. and the same for Loki's `LabelValues.name`, refused rather than cut, driven below and now
 *     also an obligation of the shared `ObservabilityLogs` contract suite (standing rule 23);
 *  2. the answers are walked to their leaves, **keys included** (a record key is emitted text too,
 *     which is exactly how a 2 MB tag *name* got in), and any string past the largest named cap
 *     fails, naming its own path;
 *  3. the key **inventory** of every emitted object is asserted, so a field added later fails this
 *     test until somebody decides where its bound comes from. It is a hand-written list, but it is
 *     the fail-closed kind: it can only make the build red, never suppress a failure (standing
 *     rule 7's corollary);
 *  4. every field that is *supposed* to be truncated is asserted to carry the marker naming its
 *     cap, so the walk cannot pass because the hostile document failed to reach a field (standing
 *     rule 10: a test satisfied by every branch must also assert which branch ran).
 *
 * ## What it cannot cover, stated rather than implied
 *
 *  - **A field the hostile document does not reach.** (3) fails on a new *key*, but a new *source*
 *     for an existing key — a second branch that fills `environment` from somewhere else — is
 *     invisible here. The per-field marker assertions in (4) are the partial answer: they fail
 *     when a field stops being fed.
 *  - **A new member whose bound is a refusal.** (1) sends it a safe value and (2) measures the
 *     safe value, so only its own document in (1) covers it; adding an identifier means adding a
 *     document, and (3)'s inventory is what makes that omission fail rather than pass. The two
 *     halves cover each other and neither is complete alone.
 *  - **Which of several guards refused.** An assertion on `invalid_response` names the field in
 *     the message, so two guards over the same field are indistinguishable to it. That is why
 *     `issue.id` is now bounded in exactly one place — `mapIssue` — and `issueUrl` takes the
 *     bounded id rather than bounding it a second time (`sentry/provider.ts`).
 *  - **Thrown errors.** An `IntegrationError` is not an emitted field; its text is bounded by the
 *     rule that `http.ts` builds messages from a method, a constant path and a status. The one
 *     error path that *is* emitted — `HealthProbe.detail` — is driven here on both branches.
 *  - **Bounds outside this ring.** What `IntegrationActionExecutor` writes to
 *     `integration_actions`, what WP-16 puts in a context pack, and what the port's own schema
 *     accepts are three other budgets. This file bounds what the adapters hand over.
 *  - **The numbers themselves.** Caps are configuration: an operator who sets `max_line_bytes` to
 *     a megabyte gets a megabyte. What is asserted is the *relation* — nothing emitted exceeds the
 *     largest cap configured — plus, in `sentry/mapping.test.ts`, the sum at the shipped defaults.
 *  - **Redaction.** A different property with its own tests — `emitted-secrets.test.ts` is this
 *     file's dual: the same walk, over the Jira and GitLab adapters, failing on any string that
 *     carries a **credential** rather than one past a cap. A bounded string can still be the wrong
 *     string, and a redacted one can still be 27 MB.
 *  - **The other two adapters.** Jira and GitLab are deliberately **not** driven here, and the
 *     reason is not that a tracker is different in kind — it is that this file's assertion is
 *     *relative to a named cap*, and neither adapter has one over the text it emits; adding them
 *     would pass vacuously against GitLab's 1 MiB job-log tail, which bounds nothing they emit.
 *     What one call of each hands over is measured in `unbounded-emission.test.ts` instead — the
 *     same hostile document, asserting the byte total and the path list rather than a bound — and
 *     filed as **Q54** with a recommendation (bound at the consumer, WP-16), because inventing a
 *     cap on a ticket description silently changes what the agent reads. The two figures this
 *     docblock used to carry were both wrong (standing rule 39): the `readTicket` one was quoted
 *     "at the shipped `MAX_COMMENTS = 100`", which is `maxResults` and enforces nothing, and the
 *     `getMergeRequest` one did not reproduce.
 */
import {
  exactSecretRedactor,
  IntegrationError,
  noSecretsRedactor,
  type SecretRedactor,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createLokiRegistration } from './loki/index.js';
import { createSentryRegistration } from './sentry/index.js';
import type { UnmappedValue } from './sentry/mapping.js';

const NOW = '2026-06-01T10:30:00.000Z' as const;
const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

/**
 * 128 KiB in every string the vendor controls.
 *
 * The blow-up was measured at 2 MB in `sentry/mapping.test.ts`, where the function under test is
 * pure and the run costs nothing. Here every document is serialised, parsed and redacted for each
 * of a dozen calls, so the hostile value is sized to be *far* past every cap in these
 * configurations (the largest is 512 bytes) rather than to reproduce a headline number.
 */
const HOSTILE = 'H'.repeat(128 * 1024);

// ── The walk ─────────────────────────────────────────────────────────────────

interface EmittedString {
  readonly path: string;
  readonly text: string;
  readonly bytes: number;
}

const label = (key: string): string => (key.length > 24 ? `${key.slice(0, 24)}…` : key);

/**
 * Every string in an emitted value, with the path it sits at.
 *
 * Object **keys** are walked as strings of their own: `tags` and `labels` are records with
 * provider-chosen keys, so a key is provider text that the platform stores, renders and puts in a
 * prompt. Missing that is what let a 2 MB tag name through review round 1.
 */
const walkStrings = (value: unknown, path = '$'): EmittedString[] => {
  if (typeof value === 'string') {
    return [{ path, text: value, bytes: bytesOf(value) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => walkStrings(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      { path: `${path}.<key ${label(key)}>`, text: key, bytes: bytesOf(key) },
      ...walkStrings(item, `${path}.${label(key)}`),
    ]);
  }
  return [];
};

/**
 * The union of the keys of **every** element of a list, so an inventory cannot be discharged by
 * whichever element happens to sit at index 0.
 *
 * `breadcrumbs[0]` on the truncating path is the **synthetic marker crumb**, a different object
 * literal from the one that carries provider data, and this file sampled it: a planted
 * `data_summary` on the provider crumb escaped the inventory entirely at WP-11a review round 1 and
 * was caught only by the byte walk. Loki's markers sit at the *end* of `streams`, `values` and
 * `series` and were sampled at index 0, so they had the mirror-image gap.
 */
const keysOfEvery = (values: readonly unknown[]): string[] =>
  [
    ...new Set(
      values.flatMap((value) =>
        value !== null && typeof value === 'object' ? Object.keys(value) : [],
      ),
    ),
  ].sort();

const at = (strings: readonly EmittedString[], path: string): EmittedString => {
  const found = strings.find((entry) => entry.path === path);
  if (found === undefined) {
    throw new Error(
      `nothing was emitted at ${path}; the hostile document no longer reaches it. Paths: ${strings
        .map((entry) => entry.path)
        .join(', ')}`,
    );
  }
  return found;
};

/** A redactor that makes text **longer**, which is what redaction really does (TD-012). */
const expandingRedactor = (): SecretRedactor =>
  exactSecretRedactor([{ name: 'expanding', value: 'answered' }]);

/**
 * The instrument, proved before it is believed (standing rule 29: a harness a suite uses to decide
 * which branch ran must itself be asserted live — mutating `providerCalls()` to `() => 0` once left
 * 2335 tests green).
 *
 * The half that matters is the key walk: a record key is emitted provider text, and a walk that
 * only looked at values would report "everything is bounded" while a 2 MB tag *name* went past it.
 */
describe('the walk itself', () => {
  it('reaches strings through arrays and objects, and reports keys as strings', () => {
    expect(
      walkStrings({ a: ['x', { b: 'y' }] }).map((entry) => `${entry.path}=${entry.text}`),
    ).toEqual(['$.<key a>=a', '$.a[0]=x', '$.a[1].<key b>=b', '$.a[1].b=y']);
  });

  it('would fail an over-cap record key, which is how a 2 MB tag name gets in', () => {
    const found = walkStrings({ tags: { [HOSTILE]: 'v' } }).filter((entry) => entry.bytes > 512);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toContain('<key ');
  });

  it('names the path when a field it was told to check is no longer emitted', () => {
    expect(() => at(walkStrings({ a: 'x' }), '$.missing')).toThrow(/nothing was emitted/);
  });
});

// ── Sentry ───────────────────────────────────────────────────────────────────

const SENTRY_CAPS = {
  max_issues: 5,
  max_stack_frames: 2,
  max_stack_trace_bytes: 512,
  max_breadcrumbs: 2,
  max_breadcrumb_bytes: 256,
  max_tags: 5,
  max_message_bytes: 320,
  max_field_bytes: 128,
} as const;
/** The bound the walk asserts: no emitted string may pass the largest cap configured. */
const LARGEST_SENTRY_CAP = SENTRY_CAPS.max_stack_trace_bytes;

const SENTRY_ISSUE = {
  id: '4242',
  shortId: 'ACME-API-7',
  shareId: HOSTILE,
  title: HOSTILE,
  culprit: HOSTILE,
  permalink: 'https://sentry.example.test/organizations/acme-example/issues/4242/',
  logger: HOSTILE,
  level: HOSTILE,
  status: HOSTILE,
  substatus: HOSTILE,
  platform: HOSTILE,
  project: { id: '11', name: HOSTILE, slug: 'api', platform: HOSTILE },
  type: HOSTILE,
  metadata: { value: HOSTILE },
  numComments: 2,
  assignedTo: { type: 'user', id: '9', name: HOSTILE, email: HOSTILE },
  count: '150',
  userCount: 12,
  firstSeen: '2026-05-01T00:00:00Z',
  lastSeen: '2026-06-01T00:00:00Z',
  firstRelease: { version: HOSTILE },
  lastRelease: { version: HOSTILE },
};

const SENTRY_EVENT = {
  id: 'ev-1',
  eventID: 'ev-1',
  groupID: '4242',
  title: HOSTILE,
  message: HOSTILE,
  platform: HOSTILE,
  dateCreated: '2026-06-01T09:11:00.098086Z',
  dateReceived: '2026-06-01T09:11:01.000000Z',
  size: 4096,
  tags: [
    { key: HOSTILE, value: HOSTILE },
    { key: 'environment', value: HOSTILE },
    // `toString` is here because `key in record` silently dropped it for three review rounds.
    { key: 'toString', value: HOSTILE },
    { key: 'request_id', value: HOSTILE },
    { key: 'server_name', value: HOSTILE },
    { key: 'dropped_by_the_count_cap', value: HOSTILE },
  ],
  entries: [
    {
      type: 'exception',
      data: {
        values: [
          {
            type: HOSTILE,
            value: HOSTILE,
            stacktrace: {
              frames: [
                { function: HOSTILE, filename: HOSTILE, lineNo: 1, colNo: 2 },
                { function: HOSTILE, filename: HOSTILE, lineNo: 3, colNo: 4 },
                { function: HOSTILE, filename: HOSTILE, lineNo: 5, colNo: 6 },
              ],
            },
          },
        ],
      },
    },
    {
      type: 'breadcrumbs',
      data: {
        values: [
          {
            timestamp: '2026-06-01T09:10:00Z',
            category: HOSTILE,
            level: HOSTILE,
            message: HOSTILE,
          },
          {
            timestamp: '2026-06-01T09:10:30Z',
            category: HOSTILE,
            level: HOSTILE,
            message: HOSTILE,
          },
          {
            timestamp: '2026-06-01T09:10:59Z',
            category: HOSTILE,
            level: HOSTILE,
            message: HOSTILE,
          },
        ],
      },
    },
  ],
  contexts: { trace: { trace_id: HOSTILE, span_id: HOSTILE, op: HOSTILE } },
  release: { version: HOSTILE },
  metadata: { function: HOSTILE },
  culprit: HOSTILE,
  location: HOSTILE,
  projectID: '11',
};

const SENTRY_ORGANIZATION = {
  id: '7',
  slug: 'acme-example',
  name: HOSTILE,
  status: { id: 'active', name: HOSTILE },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const sentryPort = (options: {
  readonly organization?: string;
  readonly redactor?: SecretRedactor;
  readonly status?: number;
  readonly onUnmapped?: (value: UnmappedValue) => void;
  /** One member replaced, so a refusal can be attributed to the field under test. */
  readonly issue?: Readonly<Record<string, unknown>>;
  readonly event?: Readonly<Record<string, unknown>>;
}) =>
  createSentryRegistration({
    clock: fixedClock(NOW),
    fetch: (url: string) => {
      if (options.status !== undefined && options.status !== 200) {
        return Promise.resolve(json({ detail: HOSTILE }, options.status));
      }
      if (url.includes('/events/latest/')) {
        return Promise.resolve(json(options.event ?? SENTRY_EVENT));
      }
      if (url.includes('/issues/') && url.includes('/projects/')) {
        return Promise.resolve(json([options.issue ?? SENTRY_ISSUE]));
      }
      if (url.includes('/issues/')) {
        return Promise.resolve(json(options.issue ?? SENTRY_ISSUE));
      }
      return Promise.resolve(json(SENTRY_ORGANIZATION));
    },
    ...(options.onUnmapped === undefined ? {} : { onUnmapped: options.onUnmapped }),
  }).create({
    integrationId: '00000000-0000-4000-8000-0000000000a6',
    config: {
      base_url: 'https://sentry.example.test',
      organization: options.organization ?? 'acme-example',
      ...SENTRY_CAPS,
    },
    secrets: { auth_token: 'FAKE-sentry-auth-token-DO-NOT-USE' },
    redactor: options.redactor ?? noSecretsRedactor(),
  });

describe('Sentry: every emitted field is bounded by a named cap (standing rule 37)', () => {
  const unmapped: UnmappedValue[] = [];
  const port = sentryPort({ onUnmapped: (value) => unmapped.push(value) });

  const answers = async () => ({
    capabilities: port.capabilities(),
    agent_tooling: port.agentTooling(),
    probe: await port.testConnection(),
    issue: await port.getIssue({ id: '4242' }),
    event: await port.getLatestEvent({ id: '4242' }),
    search: await port.searchIssues({ project: 'api', query: '' }),
    resolved: await port.resolve({ id: '4242' }, { inRelease: '1.2.3' }),
    unmapped_reports: unmapped,
  });

  it('emits no string longer than the largest cap, anywhere in any answer', async () => {
    const strings = walkStrings(await answers());
    const over = strings.filter((entry) => entry.bytes > LARGEST_SENTRY_CAP);
    expect(
      over.map((entry) => `${entry.path} = ${entry.bytes} bytes`),
      'a member of an emitted type with no cap behind it',
    ).toEqual([]);
    expect(strings.length, 'the walk reached the answers at all').toBeGreaterThan(50);
  });

  /**
   * The inventory. It fails when a field is added — which is the point: the next member of one of
   * these types has to arrive with a decision about its bound rather than with a docblock.
   */
  it('emits exactly these members, so a new one cannot arrive unexamined', async () => {
    const all = await answers();
    expect(Object.keys(all.issue).sort()).toEqual([
      'assigned_to',
      'count',
      'culprit',
      'first_seen',
      'last_seen',
      'level',
      'project',
      'ref',
      'status',
      'title',
      'user_count',
    ]);
    expect(Object.keys(all.issue.ref).sort()).toEqual(['id', 'provider', 'short_id', 'url']);
    expect(Object.keys(all.event ?? {}).sort()).toEqual([
      'breadcrumbs',
      'correlation_ids',
      'environment',
      'event_id',
      'issue_id',
      'message',
      'release',
      'stack_trace',
      'tags',
      'timestamp',
    ]);
    // Every crumb, not `[0]`: on this path `[0]` is the synthetic marker, whose members come from
    // a literal in `mapBreadcrumbs` rather than from Sentry.
    expect(keysOfEvery(all.event?.breadcrumbs ?? [])).toEqual([
      'category',
      'level',
      'message',
      'timestamp',
    ]);
    expect(
      all.event?.breadcrumbs[0]?.category,
      'the marker crumb is at [0], which is why the inventory reads every crumb',
    ).toBe('agentic.truncation');
    expect(all.event?.breadcrumbs[1]?.category, 'and [1] is the provider crumb').toContain(
      'cap: max_field_bytes=',
    );
    expect(Object.keys(all.probe).sort()).toEqual([
      'checked_at',
      'detail',
      'ok',
      'token_expires_at',
    ]);
    expect(keysOfEvery(all.unmapped_reports)).toEqual(['field', 'usedInstead', 'value']);
  });

  /**
   * Where each bound comes from, asserted at the field: the marker names the cap that fired, so
   * this fails both when a cap disappears and when the hostile document stops reaching a field.
   */
  it.each([
    ['$.issue.title', 'max_message_bytes'],
    ['$.issue.culprit', 'max_message_bytes'],
    ['$.issue.assigned_to', 'max_field_bytes'],
    ['$.event.stack_trace', 'max_stack_trace_bytes'],
    ['$.event.message', 'max_message_bytes'],
    ['$.event.breadcrumbs[1].message', 'max_breadcrumb_bytes'],
    // The two fields WP-11a was carved out for: raw for three review rounds.
    ['$.event.breadcrumbs[1].category', 'max_field_bytes'],
    ['$.event.breadcrumbs[1].level', 'max_field_bytes'],
    ['$.event.release', 'max_field_bytes'],
    ['$.event.environment', 'max_field_bytes'],
    ['$.event.correlation_ids.trace_id', 'max_field_bytes'],
    ['$.event.correlation_ids.span_id', 'max_field_bytes'],
    ['$.event.correlation_ids.request_id', 'max_field_bytes'],
  ])('%s is cut by %s and says so', async (path, capName) => {
    const entry = at(walkStrings(await answers()), path);
    expect(entry.text, `${path} carries no truncation marker`).toContain(`cap: ${capName}=`);
    expect(entry.bytes).toBeLessThanOrEqual(LARGEST_SENTRY_CAP);
  });

  it('caps a tag name and a tag value, and marks the tags it dropped', async () => {
    const event = (await answers()).event;
    const entries = Object.entries(event?.tags ?? {});
    const [firstName, firstValue] = entries[0] as [string, string];
    expect(firstName).toContain('cap: max_field_bytes=128');
    expect(firstValue).toContain('cap: max_field_bytes=128');
    expect(entries).toHaveLength(SENTRY_CAPS.max_tags + 1);
    expect(event?.tags['agentic.truncation']).toContain('cap: max_tags=5');
    expect(
      Object.hasOwn(event?.tags ?? {}, 'toString'),
      'a tag named after an Object.prototype member survives (standing rule 38)',
    ).toBe(true);
  });

  it('bounds the value it reports for a vendor enum it does not know', async () => {
    await answers();
    const level = unmapped.find((report) => report.field === 'issue.level');
    // Not a named cap: `describeValue` keeps 64 UTF-16 code units, which is at most 256 UTF-8
    // bytes. Stated here because "bounded" and "bounded by a cap in config.ts" are not the same
    // claim, and this value goes to a log.
    expect(level?.value).toHaveLength(64);
    expect(bytesOf(level?.value ?? '')).toBeLessThanOrEqual(256);
  });

  /**
   * `HealthProbe.detail` on the failure branch renders the binding's own `organization`, which
   * `slugSchema` constrains in shape and not in length — found by enumerating the members of
   * `HealthProbe` rather than the call sites that cap things.
   */
  it('bounds the probe detail even when the binding’s own organization is enormous', async () => {
    const probe = await sentryPort({
      organization: `acme-${'x'.repeat(200_000)}`,
      status: 500,
    }).testConnection();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('cap: max_message_bytes=320');
    expect(bytesOf(probe.detail ?? '')).toBeLessThanOrEqual(SENTRY_CAPS.max_message_bytes);
  });

  /**
   * And the cap runs **after** redaction, because redaction is the one transformation here that
   * makes text longer: every `answered` becomes a 39-byte placeholder.
   */
  it('bounds the probe detail after redaction has expanded it', async () => {
    // 129 bytes unredacted — comfortably inside the 320-byte cap — and 441 after every `answered`
    // becomes a 32-byte placeholder. A cap applied before redaction would emit all 441 of them,
    // with no marker; this is the positive assertion that the order is the other way round.
    const organization = 'answered'.repeat(12);
    const unredacted = `GET /organizations/${organization}/ answered 500`;
    expect(bytesOf(unredacted)).toBeLessThan(SENTRY_CAPS.max_message_bytes);
    const probe = await sentryPort({
      organization,
      status: 500,
      redactor: expandingRedactor(),
    }).testConnection();
    expect(probe.detail).toContain('[REDACTED:integration:expanding]');
    expect(probe.detail).toContain('cap: max_message_bytes=320');
    expect(bytesOf(probe.detail ?? '')).toBeLessThanOrEqual(SENTRY_CAPS.max_message_bytes);
  });
});

/**
 * **The half the walk is blind to: a bound that is a refusal** (WP-11a review round 1).
 *
 * The walk above measures emitted strings, so it can only see a field it dares feed a hostile
 * value to. Six members are not like that — `issue.id`, `issue.shortId`, `issue.permalink`,
 * `issue.project.slug`, `event.eventID` and `event.groupID` are **identifiers**, and
 * `boundedIdentifier` answers `invalid_response` for an oversize one rather than emitting a
 * plausible-looking cut (`sentry/config.ts`: "a 1 kB issue id is not a long name"). So the hostile
 * document above feeds them *safe* values, the walk measures those safe values, and the file's own
 * claim — "every string member of every response schema is far longer than every cap" — was
 * broader than what it checked. Measured by the reviewer: deleting `identifier()` from
 * `ref.short_id`, `ref.url`, `project`, `event_id` or `issue_id` left **758 of 758** tests green.
 *
 * One document per identifier, then, each differing from the walk's document in exactly one
 * member, so the refusal can be attributed:
 *
 *  - **one byte past the cap**, which pins the refusal *at* `max_field_bytes` rather than at some
 *    larger number a 128 KiB value would also satisfy;
 *  - the **field name** asserted out of the message, so a test dies for its own identifier and
 *    only its own (standing rule 3: a mutation must fail by a named assertion);
 *  - and the same document **at exactly the cap** succeeding, which proves the document is
 *    otherwise well-formed — a refusal test that passes because the response was broken somewhere
 *    else is a test of nothing (standing rule 22's shape: assert the guard, not the wreckage).
 */
describe('Sentry: an identifier past max_field_bytes is refused, not cut', () => {
  const CAP = SENTRY_CAPS.max_field_bytes;
  /** `bytes` bytes of ASCII, keeping `prefix` so a URL stays a URL and a slug stays a slug. */
  const sized = (prefix: string, bytes: number): string =>
    prefix + 'i'.repeat(bytes - prefix.length);

  const caught = async (call: () => Promise<unknown>): Promise<IntegrationError> => {
    try {
      await call();
    } catch (error) {
      if (error instanceof IntegrationError) {
        return error;
      }
      throw error;
    }
    throw new Error('the call was expected to refuse and returned instead');
  };

  const issuePort = (issue: Readonly<Record<string, unknown>>) => sentryPort({ issue });
  const eventPort = (event: Readonly<Record<string, unknown>>) => sentryPort({ event });

  const URL_PREFIX = 'https://sentry.example.test/organizations/acme-example/issues/x';

  it.each([
    [
      'issue.id',
      (size: number) =>
        issuePort({ ...SENTRY_ISSUE, id: sized('id', size) }).getIssue({ id: '4242' }),
    ],
    [
      'issue.shortId',
      (size: number) =>
        issuePort({ ...SENTRY_ISSUE, shortId: sized('ACME-', size) }).getIssue({ id: '4242' }),
    ],
    [
      'issue.permalink',
      (size: number) =>
        issuePort({ ...SENTRY_ISSUE, permalink: sized(URL_PREFIX, size) }).getIssue({ id: '4242' }),
    ],
    [
      'issue.project.slug',
      (size: number) =>
        issuePort({
          ...SENTRY_ISSUE,
          project: { ...SENTRY_ISSUE.project, slug: sized('api-', size) },
        }).getIssue({ id: '4242' }),
    ],
    [
      'event.eventID',
      (size: number) =>
        eventPort({ ...SENTRY_EVENT, eventID: sized('ev-', size) }).getLatestEvent({ id: '4242' }),
    ],
    [
      'event.groupID',
      (size: number) =>
        eventPort({ ...SENTRY_EVENT, groupID: sized('42', size) }).getLatestEvent({ id: '4242' }),
    ],
  ])('refuses a %s one byte past the cap, and accepts one exactly at it', async (field, call) => {
    const error = await caught(() => call(CAP + 1));
    expect(error.code, `${field} past the cap must be invalid_response`).toBe('invalid_response');
    expect(error.message).toBe(
      `sentry: ${field} is ${CAP + 1} bytes, past the ${CAP}-byte max_field_bytes cap`,
    );
    // The positive half: the very same document with the very same field at the cap goes through,
    // so the refusal above is this field's bound and not a broken response.
    const answer = await call(CAP);
    const strings = walkStrings(answer);
    expect(strings.filter((entry) => entry.bytes === CAP).length).toBeGreaterThan(0);
    expect(strings.filter((entry) => entry.bytes > LARGEST_SENTRY_CAP)).toEqual([]);
  });

  /**
   * `searchIssues` maps issues through the same function, which is the reason the suite drives one
   * method per identifier rather than one method per document: a refusal that only `getIssue`
   * enforced would be a bound one call site has.
   */
  it('refuses the same identifier through searchIssues', async () => {
    const error = await caught(() =>
      sentryPort({ issue: { ...SENTRY_ISSUE, shortId: sized('ACME-', CAP + 1) } }).searchIssues({
        project: 'api',
        query: '',
      }),
    );
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('issue.shortId is');
  });
});

// ── Loki ─────────────────────────────────────────────────────────────────────

const LOKI_CAPS = {
  max_lines: 4,
  max_line_bytes: 256,
  max_total_bytes: 4096,
  max_label_bytes: 128,
  max_labels: 3,
  max_label_values: 3,
  max_series: 2,
} as const;
const LARGEST_LOKI_CAP = LOKI_CAPS.max_total_bytes;

const hostileStream = () => ({
  // A computed key really does create an own property, unlike the `__proto__:` literal form, so
  // this reaches `JSON.stringify` and arrives at the adapter as an own key.
  stream: { ['__proto__']: 'v', [HOSTILE]: HOSTILE, app: HOSTILE, pod: HOSTILE, extra: HOSTILE },
  values: [
    ['1780304400000000000', HOSTILE],
    ['1780304401000000000', HOSTILE],
    ['1780304402000000000', HOSTILE],
  ],
});

const lokiPort = (
  options: {
    readonly redactor?: SecretRedactor;
    readonly failing?: boolean;
    readonly caps?: Partial<Record<keyof typeof LOKI_CAPS, number>>;
  } = {},
) =>
  createLokiRegistration({
    clock: fixedClock(NOW),
    fetch: (url: string) => {
      if (options.failing === true) {
        return Promise.resolve(json({ message: HOSTILE }, 500));
      }
      if (url.includes('/query_range')) {
        return Promise.resolve(
          json({
            status: 'success',
            data: { resultType: 'streams', result: [hostileStream(), hostileStream()] },
            warnings: [HOSTILE],
          }),
        );
      }
      if (url.includes('/series')) {
        return Promise.resolve(
          json({
            status: 'success',
            data: [
              { [HOSTILE]: HOSTILE, app: HOSTILE },
              { [HOSTILE]: HOSTILE, app: HOSTILE },
              { [HOSTILE]: HOSTILE, app: HOSTILE },
            ],
          }),
        );
      }
      return Promise.resolve(
        json({ status: 'success', data: [HOSTILE, HOSTILE, HOSTILE, HOSTILE] }),
      );
    },
  }).create({
    integrationId: '00000000-0000-4000-8000-0000000000a7',
    config: { base_url: 'https://loki.example.test:3100', ...LOKI_CAPS, ...options.caps },
    secrets: { bearer_token: 'FAKE-loki-bearer-token-DO-NOT-USE' },
    redactor: options.redactor ?? noSecretsRedactor(),
  });

describe('Loki: every emitted field is bounded by a named cap (standing rule 37)', () => {
  const port = lokiPort();

  const answers = async () => ({
    capabilities: port.capabilities(),
    agent_tooling: port.agentTooling(),
    probe: await port.testConnection(),
    query: await port.queryRange({
      selector: '{app="api"}',
      from: '2026-06-01T09:00:00.000Z',
      to: '2026-06-01T10:00:00.000Z',
      limit: 4,
    }),
    label_names: await port.labels(),
    label_values: await port.labels('app'),
    series: await port.series('{app="api"}', '2026-06-01T09:00:00.000Z'),
  });

  it('emits no string longer than the largest cap, anywhere in any answer', async () => {
    const strings = walkStrings(await answers());
    const over = strings.filter((entry) => entry.bytes > LARGEST_LOKI_CAP);
    expect(
      over.map((entry) => `${entry.path} = ${entry.bytes} bytes`),
      'a member of an emitted type with no cap behind it',
    ).toEqual([]);
    expect(strings.length, 'the walk reached the answers at all').toBeGreaterThan(30);
  });

  it('emits exactly these members, so a new one cannot arrive unexamined', async () => {
    const all = await answers();
    expect(Object.keys(all.query).sort()).toEqual(['line_count', 'streams', 'truncated']);
    // Every stream and every line, because the `max_total_bytes` marker is a stream of its own at
    // the **end** — the same defect as sampling Sentry's marker crumb at the front.
    expect(keysOfEvery(all.query.streams)).toEqual(['labels', 'lines']);
    expect(keysOfEvery(all.query.streams.flatMap((stream) => stream.lines))).toEqual([
      'labels',
      'line',
      'timestamp',
    ]);
    // The marker `max_total_bytes` appends is a **stream of its own**, at the end of the list, and
    // the document above does not reach that budget — so it is driven here rather than assumed:
    // an inventory that samples `streams[0]` never sees that literal.
    const budgeted = await lokiPort({ caps: { max_total_bytes: 600 } }).queryRange({
      selector: '{app="api"}',
      from: '2026-06-01T09:00:00.000Z',
      to: '2026-06-01T10:00:00.000Z',
      limit: 4,
    });
    expect(budgeted.streams.at(-1)?.labels['agentic.truncation']).toBe('max_total_bytes');
    expect(keysOfEvery(budgeted.streams)).toEqual(['labels', 'lines']);
    expect(keysOfEvery(budgeted.streams.flatMap((stream) => stream.lines))).toEqual([
      'labels',
      'line',
      'timestamp',
    ]);
    expect(
      walkStrings(budgeted).filter((entry) => entry.bytes > LARGEST_LOKI_CAP),
      'the marker stream is walked for bounds too',
    ).toEqual([]);
    expect(Object.keys(all.label_values).sort()).toEqual(['name', 'values']);
    expect(Object.keys(all.probe).sort()).toEqual([
      'checked_at',
      'detail',
      'ok',
      'token_expires_at',
    ]);
  });

  /**
   * Where each bound comes from, asserted at the field — including the label **name**, which is
   * the one provider-controlled object key in the platform and needs its own cap for it.
   */
  it('cuts the line, the label name and the label value, and names the cap on each', async () => {
    const all = await answers();
    const line = all.query.streams[0]?.lines[0];
    expect(line?.line).toContain('cap: max_line_bytes=256');
    const [name, value] = Object.entries(line?.labels ?? {})[0] as [string, string];
    expect(name, 'a label name is provider text too (divergence 9)').toContain(
      'cap: max_label_bytes=128',
    );
    expect(value).toContain('cap: max_label_bytes=128');
    expect(all.label_values.values[0]).toContain('cap: max_label_bytes=128');
    expect(Object.values(all.series[0] ?? {})[0]).toContain('cap: max_label_bytes=128');
  });

  it('says it truncated, so a short answer cannot read like a complete one', async () => {
    const all = await answers();
    expect(all.query.truncated).toBe(true);
    expect(all.query.streams.at(-1)?.labels['agentic.truncation']).toBeDefined();
    expect(all.label_values.values.at(-1)).toContain('cap: max_label_values=3');
    expect(all.series.at(-1)?.['agentic.truncation']).toContain('more series omitted');
  });

  /**
   * `LabelValues.name` is the caller's argument echoed back — the one emitted member here whose
   * text does not come from Loki. It is refused past `max_label_bytes` rather than cut, because it
   * names the label being listed and is spliced into the request path.
   *
   * Asserted **from both sides**, like the six Sentry identifiers above (standing rule 42). Review
   * round 2 measured the cost of not doing so: this case sent 200 bytes against a 128-byte cap and
   * accepted `'app'` — three bytes — so widening the guard to `max_label_bytes + 64` left **3000 of
   * 3000 tests green across 149 files**, the shared-suite case (128 KiB) and the fake's own case
   * (`FAKE_MAX_LABEL_BYTES + 1`, which measures the *fake's* constant) included. A refusal tested
   * at a comfortable distance pins nothing; one byte past the cap and exactly at it pins it.
   */
  it('refuses a label name one byte past max_label_bytes, and accepts one exactly at it', async () => {
    const cap = LOKI_CAPS.max_label_bytes;
    let caught: unknown;
    try {
      await port.labels('L'.repeat(cap + 1));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code, 'one byte past the cap must refuse').toBe(
      'invalid_request',
    );
    // The size and the cap's name, so a widened guard cannot die by some other assertion.
    expect((caught as { message?: string })?.message).toBe(
      `loki: label name of ${cap + 1} bytes exceeds the ${cap}-byte max_label_bytes cap`,
    );
    // The other half: the same name one byte shorter — exactly at the cap — is answered and echoed
    // back unchanged, so the refusal above is this cap and not a method that refuses everything.
    const atCap = 'L'.repeat(cap);
    expect((await port.labels(atCap)).name, 'a name exactly at the cap is still answered').toBe(
      atCap,
    );
  });

  /**
   * Loki's probe messages are platform text — a method, a constant path and a status — so the
   * *provider* cannot drive this cap. The **redactor** can, and that is the property worth
   * asserting: a placeholder carries the secret's *name*, so redaction expands a string by an
   * unbounded factor and a bound taken before it is not a bound on what is emitted.
   * `GET /labels answered 500` is 24 bytes, and 316 once its one `answered` becomes a placeholder.
   */
  it('bounds the probe detail after redaction has expanded it', async () => {
    const message = 'GET /labels answered 500';
    expect(bytesOf(message), 'unredacted, it is well inside the cap').toBeLessThan(
      LOKI_CAPS.max_line_bytes,
    );
    const named = exactSecretRedactor([{ name: 'e'.repeat(300), value: 'answered' }]);
    expect(bytesOf(named.redactText(message).value)).toBeGreaterThan(LOKI_CAPS.max_line_bytes);
    const probe = await lokiPort({ redactor: named, failing: true }).testConnection();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('cap: max_line_bytes=256');
    expect(bytesOf(probe.detail ?? '')).toBeLessThanOrEqual(LOKI_CAPS.max_line_bytes);
  });

  /**
   * The label name JavaScript treats differently, asserted at the boundary rather than argued
   * about in a docblock: `redactJson` rebuilds the document with `value[key] = …` and
   * `logQueryResultSchema` parses labels with `z.record`, and both drop `__proto__`. Closing it
   * inside `capLabelSet` would change nothing a caller sees.
   */
  it('drops a label literally named __proto__, two rings before capLabelSet', async () => {
    const result = await lokiPort().queryRange({
      selector: '{app="api"}',
      from: '2026-06-01T09:00:00.000Z',
      to: '2026-06-01T10:00:00.000Z',
      limit: 4,
    });
    const labels = result.streams[0]?.labels ?? {};
    expect(Object.hasOwn(labels, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(labels), 'a string assignment is a no-op, not pollution').toBe(
      Object.prototype,
    );
  });
});
