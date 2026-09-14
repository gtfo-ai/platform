/**
 * The package-registry metadata client — Q84's recommendation, narrowly (WP-38).
 *
 * product/04:58 wants a dependency question to carry *"license and maintenance status"* and
 * product/18:43 wants the Checks panel to show it. Nothing in this platform knew a package registry,
 * and **PROGRESS backlog 48** records why adding one is not free: a binding's host is whatever the
 * caller typed and the server process has no outbound allow-list at all. So this client is built
 * around one rule, which is also the answer Q84 gives:
 *
 * > **The platform calls a host an operator declared, or it calls nothing.**
 *
 * `APP_DEPENDENCY_REGISTRY_HOSTS` is instance configuration (TD-020), **empty by default**, and is
 * the shape `APP_INTEGRATION_SECRET_ENV` already uses for the same reason: a list a caller can
 * extend is not a list. A self-hoster who configures nothing gets `not_checked` on every package —
 * a stated non-answer on the panel — rather than a silent request to a host nobody approved. This is
 * backlog 48 closed **for this path** rather than widened for every path.
 *
 * ## What it does *not* go through, and the measurement that decided it
 *
 * Every outbound **provider** call goes through `IntegrationActionExecutor` (WP-15b), and this one
 * does not. The reason is structural rather than an omission: that executor identifies every call
 * by an `IntegrationRef`, and its audit row is
 * `integration_actions.integration_id uuid not null references integrations (id)`
 * (`0007_cost.sql:127`), as is `integration_idempotency.integration_id`. A package registry has no
 * `integrations` row — there is no binding, no credential and no project configuration — so routing
 * it through the executor would mean either inventing a row or attributing an npm request to the
 * project's GitLab binding in the audit trail, which is worse than not being in the audit trail.
 * Creating the row properly means a **sixth integration type**, which Q84 priced and rejected for
 * now: *"a whole integration type for one read-only lookup with no credential is BD-017's machinery
 * without BD-017's problem"*.
 *
 * What the executor would have given it is therefore given here, at the call, and each is asserted
 * in `registry-metadata.test.ts`:
 *
 *  - **no credential leaves this process.** The client sends no `Authorization` header and no cookie
 *    and is never handed a secret — which is *why* the audit row's absence costs less here than
 *    anywhere else: the property the audit exists to police (BD-002, TD-012) is that a credential
 *    reached a host, and none can;
 *  - **the host is allow-listed** before a request is made, by exact match — never by suffix, the
 *    lesson `renderEgressConfig`'s pattern tests already record (`gitlab.example.com.evil.test`);
 *  - **the package name is validated** against the ecosystem's own pattern (the domain's table, one
 *    spelling) and URL-encoded, so a name out of a hostile diff cannot become a path or a host;
 *  - **the request is bounded**: a timeout, a redirect refusal, and a response body read through a
 *    cap rather than into memory;
 *  - **it never throws**, and a failure is `unavailable` — the gate must not depend on the lookup
 *    (Q84), so a registry outage delays no merge;
 *  - **it never answers a value the record cannot hold**, which is the guard review round 2 earned:
 *    npm's `license` was read unbounded while `dependencyMetadataSchema.license` is `.max(200)`, so
 *    a package publishing its whole licence text made `taskDependenciesSchema.parse` throw in the
 *    gate — no record, no question, no block, and a dead job. {@link MAX_LICENCE_CHARS} bounds the
 *    string and the schema itself is asked about the finished answer, because the licence is not
 *    the only third-party field here: `modified` is whatever the registry serialised, and
 *    `new Date(Date.parse('+275760-09-13T00:00:00Z')).toISOString()` is an instant
 *    `isoDateTimeSchema` refuses (measured). A refusal is `unavailable`, never a throw;
 *  - **it never runs inside a transaction**: `assertOutsideTransaction` refuses, exactly as
 *    `integrations.forProject` does, so the *transaction / no transaction / transaction* shape is
 *    mechanical here too (WP-15d).
 *
 * ## The two registries it knows, and how their answers were measured
 *
 * Both shapes were read off the live services on **2026-09-14** rather than from memory, because a
 * field name written from memory is a prediction in a measurement's voice (standing rule 86). The
 * sizes are from those same reads.
 *
 *  - **npm** — two GETs, because neither endpoint carries both facts.
 *    `GET https://registry.npmjs.org/<name>/latest` (1 571 B for `left-pad`) carries `license`,
 *    `version` and `deprecated`;
 *    `GET https://registry.npmjs.org/<name>` with `Accept: application/vnd.npm.install-v1+json` —
 *    the abbreviated packument, 8 488 B for `left-pad` against a full one that can be megabytes —
 *    carries `modified` and **no** `license` on its version objects, which is why the first call
 *    exists. Documented at <https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md>.
 *  - **PyPI** — one GET. `GET https://pypi.org/pypi/<name>/json` (192 973 B for `requests`) carries
 *    `info.license_expression`, `info.license`, `info.yanked` and `urls[].upload_time_iso_8601`.
 *    Documented at <https://docs.pypi.org/api/json/>.
 *  - **`go` and `cargo` answer `unsupported`**, by name. `proxy.golang.org` publishes a version and
 *    a date and **no licence at all**, and crates.io's API asks callers for a `User-Agent` that
 *    identifies them; neither is hard, and shipping a half-answer under the same word the other two
 *    use would be worse than saying which ecosystems this build can describe (standing rule 18).
 */

import type {
  DependencyMetadataLookup,
  DependencyMetadataPort,
  Logger,
} from '@platform/application';
import {
  assertOutsideTransaction,
  notCheckedMetadata,
  silentLogger,
  unavailableMetadata,
  unsupportedMetadata,
} from '@platform/application';
import type { DependencyEcosystem, DependencyMetadata } from '@platform/contracts';
import { dependencyMetadataSchema } from '@platform/contracts';
import { DEPENDENCY_ECOSYSTEM_FILES } from '@platform/domain';

/** How long one registry request may take before the answer is `unavailable`. */
export const REGISTRY_TIMEOUT_MS = 5_000;

/**
 * How much of a registry response is read.
 *
 * 2 MB, which is an order of magnitude above the largest answer measured (PyPI's `requests`, 193 kB)
 * and small enough that a hostile or broken host cannot stream this process out of memory. The body
 * is read through a bound rather than with `response.text()`, because `text()` reads whatever
 * arrives.
 */
export const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

/**
 * The longest licence string this client will answer with, and what a longer one becomes.
 *
 * 200, because that is what the record holds: `dependencyMetadataSchema.license` is
 * `z.string().max(200)` (`packages/contracts/src/records.ts`). A longer value is **dropped rather
 * than truncated**, for the reason {@link pypiLicense} gives about free text — a cut-off licence on
 * a merge-readiness panel reads as a licence nobody has — and dropping it costs the licence line
 * and nothing else: the package is still on the record, the question is still asked, the block is
 * still applied.
 *
 * It is applied **once, to every registry's answer**, rather than inside each reader. npm's
 * `license` was read through `asString` (trim only, unbounded) until review round 2 while PyPI's
 * free-text path had a cap of its own, which is the shape standing rule 44 names: a bound each new
 * reader has to remember is a bound the next one forgets.
 */
export const MAX_LICENCE_CHARS = 200;

interface Registry {
  readonly host: string;
  /** Every request this ecosystem makes, in order; the first that fails makes the answer partial. */
  readonly describe: (
    name: string,
    get: (url: string, accept?: string) => Promise<unknown>,
  ) => Promise<Omit<DependencyMetadata, 'status' | 'source_url'>>;
  /** The human page for the package, composed by the platform from an encoded name. */
  readonly page: (encoded: string) => string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** An ISO instant the record can carry, or `null`. Registries publish several precisions. */
const asInstant = (value: unknown): string | null => {
  const text = asString(value);
  if (text === null) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/**
 * npm's `license`, which is a string on modern packages and an object or an array on old ones.
 *
 * `{ "type": "MIT", "url": … }` is the historic spelling and is still in the registry, so it is read
 * rather than dropped; anything else answers `null`, which the panel prints as *"the registry does
 * not say"* rather than as a guess.
 */
const npmLicense = (value: unknown): string | null => {
  const direct = asString(value);
  if (direct !== null) {
    return direct;
  }
  const record = asRecord(value);
  return record === null ? null : asString(record.type);
};

/**
 * PyPI's licence, in the order of decreasing honesty.
 *
 * `license_expression` is the SPDX field; a Trove classifier is the next best structured answer; and
 * `info.license` is **free text that is frequently the whole licence** — measured at 11 kB for some
 * packages — so it is used only when it is short enough to be a name rather than a document. A
 * truncated licence text on a merge-readiness panel would read as a licence nobody has.
 */
const pypiLicense = (info: Record<string, unknown>): string | null => {
  const expression = asString(info.license_expression);
  if (expression !== null) {
    return expression;
  }
  const classifiers = Array.isArray(info.classifiers) ? info.classifiers : [];
  for (const entry of classifiers) {
    const text = asString(entry);
    if (text !== null && text.startsWith('License :: ')) {
      return text.slice(text.lastIndexOf(' :: ') + 4);
    }
  }
  const free = asString(info.license);
  return free !== null && free.length <= 64 ? free : null;
};

/** A licence the record can hold, or `null` — see {@link MAX_LICENCE_CHARS}. */
const boundedLicence = (value: string | null): string | null =>
  value === null || value.length > MAX_LICENCE_CHARS ? null : value;

const REGISTRIES: Readonly<Record<DependencyEcosystem, Registry | null>> = {
  npm: {
    host: 'registry.npmjs.org',
    page: (encoded) => `https://www.npmjs.com/package/${encoded}`,
    describe: async (encoded, get) => {
      const latest = asRecord(await get(`https://registry.npmjs.org/${encoded}/latest`));
      const packument = asRecord(
        await get(`https://registry.npmjs.org/${encoded}`, 'application/vnd.npm.install-v1+json'),
      );
      return {
        license: latest === null ? null : npmLicense(latest.license),
        // `deprecated` is the message the author left, so its *presence* is the fact.
        deprecated: latest === null ? null : asString(latest.deprecated) !== null,
        last_published_at: packument === null ? null : asInstant(packument.modified),
      };
    },
  },
  pypi: {
    host: 'pypi.org',
    page: (encoded) => `https://pypi.org/project/${encoded}/`,
    describe: async (encoded, get) => {
      const body = asRecord(await get(`https://pypi.org/pypi/${encoded}/json`));
      const info = body === null ? null : asRecord(body.info);
      const urls = body !== null && Array.isArray(body.urls) ? body.urls : [];
      const first = urls.length > 0 ? asRecord(urls[0]) : null;
      return {
        license: info === null ? null : pypiLicense(info),
        deprecated: info === null ? null : info.yanked === true,
        last_published_at: first === null ? null : asInstant(first.upload_time_iso_8601),
      };
    },
  },
  // Named rather than silent — see the module docblock.
  go: null,
  cargo: null,
};

export interface RegistryMetadataOptions {
  /**
   * `APP_DEPENDENCY_REGISTRY_HOSTS` — the hosts an operator has declared, exactly.
   *
   * Empty (the default) means every lookup answers `not_checked` and **no request is made**. A host
   * that no ecosystem of this build knows is not an error here: it is simply never matched, and the
   * composition root logs the set it was given so an operator can see their typo.
   */
  readonly allowedHosts: readonly string[];
  /** Injected so a test can drive every branch without a network (standing rule 4). */
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
}

/** Reads at most {@link MAX_REGISTRY_BYTES} of a response and refuses the rest. */
const readBounded = async (response: Response): Promise<string> => {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_REGISTRY_BYTES) {
        throw new Error(`the registry answered with more than ${MAX_REGISTRY_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
};

/**
 * The client an instance composes when `APP_DEPENDENCY_REGISTRY_HOSTS` names a host.
 *
 * See the module docblock for what it does instead of going through `IntegrationActionExecutor`,
 * and why.
 */
export const createDependencyMetadataClient = (
  options: RegistryMetadataOptions,
): DependencyMetadataPort => {
  const logger = options.logger ?? silentLogger;
  const call = options.fetch ?? globalThis.fetch;
  const allowed = new Set(options.allowedHosts.map((host) => host.trim().toLowerCase()));
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;

  const get = async (url: string, accept?: string): Promise<unknown> => {
    const response = await call(url, {
      method: 'GET',
      // No credential of any kind: the whole reason this path can live outside the audit.
      headers: { accept: accept ?? 'application/json' },
      // A redirect is how an allow-listed host hands the request to one that is not, so it is
      // refused rather than followed.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`the registry answered ${response.status}`);
    }
    return JSON.parse(await readBounded(response)) as unknown;
  };

  return {
    describe: async (lookup: DependencyMetadataLookup): Promise<DependencyMetadata> => {
      assertOutsideTransaction('the dependency metadata lookup');
      const registry = REGISTRIES[lookup.ecosystem];
      if (registry === null) {
        return unsupportedMetadata();
      }
      if (!allowed.has(registry.host)) {
        // **The shipped path.** Nothing is requested, and the panel says so by name.
        return notCheckedMetadata();
      }
      if (!DEPENDENCY_ECOSYSTEM_FILES[lookup.ecosystem].name.test(lookup.name)) {
        // A name out of somebody's diff that the ecosystem's own rules refuse. It is not a
        // registry failure and it is not a package: say the platform did not look.
        logger.warn(
          { ecosystem: lookup.ecosystem },
          'dependency metadata: the package name in this diff is not one this ecosystem allows, so no registry was asked',
        );
        return notCheckedMetadata();
      }
      // Segment by segment, so a scope keeps its separator and everything else is escaped —
      // including the `@`, which the registry serves in either form (measured 2026-09-14:
      // `GET https://registry.npmjs.org/%40babel/core/latest` answers 200).
      const encoded = lookup.name.split('/').map(encodeURIComponent).join('/');
      try {
        const facts = await registry.describe(encoded, get);
        const answer: DependencyMetadata = {
          ...facts,
          license: boundedLicence(facts.license),
          status: 'checked',
          source_url: registry.page(encoded),
        };
        /**
         * **The record's own schema is the last guard**, so "what the panel can store" is one
         * statement rather than a list of bounds each reader re-derives (standing rule 44).
         *
         * Every field above is third-party text: a licence is whatever the author typed, and
         * `modified`/`upload_time_iso_8601` are whatever the registry serialised — and
         * `new Date(Date.parse('+275760-09-13T00:00:00Z')).toISOString()` is an instant
         * `isoDateTimeSchema` refuses. A value this schema will not take is not stored *and does
         * not reach the gate*, where the same parse happens with no way to answer `unavailable`.
         */
        const stored = dependencyMetadataSchema.safeParse(answer);
        if (!stored.success) {
          logger.warn(
            {
              ecosystem: lookup.ecosystem,
              host: registry.host,
              issues: stored.error.issues.length,
            },
            'dependency metadata: the registry answered something this record cannot hold, so the gate carries on without it',
          );
          return unavailableMetadata();
        }
        return stored.data;
      } catch (error) {
        logger.info(
          { ecosystem: lookup.ecosystem, host: registry.host, err: error },
          'dependency metadata: the registry could not answer, so the gate carries on without a licence',
        );
        return unavailableMetadata();
      }
    },
  };
};
