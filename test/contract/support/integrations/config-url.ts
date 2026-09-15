/**
 * **The obligation every provider's config schema owes its URL field** (WP-51, PROGRESS backlog 48;
 * technical/10 contract tier).
 *
 * A provider's `base_url`/`site_url` is not a string the platform renders — it is a string the
 * platform *dials*, with that binding's credential attached. Until WP-51 all five were bare
 * `z.url()`, which accepts `javascript:`, `data:`, `vbscript:` and `file:` (Q49, re-measured
 * against zod 4.5.4 while writing this). Each schema refined the *path* — Sentry and GitLab reject
 * a base URL that already carries `/api/0` or `/api/v4`, Loki `/loki/api/v1`, all four a trailing
 * slash — and **none** refined the scheme or the host.
 *
 * It is a shared suite rather than five copies for the reason rule 23 gives: a new port obligation
 * lands where every provider meets it, so a sixth provider inherits it instead of being reviewed
 * for it. The runner reads the provider directories off disk, so the set cannot quietly shrink.
 *
 * ## What this proves, and what it cannot
 *
 * It proves the **scheme** half: the value that reaches an adapter is `http` or `https`. It cannot
 * prove anything about the **host**, because which hosts an instance may dial is instance
 * configuration and a schema has no access to it — that is `APP_INTEGRATION_HOSTS`, enforced at
 * `POST /api/integrations` and again inside `IntegrationActionExecutor`, and asserted there.
 *
 * It also cannot prove that the adapter *uses* the field it validated. `providers/egress-host.test.ts`
 * is the census that ties each provider's config URL to the `IntegrationRef.host` its adapter
 * publishes; what nothing in this repository checks is that a provider's HTTP client makes no
 * request to a host it derived some other way. Stated, not implied.
 */
import { expect, it } from 'vitest';

/** The four Q49 records as accepted by a bare `z.url()`, plus one no adapter could ever want. */
export const REFUSED_URL_SCHEMES: readonly (readonly [string, string])[] = [
  ['javascript', 'javascript:alert(document.domain)'],
  ['data', 'data:text/html;base64,PHNjcmlwdD4='],
  ['vbscript', 'vbscript:msgbox(1)'],
  ['file', 'file:///etc/passwd'],
  ['ftp', 'ftp://gitlab.example.test/repo'],
];

/**
 * The half of a zod object this suite uses, spelled structurally.
 *
 * `test/` does not depend on zod — the schemas arrive through `@platform/integrations`, which does —
 * so naming `z.ZodObject` here would add a dependency to the test package for a type. The shape is
 * `safeParse`'s and nothing else.
 */
export interface ParsableSchema {
  safeParse(value: unknown): {
    readonly success: boolean;
    readonly error?: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] };
  };
}

export interface ConfigUrlCase {
  /** The provider directory, which is also the registration's id. */
  readonly provider: string;
  readonly schema: ParsableSchema;
  /** The config key holding the URL every call to this binding goes to. */
  readonly urlField: string;
  /**
   * A config document this schema accepts, with {@link urlField} set to a valid `https` URL.
   *
   * Written per provider rather than derived, because a schema's *other* required fields are the
   * provider's business and a generated document would be testing the generator.
   */
  readonly valid: Record<string, unknown>;
}

const withUrl = (testCase: ConfigUrlCase, url: unknown): Record<string, unknown> => ({
  ...testCase.valid,
  [testCase.urlField]: url,
});

/** Whether the schema's refusal is *about the URL field*, rather than about something else. */
const refusedTheUrlField = (testCase: ConfigUrlCase, value: unknown): boolean => {
  const parsed = testCase.schema.safeParse(withUrl(testCase, value));
  if (parsed.success) {
    return false;
  }
  return (parsed.error?.issues ?? []).some((issue) => issue.path[0] === testCase.urlField);
};

/**
 * The obligation, run against one provider's schema.
 *
 * Rule 42 is why the positive cases are here at all: a suite that only refused would pass against
 * `z.never()`, and the interesting failure of an over-tight scheme check is a self-hosted Loki on
 * `http://` that can no longer be configured.
 */
export const describeConfigUrlContract = (testCase: ConfigUrlCase): void => {
  it('accepts the https URL a hosted instance is configured with', () => {
    const parsed = testCase.schema.safeParse(testCase.valid);

    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify((parsed.error?.issues ?? []).map((issue) => issue.path)),
    ).toBe(true);
  });

  it('accepts http, because a self-hosted instance on a private network is a real deployment', () => {
    expect(refusedTheUrlField(testCase, 'http://self-hosted.example.test')).toBe(false);
  });

  it.each(REFUSED_URL_SCHEMES)('refuses the %s scheme (Q49)', (_name, url) => {
    expect(
      refusedTheUrlField(testCase, url),
      `${testCase.provider}.${testCase.urlField} accepted ${url}`,
    ).toBe(true);
  });

  it('refuses a bare host with no scheme, which is what an operator types by mistake', () => {
    // One past the boundary in the other direction (rule 42): the refusals above are about a
    // scheme that is present and wrong, this one about one that is absent.
    expect(refusedTheUrlField(testCase, 'gitlab.example.test')).toBe(true);
  });

  it('refuses a value that is not a string at all', () => {
    // The wire is JSON written by an `integration.write` caller, so the boundary sees whatever the
    // body held. A guard enforced only by `tsc` is not enforced here (rule 14).
    expect(refusedTheUrlField(testCase, 42)).toBe(true);
    expect(refusedTheUrlField(testCase, { toString: 'https://gitlab.example.test' })).toBe(true);
    expect(refusedTheUrlField(testCase, null)).toBe(true);
  });
};
