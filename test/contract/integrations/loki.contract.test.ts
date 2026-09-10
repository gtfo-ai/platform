/**
 * The ObservabilityLogs contract suite against the **real Loki adapter**, in replay
 * (WP-11 acceptance: "contract suites").
 *
 * Not one line of `observability-contract-suites.ts` changed for this runner, which is the BD-017
 * claim being tested as much as the adapter is: adding a provider is a module, a registration, a
 * setup guide and a runner.
 *
 * Every response comes from `test/fixtures/http/loki/*.json`, each interaction carrying the
 * documentation URL it was transcribed from and whether that shape is documented, composed or
 * inferred. The adapter's `fetch` is injected, so nothing here opens a socket, sleeps or reads a
 * wall clock.
 *
 * Below the suite are the assertions the shared suite cannot make because they belong to Loki: the
 * empty-credential refusal, the tenant header, the escaping of a caller's filter, the four volume
 * caps, and the redaction obligation `logLineSchema.line` writes down by name.
 */
import { IntegrationRateLimitedError } from '@platform/application';
import { LOKI_TRUNCATION_LABEL } from '@platform/integrations';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  closeFixtureAssertionWindow,
  loadReplayFixture,
  type ReplayInteraction,
  replayFixtureNames,
  unassertedFixtureServes,
  unusedFixtures,
} from '../support/integrations/http-replay.js';
import {
  LOKI_FAKE_TOKEN,
  LOKI_FIXTURES,
  LOKI_PLANTED_SECRET,
  LOKI_SELECTOR,
  LOKI_WINDOW,
  lokiPlantedRedactor,
  lokiReplayContext,
} from '../support/integrations/loki-harness.js';
import { runObservabilityLogsContract } from '../support/integrations/observability-contract-suites.js';

runObservabilityLogsContract({
  name: 'loki (replay against recorded fixtures)',
  create: async () => lokiReplayContext(),
});

/**
 * The corpus is held to the suite, not just the suite to the corpus (WP-09 review rounds 1 and 2,
 * standing rules 17 and 24).
 *
 * `unusedFixtures()` proves every recorded interaction was reached; `unassertedFixtureServes()`
 * proves an assertion followed each serve inside the same test. Neither is sufficient alone: the
 * first survives a test whose `expect`s were deleted, the second survives a fixture nobody loads.
 */
afterEach(() => {
  closeFixtureAssertionWindow();
});

afterAll(() => {
  expect(
    unusedFixtures(),
    'every recorded interaction must be exercised: write the test, or delete the fixture',
  ).toEqual([]);
  expect(
    unassertedFixtureServes(),
    'every fixture a test fetched must be followed by an assertion in that test: a call is not a check',
  ).toEqual([]);
});

/** The window every recorded `query_range` key was built for. */
const query = (overrides: Record<string, unknown> = {}) => ({
  selector: LOKI_SELECTOR,
  from: LOKI_WINDOW.from,
  to: LOKI_WINDOW.to,
  limit: 100,
  ...overrides,
});

/** A scripted answer for the main query — the test's own business, never counted as corpus. */
const scriptedRange = (
  values: readonly (readonly [string, string])[],
  extra: Partial<ReplayInteraction> = {},
): ReplayInteraction => ({
  method: 'GET',
  path: '/query_range?query={app="api", env="production"}&start=1780304400000000000&end=1780308000000000000&limit=100&direction=backward',
  status: 200,
  body: {
    status: 'success',
    data: {
      resultType: 'streams',
      result: [{ stream: { app: 'api', env: 'production' }, values }],
    },
  },
  source: {
    url: 'https://grafana.com/docs/loki/latest/reference/loki-http-api/',
    retrieved: '2026-09-10',
    evidence: 'composed',
    note: 'Scripted inside the test; not part of the recorded corpus.',
  },
  ...extra,
});

/** A scripted answer for the recorded `series` window — the test's own business, not corpus. */
const scriptedSeries = (data: readonly Record<string, string>[]): ReplayInteraction => ({
  method: 'GET',
  path: '/series?match[]={app="api", env="production"}&start=1780304400000000000&end=1780309800000000000',
  status: 200,
  body: { status: 'success', data },
  source: {
    url: 'https://grafana.com/docs/loki/latest/reference/loki-http-api/',
    retrieved: '2026-09-10',
    evidence: 'composed',
    note: 'Scripted inside the test; not part of the recorded corpus.',
  },
});

/**
 * Standing rule 17 applied to this corpus, which nothing else applies it to at the *file* level.
 *
 * The shared provenance suite walks the directory and checks the blocks; this one checks the two
 * things that are specific to *this* provider's evidence — that a citation is a page on Grafana's
 * documentation site rather than any allow-listed host, and that the label is one of the three
 * kinds this corpus claims to use.
 */
it('every recorded interaction names a Grafana page, a retrieval date and a kind', () => {
  const kinds = new Set(['documented-adapted', 'composed', 'inferred']);
  const complaints = replayFixtureNames(LOKI_FIXTURES).flatMap((name) =>
    loadReplayFixture(LOKI_FIXTURES, name).flatMap((interaction, index) => {
      const where = `${name}.json #${index} (${interaction.method} ${interaction.path.split('?')[0]})`;
      const source = interaction.source as Partial<ReplayInteraction['source']> | undefined;
      if (source === undefined) {
        return [`${where}: no source block`];
      }
      const problems: string[] = [];
      if (!/^https:\/\/grafana\.com\/docs\/loki\//.test(source.url ?? '')) {
        problems.push(`url ${String(source.url)} is not a page on the vendor's documentation`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(source.retrieved ?? '')) {
        problems.push(`retrieved ${String(source.retrieved)} is not a date`);
      }
      if (!kinds.has(source.evidence ?? '')) {
        problems.push(`evidence ${String(source.evidence)} is not one of ${[...kinds].join(', ')}`);
      }
      return problems.map((problem) => `${where}: ${problem}`);
    }),
  );
  expect(
    complaints,
    'a provenance label is a claim about the corpus, and an unasserted claim drifts (rule 17)',
  ).toEqual([]);
});

/**
 * The harness's own guard (standing rule 4: a positive assertion fails loudly on a broken harness).
 *
 * If the replay transport answered an unmatched request with an empty body instead of throwing,
 * every assertion in the suite above would still pass while asserting nothing about the adapter.
 */
it('loki replay refuses a request it has no fixture for', async () => {
  const { port } = lokiReplayContext();
  let caught: unknown;
  try {
    await port.queryRange(query({ limit: 37 }));
  } catch (error) {
    caught = error;
  }
  expect(caught, 'an unmatched request must fail, never answer').toBeInstanceOf(Error);
  expect(
    String((caught as Error).cause),
    'the replay transport names the key it could not serve',
  ).toContain('no fixture for GET /query_range');
});

describe('Loki in replay: the credential, the tenant and the query it writes', () => {
  /**
   * Standing rule 18, in the shape a product with a legitimate anonymous mode needs it. WP-08
   * shipped a verifier that authenticated with an empty key; here the equivalent would be an
   * anonymous query that comes back empty and reads as "no errors".
   */
  it.each([
    ['absent', null],
    ['empty', ''],
    ['whitespace', '   '],
  ])('refuses to query with a %s bearer token, and sends nothing', async (_name, token) => {
    const { port, replay } = lokiReplayContext({ token });
    let caught: unknown;
    try {
      await port.queryRange(query());
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('unauthorised');
    expect(
      replay.requests.map((request) => request.key),
      'the refusal happens before the transport, so an unauthenticated query is never sent',
    ).toEqual([]);
  });

  it('reports an unusable credential from the health probe instead of guessing', async () => {
    const { port, replay } = lokiReplayContext({ token: '' });
    const probe = await port.testConnection();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('no bearer token is configured');
    expect(replay.requests).toEqual([]);
  });

  it('sends the bearer token and the tenant header, and never puts either in the URL', async () => {
    const { port, replay } = lokiReplayContext();
    await port.queryRange(query());
    const sent = replay.requests[0];
    expect(sent?.headers.authorization).toBe('Bearer FAKE-loki-bearer-token-DO-NOT-USE');
    expect(sent?.headers['x-scope-orgid']).toBe('acme-example');
    expect(sent?.url).not.toContain('FAKE-loki-bearer-token');
  });

  it('sends no Authorization header when the operator chose auth_mode: none', async () => {
    const { port, replay } = lokiReplayContext({ authMode: 'none', tenantId: null });
    await port.queryRange(query());
    const sent = replay.requests[0];
    expect(Object.keys(sent?.headers ?? {})).not.toContain('authorization');
    expect(Object.keys(sent?.headers ?? {})).not.toContain('x-scope-orgid');
  });

  /**
   * BD-022 at the query language. A filter is untrusted text — it may come from a Sentry tag or
   * from an agent — and LogQL concatenated from untrusted text is injection with a query language
   * instead of a shell.
   */
  it('escapes a filter into a literal line filter rather than interpolating it', async () => {
    const { port } = lokiReplayContext({
      script: [
        scriptedRange([['1780305060000000000', 'nothing matched']], {
          path: '/query_range?query={app="api", env="production"} |= "x\\" | json | line_format \\"{{.password}}"&start=1780304400000000000&end=1780308000000000000&limit=100&direction=backward',
        }),
      ],
    });
    const result = await port.queryRange(
      query({ filter: 'x" | json | line_format "{{.password}}' }),
    );
    // The scripted key *is* the assertion: if the adapter had interpolated the filter rather than
    // escaping the quote, the request would have gone to a different key and the replay would have
    // thrown instead of answering.
    expect(result.line_count).toBe(1);
  });

  it('refuses a filter longer than the cap rather than sending a huge query', async () => {
    const { port, replay } = lokiReplayContext();
    let caught: unknown;
    try {
      await port.queryRange(query({ filter: 'x'.repeat(257) }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('invalid_request');
    expect(replay.requests).toEqual([]);
  });

  it('refuses a selector that is a metric query, because this port returns log lines', async () => {
    const { port, replay } = lokiReplayContext();
    let caught: unknown;
    try {
      await port.queryRange(query({ selector: 'count_over_time({app="api"}[5m])' }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('invalid_request');
    expect(replay.requests, 'and it never reached the wire').toEqual([]);
  });

  it('refuses a matrix result even when the selector parsed', async () => {
    const { port } = lokiReplayContext({
      script: [
        {
          ...scriptedRange([]),
          body: { status: 'success', data: { resultType: 'matrix', result: [] } },
        },
      ],
    });
    let caught: unknown;
    try {
      await port.queryRange(query());
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('invalid_request');
    expect((caught as Error).message).toContain('matrix');
  });

  it('refuses a body whose status is not success, rather than reading it as no lines', async () => {
    const { port } = lokiReplayContext({
      script: [
        {
          ...scriptedRange([]),
          body: { status: 'error', data: { resultType: 'streams', result: [] } },
        },
      ],
    });
    let caught: unknown;
    try {
      await port.queryRange(query());
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('invalid_response');
  });
});

describe('Loki in replay: log volume is a denial-of-service surface', () => {
  /**
   * A 50 MB line is one line. `max_line_bytes` is what stops it reaching a context pack, and the
   * assertion is positive (rule 12): the marker naming the cap must be *there*, not merely the
   * absence of a huge string.
   */
  it('truncates a single enormous line and says which cap did it', async () => {
    const enormous = 'A'.repeat(1_048_576);
    const { port } = lokiReplayContext({
      maxLineBytes: 256,
      script: [scriptedRange([['1780305060000000000', enormous]])],
    });
    const result = await port.queryRange(query());
    const line = result.streams[0]?.lines[0]?.line ?? '';
    expect(line).toContain('truncated: 1048379 more bytes (cap: max_line_bytes=256)');
    expect(line.startsWith('A'.repeat(197))).toBe(true);
    // The marker is counted inside the cap (review round 2), so the emitted line is at most 256
    // bytes rather than 256 plus however long the warning turned out to be.
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(256);
    expect(result.truncated, 'and the caller is told the answer is not complete').toBe(true);
  });

  it('stops at the total byte budget, counting the labels it copies onto every line', async () => {
    const values = Array.from(
      { length: 20 },
      (_, index) =>
        [`${1780305060000000000n + BigInt(index) * 1000000000n}`, 'B'.repeat(100)] as const,
    );
    const { port } = lokiReplayContext({
      maxTotalBytes: 350,
      script: [scriptedRange(values)],
    });
    const result = await port.queryRange(query());
    // 100 bytes of line + 19 bytes of `{app="api", env="production"}` label text = 119 per line,
    // so 350 bytes of budget holds two. Round 1 counted the line alone and answered three.
    expect(result.line_count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  /**
   * The review's third blocker, against a **constructed oversize** payload rather than a nominal
   * one (standing rule 4): a 2 MB label value across 20 lines produced a **42,002,998-byte**
   * `LogQueryResult` carrying `truncated: false` — a forty-two megabyte object reported as
   * complete, because `max_total_bytes` counted `line.line` and `provider.ts:416` copied the label
   * set onto every line.
   */
  it('is not defeated by a two-megabyte label value repeated on every line', async () => {
    const enormous = 'L'.repeat(2 * 1024 * 1024);
    const values = Array.from(
      { length: 20 },
      (_, index) =>
        [`${1780305060000000000n + BigInt(index) * 1000000000n}`, `line ${index}`] as const,
    );
    const { port } = lokiReplayContext({
      script: [
        {
          ...scriptedRange([]),
          body: {
            status: 'success',
            data: {
              resultType: 'streams',
              result: [{ stream: { app: 'api', trace: enormous }, values }],
            },
          },
        },
      ],
    });
    const result = await port.queryRange(query());
    const size = JSON.stringify(result).length;
    expect(size, 'round 1 answered 42,002,998 bytes here').toBeLessThan(200_000);
    expect(result.truncated, 'and it must say the answer is not complete').toBe(true);
    const label = result.streams[0]?.labels.trace ?? '';
    expect(label).toContain('truncated: 2096189 more bytes (cap: max_label_bytes=1024)');
  });

  it('caps the number of labels on a stream and marks the gap', async () => {
    const stream: Record<string, string> = { app: 'api' };
    for (let index = 0; index < 40; index += 1) {
      stream[`extra_${index}`] = `value-${index}`;
    }
    const { port } = lokiReplayContext({
      maxLabels: 3,
      script: [
        {
          ...scriptedRange([]),
          body: {
            status: 'success',
            data: {
              resultType: 'streams',
              result: [
                { stream, values: [['1780305060000000000', 'one line']] as [string, string][] },
              ],
            },
          },
        },
      ],
    });
    const result = await port.queryRange(query());
    const labels = result.streams[0]?.labels ?? {};
    expect(Object.keys(labels)).toEqual(['app', 'extra_0', 'extra_1', 'agentic.truncation']);
    expect(labels['agentic.truncation']).toBe('… 38 more labels omitted (cap: max_labels=3)');
    expect(result.truncated).toBe(true);
  });

  /**
   * technical/06: "Both truncate with a visible marker naming the cap that fired." The total cap
   * had none, so a caller saw a short answer with no reason for it inside the lines themselves.
   */
  it('leaves a marker line naming max_total_bytes when the budget stops it', async () => {
    const values = Array.from(
      { length: 6 },
      (_, index) =>
        [`${1780305060000000000n + BigInt(index) * 1000000000n}`, 'B'.repeat(100)] as const,
    );
    const { port } = lokiReplayContext({ maxTotalBytes: 300, script: [scriptedRange(values)] });
    const result = await port.queryRange(query());
    const last = result.streams[result.streams.length - 1];
    expect(last?.labels).toEqual({ 'agentic.truncation': 'max_total_bytes' });
    expect(last?.lines[0]?.line).toBe(
      '… 4 more lines omitted after 238 bytes (cap: max_total_bytes=300)',
    );
    expect(result.line_count, 'the marker is platform text and is not counted as a log line').toBe(
      2,
    );
  });

  it('bounds a labels() listing by value size and by count, and says which cap fired', async () => {
    const { port } = lokiReplayContext({
      maxLabelBytes: 128,
      maxLabelValues: 2,
      script: [
        {
          method: 'GET',
          path: '/label/app/values?start=1780288200000000000&end=1780309800000000000',
          status: 200,
          body: { status: 'success', data: ['A'.repeat(4096), 'b', 'c', 'd'] },
          source: {
            url: 'https://grafana.com/docs/loki/latest/reference/loki-http-api/',
            retrieved: '2026-09-10',
            evidence: 'composed',
            note: 'Scripted inside the test; not part of the recorded corpus.',
          },
        },
      ],
    });
    const values = await port.labels('app');
    expect(values.values[0]).toContain('truncated: 4025 more bytes (cap: max_label_bytes=128)');
    expect(values.values[2]).toBe('… 2 more values omitted (cap: max_label_values=2)');
  });

  /**
   * `series()` built a window from `since` to now and never consulted `maxRangeMs`, so
   * `since: 1970-01-01` sent `start=0` — a 56-year scan — through a binding whose published cap is
   * one day. A cap one method honours is a cap the binding does not have.
   */
  it('refuses a series window wider than the published range cap', async () => {
    const { port, replay } = lokiReplayContext();
    let caught: unknown;
    try {
      await port.series(LOKI_SELECTOR, '1970-01-01T00:00:00.000Z');
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('invalid_request');
    expect(String((caught as Error).message)).toContain('exceeds the 86400000 ms cap');
    expect(replay.requests, 'and it refuses before the request, not after it').toEqual([]);
  });

  /**
   * Divergence 4: the server's own limit is not trusted. The fake slices its own array and cannot
   * reach this state at all, which is exactly why the adapter has to.
   */
  it('cuts a response that carries more entries than the query asked for', async () => {
    const values = Array.from(
      { length: 5 },
      (_, index) =>
        [`${1780305060000000000n + BigInt(index) * 1000000000n}`, `line ${index}`] as const,
    );
    const { port } = lokiReplayContext({
      script: [
        { ...scriptedRange(values), path: scriptedRange([]).path.replace('limit=100', 'limit=2') },
      ],
    });
    const result = await port.queryRange(query({ limit: 2 }));
    expect(result.line_count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('reports a Loki 3 warning as truncation rather than as a complete answer', async () => {
    const { port } = lokiReplayContext({
      script: [
        {
          ...scriptedRange([['1780305060000000000', 'one line']]),
          body: {
            status: 'success',
            data: {
              resultType: 'streams',
              result: [
                {
                  stream: { app: 'api', env: 'production' },
                  values: [['1780305060000000000', 'one line']],
                },
              ],
            },
            warnings: ['maximum of series (500) reached for a single query'],
          },
        },
      ],
    });
    const result = await port.queryRange(query());
    expect(result.line_count).toBe(1);
    expect(result.truncated, 'a degraded answer is not a complete one').toBe(true);
  });

  /**
   * Review round 2, major 1 — and it is the same class as round 1's blocker 3, surviving in the
   * one method the caps did not reach.
   *
   * The exploit's shape, at its stated size (standing rule 4: a constructed oversize payload, not
   * a nominal one): **10 000 series of 5 kB of labels**, which the reviewer measured at
   * **11,068,891 bytes** with no marker and no cap of any kind, because `max_labels` and
   * `max_label_bytes` bound *one* label set and nothing bound the list. A cap on an item is not a
   * cap on a list.
   *
   * This payload spends its 5 kB on ten labels rather than on one, so with both `series` caps
   * removed it answers **51,708,901 bytes** — measured, not assumed, by running that mutation. The
   * bound below is the assertion; the two numbers are only there to say which is whose.
   */
  it('is not defeated by ten thousand series of five kilobytes of labels', async () => {
    const value = 'S'.repeat(500);
    const data = Array.from({ length: 10_000 }, (_, index) =>
      Object.fromEntries(
        Array.from({ length: 10 }, (_, label) => [`label_${label}`, `${value}${index}`]),
      ),
    );
    const { port } = lokiReplayContext({ script: [scriptedSeries(data)] });
    const series = await port.series(LOKI_SELECTOR, LOKI_WINDOW.from);
    const size = JSON.stringify(series).length;
    expect(size, 'uncapped, this payload answers 51,708,901 bytes').toBeLessThan(1_200_000);
    // `series` returns a bare array, so the marker *is* the truncation flag: a short list of
    // streams reads exactly like a complete one to an agent choosing which stream to query next.
    expect(series[series.length - 1]?.[LOKI_TRUNCATION_LABEL]).toContain(
      'more series omitted after',
    );
    expect(series[series.length - 1]?.[LOKI_TRUNCATION_LABEL]).toContain(
      'cap: max_total_bytes=1048576',
    );
  });

  it('caps the number of series and names max_series in the marker', async () => {
    const data = Array.from({ length: 5 }, (_, index) => ({ app: 'api', pod: `api-${index}` }));
    const { port } = lokiReplayContext({ maxSeries: 2, script: [scriptedSeries(data)] });
    const series = await port.series(LOKI_SELECTOR, LOKI_WINDOW.from);
    expect(series.slice(0, 2)).toEqual([
      { app: 'api', pod: 'api-0' },
      { app: 'api', pod: 'api-1' },
    ]);
    expect(series[2]).toEqual({
      [LOKI_TRUNCATION_LABEL]: '… 3 more series omitted (cap: max_series=2)',
    });
    expect(series).toHaveLength(3);
  });

  it('keeps the first series when the byte budget stops it, so an answer is never empty', async () => {
    const data = Array.from({ length: 4 }, (_, index) => ({ app: 'api', pod: `${index}` }));
    const { port } = lokiReplayContext({ maxTotalBytes: 1, script: [scriptedSeries(data)] });
    const series = await port.series(LOKI_SELECTOR, LOKI_WINDOW.from);
    expect(series[0], 'a budget smaller than one label set still answers with one').toEqual({
      app: 'api',
      pod: '0',
    });
    expect(series[1]?.[LOKI_TRUNCATION_LABEL]).toBe(
      '… 3 more series omitted after 10 bytes (cap: max_total_bytes=1)',
    );
  });

  it('maps a 429 to a retryable rate-limit error carrying the provider Retry-After', async () => {
    const context = lokiReplayContext();
    context.replay.activate('rate-limited');
    let caught: unknown;
    try {
      await context.port.queryRange(query());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationRateLimitedError);
    expect((caught as IntegrationRateLimitedError).retryAfterMs).toBe(2000);
    expect((caught as IntegrationRateLimitedError).retryable).toBe(true);
  });
});

describe('Loki in replay: TD-012 on every line that leaves the ring', () => {
  /**
   * The obligation `logLineSchema.line` names: "these lines are read to be *stored* … and TD-012
   * wants the redactor on every one of those writes … Whoever writes that path adds the
   * `SecretRedactor` and records its count."
   */
  it('redacts an injected secret out of a log line and records the count', async () => {
    const { port, redactions } = lokiReplayContext({
      redactor: lokiPlantedRedactor(),
      script: [
        scriptedRange([
          ['1780305060000000000', `GET /login authorization=${LOKI_PLANTED_SECRET} 200`],
        ]),
      ],
    });
    const result = await port.queryRange(query());
    const line = result.streams[0]?.lines[0]?.line ?? '';
    expect(line).toBe('GET /login authorization=[REDACTED:integration:loki] 200');
    expect(redactions).toEqual([{ action: 'query_range', count: 1 }]);
  });

  it('redacts a label value too, because a label set is stored with the line', async () => {
    const { port, redactions } = lokiReplayContext({
      redactor: lokiPlantedRedactor(),
      script: [
        {
          ...scriptedRange([]),
          body: {
            status: 'success',
            data: {
              resultType: 'streams',
              result: [
                {
                  stream: { app: 'api', token: LOKI_PLANTED_SECRET },
                  values: [['1780305060000000000', 'ordinary line']],
                },
              ],
            },
          },
        },
      ],
    });
    const result = await port.queryRange(query());
    expect(result.streams[0]?.labels.token).toBe('[REDACTED:integration:loki]');
    expect(redactions).toEqual([{ action: 'query_range', count: 1 }]);
  });

  /**
   * Standing rule 31, and the reason `ProviderCreateInput.redactor` is required.
   *
   * Round 1's proof of the defect was exactly this call — `create({config, secrets:{bearer_token}})`
   * plus one scripted response — and it returned
   * `line = "Authorization: Bearer FAKE-loki-bearer-token-DO-NOT-USE-1234"` verbatim, because the
   * registration passed no redactor and there was no field for one. The harness now builds the port
   * through `createLokiRegistration(...).create(...)`, which is what production does, and hands it
   * the **no-op** redactor on purpose: what removes the token here is the redactor the adapter
   * composes from its own resolved credentials, so a caller cannot disarm it by passing nothing.
   */
  it('removes the binding’s own bearer token even when the caller injects a no-op redactor', async () => {
    const { port, redactions } = lokiReplayContext({
      script: [
        scriptedRange([
          ['1780305060000000000', `GET /login Authorization: Bearer ${LOKI_FAKE_TOKEN} 200`],
        ]),
      ],
    });
    const result = await port.queryRange(query());
    const line = result.streams[0]?.lines[0]?.line ?? '';
    expect(line).toBe(
      'GET /login Authorization: Bearer [REDACTED:integration:loki_bearer_token] 200',
    );
    expect(line).not.toContain(LOKI_FAKE_TOKEN);
    expect(redactions).toEqual([{ action: 'query_range', count: 1 }]);
  });

  /**
   * The ordering the review found asserted **in prose only** on both providers (its M2/M4).
   *
   * The secret straddles the byte cap: `max_line_bytes` cuts three bytes into it. Redaction runs
   * first, at the transport, so the cap can only ever cut the placeholder; the mutation — cap
   * first, redact after — leaves `FAK` in the answer, which `exactSecretRedactor` can never remove
   * because it matches whole values, not prefixes.
   */
  it('redacts before it caps, so a secret straddling the boundary leaves no fragment', async () => {
    const prefix = 'GET /login token=';
    const { port } = lokiReplayContext({
      redactor: lokiPlantedRedactor(),
      // 74 bytes cuts two characters into the placeholder: since review round 2 the marker is paid
      // for out of the cap, so the budget for provider text is 74 minus the marker's own length.
      maxLineBytes: 74,
      script: [
        scriptedRange([
          ['1780305060000000000', `${prefix}${LOKI_PLANTED_SECRET} ${'t'.repeat(80)}`],
        ]),
      ],
    });
    const result = await port.queryRange(query());
    const line = result.streams[0]?.lines[0]?.line ?? '';
    expect(line.startsWith(`${prefix}[RE`), 'the cap cut the placeholder, not the secret').toBe(
      true,
    );
    expect(line).not.toContain(LOKI_PLANTED_SECRET.slice(0, 3));
    expect(line, 'and the cut is visible').toContain('cap: max_line_bytes=74');
  });

  /**
   * Divergence 9, and the reason it exists: `redactJson` walks string **values** and leaves object
   * keys alone by design (`redaction.ts` says so and justifies it). That justification is about
   * keys the *platform* writes — and a Loki stream is `{"<label name>": "<value>"}`, so a label
   * name is provider text in key position. `{"<secret>": "v"}` therefore survived the one pass in
   * `http.ts` verbatim, in `queryRange` and in `series` (review round 2). Sentry is immune because
   * its tags are `[{key, value}]`, where the key is a value.
   *
   * Closed in `capLabelSet` rather than by widening the shared helper: this is the only provider
   * whose keys come from the provider, and it is the only place this adapter emits one. The
   * assertion is positive (standing rule 12), on both methods.
   */
  it('redacts a label name, which the shared redactor walks straight past', async () => {
    const { port, redactions } = lokiReplayContext({
      redactor: lokiPlantedRedactor(),
      script: [
        {
          ...scriptedRange([]),
          body: {
            status: 'success',
            data: {
              resultType: 'streams',
              result: [
                {
                  stream: { app: 'api', [LOKI_PLANTED_SECRET]: 'ordinary value' },
                  values: [['1780305060000000000', 'ordinary line']],
                },
              ],
            },
          },
        },
      ],
    });
    const result = await port.queryRange(query());
    expect(Object.keys(result.streams[0]?.labels ?? {})).toEqual([
      'app',
      '[REDACTED:integration:loki]',
    ]);
    expect(JSON.stringify(result)).not.toContain(LOKI_PLANTED_SECRET);
    expect(redactions).toEqual([{ action: 'query_range', count: 1 }]);
  });

  it('redacts a label name in series as well, because it is the same emitter', async () => {
    const { port, redactions } = lokiReplayContext({
      redactor: lokiPlantedRedactor(),
      script: [scriptedSeries([{ app: 'api', [LOKI_PLANTED_SECRET]: 'ordinary value' }])],
    });
    const series = await port.series(LOKI_SELECTOR, LOKI_WINDOW.from);
    expect(Object.keys(series[0] ?? {})).toEqual(['app', '[REDACTED:integration:loki]']);
    expect(JSON.stringify(series)).not.toContain(LOKI_PLANTED_SECRET);
    expect(redactions).toEqual([{ action: 'series', count: 1 }]);
  });

  /**
   * The collision `redaction.ts` predicts as the reason keys are not rewritten — made explicit
   * here rather than left to whichever value happened to be serialised last (review round 2).
   *
   * Two names longer than `max_label_bytes` that share a prefix and a length cap to the same
   * string. The rule is `mapTags`' rule next door: **keep the first**, so which value survives
   * does not depend on the order Loki serialised the stream in, count the loss into
   * `droppedBytes` so the answer reports `truncated`, and say so in the label set's own marker.
   */
  it('keeps the first value when two over-cap label names collide, and says so', async () => {
    const stem = 'A'.repeat(200);
    const { port } = lokiReplayContext({
      maxLabelBytes: 128,
      script: [
        {
          ...scriptedRange([]),
          body: {
            status: 'success',
            data: {
              resultType: 'streams',
              result: [
                {
                  stream: { [`${stem}x`]: 'first', [`${stem}y`]: 'second' },
                  values: [['1780305060000000000', 'ordinary line']],
                },
              ],
            },
          },
        },
      ],
    });
    const result = await port.queryRange(query());
    const labels = result.streams[0]?.labels ?? {};
    const collided = Object.entries(labels).find(([name]) => name.startsWith('A'));
    expect(collided?.[1], 'the first value survives, not the last').toBe('first');
    expect(Object.keys(labels)).toHaveLength(2);
    expect(labels[LOKI_TRUNCATION_LABEL]).toBe(
      '… 1 label names collided after redaction or max_label_bytes; the first value of each was kept',
    );
    expect(result.truncated, 'a dropped label is not a complete answer').toBe(true);
  });

  it('redacts the health probe detail instead of rendering it', async () => {
    const { port } = lokiReplayContext({
      token: LOKI_PLANTED_SECRET,
      redactor: lokiPlantedRedactor(),
    });
    // An unusable-credential probe is the one that quotes configuration back; here the token is
    // usable, so the probe succeeds and the assertion is that its detail is clean.
    const probe = await port.testConnection();
    expect(probe.ok).toBe(true);
    expect(probe.detail).not.toContain(LOKI_PLANTED_SECRET);
  });
});
