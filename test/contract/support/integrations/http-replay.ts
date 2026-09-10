/**
 * A replay transport for adapters whose `fetch` is injected — shared by the Sentry and the Loki
 * contract runs (technical/10 § contract tier).
 *
 * ## Why this exists beside `gitlab-replay.ts` rather than inside it
 *
 * WP-09's harness is the same idea and its docblock is the argument for the idea; this module is
 * the same machinery with the GitLab-shaped parts taken out (`/api/v4`, `x-next-page` paging, the
 * `PRIVATE-TOKEN` header) and one new one added (`variant`, below). WP-11 ships **two** providers,
 * so a third and a fourth copy of ~200 lines of queueing and bookkeeping was the alternative.
 *
 * What is shared is deliberately only *HTTP plumbing and fixture bookkeeping*: a key built from a
 * method and a path, a queue per key, a request log, and the two "is this corpus honest" counters.
 * Nothing here knows a vendor. The vendor-shaped decisions — which endpoints exist, what a 404
 * means, how the credential travels — stay in each provider's own harness and adapter, because a
 * helper that encoded one vendor's assumptions into the other's adapter is exactly the coupling
 * this work package was told to avoid.
 *
 * `gitlab-replay.ts` is **not** refactored onto this module. That file is reviewed, landed and
 * asserted by 32 tests, and rewriting it to prove a point about reuse would put WP-09's guarantees
 * at risk inside WP-11's diff. Recorded as discovered work instead.
 *
 * ## What the transport gives a test beyond "it answered"
 *
 *  - **an unmatched request is a loud failure**, naming the key it looked for and the keys it has.
 *    A replay that answered `{}` to an unknown request would make every assertion below it vacuous;
 *  - **an unexercised fixture is a loud failure** (`unusedFixtures()`), so a recorded interaction
 *    that no test reaches must be written about or deleted;
 *  - **a fixture a test fetched and never asserted on is a failure too**
 *    (`unassertedFixtureServes()`): reaching a fixture is execution, not verification. Standing
 *    rule 24, and the docblock there states the line it deliberately does not cross;
 *  - **sequenced responses** for one key, so two reads of the same resource can be two states;
 *  - **variants**, so a *write* can change what the next read answers. Sentry's `resolve` issues a
 *    `PUT` and then re-reads the issue, and the re-read must see `"status": "resolved"`. Jira's
 *    replay double models this with mutable state; here the second state is a **recorded fixture**
 *    carrying `"variant": "resolved"`, invisible until the harness calls `activate('resolved')`.
 *    That keeps both documents in the corpus, both provenance-checked, and both counted by
 *    `unusedFixtures()` — a mutable object in the harness would be neither;
 *  - **a request log**, so a test can assert what was *sent*: that a mutating call in shadow mode
 *    sent nothing at all, that the tenant header was present, that the line filter was escaped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/** Where a recorded interaction comes from. Checked by the shared fixture-provenance suite. */
export interface ReplaySource {
  readonly url?: string;
  readonly retrieved?: string;
  readonly kind?: string;
  readonly evidence?: string;
  readonly note?: string;
}

export interface ReplayInteraction {
  readonly method: string;
  /** Path below the provider's API base, with the query string as the adapter will build it. */
  readonly path: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Raw body for a text endpoint. Wins over `body`. */
  readonly text?: string;
  /**
   * Only served once the harness has `activate`d this name — the second state of a resource after
   * a write. An interaction with no `variant` is always a candidate.
   */
  readonly variant?: string;
  readonly source: ReplaySource;
}

export interface ReplayFixtureFile {
  readonly interactions: readonly ReplayInteraction[];
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface HttpReplay {
  /** Drop-in for a provider's injected `fetch`. */
  readonly fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<Response>;
  readonly requests: readonly RecordedRequest[];
  /** Adds or replaces the responses for one key, for a test that needs a specific answer. */
  script(interaction: ReplayInteraction | readonly ReplayInteraction[]): void;
  /** Makes every recorded interaction carrying this variant eligible. */
  activate(variant: string): void;
  reset(): void;
}

// ── Corpus bookkeeping, per test file (vitest isolates a module per file) ─────

const loadedLabels = new Set<string>();
const servedLabels = new Set<string>();

/** Every recorded interaction loaded in this test file that no request has reached. */
export const unusedFixtures = (): readonly string[] =>
  [...loadedLabels].filter((label) => !servedLabels.has(label)).sort();

interface PendingServe {
  readonly label: string;
  readonly testName: string;
  readonly assertionsBefore: number;
}

const pendingServes: PendingServe[] = [];
const unasserted: string[] = [];

const describeServe = (serve: PendingServe): string => `${serve.label} in "${serve.testName}"`;

/**
 * Every serve that no assertion followed — standing rule 24, and the half `unusedFixtures()`
 * cannot see. Fail-closed: a serve whose window nobody closed counts as unasserted.
 *
 * What it deliberately does **not** prove is that the assertion is *about* the response;
 * `expect(1).toBe(1)` after a fetch satisfies it. Tying an assertion to the bytes that fed it needs
 * taint tracking, which the corpus is not worth. This is a floor, not a proof.
 */
export const unassertedFixtureServes = (): readonly string[] =>
  [
    ...unasserted,
    ...pendingServes.map((serve) => `${describeServe(serve)} (assertion window never closed)`),
  ].sort();

const openAssertionWindow = (label: string): void => {
  const state = expect.getState();
  pendingServes.push({
    label,
    testName: state.currentTestName ?? '(no test was running)',
    assertionsBefore: state.assertionCalls ?? 0,
  });
};

/** Ends the current test's window. Call it from an `afterEach` in the file that owns the corpus. */
export const closeFixtureAssertionWindow = (): void => {
  const after = expect.getState().assertionCalls ?? 0;
  for (const serve of pendingServes) {
    if (after <= serve.assertionsBefore) {
      unasserted.push(describeServe(serve));
    }
  }
  pendingServes.length = 0;
};

// ── Keys ─────────────────────────────────────────────────────────────────────

/** `GET /organizations/acme/issues/?limit=25&query=is%3Aunresolved`, query sorted. */
export const replayKey = (method: string, pathWithQuery: string): string => {
  const [path, query = ''] = pathWithQuery.split('?');
  const params = new URLSearchParams(query);
  const sorted = [...params.entries()].sort(([left], [right]) => left.localeCompare(right));
  const rendered = sorted.map(([name, value]) => `${name}=${value}`).join('&');
  return `${method.toUpperCase()} ${path}${rendered === '' ? '' : `?${rendered}`}`;
};

// ── Loading a corpus ─────────────────────────────────────────────────────────

/**
 * Every fixture file in a directory, asked of the filesystem rather than carried in a list.
 *
 * A hand-maintained scope drifts (standing rule 7), and an unloaded fixture is invisible to
 * `unusedFixtures()` — drift in the permissive direction. An empty directory throws, because a
 * harness that quietly loaded nothing makes every replay assertion vacuous (rule 4).
 */
export const replayFixtureNames = (directory: URL): readonly string[] => {
  const names = readdirSync(fileURLToPath(directory))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
  if (names.length === 0) {
    throw new Error(`replay: no fixtures found in ${fileURLToPath(directory)}`);
  }
  return names;
};

export const loadReplayFixture = (directory: URL, name: string): readonly ReplayInteraction[] => {
  const url = new URL(`${name}.json`, directory);
  const parsed = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as ReplayFixtureFile;
  return parsed.interactions;
};

export const loadAllReplayFixtures = (directory: URL): readonly ReplayInteraction[] =>
  replayFixtureNames(directory).flatMap((name) => loadReplayFixture(directory, name));

// ── The transport ────────────────────────────────────────────────────────────

interface Recorded {
  readonly interaction: ReplayInteraction;
  readonly label: string;
  /** A response the test wrote itself, which is the test's business and not the corpus's. */
  readonly scripted: boolean;
}

export interface HttpReplayOptions {
  /** Prefixes every label, so two providers in one file cannot collide. */
  readonly provider: string;
  /** Stripped from a request's pathname before the key is built: `/api/0`, `/loki/api/v1`. */
  readonly apiBase: string;
  readonly interactions: readonly ReplayInteraction[];
}

export const createHttpReplay = (options: HttpReplayOptions): HttpReplay => {
  const queues = new Map<string, Recorded[]>();
  const requests: RecordedRequest[] = [];
  const activeVariants = new Set<string>();

  const add = (interaction: ReplayInteraction, scripted: boolean): void => {
    const key = replayKey(interaction.method, interaction.path);
    const queue = queues.get(key) ?? [];
    const variant = interaction.variant === undefined ? '' : ` [${interaction.variant}]`;
    const label = `${options.provider} ${scripted ? 'scripted ' : ''}${key}${variant} #${queue.length}`;
    queue.push({ interaction, label, scripted });
    queues.set(key, queue);
    if (!scripted) {
      loadedLabels.add(label);
    }
  };
  for (const interaction of options.interactions) {
    add(interaction, false);
  }

  const keyOfUrl = (method: string, url: string): string => {
    const parsed = new URL(url);
    const path = parsed.pathname.startsWith(options.apiBase)
      ? parsed.pathname.slice(options.apiBase.length)
      : parsed.pathname;
    return replayKey(method, `${path}${parsed.search}`);
  };

  return {
    requests,
    script: (interaction) => {
      const replaced = new Set<string>();
      for (const one of Array.isArray(interaction) ? interaction : [interaction]) {
        const key = replayKey(one.method, one.path);
        if (!replaced.has(key)) {
          queues.set(key, []);
          replaced.add(key);
        }
        add(one, true);
      }
    },
    activate: (variant) => {
      activeVariants.add(variant);
    },
    reset: () => {
      requests.length = 0;
    },
    fetchImpl: async (url, init) => {
      const key = keyOfUrl(init.method, url);
      requests.push({
        method: init.method,
        url,
        key,
        headers: { ...init.headers },
        body: init.body ?? null,
      });
      const queue = queues.get(key) ?? [];
      // A variant that has been activated wins; otherwise only the plain interactions are
      // candidates, so a second state cannot be served before the write that produces it.
      const variants = queue.filter(
        (recorded) =>
          recorded.interaction.variant !== undefined &&
          activeVariants.has(recorded.interaction.variant),
      );
      const pool =
        variants.length > 0
          ? variants
          : queue.filter((recorded) => recorded.interaction.variant === undefined);
      if (pool.length === 0) {
        throw new Error(
          `${options.provider} replay: no fixture for ${key}\navailable:\n  ${[...queues.keys()].sort().join('\n  ')}`,
        );
      }
      // The last candidate repeats: a read the suite makes twice needs one fixture, while a
      // sequence of two states needs two.
      const recorded = pool[0] as Recorded;
      if (pool.length > 1) {
        const remaining = queue.filter((candidate) => candidate !== recorded);
        queues.set(key, remaining);
      }
      servedLabels.add(recorded.label);
      if (!recorded.scripted) {
        openAssertionWindow(recorded.label);
      }
      const chosen = recorded.interaction;
      const headers: Record<string, string> = { ...chosen.headers };
      const body =
        chosen.text !== undefined
          ? chosen.text
          : chosen.body === undefined
            ? ''
            : JSON.stringify(chosen.body);
      if (chosen.text === undefined && chosen.body !== undefined) {
        headers['content-type'] ??= 'application/json';
      }
      return new Response(chosen.status === 204 ? null : body, {
        status: chosen.status,
        headers,
      });
    },
  };
};
