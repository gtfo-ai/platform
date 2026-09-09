/**
 * The **ObservabilityLogs** type port — technical/06 § "ObservabilityLogs", product/08 §
 * "Observability — logs".
 *
 * Loki is the first provider (WP-11). The platform queries it in exactly one place — the optional
 * excerpt around a Sentry event's timestamp for a bug task — and agents query it through `logcli`
 * with a skill of LogQL recipes. Log lines are untrusted text (BD-022).
 *
 * The port carries **caps, not suggestions**. product/08 configures a maximum time window and a
 * line limit per binding; a query that exceeds either is an `invalid_request` failure rather than
 * a silently truncated answer, because a truncated answer looks like a complete one to an agent
 * reasoning about whether an error still happens.
 */
import { isoDateTimeSchema, nonEmptyStringSchema } from '@platform/contracts';
import * as z from 'zod';
import type { AgentTooling, IntegrationPort } from './common.js';

// ── Data ─────────────────────────────────────────────────────────────────────

/**
 * One log line. `labels` has **provider-chosen keys** (the stream's label set), one of the
 * documented exceptions to the strict-object rule (CLAUDE.md).
 */
export const logLineSchema = z.strictObject({
  timestamp: isoDateTimeSchema,
  /**
   * Untrusted (BD-022) — and the most likely single place in this port for a credential to appear,
   * because an application that logs a request logs its headers.
   *
   * **TODO (WP-11, and WP-16 when a pre-fetch reaches a context pack):** these lines are read to be
   * *stored* — in an artifact, in a context pack, in `events.payload` — and TD-012 wants the
   * redactor on every one of those writes. The read itself goes through
   * `IntegrationActionExecutor`, which redacts the audit row; nothing redacts the lines on their
   * way into a pack. Whoever writes that path adds the `SecretRedactor` and records its count.
   */
  line: z.string(),
  labels: z.record(z.string(), z.string()),
});

export const logStreamSchema = z.strictObject({
  labels: z.record(z.string(), z.string()),
  lines: z.array(logLineSchema),
});

/**
 * The result of a range query.
 *
 * `truncated` is explicit: a caller that asked for 100 lines and got 100 cannot tell from the
 * lines alone whether it saw everything, and "did the error stop?" is exactly the question that
 * gets that wrong.
 */
export const logQueryResultSchema = z.strictObject({
  streams: z.array(logStreamSchema),
  line_count: z.int().nonnegative(),
  truncated: z.boolean(),
});

export const labelValuesSchema = z.strictObject({
  name: nonEmptyStringSchema,
  values: z.array(z.string()),
});

export type LogLine = z.infer<typeof logLineSchema>;
export type LogStream = z.infer<typeof logStreamSchema>;
export type LogQueryResult = z.infer<typeof logQueryResultSchema>;
export type LabelValues = z.infer<typeof labelValuesSchema>;

/** A range query. `selector` is provider query syntax (LogQL); `filter` narrows the lines. */
export interface LogRangeQuery {
  readonly selector: string;
  readonly from: string;
  readonly to: string;
  readonly limit: number;
  /** Substring or provider filter expression, applied server-side when possible. */
  readonly filter?: string | null;
  readonly direction?: 'forward' | 'backward';
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export interface ObservabilityLogsCapabilities {
  /** Label discovery (`labels`). */
  readonly labels: boolean;
  /** Stream discovery (`series`). */
  readonly series: boolean;
  /** Widest time range a single query may cover, in milliseconds (product/08 config). */
  readonly maxRangeMs: number;
  /** Highest line limit a single query may ask for. */
  readonly maxLines: number;
}

// ── The port ─────────────────────────────────────────────────────────────────

export interface ObservabilityLogsPort extends IntegrationPort<ObservabilityLogsCapabilities> {
  /**
   * @throws {IntegrationError} `invalid_request` when the range or the limit exceeds the caps in
   * `capabilities()`, or when `from` is not before `to`.
   */
  queryRange(query: LogRangeQuery): Promise<LogQueryResult>;

  /** Label names, or the values of one label. */
  labels(name?: string): Promise<LabelValues>;

  /** Label sets matching a selector since an instant — the "narrow the stream" recipe step. */
  series(selector: string, since: string): Promise<readonly Record<string, string>[]>;

  agentTooling(): AgentTooling;
}
