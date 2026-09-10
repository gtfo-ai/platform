/**
 * Unit tests for the pure half of the Sentry adapter (technical/10 unit tier).
 *
 * Everything here is a function of its arguments — no clock, no I/O — so each case is a claim
 * about a rule rather than about a fixture. The contract runner proves the rules are wired up; this
 * file proves they are right, including at the edges a recorded document does not reach (an empty
 * stack, a multi-byte character exactly on a byte cap, a duplicate tag key).
 */
import type { Breadcrumb } from '@platform/application';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sentryConfigSchema } from './config.js';
import {
  capText,
  formatFrame,
  mapBreadcrumbs,
  mapCorrelationIds,
  mapIssueLevel,
  mapIssueStatus,
  mapTags,
  renderStackTrace,
  toIsoDateTime,
  truncateUtf8,
  type UnmappedValue,
} from './mapping.js';

const AT = '2026-06-01T09:11:00.000Z' as const;

/**
 * Standing rule 2: a property test must not inherit Vitest's 5 s default, because that makes the
 * verdict a hardware reading. Declared here rather than imported — `contracts` and `domain` each
 * keep their copy out of `index.ts` on purpose, and a shared home needs its own package
 * (`docs/technical/PROGRESS.md`).
 */
const PROPERTY_TEST_TIMEOUT_MS = 30_000;

describe('toIsoDateTime', () => {
  it.each([
    ['2018-11-06T21:19:55Z', '2018-11-06T21:19:55.000Z'],
    ['2020-06-17T22:26:56.098086Z', '2020-06-17T22:26:56.098Z'],
    ['2026-06-01T11:11:00+02:00', '2026-06-01T09:11:00.000Z'],
  ])('normalises %s to the platform wire format', (input, expected) => {
    expect(toIsoDateTime(input, AT)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['  '], ['not a date']])(
    'falls back for %s rather than producing an invalid instant',
    (input) => {
      expect(toIsoDateTime(input as string | null | undefined, AT)).toBe(AT);
    },
  );
});

describe('mapIssueLevel and mapIssueStatus (standing rule 20: a read fails open)', () => {
  it.each(['fatal', 'error', 'warning', 'info', 'debug'] as const)('passes %s through', (level) => {
    const reports: UnmappedValue[] = [];
    expect(mapIssueLevel(level, (value) => reports.push(value))).toBe(level);
    expect(reports, 'a known value is not a report').toEqual([]);
  });

  it('maps critical onto fatal, which is a known mapping rather than a fallback', () => {
    const reports: UnmappedValue[] = [];
    expect(mapIssueLevel('critical', (value) => reports.push(value))).toBe('fatal');
    expect(reports).toEqual([]);
  });

  it('falls back to error and reports for a level nobody documents', () => {
    const reports: UnmappedValue[] = [];
    expect(mapIssueLevel('catastrophic', (value) => reports.push(value))).toBe('error');
    expect(reports).toEqual([
      { field: 'issue.level', value: 'catastrophic', usedInstead: 'error' },
    ]);
  });

  it('maps muted onto ignored, Sentry’s legacy spelling', () => {
    const reports: UnmappedValue[] = [];
    expect(mapIssueStatus('muted', (value) => reports.push(value))).toBe('ignored');
    expect(reports).toEqual([]);
  });

  it('falls back to unresolved and reports, so an unknown word never hides a live bug', () => {
    const reports: UnmappedValue[] = [];
    expect(mapIssueStatus('archived_until_escalating', (value) => reports.push(value))).toBe(
      'unresolved',
    );
    expect(reports).toEqual([
      { field: 'issue.status', value: 'archived_until_escalating', usedInstead: 'unresolved' },
    ]);
  });

  it('truncates the reported value, because it is untrusted text on its way to a log', () => {
    const reports: UnmappedValue[] = [];
    mapIssueStatus('x'.repeat(500), (value) => reports.push(value));
    expect(reports[0]?.value).toHaveLength(64);
  });
});

describe('truncateUtf8 and capText', () => {
  it('leaves a string that fits alone, and says nothing was dropped', () => {
    expect(truncateUtf8('hello', 5)).toEqual({ text: 'hello', droppedBytes: 0 });
    expect(capText('hello', 5, 'max_x')).toBe('hello');
  });

  it('counts bytes, not UTF-16 code units', () => {
    // "é" is two UTF-8 bytes and one code unit; a slice(0, 2) would keep both characters.
    expect(truncateUtf8('éé', 2)).toEqual({ text: 'é', droppedBytes: 2 });
  });

  it('never splits a multi-byte character', () => {
    const { text, droppedBytes } = truncateUtf8('aé', 2);
    expect(text, 'the cut walks back off the continuation byte').toBe('a');
    expect(droppedBytes).toBe(2);
  });

  it('never splits an astral character either', () => {
    // A four-byte emoji: cutting at 3 must keep none of it.
    expect(truncateUtf8('🙂', 3).text).toBe('');
  });

  it('appends a marker naming the cap that fired, counted inside the cap', () => {
    expect(capText('abcdef'.repeat(20), 64, 'max_message_bytes')).toBe(
      'abcdef\n… truncated: 114 more bytes (cap: max_message_bytes=64)',
    );
  });

  /**
   * The two properties review round 2 asked for, over generated inputs rather than one example.
   *
   * The bound is the interesting one: round 1 appended the marker *outside* `maxBytes`, so the cap
   * was a bound on the provider's text and not on the string. Idempotence then follows from the
   * bound — a second pass sees something that already fits — which is why it is asserted as a
   * consequence and not as a suffix check. A suffix check would be defeatable by a provider that
   * ends its own text with a forged marker (BD-022); a length cannot be forged.
   */
  it(
    'never emits more than maxBytes, and applying it twice changes nothing',
    () => {
      fc.assert(
        fc.property(
          fc.string({ unit: 'binary', maxLength: 300 }),
          fc.integer({ min: 1, max: 200 }),
          fc.constantFrom('max_field_bytes', 'max_message_bytes', 'max_stack_trace_bytes'),
          (text, maxBytes, capName) => {
            const once = capText(text, maxBytes, capName);
            expect(
              new TextEncoder().encode(once).length,
              'the marker is counted inside the cap',
            ).toBeLessThanOrEqual(maxBytes);
            expect(capText(once, maxBytes, capName), 'capping twice is capping once').toBe(once);
          },
        ),
        { numRuns: 500 },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('emits its marker, cut, when the cap is smaller than the marker itself', () => {
    // 3 bytes cannot hold "… truncated: 6 more bytes (cap: max_message_bytes=3)", so no provider
    // text is kept at all. The bound stays true, which is what keeps the cap idempotent here too.
    const capped = capText('abcdef', 3, 'max_message_bytes');
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(3);
    expect(capText(capped, 3, 'max_message_bytes')).toBe(capped);
  });
});

describe('renderStackTrace', () => {
  const frame = (name: string, line: number) => ({
    function: name,
    filename: `src/${name}.ts`,
    lineNo: line,
    colNo: 1,
  });

  it('renders the exception header and its frames', () => {
    const rendered = renderStackTrace(
      [{ type: 'TypeError', value: 'boom', stacktrace: { frames: [frame('a', 1)] } }],
      50,
    );
    expect(rendered.text).toBe('TypeError: boom\n    at a (src/a.ts:1:1)');
    expect(rendered).toMatchObject({ framesTotal: 1, framesKept: 1 });
  });

  it('keeps the innermost frames and says how many it dropped', () => {
    const frames = Array.from({ length: 5 }, (_, index) => frame(`f${index}`, index));
    const rendered = renderStackTrace([{ type: 'E', value: 'v', stacktrace: { frames } }], 2);
    expect(rendered.text.split('\n')).toEqual([
      '… 3 of 5 stack frames omitted (cap: max_stack_frames=2)',
      'E: v',
      '    at f3 (src/f3.ts:3:1)',
      '    at f4 (src/f4.ts:4:1)',
    ]);
    expect(rendered.framesKept).toBe(2);
  });

  it('falls back to rawStacktrace when the symbolicated one is absent', () => {
    const rendered = renderStackTrace(
      [{ type: 'E', value: 'v', stacktrace: null, rawStacktrace: { frames: [frame('r', 9)] } }],
      50,
    );
    expect(rendered.text).toContain('at r (src/r.ts:9:1)');
  });

  it('renders an event with no exception entry as an empty string, not as invented text', () => {
    expect(renderStackTrace([], 50)).toEqual({ text: '', framesTotal: 0, framesKept: 0 });
  });

  it('spends one frame budget across chained exceptions', () => {
    const rendered = renderStackTrace(
      [
        { type: 'Outer', value: 'o', stacktrace: { frames: [frame('a', 1)] } },
        { type: 'Inner', value: 'i', stacktrace: { frames: [frame('b', 2)] } },
      ],
      1,
    );
    expect(rendered.text.split('\n')).toEqual([
      '… 1 of 2 stack frames omitted (cap: max_stack_frames=1)',
      'Outer: o',
      'Inner: i',
      '    at b (src/b.ts:2:1)',
    ]);
  });
});

describe('formatFrame', () => {
  it.each([
    [{ function: 'f', filename: 'a.ts', lineNo: 1, colNo: 2 }, 'f (a.ts:1:2)'],
    [{ function: 'f', filename: 'a.ts', lineNo: 1 }, 'f (a.ts:1)'],
    [{ function: 'f', filename: 'a.ts' }, 'f (a.ts)'],
    [{ module: 'm', absPath: '/x/a.ts' }, 'm (/x/a.ts)'],
    [{}, '<anonymous> (<unknown>)'],
  ])('renders %j', (input, expected) => {
    expect(formatFrame(input)).toBe(expected);
  });
});

describe('mapBreadcrumbs', () => {
  const crumb = (message: string | null) => ({ timestamp: AT, category: 'c', message });
  const LIMITS = { maxBreadcrumbs: 10, maxBreadcrumbBytes: 100, maxFieldBytes: 64 } as const;

  it('renders a null message as an empty string, which the port allows', () => {
    expect(mapBreadcrumbs([crumb(null)], { ...LIMITS, fallbackTimestamp: AT })[0]?.message).toBe(
      '',
    );
  });

  it('keeps the newest crumbs and announces the gap as a crumb of its own', () => {
    const crumbs = mapBreadcrumbs([crumb('one'), crumb('two'), crumb('three')], {
      ...LIMITS,
      maxBreadcrumbs: 1,
      fallbackTimestamp: AT,
    });
    expect(crumbs.map((entry) => entry.message)).toEqual([
      '… 2 earlier breadcrumbs omitted (cap: max_breadcrumbs=1)',
      'three',
    ]);
    expect(crumbs[0]?.category).toBe('agentic.truncation');
  });

  it('caps one crumb by bytes', () => {
    expect(
      mapBreadcrumbs([crumb('abcdef'.repeat(40))], {
        ...LIMITS,
        maxBreadcrumbBytes: 128,
        fallbackTimestamp: AT,
      })[0]?.message,
    ).toContain('cap: max_breadcrumb_bytes=128');
  });

  /**
   * WP-11a's blocking finding, asserted per field rather than as a total, because the total is
   * what three review rounds looked at and the fields are what leaked. `category` and `level` are
   * `z.string().nullish()` on both sides of the mapping — untrusted provider text (BD-022) with no
   * length in the schema — and they sat in the same object literal as the `message` every round
   * capped.
   */
  it('caps a breadcrumb\u2019s category and level, not only its message', () => {
    const enormous = 'C'.repeat(2 * 1024 * 1024);
    const [mapped] = mapBreadcrumbs(
      [{ timestamp: AT, category: enormous, level: enormous, message: enormous }],
      { maxBreadcrumbs: 10, maxBreadcrumbBytes: 256, maxFieldBytes: 128, fallbackTimestamp: AT },
    );
    const bytes = (text: string | null | undefined): number =>
      new TextEncoder().encode(text ?? '').length;
    expect(mapped?.category).toContain('cap: max_field_bytes=128');
    expect(mapped?.level).toContain('cap: max_field_bytes=128');
    expect(bytes(mapped?.category), 'category is bounded by max_field_bytes').toBeLessThanOrEqual(
      128,
    );
    expect(bytes(mapped?.level), 'level is bounded by max_field_bytes').toBeLessThanOrEqual(128);
    expect(bytes(mapped?.message)).toBeLessThanOrEqual(256);
  });

  it('leaves an absent category or level null rather than inventing an empty string', () => {
    const [mapped] = mapBreadcrumbs([{ timestamp: AT, message: 'm' }], {
      ...LIMITS,
      fallbackTimestamp: AT,
    });
    expect(mapped).toEqual({ timestamp: AT, category: null, level: null, message: 'm' });
  });

  /**
   * The measurement that carved WP-11a out of WP-11 — **restated at the shipped defaults, and
   * produced by this test rather than quoted from a session** (WP-11a review round 1).
   *
   * The figure `config.ts`, `mapping.ts`, technical/06 and this file all carried — "200,106,401
   * bytes at the shipped defaults" — **does not reproduce**. It was taken at 50 breadcrumbs and a
   * 2048-byte message cut, which is `max_breadcrumbs` and `max_breadcrumb_bytes` *doubled*; the
   * shipped defaults are 25 and 1024. The defect was entirely real and 100 MB is still
   * catastrophic for a context pack and an `events.payload` row — but a number nobody can
   * reproduce is a claim, and a claim repeated in five places drifts from whatever it was once a
   * measurement of. So the number is asserted here and the citations point at this test.
   *
   * The defect is reproduced through the **shipped** function rather than a copy of the old one:
   * `maxFieldBytes: Number.MAX_SAFE_INTEGER` makes `capText` return its input unchanged, which is
   * exactly what the pre-fix `category: crumb.category ?? null` did. Checked against the real
   * pre-fix `mapBreadcrumbs` (commit `c150214^`) on this input: the two outputs are byte-identical,
   * so this cannot drift from the defect the way a hand-written copy of it would.
   */
  it('emitted 100,027,762 bytes of JSON at the shipped defaults, and emits 79,012 now', () => {
    const defaults = sentryConfigSchema.parse({ organization: 'acme-example' });
    const encoder = new TextEncoder();
    const enormous = 'X'.repeat(2_000_000);
    // Twice the default breadcrumb cap — 50 crumbs today — so the count cap fires as well.
    const hostile = Array.from({ length: defaults.max_breadcrumbs * 2 }, () => ({
      timestamp: '2026-06-01T09:11:00Z',
      category: enormous,
      level: enormous,
      message: enormous,
    }));
    const map = (maxFieldBytes: number): Breadcrumb[] =>
      mapBreadcrumbs(hostile, {
        maxBreadcrumbs: defaults.max_breadcrumbs,
        maxBreadcrumbBytes: defaults.max_breadcrumb_bytes,
        maxFieldBytes,
        fallbackTimestamp: AT,
      });
    const jsonBytes = (crumbs: readonly Breadcrumb[]): number =>
      encoder.encode(JSON.stringify(crumbs)).length;
    const fieldBytes = (crumbs: readonly Breadcrumb[]): number =>
      crumbs.reduce(
        (sum, entry) =>
          sum +
          encoder.encode(`${entry.category ?? ''}${entry.level ?? ''}${entry.message}`).length,
        0,
      );

    const withoutTheCap = map(Number.MAX_SAFE_INTEGER);
    expect(
      jsonBytes(withoutTheCap),
      'the figure config.ts and technical/06 quote, at max_breadcrumbs=25, max_breadcrumb_bytes=1024',
    ).toBe(100_027_762);
    expect(fieldBytes(withoutTheCap), 'the same trail without the JSON punctuation').toBe(
      100_025_682,
    );
    // Which branch produced it (standing rule 10): `message` was capped all along, at the *default*
    // 1024 rather than at the 2048 the old figure implies, and the two fields beside it were raw.
    expect(encoder.encode(withoutTheCap[1]?.message ?? '').length).toBe(
      defaults.max_breadcrumb_bytes,
    );
    expect(encoder.encode(withoutTheCap[1]?.category ?? '').length).toBe(2_000_000);
    expect(encoder.encode(withoutTheCap[1]?.level ?? '').length).toBe(2_000_000);

    const emitted = map(defaults.max_field_bytes);
    expect(emitted).toHaveLength(defaults.max_breadcrumbs + 1);
    // config.ts: `(max_breadcrumbs + 1) × (max_breadcrumb_bytes + 2 × max_field_bytes)`.
    const stated =
      (defaults.max_breadcrumbs + 1) *
      (defaults.max_breadcrumb_bytes + 2 * defaults.max_field_bytes);
    expect(
      fieldBytes(emitted),
      'the sum config.ts states is a bound, not a description',
    ).toBeLessThanOrEqual(stated);
    // Exact, because "less than the bound" would hold at 10 MB too, and this is the figure the fix
    // is worth: 1,266 times smaller, at the same defaults, on the same document.
    expect(jsonBytes(emitted)).toBe(79_012);
  });
});

describe('mapTags and mapCorrelationIds', () => {
  const LIMITS = { maxTags: 10, maxBytes: 64 } as const;

  it('turns the documented list of pairs into a record', () => {
    expect(mapTags([{ key: 'a', value: '1' }, { key: 'b' }], LIMITS)).toEqual({ a: '1', b: '' });
  });

  it('keeps the first value for a duplicate key, so ordering does not decide', () => {
    expect(
      mapTags(
        [
          { key: 'a', value: 'first' },
          { key: 'a', value: 'second' },
        ],
        LIMITS,
      ),
    ).toEqual({ a: 'first' });
  });

  /**
   * Standing rule 38, both halves, measured before they were fixed (WP-11a).
   *
   * The check used to be `tag.key in record`. `in` walks the prototype chain, so this exact list
   * came back as `{"app":"api"}`: five tags dropped, no marker, `truncated` untouched — silent
   * data loss on the names an application is most likely to set by accident and an attacker most
   * likely to set on purpose (BD-022).
   */
  it('keeps a tag named after an Object.prototype member (Object.hasOwn, not `in`)', () => {
    const tags = mapTags(
      [
        { key: 'toString', value: 't' },
        { key: 'constructor', value: 'c' },
        { key: 'valueOf', value: 'v' },
        { key: 'hasOwnProperty', value: 'h' },
        { key: 'app', value: 'api' },
      ],
      LIMITS,
    );
    expect(tags).toEqual({
      toString: 't',
      constructor: 'c',
      valueOf: 'v',
      hasOwnProperty: 'h',
      app: 'api',
    });
  });

  /**
   * The one name that is dropped, stated rather than implied — and *where* it is dropped, because
   * that is what decides who can fix it. `record['__proto__'] = v` runs `Object.prototype`'s
   * setter instead of creating an own property; `Object.defineProperty` would make this function
   * emit it and change nothing further out, because `errorEventSchema` parses `tags` with
   * `z.record` and zod 4.5.4 skips the key by design (`zod/v4/core/compile.cjs:1542`). Asserted so
   * that the day zod changes, this test fails and the docblock gets rewritten.
   */
  it('drops a tag literally named __proto__, which is JavaScript rather than this function', () => {
    const tags = mapTags(
      JSON.parse('[{"key":"__proto__","value":"v"},{"key":"app","value":"api"}]'),
      LIMITS,
    );
    expect(Object.keys(tags)).toEqual(['app']);
    expect(Object.getPrototypeOf(tags), 'a string assignment is a no-op, not pollution').toBe(
      Object.prototype,
    );
  });

  /**
   * The second half of rule 38: the check compared the **raw** key against **capped** keys, so two
   * names that differ before the cap and are identical after it both got written and the record
   * kept the *last* — measured as `{"A"\u00d7200 + "x": "first"}` then `…"y": "second"` at
   * `maxBytes: 128` answering with one entry whose value was `"second"`, contradicting the
   * docblock above and Loki's citation of it (`loki/provider.ts`, `capLabelSet`).
   */
  it('keeps the first value when two names collide only after the cap', () => {
    const prefix = 'A'.repeat(200);
    const tags = mapTags(
      [
        { key: `${prefix}x`, value: 'first' },
        { key: `${prefix}y`, value: 'second' },
      ],
      { maxTags: 10, maxBytes: 128 },
    );
    expect(Object.values(tags)).toEqual(['first']);
  });

  it('stops at the count cap and says so, rather than answering short and silently', () => {
    const tags = mapTags([{ key: 'a' }, { key: 'b' }, { key: 'c' }], { maxTags: 2, maxBytes: 64 });
    expect(Object.keys(tags)).toEqual(['a', 'b', 'agentic.truncation']);
    expect(tags['agentic.truncation']).toBe('… 1 more tags omitted (cap: max_tags=2)');
  });

  /**
   * The review's third blocker in Sentry's shape: `max_tags` bounded the *count* and nothing
   * bounded a *value*, so a 2 MB `server_name` reached the port intact inside a "capped" record.
   * The payload here is constructed oversize rather than nominal (rule 4).
   */
  it('caps a two-megabyte tag value and a two-megabyte tag name, with a marker on each', () => {
    const enormous = 'V'.repeat(2 * 1024 * 1024);
    const tags = mapTags([{ key: enormous, value: enormous }], { maxTags: 50, maxBytes: 128 });
    const [name, value] = Object.entries(tags)[0] as [string, string];
    expect(name.startsWith('V'.repeat(64))).toBe(true);
    expect(name).toContain('truncated: 2097085 more bytes (cap: max_field_bytes=128)');
    expect(value).toContain('truncated: 2097085 more bytes (cap: max_field_bytes=128)');
    expect(name.length + value.length).toBeLessThanOrEqual(256);
  });

  it('reads the trace context and only the correlation-shaped tags', () => {
    expect(
      mapCorrelationIds(
        { contexts: { trace: { trace_id: 't', span_id: 's' } } },
        { request_id: 'r', server_name: 'api-7', user_id: 'u' },
        64,
      ),
    ).toEqual({ trace_id: 't', span_id: 's', request_id: 'r' });
  });

  it('ignores a trace context that is not an object, rather than throwing on a read', () => {
    expect(mapCorrelationIds({ contexts: { trace: 'nonsense' } }, {}, 64)).toEqual({});
    expect(mapCorrelationIds({}, {}, 64)).toEqual({});
  });

  it('lets the trace context win over a tag of the same name', () => {
    expect(
      mapCorrelationIds(
        { contexts: { trace: { trace_id: 'from-context' } } },
        { trace_id: 'tag' },
        64,
      ),
    ).toEqual({ trace_id: 'from-context' });
  });

  it('caps a correlation id that arrived from the opaque trace context', () => {
    const ids = mapCorrelationIds(
      { contexts: { trace: { trace_id: 'T'.repeat(2 * 1024 * 1024) } } },
      {},
      128,
    );
    expect(ids.trace_id).toContain('truncated: 2097085 more bytes (cap: max_field_bytes=128)');
  });
});
