/**
 * **The error reporter's SDK half** — TD-023's 2026-11-05 amendment, WP-295.
 *
 * `@sentry/node` is a dependency of this package only (decision 4), so the `NodeClient` is built
 * here — and loaded with a dynamic `import()` only once a DSN is configured, so a process with
 * reporting off never loads the SDK at all. Everything about **what** leaves the process is
 * `@platform/infrastructure`'s `errorReporting` module: the client is built with its
 * `REPORTING_CLIENT_OPTIONS` (no integration, no default PII, no server name, no client reports, no
 * breadcrumbs) and its two hooks, `shapeReportedEvent` as `beforeSend` and `shapeBreadcrumb` as
 * `beforeBreadcrumb`, each over the process's redactor **read per event** — so a secret the process
 * learns later (a run's token, a new Claude sign-in) is redacted from the next event on.
 *
 * Each capture has a **scope of its own** carrying only the report's tags, rather than the SDK's
 * global scopes: nothing else in the process can attach data to an event this reporter sends. (The
 * global isolation scope is still merged by the SDK; the allow-list drops what it adds.)
 *
 * The feed is the logger's `error`/`fatal` path ({@link reportingLogHook}), nothing else: no
 * uncaught-exception integration — `main.ts` logs an uncaught error through the logger, and that
 * line is what is reported.
 */
import { type InjectedSecret, MIN_SECRET_LENGTH, type SecretRedactor } from '@platform/application';
import { errorReporting, redaction as redactionAdapters } from '@platform/infrastructure';
import type { Breadcrumb, ErrorEvent, NodeClient } from '@sentry/node';

type NodeClientOptions = ConstructorParameters<typeof NodeClient>[0];
/** How a client sends an envelope — `makeNodeTransport`, or a test's recorder. */
export type ReportingTransport = NodeClientOptions['transport'];

/** Builds `NodeClient`s over the process's redactor; `transport` is the test seam (no network). */
export const sentryClientFactory =
  (options: {
    /** The process's exact-value redactor, read at every event. */
    readonly secrets: () => SecretRedactor;
    readonly transport?: ReportingTransport;
  }): errorReporting.ErrorReportingClientFactory =>
  async (dsn) => {
    const sentry = await import('@sentry/node');
    // TD-012's order: the exact values first (their placeholder names the secret), patterns second.
    // Read per event, and a redactor that cannot be built drops the event: a hook that throws is
    // sent by the SDK as an internal exception that skips the hook (`reporter.ts`'s docblock).
    const redactor = (): SecretRedactor | null => {
      try {
        return redactionAdapters.composeRedactors(
          options.secrets(),
          redactionAdapters.patternRedactor(),
        );
      } catch {
        return null;
      }
    };
    const client = new sentry.NodeClient({
      ...errorReporting.REPORTING_CLIENT_OPTIONS,
      integrations: [],
      dsn,
      stackParser: sentry.defaultStackParser,
      transport: options.transport ?? sentry.makeNodeTransport,
      beforeSend: (event) => {
        const current = redactor();
        return current === null
          ? null
          : (errorReporting.shapeReportedEvent(event, current) as unknown as ErrorEvent | null);
      },
      beforeBreadcrumb: (crumb) => {
        const current = redactor();
        return current === null
          ? null
          : (errorReporting.shapeBreadcrumb(crumb, current) as unknown as Breadcrumb | null);
      },
    });
    client.init();
    return {
      capture: (report) => {
        const scope = new sentry.Scope();
        const tags: Record<string, string> = {};
        for (const [name, value] of Object.entries(report.tags)) {
          if (typeof value === 'string' && value !== '') tags[name] = value;
        }
        scope.setTags(tags);
        return report.error === null
          ? client.captureMessage(report.message, 'error', undefined, scope)
          : client.captureException(report.error, undefined, scope);
      },
      flush: async (timeoutMs) => client.flush(timeoutMs),
      close: async (timeoutMs) => client.close(timeoutMs),
    };
  };

/**
 * The logger's hook (`createLogger`'s `onError`): every `error` (50) and `fatal` (60) call becomes
 * one report, with the tags the process knows **now** (a worker learns its id at the handshake).
 */
export const reportingLogHook =
  (reporter: errorReporting.ErrorReporter, tags: () => errorReporting.ReportTags) =>
  (fields: unknown, message: string | undefined): void => {
    if (reporter.dsn() === null) return;
    reporter.report(errorReporting.reportOfLogCall(fields, message, tags()));
  };

/** The error *Send a test error* sends: platform words only, nothing of the machine. */
export class ErrorReportingTestError extends Error {
  override readonly name = 'ErrorReportingTestError';
  constructor(source: string) {
    super(`a test error sent from ${source} to check error reporting`);
  }
}

/** What {@link coreReportingSecrets} reads — the fields of `ServerConfig` that hold a secret. */
export interface CoreSecretSources {
  readonly secretKey: string;
  readonly database: { readonly url: string };
  readonly launcherToken: string | null;
  readonly modelApiKey: string | null;
  readonly modelOauthToken: string | null;
  readonly metricsPassword: string | null;
  readonly bootstrapAdminPassword: string | null;
}

/** The password a `postgres://` URL carries, decoded — or `null`. */
const databasePasswordOf = (url: string): string | null => {
  try {
    const password = new URL(url).password;
    return password === '' ? null : decodeURIComponent(password);
  } catch {
    return null;
  }
};

/**
 * The core's exact values (the amendment's decision 2): `APP_SECRET_KEY`, the database password and
 * the launcher token — and the other secrets the process holds, the model credentials, the metrics
 * password and the bootstrap password. A value shorter than `MIN_SECRET_LENGTH` cannot be an exact
 * value (it would erase ordinary words), so it is left to the pattern redactor — **a stated gap**:
 * `postgres://app:app@…`, the stock development URL, has a three-character password no reporter can
 * redact by value.
 */
export const coreReportingSecrets = (config: CoreSecretSources): readonly InjectedSecret[] =>
  (
    [
      ['app_secret_key', config.secretKey],
      ['database_password', databasePasswordOf(config.database.url)],
      ['launcher_token', config.launcherToken],
      ['anthropic_api_key', config.modelApiKey],
      ['claude_code_oauth_token', config.modelOauthToken],
      ['metrics_password', config.metricsPassword],
      ['bootstrap_admin_password', config.bootstrapAdminPassword],
    ] as const
  )
    .filter((entry): entry is readonly [string, string] => {
      const value = entry[1];
      return value !== null && value.length >= MIN_SECRET_LENGTH;
    })
    .map(([name, value]) => ({ name, value }));
