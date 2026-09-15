/**
 * The platform's own egress policy — which hosts this process may dial for a provider call
 * (WP-51, PROGRESS backlog **48**).
 *
 * ## The asymmetry this closes
 *
 * technical/05 § "Network policy" gives the **run container** an allow-list: no default route, a
 * sidecar that forwards to a rendered list of hosts and denies everything else. The **server
 * process** — the one that holds every decrypted credential — had nothing equivalent. Every
 * provider takes its host from `integrations.config` as a free-form URL written by an
 * `integration.write` caller, and the value is handed straight to the client the binding's token is
 * built into: `createSentryHttp({ baseUrl, token })`, and GitLab's `buildCloneUrl`, which puts the
 * credential *into* a URL for that host. An administrator who may name a host and a credential
 * *field* — but who by design never sees the credential's *value* — could therefore have the
 * platform deliver it somewhere they do read, and the audit could not tell: `integration_actions`
 * records the action and redacts the secret, so a token sent to an attacker's host looks exactly
 * like a successful provider call.
 *
 * ## What this module is, and what it is not
 *
 * It is a pure decision over two inputs — the operator's declared list and one URL — with no I/O,
 * no DNS and no socket. It cannot stop a host that resolves to an address the operator did not
 * expect, it does not pin an address, and it does not re-check after a redirect. Those are stated
 * rather than implied; see "What it does not cover" below.
 *
 * ## Exact matching, because the useful negatives are the adjacent ones
 *
 * `renderEgressConfig`'s pattern tests already record the lesson for the sidecar (standing rule
 * 43): `evil.example.com` is refused by every candidate implementation and proves nothing, while
 * `evil-gitlab.example.com`, `gitlab.example.com.evil.test` and `xgitlab.example.com` separate
 * exact matching from substring matching. So the comparison here is string equality over the
 * **parsed** host, never `includes`, never `endsWith`, and never a suffix rule that would make
 * declaring `example.com` admit a subdomain nobody named.
 *
 * Two normalisations happen before the comparison, and both are on the *candidate* as well as on
 * the declaration, so they cannot disagree:
 *
 *  - **case**, because `HTTPS://GITLAB.EXAMPLE.TEST` parses to the same host as the lowercase form
 *    and zod's `protocol` check passes it (measured, zod 4.5.4);
 *  - **one trailing dot**, because `gitlab.example.test.` is the same name in DNS and is what a
 *    caller writes to sidestep a comparison that does not know that. The sidecar's own list has the
 *    identical case in its pattern tests.
 *
 * Nothing else is normalised: no punycode/IDNA mapping (so a declared list written in Unicode and a
 * URL written in punycode do **not** match — the refusal is the safe direction and the operator
 * guide says to declare the punycode form), and no port stripping beyond what `URL.hostname`
 * already does, which means **a port is not part of the decision**. A Loki at
 * `https://loki.example.test:3100` is admitted by declaring `loki.example.test`; the port is the
 * binding's business and a port allow-list would be a second list to keep in step for no measured
 * gain. That is a deliberate narrowing of the sidecar's shape, which *does* bound `CONNECT` ports.
 *
 * ## The empty list fails closed, and `*` is how an operator declares it open
 *
 * Standing rule 18: an empty allow-list that admits everything is spelled exactly like a scan of
 * zero bytes. So an empty or absent `APP_INTEGRATION_HOSTS` means **no provider call leaves this
 * process** and **no integration can be created through the API**, with both refusals naming the
 * setting. It is the third operator-declared list on this process and the third to fail closed:
 * `APP_INTEGRATION_SECRET_ENV` (empty → no credential is readable) and
 * `APP_DEPENDENCY_REGISTRY_HOSTS` (empty → no request leaves) are the other two, and consistency
 * between them is itself part of the answer — an operator who has learned one has learned all
 * three.
 *
 * The cost is stated rather than hidden: an instance upgrading to this version finds its
 * integrations refused until an operator declares their hosts, which is why the refusal names the
 * host **and** the variable, why the composition logs the declared set at boot, and why
 * `docs/operator-guide.md` carries it under the upgrade steps. {@link ALLOW_ANY_HOST} is the escape
 * hatch for an operator who genuinely means "anywhere" — a single `*` entry, which is a thing
 * somebody types on purpose.
 *
 * ## What it does not cover, stated rather than implied
 *
 *  - **DNS.** A declared host that resolves to `169.254.169.254` is allowed. This is an allow-list
 *    over names, not over addresses, and an SSRF guard over addresses is a different mechanism
 *    (it would have to run at connect time, inside the HTTP client, and re-run on every redirect).
 *  - **Redirects.** The adapters pass the base URL to `fetch`; a 302 to another host is followed by
 *    whatever the adapter's client does. The registry client next door sets `redirect: 'error'`;
 *    no provider adapter does, and that is recorded as discovered work rather than fixed here.
 *  - **A host reached some other way.** The guard is on the executor's request and on the write, so
 *    it covers what a *binding* dials. A module that opens a socket by itself is outside it — which
 *    is exactly why the one such module names its own checklist (see
 *    `packages/infrastructure/src/dependencies/registry-metadata.ts`).
 *  - **The scheme of a URL that never reaches a schema.** `httpUrlSchema` refuses a non-http(s)
 *    scheme at the five provider configs, and this module refuses one again **at the write**,
 *    because a config key can be added by a provider that forgets. It does **not** refuse one at
 *    the call: the executor synthesises `https://<host>` from the adapter's `IntegrationRef.host`
 *    and checks that, so `scheme_not_permitted` is unreachable from the call path — a row written
 *    by `psql` with a hostile scheme is caught by the binding loader's `configSchema` instead,
 *    which is a parse refusal and not an `IntegrationEgressRefusedError`
 *    (`test/integration/integrations/egress.integration.test.ts` asserts exactly that; round-1
 *    reviewer, rule 44: the first version of this sentence claimed the call-time layer).
 */
import { IntegrationError, type IntegrationRef } from '../ports/integrations/common.js';

/**
 * The environment variable the declared list comes from, spelled once.
 *
 * Both refusals quote it — the HTTP one an operator reads in the browser, the call-time one an
 * operator reads in the log — and an operator who is told "add it to the setting" without being
 * told *which* setting has been told nothing.
 */
export const INTEGRATION_HOSTS_SETTING = 'APP_INTEGRATION_HOSTS';

/** The one entry that declares the list open. See the docblock: rule 18's escape hatch. */
export const ALLOW_ANY_HOST = '*';

/** Why a URL was refused. The same vocabulary at the write and at the call. */
export type EgressRefusalReason =
  /** Not parseable as an absolute URL at all. */
  | 'not_a_url'
  /** Parseable, but not `http:` or `https:` — `javascript:`, `data:`, `vbscript:`, `file:` (Q49). */
  | 'scheme_not_permitted'
  /** Parseable and http(s), and its host is not one an operator declared. */
  | 'host_not_declared';

export type EgressVerdict =
  | { readonly allowed: true; readonly host: string }
  | {
      readonly allowed: false;
      readonly reason: EgressRefusalReason;
      /** The parsed host, or `null` when there was nothing to parse. Never the whole URL. */
      readonly host: string | null;
      /** One sentence naming what is wrong and which setting fixes it. */
      readonly message: string;
    };

export interface IntegrationEgressPolicy {
  /** The declared entries, in the order the operator wrote them. For logging and for messages. */
  readonly declared: readonly string[];
  /** True when the operator declared {@link ALLOW_ANY_HOST}. */
  readonly open: boolean;
  /** The decision for one URL. Never throws; the caller decides what a refusal costs. */
  check(url: string): EgressVerdict;
}

/**
 * The host a URL names, lower-cased and without a single trailing dot — or `null`.
 *
 * `URL.hostname` already drops the port and the credentials, keeps IPv6 brackets, and lower-cases
 * an ASCII host. The trailing dot is the one thing it keeps that DNS treats as identical, and it is
 * removed here rather than at the comparison so the declared list and the candidate go through the
 * same function.
 */
export const egressHostOf = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  return host.endsWith('.') ? host.slice(0, -1) : host;
};

/** `http:` and `https:`. A set rather than two comparisons, so the list is readable as data. */
const DIALLABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

const declaredList = (declared: readonly string[]): string =>
  declared.length === 0 ? 'none' : declared.join(', ');

/**
 * Builds the policy from what an operator declared.
 *
 * **Required wherever it is consumed, never defaulted.** A composition root that forgot it would
 * otherwise get whichever default this file chose, and both possible defaults are wrong: "open" is
 * the defect the whole module exists to remove, and "closed" would look at the call site exactly
 * like a working policy (standing rule 31, the argument `SecretRedactor` already carries).
 */
export const createIntegrationEgressPolicy = (
  declared: readonly string[],
): IntegrationEgressPolicy => {
  const entries = declared
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  const open = entries.includes(ALLOW_ANY_HOST);
  // Normalised exactly as a candidate is (see `egressHostOf`), so a declaration written with a
  // trailing dot matches a URL written without one and the other way round.
  const hosts = new Set(
    entries
      .filter((entry) => entry !== ALLOW_ANY_HOST)
      .map((entry) => (entry.endsWith('.') ? entry.slice(0, -1) : entry)),
  );

  return {
    declared: [...declared],
    open,
    check: (url: string): EgressVerdict => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return {
          allowed: false,
          reason: 'not_a_url',
          host: null,
          // The caller's string is never echoed: it is configuration somebody may have pasted a
          // credential into, and this message reaches an HTTP response and a log line.
          message:
            'this value is not an absolute URL, so the platform cannot tell which host it would call',
        };
      }
      const host = egressHostOf(url) ?? '';
      if (!DIALLABLE_PROTOCOLS.has(parsed.protocol)) {
        return {
          allowed: false,
          reason: 'scheme_not_permitted',
          host: host === '' ? null : host,
          message: `"${parsed.protocol}" is not a scheme the platform dials; use http or https`,
        };
      }
      if (host === '') {
        return {
          allowed: false,
          reason: 'not_a_url',
          host: null,
          message: 'this URL names no host, so the platform cannot tell where it would call',
        };
      }
      if (open || hosts.has(host)) {
        return { allowed: true, host };
      }
      return {
        allowed: false,
        reason: 'host_not_declared',
        host,
        message:
          `this deployment does not permit calling "${host}". ` +
          `Add it to ${INTEGRATION_HOSTS_SETTING} (declared: ${declaredList(entries)}) and restart the process`,
      };
    },
  };
};

/**
 * The policy that admits every host, spelled out in full.
 *
 * It exists so that a test, a fake or a deployment that genuinely means "anywhere" *says so* at the
 * construction site rather than getting it by omission — the same reason `noSecretsRedactor()` is a
 * named function instead of an optional field.
 */
export const allowAnyIntegrationHost = (): IntegrationEgressPolicy =>
  createIntegrationEgressPolicy([ALLOW_ANY_HOST]);

/**
 * A provider call refused before it was made, because the binding's host is not declared.
 *
 * `forbidden` rather than `invalid_request`: the request is well-formed and this deployment does
 * not permit it, which is the same reading `POST /api/integrations` gives the write-time half with
 * its 403. It is **not** retryable (`forbidden` is outside `RETRYABLE_CODES`), because nothing
 * about a later attempt changes an operator's configuration.
 */
export class IntegrationEgressRefusedError extends IntegrationError {
  readonly reason: EgressRefusalReason;
  /** The host that was refused, or `null` when the binding's URL named none. */
  readonly host: string | null;
  /** The setting an operator changes. Carried on the error so a log line cannot forget it. */
  readonly setting: string = INTEGRATION_HOSTS_SETTING;

  constructor(
    ref: Pick<IntegrationRef, 'provider'>,
    action: string,
    verdict: Extract<EgressVerdict, { allowed: false }>,
  ) {
    super('forbidden', ref.provider, verdict.message, { action });
    this.reason = verdict.reason;
    this.host = verdict.host;
  }
}
