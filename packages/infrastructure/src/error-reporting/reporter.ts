/**
 * **Optional error reporting, redacted by construction** — TD-023's 2026-11-05 amendment, WP-295.
 *
 * One reporter for the worker and the core. This module is the half that knows **what may leave
 * the process**, and it names no SDK: `@sentry/node` is a dependency of `apps/server` only (the
 * amendment's decision 4 — the launcher's image ships `packages/infrastructure` too and must not
 * carry it), so the `NodeClient` itself is built there (`apps/server/src/error-reporting.ts`) from
 * the options and hooks this module answers. What is decided here:
 *
 * - **Where a DSN may point** ({@link parseErrorReportingDsn}): `https://<key>@<host>/<project id>`,
 *   `http:` only to a loopback host, no secret key, no path prefix, no query.
 * - **What an event carries** ({@link shapeReportedEvent}, the `beforeSend` hook): an **allow-list**
 *   rebuilt from the SDK's event — the id, the time, the level, the platform, the error's type, its
 *   message bounded at {@link ERROR_MESSAGE_MAX_BYTES} and its stack frames (file, function, line
 *   and column only), a log line's own message when it carried no error, and the tags
 *   {@link REPORT_TAG_NAMES}. **Everything else is dropped**, whatever the SDK or a scope put there:
 *   no `server_name`, no `contexts`, no `extra`, no `user`, no `request`, no breadcrumbs, no SDK
 *   processing metadata (so no trace header in the envelope either). No transcript, prompt, tool
 *   input, ticket text, project name or ticket key reaches an event, because none is a field on the
 *   list and the only feed is the composition's own `error`/`fatal` log call
 *   ({@link reportOfLogCall}).
 * - **Redaction before sending**: the rebuilt event goes through the process's redactor — the
 *   exact-value redactor of the secrets it holds, then TD-012's pattern redactor — **before** the
 *   message is bounded, so a cut never leaves half a secret behind a placeholder it was not
 *   replaced by. `beforeBreadcrumb` ({@link shapeBreadcrumb}) redacts too, although no breadcrumb
 *   is on the event's list: it is the second line, for the day somebody adds one.
 * - **A hook never throws**: the SDK answers a throwing `beforeSend` by capturing the throw as an
 *   *internal* exception, and an internal exception skips `beforeSend` — so a hook that failed
 *   would send its own error unredacted. Each hook catches and drops the event instead.
 * - **The transport is the last gate** ({@link shapeEnvelope}): an internal exception the SDK
 *   raises on its own skips `beforeSend` too, so every envelope is shaped and redacted again before
 *   it is serialised — only event items, each through the same allow-list.
 *
 * The residual is the amendment's: a third-party error message that quotes untrusted text carries
 * up to 1 KiB of it, redacted for exact values and patterns, not for meaning.
 */
import type { SecretRedactor } from '@platform/application';
import type { JsonObject } from '@platform/contracts';

/** An error's message, in UTF-8 bytes, after redaction (the amendment's 1 KiB). */
export const ERROR_MESSAGE_MAX_BYTES = 1_024;

/** The only tags an event carries (the amendment's decision 1). */
export const REPORT_TAG_NAMES = [
  'role',
  'worker_id',
  'core_url',
  'version',
  'commit',
  'run_id',
] as const;
export type ReportTagName = (typeof REPORT_TAG_NAMES)[number];
export type ReportTags = Partial<Record<ReportTagName, string | null | undefined>>;

/** One tag value's bound — a URL or an id; nothing longer is a tag. */
const TAG_MAX_CHARS = 256;
/** Stack frames kept, newest last — the SDK's own order. */
const MAX_FRAMES = 50;
/** Exception values kept (the error and, if the SDK ever adds them, its causes). */
const MAX_EXCEPTIONS = 5;
const NAME_MAX_CHARS = 128;
const FRAME_TEXT_MAX_CHARS = 512;

/** The hosts an `http:` DSN may name: this process's own loopback only. */
export const LOOPBACK_DSN_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export type DsnVerdict =
  | { readonly ok: true; readonly dsn: string; readonly host: string }
  | { readonly ok: false; readonly reason: string };

/** What a refused DSN is told — never echoing the value, which carries a key. */
export const DSN_SHAPE_WORDS =
  'a Sentry DSN, https://<key>@<host>/<project id> (http: only to localhost)';

/**
 * Whether `text` is a DSN this platform sends to — and its canonical spelling and host.
 *
 * `https://<key>@<host>/<project id>`, or `http:` to {@link LOOPBACK_DSN_HOSTS}. Refused: another
 * scheme, a missing key, a key with a secret (`<key>:<secret>@`, the legacy form — the SDK needs
 * none, and a secret here would be a second credential on disk), a path that is not exactly one
 * numeric project id (a self-hosted path prefix is not accepted: stated rather than guessed), a
 * query or a fragment, and anything past 2 KiB.
 */
export const parseErrorReportingDsn = (text: string): DsnVerdict => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) {
    return { ok: false, reason: `expected ${DSN_SHAPE_WORDS}` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: `expected ${DSN_SHAPE_WORDS}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `expected ${DSN_SHAPE_WORDS}: an https address` };
  }
  if (url.protocol === 'http:' && !LOOPBACK_DSN_HOSTS.includes(url.hostname)) {
    return {
      ok: false,
      reason: `expected ${DSN_SHAPE_WORDS}: http is accepted only to this machine`,
    };
  }
  if (!/^[A-Za-z0-9]{1,128}$/.test(url.username)) {
    return { ok: false, reason: `expected ${DSN_SHAPE_WORDS}: the key is missing` };
  }
  if (url.password !== '') {
    return {
      ok: false,
      reason: `expected ${DSN_SHAPE_WORDS}: a DSN with a secret key is the legacy form; use the one without`,
    };
  }
  if (!/^\/[0-9]{1,20}$/.test(url.pathname) || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: `expected ${DSN_SHAPE_WORDS}: the path is the project id` };
  }
  return {
    ok: true,
    dsn: `${url.protocol}//${url.username}@${url.host}${url.pathname}`,
    host: url.host,
  };
};

/** `text` cut to at most `maxBytes` of UTF-8, on a code point boundary, marked when cut. */
export const boundUtf8 = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const marker = ' … [cut]';
  let end = Math.max(0, maxBytes - Buffer.byteLength(marker));
  // Step back off a continuation byte so a code point is never split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}${marker}`;
};

type Unknown = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string as it came — **never cut here**: every bound is applied after redaction. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Writes only defined values, so the rebuilt event has no `undefined` key to serialise. */
const defined = (entries: Record<string, unknown>): JsonObject =>
  Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as JsonObject;

const LEVELS = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);

/** A stack frame: its file, function, line and column — nothing else (no module, no `in_app`). */
const frameOf = (frame: unknown): JsonObject | null => {
  if (!isRecord(frame)) return null;
  return defined({
    filename: text(frame.filename),
    function: text(frame.function),
    lineno: integer(frame.lineno),
    colno: integer(frame.colno),
  });
};

const exceptionOf = (value: unknown): JsonObject | null => {
  if (!isRecord(value)) return null;
  const frames = isRecord(value.stacktrace) ? value.stacktrace.frames : undefined;
  const kept = Array.isArray(frames)
    ? frames
        .slice(-MAX_FRAMES)
        .map(frameOf)
        .filter((frame): frame is JsonObject => frame !== null)
    : [];
  return defined({
    type: text(value.type),
    value: text(value.value),
    stacktrace: kept.length === 0 ? undefined : { frames: kept },
  });
};

const tagsOf = (value: unknown): JsonObject | undefined => {
  if (!isRecord(value)) return undefined;
  const tags: Record<string, string> = {};
  for (const name of REPORT_TAG_NAMES) {
    const tag = value[name];
    if (typeof tag === 'string' && tag !== '') tags[name] = tag;
  }
  return Object.keys(tags).length === 0 ? undefined : tags;
};

const messageOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.formatted === 'string') return value.formatted;
  return undefined;
};

/** `text` bounded at `max` characters, marked when cut — applied to redacted text only. */
const cut = (value: unknown, max: number): unknown =>
  typeof value === 'string' && value.length > max ? `${value.slice(0, max)} … [cut]` : value;

/**
 * Every bound of the event, applied **after** redaction (a cut before it could split a secret and
 * leave the half that no longer matches in clear): the message and each exception's value at
 * {@link ERROR_MESSAGE_MAX_BYTES}, a type, a frame's file and function, and each tag.
 */
const boundEvent = (event: JsonObject): JsonObject => {
  const out: Record<string, unknown> = { ...event };
  if (typeof out.message === 'string') {
    out.message = boundUtf8(out.message, ERROR_MESSAGE_MAX_BYTES);
  }
  const exception = out.exception;
  if (isRecord(exception) && Array.isArray(exception.values)) {
    out.exception = {
      values: exception.values.map((value: unknown) => {
        if (!isRecord(value)) return value;
        const frames = isRecord(value.stacktrace) ? value.stacktrace.frames : undefined;
        return defined({
          type: cut(value.type, NAME_MAX_CHARS),
          value:
            typeof value.value === 'string'
              ? boundUtf8(value.value, ERROR_MESSAGE_MAX_BYTES)
              : undefined,
          stacktrace: Array.isArray(frames)
            ? {
                frames: frames.map((frame: unknown) =>
                  isRecord(frame)
                    ? {
                        ...frame,
                        ...(frame.filename === undefined
                          ? {}
                          : { filename: cut(frame.filename, FRAME_TEXT_MAX_CHARS) }),
                        ...(frame.function === undefined
                          ? {}
                          : { function: cut(frame.function, FRAME_TEXT_MAX_CHARS) }),
                      }
                    : frame,
                ),
              }
            : undefined,
        });
      }),
    };
  }
  if (isRecord(out.tags)) {
    out.tags = Object.fromEntries(
      Object.entries(out.tags).map(([name, value]) => [name, cut(value, TAG_MAX_CHARS)]),
    );
  }
  return out as JsonObject;
};

/**
 * `beforeSend`: the event rebuilt from the allow-list, redacted, then bounded — or `null` (the SDK
 * then sends nothing) when there is nothing to send or anything went wrong.
 */
export const shapeReportedEvent = (event: unknown, redactor: SecretRedactor): JsonObject | null => {
  try {
    if (!isRecord(event)) return null;
    const exceptionValues =
      isRecord(event.exception) && Array.isArray(event.exception.values)
        ? event.exception.values
            .slice(0, MAX_EXCEPTIONS)
            .map(exceptionOf)
            .filter((value): value is JsonObject => value !== null)
        : [];
    const message = messageOf(event.message);
    if (exceptionValues.length === 0 && message === undefined) return null;
    const rebuilt = defined({
      event_id:
        typeof event.event_id === 'string' && /^[0-9a-f]{32}$/.test(event.event_id)
          ? event.event_id
          : undefined,
      timestamp: typeof event.timestamp === 'number' ? event.timestamp : undefined,
      level: typeof event.level === 'string' && LEVELS.has(event.level) ? event.level : 'error',
      platform: 'node',
      message,
      exception: exceptionValues.length === 0 ? undefined : { values: exceptionValues },
      tags: tagsOf(event.tags),
    });
    return boundEvent(redactor.redactJson(rebuilt).value);
  } catch {
    // Never thrown back into the SDK: a throwing hook's error is sent as an internal exception,
    // which skips this hook (see the docblock). Dropping the event is the only safe answer.
    return null;
  }
};

/** `beforeBreadcrumb`: the time, category, level and message only, redacted, then bounded. */
export const shapeBreadcrumb = (crumb: unknown, redactor: SecretRedactor): JsonObject | null => {
  try {
    if (!isRecord(crumb)) return null;
    const rebuilt = defined({
      timestamp: typeof crumb.timestamp === 'number' ? crumb.timestamp : undefined,
      category: text(crumb.category),
      level: typeof crumb.level === 'string' && LEVELS.has(crumb.level) ? crumb.level : undefined,
      message: text(crumb.message),
    });
    const redacted = redactor.redactJson(rebuilt).value;
    return defined({
      ...redacted,
      category: cut(redacted.category, 64),
      message:
        typeof redacted.message === 'string'
          ? boundUtf8(redacted.message, ERROR_MESSAGE_MAX_BYTES)
          : undefined,
    });
  } catch {
    return null;
  }
};

/**
 * **The envelope that leaves the process — the transport's own gate** (review of PR #60).
 *
 * `beforeSend` does not see everything the SDK sends: an error *inside* the SDK's event pipeline
 * (an event processor that throws, a scope's hook) is captured as an **internal** exception, and an
 * internal exception skips `beforeSend` entirely. So the transport is wrapped as well
 * (`apps/server`'s `sentryClientFactory`), and every envelope is rebuilt here before it is
 * serialised: **only `event` items are kept**, each shaped again by {@link shapeReportedEvent}
 * (idempotent over an already shaped event), and the header is rebuilt to its id, its time and the
 * SDK's name and version, redacted. Sessions, client reports, attachments, spans and a trace header
 * never leave. `null` — nothing to send — when no event survives or anything went wrong.
 */
export const shapeEnvelope = (envelope: unknown, redactor: SecretRedactor): unknown[] | null => {
  try {
    if (!Array.isArray(envelope) || envelope.length !== 2) return null;
    const [headers, items] = envelope as [unknown, unknown];
    if (!Array.isArray(items)) return null;
    const kept: [JsonObject, JsonObject][] = [];
    for (const item of items) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [itemHeader, payload] = item as [unknown, unknown];
      if (!isRecord(itemHeader) || itemHeader.type !== 'event') continue;
      const shaped = shapeReportedEvent(payload, redactor);
      if (shaped !== null) kept.push([{ type: 'event' }, shaped]);
    }
    if (kept.length === 0) return null;
    const header = isRecord(headers) ? headers : {};
    const sdk = isRecord(header.sdk) ? header.sdk : {};
    const rebuilt = defined({
      event_id: text(header.event_id),
      sent_at: text(header.sent_at),
      sdk:
        typeof sdk.name === 'string' && typeof sdk.version === 'string'
          ? { name: sdk.name, version: sdk.version }
          : undefined,
    });
    const redacted = redactor.redactJson(rebuilt).value;
    return [
      defined({
        event_id: cut(redacted.event_id, 64),
        sent_at: cut(redacted.sent_at, 64),
        sdk: redacted.sdk,
      }),
      kept,
    ];
  } catch {
    return null;
  }
};

/**
 * The client options every reporting client is built with, beside the DSN, the transport, the
 * stack parser and the two hooks: **no integration at all** (no auto-instrumentation, no console,
 * HTTP or uncaught-exception hooks — the only feed is the log path), no default PII, no server
 * name, no client reports (the only traffic is an error), no stack attached to a message.
 */
export const REPORTING_CLIENT_OPTIONS = {
  integrations: [],
  sendDefaultPii: false,
  includeServerName: false,
  sendClientReports: false,
  attachStacktrace: false,
  maxBreadcrumbs: 0,
} as const;

/** One report: an error (its type, message and stack), or a log line's message when it had none. */
export interface ErrorReport {
  readonly error: Error | null;
  readonly message: string;
  readonly tags: ReportTags;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The report a composition's `error`/`fatal` log call makes, from its arguments — pino's
 * `(fields, message)` — and the tags the process knows. The error is `fields.err` when it is one;
 * the run id is `fields.run_id` when it is a uuid. **No other field of the log call is read.**
 */
export const reportOfLogCall = (
  fields: unknown,
  message: string | undefined,
  tags: ReportTags,
): ErrorReport => {
  const record = isRecord(fields) ? fields : {};
  const error = record.err instanceof Error ? record.err : null;
  const runId =
    typeof record.run_id === 'string' && UUID.test(record.run_id) ? record.run_id : null;
  return {
    error,
    message: message ?? (error === null ? 'an error was logged' : error.message),
    tags: { ...tags, ...(runId === null ? {} : { run_id: runId }) },
  };
};

/** What the reporter asks of an SDK client (`apps/server` builds a `NodeClient` behind it). */
export interface ErrorReportingClient {
  /** Sends one report; answers the event id. */
  capture(report: ErrorReport): string | undefined;
  flush(timeoutMs: number): Promise<boolean>;
  close(timeoutMs: number): Promise<boolean>;
}

/** Builds a client for one DSN. */
export type ErrorReportingClientFactory = (dsn: string) => Promise<ErrorReportingClient>;

export interface ErrorReporter {
  /** The DSN events are sent to now, or `null` when reporting is off. */
  dsn(): string | null;
  /**
   * Point reporting at `dsn`, or turn it off with `null` — **without a restart**: the old client is
   * flushed and closed, and a new one built (the amendment's decision 3). Serialised: a second call
   * waits for the first.
   */
  configure(dsn: string | null): Promise<void>;
  /** Sends one report through the current client; `null` when reporting is off. Never throws. */
  report(report: ErrorReport): string | null;
  /** Waits for what was sent so far (bounded); `false` when it did not all go, or nothing is on. */
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flushes and closes the client; reporting is off afterwards. */
  close(timeoutMs?: number): Promise<void>;
}

const CLOSE_TIMEOUT_MS = 2_000;

/**
 * The reporter: one client at a time, swapped on {@link ErrorReporter.configure}. `onFailure` hears
 * a client that could not be built or a capture that threw — the composition logs it below `error`,
 * so a failure to report is never itself reported (no loop).
 */
export const createErrorReporter = (options: {
  readonly createClient: ErrorReportingClientFactory;
  readonly onFailure?: (error: unknown) => void;
}): ErrorReporter => {
  let current: { readonly dsn: string; readonly client: ErrorReportingClient } | null = null;
  let queue: Promise<void> = Promise.resolve();
  const failed = (error: unknown): void => {
    try {
      options.onFailure?.(error);
    } catch {
      // The failure path itself failing has nowhere left to go; the log line was already written.
    }
  };
  const swap = async (dsn: string | null): Promise<void> => {
    const previous = current;
    // Off first: a report made while the old client closes is not sent to the old DSN.
    current = null;
    if (previous !== null) {
      await previous.client.close(CLOSE_TIMEOUT_MS).catch(failed);
    }
    if (dsn === null) return;
    try {
      current = { dsn, client: await options.createClient(dsn) };
    } catch (error) {
      failed(error);
      throw error;
    }
  };
  return {
    dsn: () => current?.dsn ?? null,
    configure: (dsn) => {
      const next = queue.then(() => swap(dsn));
      queue = next.catch(() => undefined);
      return next;
    },
    report: (report) => {
      const target = current;
      if (target === null) return null;
      try {
        return target.client.capture(report) ?? null;
      } catch (error) {
        failed(error);
        return null;
      }
    },
    flush: async (timeoutMs = CLOSE_TIMEOUT_MS) => {
      const target = current;
      if (target === null) return false;
      return target.client.flush(timeoutMs).catch((error: unknown) => {
        failed(error);
        return false;
      });
    },
    close: async (timeoutMs = CLOSE_TIMEOUT_MS) => {
      await queue;
      const previous = current;
      current = null;
      if (previous !== null) await previous.client.close(timeoutMs).catch(failed);
    },
  };
};
