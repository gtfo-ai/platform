/**
 * `FakeObservabilityLogs` — the in-memory log store behind the ObservabilityLogs contract suite
 * and the bug template's log excerpt (technical/06, product/08).
 *
 * The port's caps are the interesting part. product/08 configures a maximum time window and a line
 * limit per binding, and an agent asking "is this error still happening?" must not be handed a
 * silently truncated answer — so the fake enforces both caps as `invalid_request` and reports
 * `truncated` when the limit bit.
 *
 * ## Known divergences from Loki
 *
 * The rule: **a fake may be stricter than the real adapter, never kinder.**
 *
 *  1. **Stricter — the selector grammar is `{label="value", …}` and nothing else.** Real LogQL
 *     has matchers (`=~`, `!=`), line filters, parsers and aggregations. A fake that accepted
 *     everything and matched nothing would turn a broken recipe into an empty result, which reads
 *     as "no errors".
 *  2. **Stricter — a range wider than `maxRangeMs`, a limit above `maxLines`, or `from >= to` is
 *     `invalid_request`.** Loki would clamp or answer with what it has. This holds for `series`
 *     too: its window runs from `since` to now, and the shared suite asserts the refusal for both
 *     the fake and the real adapter (standing rule 23 — an obligation the suite does not carry is
 *     a provider-local promise).
 *  3. **Stricter — every line returned is validated against `logLineSchema`.**
 *  4. **Kinder, deliberately — no quota, no tenant checks, no partial responses, and none of the
 *     adapter's volume caps.** Loki returns partial results with a warning when a query hits its
 *     own limits; here a query either succeeds or is refused. A 429 is reachable only by scripting
 *     one, which `test/contract/integrations/action-executor.contract.test.ts` ("logs —
 *     query_range") does, through `IntegrationActionExecutor`. The byte and count caps a real
 *     binding carries — `max_line_bytes`, `max_label_bytes`, `max_labels`, `max_label_values`,
 *     `max_series`, `max_total_bytes` — are **binding configuration**, so this fake has none of
 *     them and will happily return a 50 MB line or ten thousand series. They are asserted on the
 *     adapter in `test/contract/integrations/loki.contract.test.ts` ("log volume is a
 *     denial-of-service surface"), which is the only place they can be: a test that leans on this
 *     fake for "the answer is bounded" is leaning on nothing. **One exception, divergence 6:** the
 *     bound on a label *name* is not a cap on a provider's answer but a refusal of the caller's
 *     argument, and a fake that accepts what the adapter refuses is kinder in the dangerous
 *     direction.
 *  5. **Different — lines are stored in insertion order and returned in timestamp order**, with
 *     no de-duplication of identical timestamps, where Loki orders by (timestamp, stream).
 *  6. **Stricter — `labels(name)` refuses a name past `FAKE_MAX_LABEL_BYTES`** (WP-11a review
 *     round 1). This is the one volume cap divergence 4 does not get to wave away, and the reason
 *     is that it is not a cap on a *provider's* answer: `LabelValues.name` is the **caller's own
 *     argument echoed back**, so a port that accepts a 128 KiB name emits a 128 KiB string, and
 *     the argument reaches this port from an agent's tool call, which is untrusted too (BD-022).
 *     The Loki adapter refuses it past `max_label_bytes` for that reason; this fake accepted it,
 *     the shared suite never called it with one, and that is standing rule 1 in the dangerous
 *     direction — the fake being **kinder** than the adapter. The bound is a constant here where
 *     the adapter's is configuration, which is the stricter-or-equal direction as long as it stays
 *     at or below the port's own ceiling (Loki's `max_label_bytes` may be configured up to 65,536).
 *     The obligation now lives in `observability-contract-suites.ts`, so a future logs provider
 *     that echoes an unbounded name fails the shared suite rather than this file (standing rule 23).
 */
import {
  type AgentTooling,
  type HealthProbe,
  type IntegrationRef,
  IntegrationUnsupportedError,
  type LabelValues,
  type LogQueryResult,
  type LogRangeQuery,
  logLineSchema,
  type ObservabilityLogsCapabilities,
  type ObservabilityLogsPort,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { createFakeCore, type FakeCore, invalidRequest } from '../support/fake-support.js';

const PROVIDER = 'fake-logs';

/**
 * Divergence 6. Loki's own default for `max_label_bytes`, fixed rather than configurable: a fake
 * with a knob for every cap is a second implementation of the adapter, and what the suite needs is
 * that the refusal *exists*.
 */
export const FAKE_MAX_LABEL_BYTES = 1024;

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

export interface FakeLogStreamSeed {
  readonly labels: Readonly<Record<string, string>>;
  readonly lines: readonly { timestamp: string; line: string }[];
}

export interface FakeLogsOptions {
  readonly integrationId: Id;
  readonly streams?: readonly FakeLogStreamSeed[];
  readonly capabilities?: Partial<ObservabilityLogsCapabilities>;
}

interface StoredStream {
  labels: Record<string, string>;
  lines: { timestamp: string; line: string }[];
}

export interface FakeObservabilityLogs extends ObservabilityLogsPort {
  readonly core: FakeCore;
  seedStream(seed: FakeLogStreamSeed): void;
  appendLine(labels: Readonly<Record<string, string>>, timestamp: string, line: string): void;
}

/** `{app="api", env="prod"}` — divergence 1. */
const parseSelector = (selector: string): Record<string, string> => {
  const trimmed = selector.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw invalidRequest(PROVIDER, 'query_range', `selector ${selector} is not {label="value", …}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) {
    throw invalidRequest(PROVIDER, 'query_range', 'selector must constrain at least one label');
  }
  const matchers: Record<string, string> = {};
  for (const part of inner.split(',')) {
    const match = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/.exec(part);
    if (match === null) {
      throw invalidRequest(PROVIDER, 'query_range', `matcher ${part.trim()} is not label="value"`);
    }
    matchers[match[1] as string] = match[2] as string;
  }
  return matchers;
};

export const createFakeObservabilityLogs = (options: FakeLogsOptions): FakeObservabilityLogs => {
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: PROVIDER,
    type: 'logs',
  };
  const core = createFakeCore({ ref });
  const capabilities: ObservabilityLogsCapabilities = {
    labels: true,
    series: true,
    maxRangeMs: 24 * 60 * 60 * 1000,
    maxLines: 1000,
    ...options.capabilities,
  };

  const streams: StoredStream[] = [];

  const seedStream = (seed: FakeLogStreamSeed): void => {
    streams.push({
      labels: { ...seed.labels },
      lines: seed.lines.map((line) => ({ ...line })),
    });
  };
  for (const seed of options.streams ?? []) {
    seedStream(seed);
  }

  const streamMatches = (
    stream: StoredStream,
    matchers: Readonly<Record<string, string>>,
  ): boolean => Object.entries(matchers).every(([name, value]) => stream.labels[name] === value);

  return {
    core,
    ref,
    capabilities: () => ({ ...capabilities }),
    testConnection: async (): Promise<HealthProbe> => {
      core.enter('test_connection');
      return {
        ok: true,
        checked_at: core.clock.now(),
        detail: `${streams.length} streams seeded`,
        token_expires_at: null,
      };
    },

    queryRange: async (query: LogRangeQuery): Promise<LogQueryResult> => {
      core.enter('query_range');
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        throw invalidRequest(PROVIDER, 'query_range', 'from and to must be ISO-8601 instants');
      }
      if (from >= to) {
        throw invalidRequest(PROVIDER, 'query_range', 'from must be before to');
      }
      if (to - from > capabilities.maxRangeMs) {
        throw invalidRequest(
          PROVIDER,
          'query_range',
          `range of ${to - from} ms exceeds the ${capabilities.maxRangeMs} ms cap`,
        );
      }
      if (!Number.isInteger(query.limit) || query.limit < 1) {
        throw invalidRequest(PROVIDER, 'query_range', 'limit must be a positive integer');
      }
      if (query.limit > capabilities.maxLines) {
        throw invalidRequest(
          PROVIDER,
          'query_range',
          `limit ${query.limit} exceeds the ${capabilities.maxLines} line cap`,
        );
      }

      const matchers = parseSelector(query.selector);
      const filter = query.filter ?? null;
      const direction = query.direction ?? 'backward';
      const selected = streams.filter((stream) => streamMatches(stream, matchers));

      const flat = selected.flatMap((stream) =>
        stream.lines
          .filter((line) => {
            const at = Date.parse(line.timestamp);
            return at >= from && at < to && (filter === null || line.line.includes(filter));
          })
          .map((line) =>
            logLineSchema.parse({
              timestamp: line.timestamp,
              line: line.line,
              labels: { ...stream.labels },
            }),
          ),
      );
      flat.sort((left, right) =>
        direction === 'forward'
          ? Date.parse(left.timestamp) - Date.parse(right.timestamp)
          : Date.parse(right.timestamp) - Date.parse(left.timestamp),
      );

      const limited = flat.slice(0, query.limit);
      const byLabels = new Map<string, { labels: Record<string, string>; lines: typeof limited }>();
      for (const line of limited) {
        const key = JSON.stringify(line.labels);
        const bucket = byLabels.get(key) ?? { labels: line.labels, lines: [] };
        bucket.lines.push(line);
        byLabels.set(key, bucket);
      }

      return {
        streams: [...byLabels.values()].map((bucket) => ({
          labels: bucket.labels,
          lines: bucket.lines,
        })),
        line_count: limited.length,
        truncated: flat.length > limited.length,
      };
    },

    labels: async (name?: string): Promise<LabelValues> => {
      core.enter('labels');
      if (!capabilities.labels) {
        throw new IntegrationUnsupportedError(PROVIDER, 'label discovery');
      }
      // Divergence 6: refused, not echoed. `LabelValues.name` is an emitted string whose text is
      // the caller's argument, so this is the same rule `sentry/mapping.ts` applies to an
      // identifier — a name past the bound is a request this port should not be answering.
      if (name !== undefined && utf8Length(name) > FAKE_MAX_LABEL_BYTES) {
        throw invalidRequest(
          PROVIDER,
          'labels',
          `label name of ${utf8Length(name)} bytes exceeds the ${FAKE_MAX_LABEL_BYTES}-byte cap`,
        );
      }
      if (name === undefined) {
        const names = new Set<string>();
        for (const stream of streams) {
          for (const label of Object.keys(stream.labels)) {
            names.add(label);
          }
        }
        return { name: '__name__', values: [...names].sort() };
      }
      const values = new Set<string>();
      for (const stream of streams) {
        const value = stream.labels[name];
        if (value !== undefined) {
          values.add(value);
        }
      }
      return { name, values: [...values].sort() };
    },

    series: async (selector, since) => {
      core.enter('series');
      if (!capabilities.series) {
        throw new IntegrationUnsupportedError(PROVIDER, 'series discovery');
      }
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) {
        throw invalidRequest(PROVIDER, 'series', 'since must be an ISO-8601 instant');
      }
      // Divergence 2, second half (WP-11 review): `series` builds a window from `since` to now, so
      // it is bounded by the same `maxRangeMs` a range query is. Loki answered `start=0` — a
      // 56-year scan — for `since: 1970-01-01`, which is a cap the binding published and did not
      // have.
      const nowMs = Date.parse(core.clock.now());
      if (nowMs - sinceMs > capabilities.maxRangeMs) {
        throw invalidRequest(
          PROVIDER,
          'series',
          `range of ${nowMs - sinceMs} ms exceeds the ${capabilities.maxRangeMs} ms cap`,
        );
      }
      const matchers = parseSelector(selector);
      return streams
        .filter((stream) => streamMatches(stream, matchers))
        .filter((stream) => stream.lines.some((line) => Date.parse(line.timestamp) >= sinceMs))
        .map((stream) => ({ ...stream.labels }));
    },

    agentTooling: (): AgentTooling => ({
      cli: {
        command: 'logcli',
        version: null,
        env: {
          variables: [
            { name: 'LOKI_ADDR', secret: false, description: 'Base URL of the Loki instance' },
            {
              name: 'LOKI_BEARER_TOKEN',
              secret: true,
              description: 'Read-only token injected for the run only (BD-025)',
            },
          ],
        },
      },
      mcp: null,
      skill: { id: 'logql-recipes', path: 'skills/logs' },
      env: {
        variables: [
          { name: 'LOKI_ADDR', secret: false, description: 'Base URL of the Loki instance' },
          {
            name: 'LOKI_BEARER_TOKEN',
            secret: true,
            description: 'Read-only token injected for the run only (BD-025)',
          },
        ],
      },
    }),

    seedStream,
    appendLine: (labels, timestamp, line) => {
      const existing = streams.find(
        (stream) => JSON.stringify(stream.labels) === JSON.stringify(labels),
      );
      if (existing === undefined) {
        seedStream({ labels, lines: [{ timestamp, line }] });
        return;
      }
      existing.lines.push({ timestamp, line });
    },
  };
};
