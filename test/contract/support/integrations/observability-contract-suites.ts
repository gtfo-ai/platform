/**
 * The **ObservabilityErrors** and **ObservabilityLogs** contract suites (technical/10 contract
 * tier).
 *
 * They share a file because they share a purpose: both feed a bug task's Investigation context,
 * both are read-mostly, and both expose a CLI or an MCP server to the agent. WP-11 runs both
 * against Sentry and Loki with recorded fixtures.
 *
 * The tooling assertion (`expectAgentTooling`) is the security half: a provider declares the
 * *names* of the variables the runner will inject, never a value (BD-002, BD-025). The logs suite
 * adds the caps from product/08 — a query wider than the configured window, or asking for more
 * lines than the limit, must be refused rather than silently truncated, because a truncated answer
 * to "is this error still happening?" reads exactly like a complete one.
 */
import type {
  LogRangeQuery,
  ObservabilityErrorsPort,
  ObservabilityLogsPort,
} from '@platform/application';
import { errorEventSchema, issueSchema, logQueryResultSchema } from '@platform/application';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectAgentTooling, expectIntegrationError } from './shared.js';

// ── Errors ───────────────────────────────────────────────────────────────────

export interface ObservabilityErrorsContractContext {
  readonly port: ObservabilityErrorsPort;
  readonly project: string;
  /** An issue that exists and has a latest event. */
  readonly issueId: string;
  /** An issue that exists but whose events are gone (or `null` if the harness has none). */
  readonly issueWithoutEventsId: string | null;
  readonly missingIssueId: string;
  /** A substring of the seeded issue's title. */
  readonly titleFragment: string;
  cleanup(): Promise<void>;
}

export interface ObservabilityErrorsContractHarness {
  readonly name: string;
  create(): Promise<ObservabilityErrorsContractContext>;
}

export const runObservabilityErrorsContract = (
  harness: ObservabilityErrorsContractHarness,
): void => {
  describe(`ObservabilityErrors contract — ${harness.name}`, () => {
    let context: ObservabilityErrorsContractContext;
    let port: ObservabilityErrorsPort;

    beforeEach(async () => {
      context = await harness.create();
      port = context.port;
      return async () => {
        await context.cleanup();
      };
    });

    it('declares every capability flag as a boolean and answers a probe', async () => {
      for (const [name, value] of Object.entries(port.capabilities())) {
        expect(typeof value, `capability ${name}`).toBe('boolean');
      }
      expect((await port.testConnection()).ok).toBe(true);
    });

    it('reads an issue that matches the port schema', async () => {
      const issue = issueSchema.parse(await port.getIssue({ id: context.issueId }));
      expect(issue.ref.id).toBe(context.issueId);
      expect(issue.count).toBeGreaterThanOrEqual(1);
      expect(Date.parse(issue.last_seen)).not.toBeNaN();
    });

    it('fails with not_found for an issue that does not exist', async () => {
      await expectIntegrationError(
        () => port.getIssue({ id: context.missingIssueId }),
        'not_found',
      );
    });

    it('reads the latest event, stack trace included (untrusted data, BD-022)', async () => {
      const event = await port.getLatestEvent({ id: context.issueId });
      expect(event).not.toBeNull();
      const parsed = errorEventSchema.parse(event);
      expect(parsed.issue_id).toBe(context.issueId);
      expect(parsed.stack_trace.length).toBeGreaterThan(0);
    });

    it('returns null when an issue has no event left', async () => {
      if (context.issueWithoutEventsId === null) {
        return;
      }
      expect(await port.getLatestEvent({ id: context.issueWithoutEventsId })).toBeNull();
    });

    it('searches by status and by title fragment, or refuses when it cannot', async () => {
      if (!port.capabilities().search) {
        await expectIntegrationError(
          () => port.searchIssues({ project: context.project, query: 'is:unresolved' }),
          'unsupported_capability',
        );
        return;
      }
      const unresolved = await port.searchIssues({
        project: context.project,
        query: 'is:unresolved',
      });
      expect(unresolved.map((issue) => issue.ref.id)).toContain(context.issueId);

      const byTitle = await port.searchIssues({
        project: context.project,
        query: context.titleFragment,
      });
      expect(byTitle.map((issue) => issue.ref.id)).toContain(context.issueId);
    });

    it('links a merge request, comments and resolves idempotently', async () => {
      const capabilities = port.capabilities();
      const mrUrl = 'https://git.example.test/acme/api/-/merge_requests/7';
      if (capabilities.linkMergeRequest) {
        await port.linkMergeRequest({ id: context.issueId }, mrUrl);
      } else {
        await expectIntegrationError(
          () => port.linkMergeRequest({ id: context.issueId }, mrUrl),
          'unsupported_capability',
        );
      }
      if (capabilities.comments) {
        const comment = await port.comment({ id: context.issueId }, 'Fixed by !7');
        expect(comment.id.length).toBeGreaterThan(0);
      } else {
        await expectIntegrationError(
          () => port.comment({ id: context.issueId }, 'Fixed by !7'),
          'unsupported_capability',
        );
      }
      if (capabilities.resolve) {
        const resolved = await port.resolve({ id: context.issueId });
        expect(resolved.status).toBe('resolved');
        const again = await port.resolve({ id: context.issueId });
        expect(again.status).toBe('resolved');
      } else {
        await expectIntegrationError(
          () => port.resolve({ id: context.issueId }),
          'unsupported_capability',
        );
      }
    });

    it('declares agent tooling by name only', () => {
      expectAgentTooling(port.agentTooling());
    });
  });
};

// ── Logs ─────────────────────────────────────────────────────────────────────

export interface ObservabilityLogsContractContext {
  readonly port: ObservabilityLogsPort;
  /** A selector that matches the seeded stream, and one that matches nothing. */
  readonly selector: string;
  readonly emptySelector: string;
  /** A window that contains the seeded lines. */
  readonly window: { readonly from: string; readonly to: string };
  /** A label the seeded stream carries, and one of its values. */
  readonly label: { readonly name: string; readonly value: string };
  /**
   * The largest label **name** this binding accepts, in bytes — the suite sends exactly one byte
   * past it.
   *
   * It is a harness field rather than a capability because widening
   * `ObservabilityLogsCapabilities` is a port change (technical/06), and it must be the number the
   * binding is really configured with: a harness that overstates it sends a value that a *wrong*,
   * too-wide guard would also refuse, which is the negative case that proves nothing (standing
   * rule 43). Read it out of the binding's own config rather than restating it.
   */
  readonly maxLabelNameBytes: number;
  /** A substring present in exactly one seeded line. */
  readonly lineFilter: string;
  cleanup(): Promise<void>;
}

export interface ObservabilityLogsContractHarness {
  readonly name: string;
  create(): Promise<ObservabilityLogsContractContext>;
}

export const runObservabilityLogsContract = (harness: ObservabilityLogsContractHarness): void => {
  describe(`ObservabilityLogs contract — ${harness.name}`, () => {
    let context: ObservabilityLogsContractContext;
    let port: ObservabilityLogsPort;

    beforeEach(async () => {
      context = await harness.create();
      port = context.port;
      return async () => {
        await context.cleanup();
      };
    });

    const query = (overrides: Partial<LogRangeQuery> = {}): LogRangeQuery => ({
      selector: context.selector,
      from: context.window.from,
      to: context.window.to,
      limit: 100,
      ...overrides,
    });

    it('declares its caps and answers a probe', async () => {
      const capabilities = port.capabilities();
      expect(capabilities.maxRangeMs).toBeGreaterThan(0);
      expect(capabilities.maxLines).toBeGreaterThan(0);
      expect((await port.testConnection()).ok).toBe(true);
    });

    it('returns lines for a selector, newest first by default', async () => {
      const result = logQueryResultSchema.parse(await port.queryRange(query()));
      expect(result.line_count).toBeGreaterThan(0);
      expect(result.streams.length).toBeGreaterThan(0);
      const timestamps = result.streams.flatMap((stream) =>
        stream.lines.map((line) => Date.parse(line.timestamp)),
      );
      expect([...timestamps].sort((left, right) => right - left)).toEqual(timestamps);
    });

    it('returns an empty result for a selector that matches nothing', async () => {
      const result = await port.queryRange(query({ selector: context.emptySelector }));
      expect(result.line_count).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('narrows by a line filter', async () => {
      const result = await port.queryRange(query({ filter: context.lineFilter }));
      expect(result.line_count).toBeGreaterThan(0);
      for (const stream of result.streams) {
        for (const line of stream.lines) {
          expect(line.line).toContain(context.lineFilter);
        }
      }
    });

    it('reports truncation rather than pretending the answer is complete', async () => {
      const all = await port.queryRange(query());
      if (all.line_count < 2) {
        return;
      }
      const truncated = await port.queryRange(query({ limit: 1 }));
      expect(truncated.line_count).toBe(1);
      expect(truncated.truncated).toBe(true);
    });

    it('refuses a window wider than the cap, a limit above it, and an inverted range', async () => {
      const capabilities = port.capabilities();
      const from = Date.parse(context.window.from);
      await expectIntegrationError(
        () =>
          port.queryRange(
            query({
              from: new Date(from).toISOString(),
              to: new Date(from + capabilities.maxRangeMs + 60_000).toISOString(),
            }),
          ),
        'invalid_request',
      );
      await expectIntegrationError(
        () => port.queryRange(query({ limit: capabilities.maxLines + 1 })),
        'invalid_request',
      );
      await expectIntegrationError(
        () => port.queryRange(query({ from: context.window.to, to: context.window.from })),
        'invalid_request',
      );
    });

    it('refuses a selector it cannot parse', async () => {
      await expectIntegrationError(
        () => port.queryRange(query({ selector: 'app = api' })),
        'invalid_request',
      );
    });

    it('discovers labels and series', async () => {
      const capabilities = port.capabilities();
      if (capabilities.labels) {
        const names = await port.labels();
        expect(names.values).toContain(context.label.name);
        const values = await port.labels(context.label.name);
        expect(values.values).toContain(context.label.value);
      } else {
        await expectIntegrationError(() => port.labels(), 'unsupported_capability');
      }
      if (capabilities.series) {
        const series = await port.series(context.selector, context.window.from);
        expect(series.length).toBeGreaterThan(0);
        expect(series[0]?.[context.label.name]).toBe(context.label.value);
        // `series` builds a window from `since` to now, so `maxRangeMs` binds it exactly as it
        // binds `queryRange` — the port publishes one cap, not one per method. WP-11 shipped a
        // `series` that sent `start=0` for this argument, i.e. a 56-year scan, because the check
        // lived in the other method (standing rule 23: the obligation belongs in this file).
        await expectIntegrationError(
          () => port.series(context.selector, '1970-01-01T00:00:00.000Z'),
          'invalid_request',
        );
      } else {
        await expectIntegrationError(
          () => port.series(context.selector, context.window.from),
          'unsupported_capability',
        );
      }
    });

    /**
     * `LabelValues.name` is the caller's argument **echoed back**, which makes it the one emitted
     * member of this port whose text does not come from the provider — and an agent's tool call is
     * untrusted text too (BD-022). A binding that accepts any name emits any string, so the bound
     * is a refusal rather than a cut: a truncated name would quietly answer about a *different*
     * label (`loki/provider.ts`, `sentry/mapping.ts` on identifiers).
     *
     * It lives here because it was a provider-local promise for one review round: the Loki adapter
     * refused, the fake accepted, and nothing called it (WP-11a review round 1; standing rules 1
     * and 23).
     *
     * **One byte past `context.maxLabelNameBytes`, not an absurd value** (review round 2). This
     * case used to send 128 KiB, which every wrong implementation refuses too: a Loki guard widened
     * to `max_label_bytes + 64` stayed green here and everywhere else (standing rule 43). The
     * *acceptance* half at exactly the cap cannot live in this file — a name of the cap's length is
     * a label no harness has recorded an answer for, and the Loki runner replays fixtures — so each
     * binding asserts it in its own tier: `providers/emitted-bounds.test.ts` for the adapter,
     * `logs/fake.test.ts` for the fake. What the suite pins is the refusal's *position*.
     */
    it('refuses a label name one byte past the cap rather than echoing it back', async () => {
      const tooLong = 'L'.repeat(context.maxLabelNameBytes + 1);
      if (!port.capabilities().labels) {
        // Unexercised today: both logs harnesses (the in-memory fake and the Loki replay) declare
        // `labels`, so nothing reaches this branch — a binding without label discovery would, and
        // that is what it is here for (standing rule 22: an unreachable branch says so at the
        // line). Asserted rather than skipped: this test sat in the *errors* suite for one run of
        // the author's own harness, where `capabilities().labels` is `undefined` — and passed,
        // green and empty.
        await expectIntegrationError(() => port.labels(tooLong), 'unsupported_capability');
        return;
      }
      await expectIntegrationError(() => port.labels(tooLong), 'invalid_request');
      // Which branch ran (standing rule 10): a name the binding accepts is still answered, so the
      // refusal above is a bound rather than a method that refuses everything.
      expect((await port.labels(context.label.name)).name).toBe(context.label.name);
    });

    it('declares agent tooling by name only', () => {
      expectAgentTooling(port.agentTooling());
    });
  });
};
